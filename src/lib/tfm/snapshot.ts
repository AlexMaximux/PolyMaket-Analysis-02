import { tfmForecast } from './client';
import { ensureTfmService } from './service';
import { fetchMinuteBars } from './klines';
import { windowForecast, windowsAt } from './math';
import { contextAsOf, openAt } from './series';
import { appendTfmPath, roundSig, type TfmPathRecord } from './paths';
import { appendTfmRecords } from './store';
import { TFM_HORIZON, TFM_MAX_CONTEXT, TFM_MIN_CONTEXT, type MinuteBar, type TfmRecord, type TfmWindowForecast, type TfmWindowKey } from './types';

export interface SnapshotInput {
  file: string;
  coin: string;
  tsMs: number;
  spot: number | null;
  open1h: number | null;
  open15m: number | null;
  open5m: number | null;
}

const MIN_MS = 60_000;
const BARS_BACK_MIN = 1030;
const LIVE_TIMEOUT_MS = 10_000;
const PATH_HISTORY = 60; // context prices kept in a saved path (what the TFM tab draws)

const posNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/**
 * Reads a history snapshot file (parsed JSON). Null without a valid timestamp or a coin (the content's `coin`,
 * else the file name prefix, upper case). Legacy snapshots have no price fields: those are null.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function snapshotInputOf(file: string, content: any): SnapshotInput | null {
  if (!content || typeof content !== 'object') return null;
  const tsMs = typeof content.timestamp === 'string' ? Date.parse(content.timestamp) : NaN;
  if (!Number.isFinite(tsMs)) return null;
  let coin = typeof content.coin === 'string' ? content.coin.trim().toUpperCase() : '';
  if (!coin) coin = file.replace(/^CL-/, '').split('_')[0].toUpperCase();
  if (!coin) return null;
  const mi = content.model_inputs && typeof content.model_inputs === 'object' ? content.model_inputs : {};
  return {
    file,
    coin,
    tsMs,
    spot: posNum(content.spot_price),
    open1h: posNum(content.open_price),
    open15m: posNum(mi.sa),
    open5m: posNum(mi.sa5),
  };
}

/** Fewest points a series needs to be forecast: TFM_MIN_CONTEXT, or the whole context when that is shorter. */
export function minContextFor(context: number): number {
  return Math.min(TFM_MIN_CONTEXT, context);
}

/**
 * One forecast per input, computed only from bars that had closed by the input's time plus its own spot price.
 * `barsOf` gets the lower-case coin (a key of TFM_SYMBOLS). Inputs with fewer than TFM_MIN_CONTEXT points are
 * left out. Returns [] when the service gives nothing usable.
 */
export async function forecastSnapshots(
  inputs: SnapshotInput[],
  barsOf: (coin: string) => MinuteBar[],
  source: 'live' | 'backfill',
  forecast: typeof tfmForecast = tfmForecast,
  onPath?: (path: TfmPathRecord) => void,
  context: number = TFM_MAX_CONTEXT, // 1-minute points sent to the model (backfill --context); live is always the default
): Promise<TfmRecord[]> {
  const items: { input: SnapshotInput; bars: MinuteBar[]; series: number[] }[] = [];
  const minPoints = minContextFor(context);
  for (const input of inputs) {
    const bars = barsOf(input.coin.toLowerCase());
    const series = contextAsOf(bars, input.tsMs, input.spot, context);
    if (series.length >= minPoints) items.push({ input, bars, series });
  }
  if (items.length === 0) return [];
  const res = await forecast(items.map((i) => i.series), TFM_HORIZON);
  if (!res || res.quantiles.length !== items.length) return [];

  const out: TfmRecord[] = [];
  items.forEach(({ input, bars, series }, idx) => {
    const quantiles = res.quantiles[idx];
    const last = series[series.length - 1];
    if (onPath) {
      onPath({
        file: input.file,
        coin: input.coin.toUpperCase(),
        ts: new Date(input.tsMs).toISOString(),
        model: res.model,
        last: roundSig(last),
        history: series.slice(-PATH_HISTORY).map(roundSig),
        mean: (res.mean[idx] ?? []).map(roundSig),
        q: quantiles.map((row) => row.map(roundSig)),
      });
    }
    const w = windowsAt(input.tsMs);
    const given: Record<TfmWindowKey, number | null> = { h1: input.open1h, m15: input.open15m, m5: input.open5m };
    const win = (k: TfmWindowKey): TfmWindowForecast | null => {
      const open = given[k] ?? openAt(bars, w[k].startMs);
      if (open === null || !(open > 0)) return null;
      return windowForecast({ open, last, minutesLeft: w[k].minutesLeft, quantiles });
    };
    out.push({
      file: input.file,
      coin: input.coin.toUpperCase(),
      ts: new Date(input.tsMs).toISOString(),
      model: res.model,
      context: series.length,
      last,
      h1: win('h1'),
      m15: win('m15'),
      m5: win('m5'),
      source,
    });
  });
  return out;
}

/**
 * Forecast one freshly saved snapshot and append it to the store. Never throws and never takes longer than 10 s:
 * returns 'skipped' when the service is not up, the snapshot is not usable, or anything fails.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function recordTfmForSnapshot(file: string, content: any): Promise<'saved' | 'skipped'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  try {
    const input = snapshotInputOf(file, content);
    if (!input) return 'skipped';
    const work = async (): Promise<'saved' | 'skipped'> => {
      // 'starting' also starts the service (once), so a collector that began before it still gets forecasts on the next snapshots
      if ((await ensureTfmService()) !== 'ready') return 'skipped';
      const bars = await fetchMinuteBars(input.coin, input.tsMs - BARS_BACK_MIN * MIN_MS, input.tsMs);
      if (cancelled) return 'skipped';
      const paths: TfmPathRecord[] = [];
      const records = await forecastSnapshots([input], () => bars, 'live', tfmForecast, (p) => paths.push(p));
      if (cancelled || records.length === 0) return 'skipped';
      appendTfmRecords(records);
      // the full price path of the TFM tab, kept for later study of how the forecast behaved (jev/tfm/paths/)
      for (const p of paths) appendTfmPath(p);
      return 'saved';
    };
    const timeout = new Promise<'skipped'>((resolve) => {
      timer = setTimeout(() => {
        cancelled = true;
        resolve('skipped');
      }, LIVE_TIMEOUT_MS);
    });
    return await Promise.race([work().catch((): 'skipped' => 'skipped'), timeout]);
  } catch {
    return 'skipped';
  } finally {
    if (timer) clearTimeout(timer);
  }
}
