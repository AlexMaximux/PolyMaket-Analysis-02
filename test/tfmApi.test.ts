import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { normInv } from '@/lib/normal';
import { TFM_QUANTILE_LEVELS, type MinuteBar } from '@/lib/tfm/types';

const Z = TFM_QUANTILE_LEVELS.map((q) => normInv(q));
const deciles = (last: number, sigma: number) => Z.map((z) => last * Math.exp(sigma * z));

const MIN = 60_000;
const mkBars = (n: number): MinuteBar[] => {
  const end = Math.floor(Date.now() / MIN) * MIN; // the newest bar is the current minute
  return Array.from({ length: n }, (_, i) => {
    const m = n - 1 - i;
    const close = 76000 + Math.sin(i / 30) * 50;
    return { openTime: end - m * MIN, open: close - 1, close };
  });
};

const mocks = vi.hoisted(() => ({
  fetchMinuteBars: vi.fn(),
  ensureTfmService: vi.fn(),
  tfmForecast: vi.fn(),
}));

vi.mock('@/lib/tfm/klines', async (orig) => ({ ...(await orig<typeof import('@/lib/tfm/klines')>()), fetchMinuteBars: mocks.fetchMinuteBars }));
vi.mock('@/lib/tfm/service', () => ({ ensureTfmService: mocks.ensureTfmService, resetTfmServiceForTests: () => {} }));
vi.mock('@/lib/tfm/client', () => ({ tfmForecast: mocks.tfmForecast, tfmHealth: async () => ({ ok: true }), TFM_URL: 'http://x' }));

import { GET } from '@/app/api/updown/tfm/route';
import { resetTfmLiveCacheForTests, tfmLivePath } from '@/lib/tfm/live';

const fakeForecast = async (series: number[][], horizon: number) => ({
  model: 'fake-model',
  mean: series.map((s) => Array(horizon).fill(s[s.length - 1])),
  quantiles: series.map((s) => Array.from({ length: horizon }, (_, k) => deciles(s[s.length - 1], 0.0005 * Math.sqrt(k + 1)))),
});

const get = async (qs: string) => {
  const res = await GET(new Request(`http://x/api/updown/tfm${qs}`) as never);
  return { status: res.status, json: await res.json() };
};

beforeEach(() => {
  resetTfmLiveCacheForTests();
  mocks.fetchMinuteBars.mockReset().mockImplementation(async () => mkBars(1000));
  mocks.ensureTfmService.mockReset().mockResolvedValue('ready');
  mocks.tfmForecast.mockReset().mockImplementation(fakeForecast);
});

describe('/api/updown/tfm', () => {
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tfm-api-test-'));
    vi.spyOn(process, 'cwd').mockReturnValue(root);
  });
  afterAll(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('tfmLivePath points to <cwd>/jev/tfm/live/<coin>-<day>.jsonl', () => {
    expect(tfmLivePath('btc', '2026-11-10')).toBe(path.join(root, 'jev', 'tfm', 'live', 'btc-2026-11-10.jsonl'));
    expect(tfmLivePath('ETH', '2026-11-10')).toBe(path.join(root, 'jev', 'tfm', 'live', 'eth-2026-11-10.jsonl'));
  });

  it('answers a ready service with windows, the path, history and track', async () => {
    const { status, json } = await get('?coin=btc');
    expect(status).toBe(200);
    expect(json.coin).toBe('btc');
    expect(json.service.ok).toBe(true);
    expect(json.service.state).toBe('ready');
    expect(json.service.model).toBe('fake-model');
    expect(typeof json.service.latencyMs).toBe('number');
    expect(json.path).toHaveLength(60);
    expect(json.path[0].q).toHaveLength(9);
    expect(json.history).toHaveLength(60);
    expect(json.context).toBeGreaterThanOrEqual(256);
    expect(json.windows.h1.probUp).toBeGreaterThan(0);
    expect(json.windows.h1.probUp).toBeLessThan(1);
    expect(json.windows.m5.endSec % 300).toBe(0);
    expect(json.windows.m15.endSec % 900).toBe(0);
    expect(json.windows.h1.endSec % 3600).toBe(0);
    expect(Array.isArray(json.track)).toBe(true);
    expect(json.track.length).toBeGreaterThanOrEqual(1);
    expect(mocks.tfmForecast).toHaveBeenCalledTimes(1);
    expect(mocks.tfmForecast.mock.calls[0][1]).toBe(60);
  });

  it('appends a line to today live file on fresh computation, but not on second call within cache', async () => {
    resetTfmLiveCacheForTests();
    const today = new Date().toISOString().slice(0, 10);
    const liveFile = tfmLivePath('btc', today);
    if (fs.existsSync(liveFile)) fs.unlinkSync(liveFile);

    const { json: first } = await get('?coin=btc');
    expect(first.service.ok).toBe(true);
    expect(fs.existsSync(liveFile)).toBe(true);

    const linesAfterFirst = fs.readFileSync(liveFile, 'utf8').trim().split('\n');
    expect(linesAfterFirst).toHaveLength(1);
    const parsed = JSON.parse(linesAfterFirst[0]);
    expect(typeof parsed.ts).toBe('number');
    expect(parsed.model).toBe('fake-model');
    expect(typeof parsed.last).toBe('number');
    expect(parsed.h1).toBeDefined();
    expect(typeof parsed.h1.probUp).toBe('number');

    // Second call within cache time (25 s) should not append
    await get('?coin=btc');
    const linesAfterSecond = fs.readFileSync(liveFile, 'utf8').trim().split('\n');
    expect(linesAfterSecond).toHaveLength(1);
  });

  it('filters track to current hour only, oldest first, at most 240 points', async () => {
    resetTfmLiveCacheForTests();
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    const liveFile = tfmLivePath('btc', today);
    fs.mkdirSync(path.dirname(liveFile), { recursive: true });

    const hourStartMs = Math.floor(now / 3600_000) * 3600_000;
    const prevHourMs = hourStartMs - 30 * 60_000;
    const currHourMs = hourStartMs + 5 * 60_000;

    const mkLine = (ts: number, p: number) => JSON.stringify({
      ts,
      model: 'fake-model',
      last: 100,
      h1: { open: 100, minutesLeft: 10, probUp: p, median: 100, q10: 99, q90: 101 },
      m15: { open: 100, minutesLeft: 5, probUp: 0.7, median: 100, q10: 99, q90: 101 },
      m5: null,
    });

    fs.writeFileSync(liveFile, [mkLine(prevHourMs, 0.4), mkLine(currHourMs, 0.65)].join('\n') + '\n', 'utf8');

    const { json } = await get('?coin=btc');
    expect(json.track).toHaveLength(2); // currHourMs and the freshly computed point
    expect(json.track[0].t).toBe(Math.floor(currHourMs / 1000));
    expect(json.track[0].h1).toBe(0.65);
    expect(json.track[0].m15).toBe(0.7);
    expect(json.track[1].t).toBeGreaterThanOrEqual(Math.floor(now / 1000));
  });

  it('swallows write errors on unwritable live folder and returns valid response', async () => {
    resetTfmLiveCacheForTests();
    // Create 'doge' file directory as an unwritable obstacle or read-only file where dir should be
    const today = new Date().toISOString().slice(0, 10);
    const dogePath = tfmLivePath('doge', today);
    fs.mkdirSync(path.dirname(dogePath), { recursive: true });
    // Make a file where the directory or file would be in an unwritable state
    // Create a directory named doge-<today>.jsonl so appendFileSync fails with EISDIR
    if (fs.existsSync(dogePath)) fs.unlinkSync(dogePath);
    fs.mkdirSync(dogePath);

    const { status, json } = await get('?coin=doge');
    expect(status).toBe(200);
    expect(json.service.ok).toBe(true);
    expect(Array.isArray(json.track)).toBe(true);

    // Clean up
    fs.rmdirSync(dogePath);
  });

  it('makes one forecast for several callers within 10 seconds', async () => {
    await Promise.all([get('?coin=btc'), get('?coin=btc')]);
    await get('?coin=btc');
    expect(mocks.tfmForecast).toHaveBeenCalledTimes(1);
  });

  it('answers 200 with service.ok false when the service is not installed, and does not forecast', async () => {
    mocks.ensureTfmService.mockResolvedValue('not-installed');
    const { status, json } = await get('?coin=btc');
    expect(status).toBe(200);
    expect(json.service.ok).toBe(false);
    expect(json.service.state).toBe('not-installed');
    expect(json.windows).toBeNull();
    expect(json.path).toBeNull();
    expect(mocks.tfmForecast).not.toHaveBeenCalled();
  });

  it('answers service.ok false with state offline when the forecast fails', async () => {
    mocks.tfmForecast.mockResolvedValue(null);
    const { status, json } = await get('?coin=btc');
    expect(status).toBe(200);
    expect(json.service.ok).toBe(false);
    expect(json.service.state).toBe('offline');
    expect(json.windows).toBeNull();
  });

  it('answers 400 for an unknown coin', async () => {
    const { status, json } = await get('?coin=zzz');
    expect(status).toBe(400);
    expect(json).toEqual({ error: 'unknown coin' });
  });
});
