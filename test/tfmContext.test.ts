import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { appendTfmRecords, listTfmContexts, loadTfmStore, tfmContextOf, tfmStorePath } from '@/lib/tfm/store';
import { forecastSnapshots, minContextFor, type SnapshotInput } from '@/lib/tfm/snapshot';
import type { MinuteBar, TfmRecord } from '@/lib/tfm/types';

const rec = (file: string, p: number, context = 1024): TfmRecord => ({
  file, coin: 'BTC', ts: '2026-10-02T14:00:00.000Z', model: 'google/timesfm-3.0-pytorch', context, last: 100,
  h1: { open: 99, minutesLeft: 20, probUp: p, median: 100.05, q10: 99.5, q90: 100.6 },
  m15: null, m5: null, source: 'backfill',
});

describe('tfm context stores', () => {
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tfm-ctx-'));
    vi.spyOn(process, 'cwd').mockReturnValue(root);
  });
  afterAll(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps the live store name for 1024 and gives other contexts their own file', () => {
    const dir = path.join(root, 'jev', 'tfm');
    expect(tfmStorePath('timesfm-3.0')).toBe(path.join(dir, 'forecasts-timesfm-3.0.jsonl'));
    expect(tfmStorePath('timesfm-3.0', 1024)).toBe(path.join(dir, 'forecasts-timesfm-3.0.jsonl'));
    expect(tfmStorePath('timesfm-3.0', 512)).toBe(path.join(dir, 'forecasts-timesfm-3.0-ctx512.jsonl'));
  });

  it('writes and reads each context separately, and lists the contexts that exist', () => {
    expect(listTfmContexts('timesfm-3.0')).toEqual([]);
    appendTfmRecords([rec('a.json', 0.8)]);
    appendTfmRecords([rec('a.json', 0.3, 512)], 512);
    appendTfmRecords([rec('a.json', 0.6, 2048)], 2048);
    expect(loadTfmStore('timesfm-3.0').get('a.json')!.h1!.probUp).toBe(0.8);
    expect(loadTfmStore('timesfm-3.0', 512).get('a.json')!.h1!.probUp).toBe(0.3);
    expect(loadTfmStore('timesfm-3.0', 2048).get('a.json')!.h1!.probUp).toBe(0.6);
    fs.writeFileSync(path.join(root, 'jev', 'tfm', 'forecasts-timesfm-3.0-ctxabc.jsonl'), '');
    expect(listTfmContexts('timesfm-3.0')).toEqual([512, 1024, 2048]);
    expect(listTfmContexts('timesfm-2.5')).toEqual([]);
  });

  it('accepts only whole context lengths from 32 to 16384', () => {
    expect(tfmContextOf('512')).toBe(512);
    expect(tfmContextOf(2048)).toBe(2048);
    for (const bad of ['', 'x', '31', '16385', '512.5', null, undefined, -1]) expect(tfmContextOf(bad)).toBeNull();
  });
});

describe('forecastSnapshots context', () => {
  const T = Date.parse('2026-11-05T19:34:28.881Z');
  const MIN = 60_000;
  const BASE = Math.floor(T / MIN) * MIN - 3000 * MIN;
  const bars: MinuteBar[] = Array.from({ length: 3100 }, (_, m) => ({ openTime: BASE + m * MIN, close: 50000 + m, open: 50000 + m }));
  const input: SnapshotInput = { file: 'a.json', coin: 'btc', tsMs: T, spot: 51234, open1h: 51000, open15m: null, open5m: null };
  const fake = () => {
    const lens: number[] = [];
    const fn = async (series: number[][], horizon: number) => {
      for (const s of series) lens.push(s.length);
      return { model: 'fake', mean: series.map(() => Array(horizon).fill(1)), quantiles: series.map((s) => Array.from({ length: horizon }, () => Array(9).fill(s[s.length - 1]))) };
    };
    return { lens, fn };
  };

  it('sends 1024 points by default and the chosen length otherwise', async () => {
    for (const [ctx, want] of [[undefined, 1024], [512, 512], [2048, 2048], [64, 64]] as const) {
      const f = fake();
      const out = await forecastSnapshots([input], () => bars, 'backfill', f.fn, undefined, ctx);
      expect(f.lens).toEqual([want]);
      expect(out[0].context).toBe(want);
    }
  });

  it('needs at least 256 points, or the whole context when it is shorter', async () => {
    expect(minContextFor(1024)).toBe(256);
    expect(minContextFor(64)).toBe(64);
    const short = bars.slice(-(Math.ceil((BASE + 3100 * MIN - T) / MIN) + 100)); // about 100 closed bars before T
    const f = fake();
    expect(await forecastSnapshots([input], () => short, 'backfill', f.fn, undefined, 1024)).toEqual([]);
    expect((await forecastSnapshots([input], () => short, 'backfill', f.fn, undefined, 64)).length).toBe(1);
  });
});
