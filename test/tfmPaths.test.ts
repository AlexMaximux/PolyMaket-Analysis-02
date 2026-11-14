import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { normInv } from '@/lib/normal';
import { forecastSnapshots, type SnapshotInput } from '@/lib/tfm/snapshot';
import { appendTfmPath, roundSig, tfmPathFile, type TfmPathRecord } from '@/lib/tfm/paths';
import { TFM_QUANTILE_LEVELS, type MinuteBar } from '@/lib/tfm/types';

const Z = TFM_QUANTILE_LEVELS.map((q) => normInv(q));
const deciles = (last: number, sigma: number) => Z.map((z) => last * Math.exp(sigma * z));

const T = Date.parse('2026-11-05T19:34:28.881Z');
const MIN = 60_000;
const BASE = Math.floor(T / MIN) * MIN - 1500 * MIN;
const bars: MinuteBar[] = Array.from({ length: 2000 }, (_, m) => ({ openTime: BASE + m * MIN, close: 50000 + m, open: 50000 + m - 0.5 }));
const input: SnapshotInput = { file: 'a.json', coin: 'btc', tsMs: T, spot: 51234.123456789, open1h: 51000, open15m: 51100, open5m: 51200 };

const fn = async (series: number[][], horizon: number) => ({
  model: 'fake-model',
  mean: series.map((s) => Array(horizon).fill(s[s.length - 1])),
  quantiles: series.map((s) => Array.from({ length: horizon }, (_, k) => deciles(s[s.length - 1], 0.0005 * Math.sqrt(k + 1)))),
});

describe('roundSig', () => {
  it('keeps 7 significant digits for large and small prices', () => {
    expect(roundSig(74105.06123456)).toBe(74105.06);
    expect(roundSig(0.1523456789)).toBe(0.1523457);
    expect(roundSig(0)).toBe(0);
  });
});

describe('forecastSnapshots onPath', () => {
  it('hands over the 60-step path and the last 60 context prices of each forecast', async () => {
    const got: TfmPathRecord[] = [];
    const out = await forecastSnapshots([input], () => bars, 'live', fn, (p) => got.push(p));
    expect(out).toHaveLength(1);
    expect(got).toHaveLength(1);
    const p = got[0];
    expect(p).toMatchObject({ file: 'a.json', coin: 'BTC', ts: new Date(T).toISOString(), model: 'fake-model' });
    expect(p.last).toBe(roundSig(51234.123456789));
    expect(p.history).toHaveLength(60);
    expect(p.history[59]).toBe(p.last);
    expect(p.mean).toHaveLength(60);
    expect(p.q).toHaveLength(60);
    expect(p.q.every((row) => row.length === 9)).toBe(true);
    expect(p.q[0][4]).toBeCloseTo(51234.12, 1);
  });
  it('gives no path when the service gives nothing', async () => {
    const got: TfmPathRecord[] = [];
    await forecastSnapshots([input], () => bars, 'live', async () => null, (p) => got.push(p));
    expect(got).toEqual([]);
  });
});

describe('appendTfmPath', () => {
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tfm-paths-test-'));
    vi.spyOn(process, 'cwd').mockReturnValue(root);
  });
  afterAll(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('writes to jev/tfm/paths/<coin>-<UTC day>.jsonl, one line per record', async () => {
    const got: TfmPathRecord[] = [];
    await forecastSnapshots([input], () => bars, 'live', fn, (p) => got.push(p));
    appendTfmPath(got[0]);
    appendTfmPath({ ...got[0], file: 'b.json' });
    const file = tfmPathFile('btc', '2026-11-05');
    expect(file).toBe(path.join(root, 'jev', 'tfm', 'paths', 'btc-2026-11-05.jsonl'));
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]).file).toBe('b.json');
    expect(JSON.parse(lines[0]).q).toHaveLength(60);
  });
});
