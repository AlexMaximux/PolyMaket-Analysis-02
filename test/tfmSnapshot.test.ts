import { describe, it, expect } from 'vitest';
import { normInv } from '@/lib/normal';
import { forecastSnapshots, snapshotInputOf, type SnapshotInput } from '@/lib/tfm/snapshot';
import { openAt } from '@/lib/tfm/series';
import { TFM_QUANTILE_LEVELS, type MinuteBar } from '@/lib/tfm/types';

const Z = TFM_QUANTILE_LEVELS.map((q) => normInv(q));
const deciles = (last: number, sigma: number) => Z.map((z) => last * Math.exp(sigma * z));

const T = Date.parse('2026-11-05T19:34:28.881Z');
const MIN = 60_000;
const BASE = Math.floor(T / MIN) * MIN - 1500 * MIN; // bar m opens at BASE + m minutes; 2000 bars end after T
const mkBars = (n: number): MinuteBar[] =>
  Array.from({ length: n }, (_, m) => ({ openTime: BASE + m * MIN, close: 50000 + m, open: 50000 + m - 0.5 }));
const bars = mkBars(2000);

const fakeForecast = () => {
  const calls: { series: number[][]; horizon: number }[] = [];
  const fn = async (series: number[][], horizon: number) => {
    calls.push({ series, horizon });
    return {
      model: 'fake-model',
      mean: series.map((s) => Array(horizon).fill(s[s.length - 1])),
      quantiles: series.map((s) => Array.from({ length: horizon }, (_, k) => deciles(s[s.length - 1], 0.0005 * Math.sqrt(k + 1)))),
    };
  };
  return { calls, fn };
};

const full: SnapshotInput = { file: 'a.json', coin: 'btc', tsMs: T, spot: 51234, open1h: 51000, open15m: 51100, open5m: 51200 };
const legacy: SnapshotInput = { file: 'b.json', coin: 'BTC', tsMs: T, spot: null, open1h: null, open15m: null, open5m: null };

describe('snapshotInputOf', () => {
  it('reads the snapshot fields', () => {
    expect(snapshotInputOf('btc_updown_x.json', {
      timestamp: '2026-11-05T19:34:28.881Z', coin: 'BTC', spot_price: 76142, open_price: 76090.01,
      model_inputs: { sa: 76034.01, sa5: 76030 },
    })).toEqual({
      file: 'btc_updown_x.json', coin: 'BTC', tsMs: Date.parse('2026-11-05T19:34:28.881Z'),
      spot: 76142, open1h: 76090.01, open15m: 76034.01, open5m: 76030,
    });
  });
  it('gives null without a timestamp', () => {
    expect(snapshotInputOf('btc_updown_x.json', { coin: 'BTC' })).toBeNull();
    expect(snapshotInputOf('btc_updown_x.json', { timestamp: 'nope', coin: 'BTC' })).toBeNull();
  });
  it('takes the coin from the file name prefix in upper case when the content has none', () => {
    const r = snapshotInputOf('eth_updown_x.json', { timestamp: '2026-11-05T19:34:28.881Z' });
    expect(r?.coin).toBe('ETH');
    expect(r?.spot).toBeNull();
    expect(r?.open1h).toBeNull();
    expect(r?.open15m).toBeNull();
    expect(r?.open5m).toBeNull();
  });
});

describe('forecastSnapshots', () => {
  it('forecasts a batch with one call and keeps the snapshot time as the cut-off', async () => {
    const f = fakeForecast();
    const out = await forecastSnapshots([full, legacy], () => bars, 'backfill', f.fn);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].series).toHaveLength(2);
    expect(f.calls[0].horizon).toBe(60);
    const [s0, s1] = f.calls[0].series;
    expect(s0[s0.length - 1]).toBe(51234); // the spot
    const lastClosedIdx = Math.floor(T / MIN) - BASE / MIN - 1; // bar before the one that contains T
    expect(s1[s1.length - 1]).toBe(50000 + lastClosedIdx);
    expect(s1).not.toContain(50000 + lastClosedIdx + 1); // the bar that contains T is not in the context

    expect(out).toHaveLength(2);
    const [r0, r1] = out;
    expect(r0).toMatchObject({ file: 'a.json', coin: 'BTC', ts: new Date(T).toISOString(), source: 'backfill', model: 'fake-model', context: s0.length, last: 51234 });
    expect(r1).toMatchObject({ file: 'b.json', coin: 'BTC', ts: new Date(T).toISOString(), source: 'backfill', model: 'fake-model', context: s1.length, last: 50000 + lastClosedIdx });
    expect(r0.h1!.open).toBe(51000);
    expect(r0.m15!.open).toBe(51100);
    expect(r0.m5!.open).toBe(51200);
    // legacy: opens come from the kline opens
    const hourStart = Date.parse('2026-11-05T19:00:00.000Z');
    expect(r1.h1!.open).toBe(openAt(bars, hourStart));
    expect(r1.m15!.open).toBe(openAt(bars, Date.parse('2026-11-05T19:30:00.000Z')));
    expect(r1.m5!.open).toBe(openAt(bars, Date.parse('2026-11-05T19:30:00.000Z')));
    expect(r1.h1!.open).not.toBeNull();
    expect(r0.h1!.probUp).toBeGreaterThan(0);
    expect(r0.h1!.probUp).toBeLessThan(1);
  });

  it('leaves out a snapshot whose context has fewer than 256 points', async () => {
    const f = fakeForecast();
    const short: SnapshotInput = { ...full, file: 's.json', coin: 'eth' };
    const out = await forecastSnapshots([short, full], (coin) => (coin.toLowerCase() === 'eth' ? mkBars(1520).slice(0, 100) : bars), 'live', f.fn);
    expect(f.calls[0].series).toHaveLength(1);
    expect(out.map((r) => r.file)).toEqual(['a.json']);
    expect(out[0].source).toBe('live');
  });

  it('gives [] when the service gives nothing', async () => {
    const out = await forecastSnapshots([full], () => bars, 'live', async () => null);
    expect(out).toEqual([]);
  });

  it('does not call the service when nothing is long enough', async () => {
    const f = fakeForecast();
    const out = await forecastSnapshots([full], () => [], 'live', f.fn);
    expect(out).toEqual([]);
    expect(f.calls).toHaveLength(0);
  });
});
