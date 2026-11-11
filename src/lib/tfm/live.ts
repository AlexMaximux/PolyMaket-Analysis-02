import fs from 'fs';
import path from 'path';
import { tfmForecast } from './client';
import { fetchMinuteBars } from './klines';
import { windowForecast, windowsAt } from './math';
import { contextAsOf, openAt } from './series';
import { ensureTfmService, type TfmServiceState } from './service';
import { TFM_HORIZON, TFM_MIN_CONTEXT, type TfmWindowForecast, type TfmWindowKey } from './types';

export interface TfmTrackPoint {
  t: number /* s */;
  h1: number | null;
  m15: number | null;
  m5: number | null;
} // probUp 0-1

/** JSON answer of GET /api/updown/tfm. */
export interface TfmLiveResponse {
  coin: string;
  serverTime: number; // s
  service: { ok: boolean; state: TfmServiceState; latencyMs: number | null; model: string | null };
  context: number | null;
  last: number | null;
  windows: Record<TfmWindowKey, (TfmWindowForecast & { endSec: number }) | null> | null;
  path: { step: number; mean: number; q: number[] }[] | null; // 60 steps, q = 9 deciles
  history: number[] | null; // the last 60 context values
  track: TfmTrackPoint[]; // points since the start of the current 1H window, oldest first
}

/** <cwd>/jev/tfm/live/<coin>-<YYYY-MM-DD>.jsonl */
export function tfmLivePath(coin: string, dayUtc: string): string {
  return path.join(process.cwd(), 'jev', 'tfm', 'live', `${coin.toLowerCase()}-${dayUtc}.jsonl`);
}

const CACHE_MS = 25_000;
const BARS_BACK_MIN = 1000;
const HISTORY_POINTS = 60;

const cache = new Map<string, { at: number; body: TfmLiveResponse }>();
const inflight = new Map<string, Promise<TfmLiveResponse>>();

const empty = (coin: string, state: TfmServiceState, ok: boolean, now: number): TfmLiveResponse => ({
  coin,
  serverTime: Math.floor(now / 1000),
  service: { ok, state, latencyMs: null, model: null },
  context: null,
  last: null,
  windows: null,
  path: null,
  history: null,
  track: [],
});

function readTrack(coin: string, now: number): TfmTrackPoint[] {
  const dayUtc = new Date(now).toISOString().slice(0, 10);
  const filePath = tfmLivePath(coin, dayUtc);
  const hourStartMs = Math.floor(now / 3600_000) * 3600_000;
  const points: TfmTrackPoint[] = [];
  try {
    if (fs.existsSync(filePath)) {
      const text = fs.readFileSync(filePath, 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const item = JSON.parse(line);
          if (typeof item.ts === 'number' && item.ts >= hourStartMs && item.ts <= now) {
            points.push({
              t: Math.floor(item.ts / 1000),
              h1: typeof item.h1?.probUp === 'number' ? item.h1.probUp : null,
              m15: typeof item.m15?.probUp === 'number' ? item.m15.probUp : null,
              m5: typeof item.m5?.probUp === 'number' ? item.m5.probUp : null,
            });
          }
        } catch {
          // ignore malformed line
        }
      }
    }
  } catch {
    // swallow read errors
  }
  return points.slice(-240);
}

async function compute(coin: string): Promise<TfmLiveResponse> {
  const now = Date.now();
  let bars: Awaited<ReturnType<typeof fetchMinuteBars>> = [];
  try {
    bars = await fetchMinuteBars(coin, now - BARS_BACK_MIN * 60_000, now);
  } catch {
    bars = [];
  }
  const spot = bars.length > 0 ? bars[bars.length - 1].close : null;
  const context = contextAsOf(bars, now, spot);
  if (context.length < TFM_MIN_CONTEXT) {
    // the service is fine, there is just not enough price history to forecast from
    return { ...empty(coin, 'ready', true, now), context: context.length, last: spot };
  }
  const last = context[context.length - 1];
  const t0 = Date.now();
  const res = await tfmForecast([context], TFM_HORIZON);
  if (!res || res.quantiles.length !== 1 || res.mean.length !== 1) return empty(coin, 'offline', false, now);
  const latencyMs = Date.now() - t0;
  const quantiles = res.quantiles[0];

  const w = windowsAt(now);
  const windows = {} as Record<TfmWindowKey, (TfmWindowForecast & { endSec: number }) | null>;
  for (const k of ['h1', 'm15', 'm5'] as const) {
    const open = openAt(bars, w[k].startMs);
    windows[k] = open === null || !(open > 0)
      ? null
      : { ...windowForecast({ open, last, minutesLeft: w[k].minutesLeft, quantiles }), endSec: w[k].endMs / 1000 };
  }

  // Append fresh calculation to today's live file
  const dayUtc = new Date(now).toISOString().slice(0, 10);
  const filePath = tfmLivePath(coin, dayUtc);
  const lineRecord = {
    ts: now,
    model: res.model,
    last,
    h1: windows.h1 ? {
      open: windows.h1.open,
      minutesLeft: windows.h1.minutesLeft,
      probUp: windows.h1.probUp,
      median: windows.h1.median,
      q10: windows.h1.q10,
      q90: windows.h1.q90,
    } : null,
    m15: windows.m15 ? {
      open: windows.m15.open,
      minutesLeft: windows.m15.minutesLeft,
      probUp: windows.m15.probUp,
      median: windows.m15.median,
      q10: windows.m15.q10,
      q90: windows.m15.q90,
    } : null,
    m5: windows.m5 ? {
      open: windows.m5.open,
      minutesLeft: windows.m5.minutesLeft,
      probUp: windows.m5.probUp,
      median: windows.m5.median,
      q10: windows.m5.q10,
      q90: windows.m5.q90,
    } : null,
  };
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(lineRecord) + '\n', 'utf8');
  } catch {
    // swallow write errors
  }

  const track = readTrack(coin, now);

  return {
    coin,
    serverTime: Math.floor(now / 1000),
    service: { ok: true, state: 'ready', latencyMs, model: res.model },
    context: context.length,
    last,
    windows,
    path: quantiles.map((q, i) => ({ step: i + 1, mean: res.mean[0][i], q })),
    history: context.slice(-HISTORY_POINTS),
    track,
  };
}

/**
 * Live forecast of a coin (lower-case key of TFM_SYMBOLS). The last good answer is kept for 25 s and concurrent
 * callers share one computation, so several open tabs make one forecast.
 */
export async function tfmLive(coin: string): Promise<TfmLiveResponse> {
  const state = await ensureTfmService();
  if (state !== 'ready') return empty(coin, state, false, Date.now());

  const hit = cache.get(coin);
  if (hit && Date.now() - hit.at < CACHE_MS) return { ...hit.body, serverTime: Math.floor(Date.now() / 1000) };

  let p = inflight.get(coin);
  if (!p) {
    p = compute(coin).finally(() => inflight.delete(coin));
    inflight.set(coin, p);
  }
  const body = await p;
  if (body.service.ok && body.windows) cache.set(coin, { at: Date.now(), body });
  return body;
}

export function resetTfmLiveCacheForTests(): void {
  cache.clear();
  inflight.clear();
}
