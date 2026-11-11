import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { appendTfmRecords, loadTfmStore, tfmRowFields, tfmStorePath } from '@/lib/tfm/store';
import type { TfmRecord } from '@/lib/tfm/types';

const rec = (file: string, p: number): TfmRecord => ({
  file, coin: 'BTC', ts: '2026-10-02T14:00:00.000Z', model: 'm', context: 1024, last: 100,
  h1: { open: 99, minutesLeft: 20, probUp: p, median: 100.05, q10: 99.5, q90: 100.6 },
  m15: { open: 99, minutesLeft: 5, probUp: 0.6, median: 100, q10: 99.8, q90: 100.2 },
  m5: null, source: 'backfill',
});

describe('tfm store', () => {
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tfm-store-'));
    vi.spyOn(process, 'cwd').mockReturnValue(root);
  });
  afterAll(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('points at jev/tfm/forecasts-<key>.jsonl under the working directory', () => {
    expect(tfmStorePath()).toBe(path.join(root, 'jev', 'tfm', 'forecasts-timesfm-3.0.jsonl'));
    expect(tfmStorePath('timesfm-2.5')).toBe(path.join(root, 'jev', 'tfm', 'forecasts-timesfm-2.5.jsonl'));
    expect(tfmStorePath('timesfm-3.0')).toBe(path.join(root, 'jev', 'tfm', 'forecasts-timesfm-3.0.jsonl'));
  });

  it('reads a missing file as an empty store', () => {
    expect(loadTfmStore().size).toBe(0);
    expect(loadTfmStore('timesfm-2.5').size).toBe(0);
  });

  it('appends, lets the last line for a file win, and skips a half-written last line', () => {
    appendTfmRecords([rec('a.json', 0.8126), rec('b.json', 0.3)]);
    expect(loadTfmStore().size).toBe(2);

    appendTfmRecords([rec('a.json', 0.9)]);
    const store = loadTfmStore();
    expect(store.get('a.json')!.h1!.probUp).toBe(0.9);
    expect(store.size).toBe(2);

    fs.appendFileSync(tfmStorePath(), '{"file":"c.json","coin');
    expect(() => loadTfmStore()).not.toThrow();
    expect(loadTfmStore().size).toBe(2);

    // a record appended after a torn line is not glued onto it
    appendTfmRecords([rec('d.json', 0.55)]);
    expect(loadTfmStore().size).toBe(3);
    expect(loadTfmStore().get('d.json')!.h1!.probUp).toBe(0.55);
  });

  it('stores records per model and keeps them isolated', () => {
    const r25: TfmRecord = {
      ...rec('m25.json', 0.4),
      model: 'google/timesfm-2.5-200m-pytorch',
    };
    const r30: TfmRecord = {
      ...rec('m30.json', 0.7),
      model: 'google/timesfm-3.0-pytorch',
    };
    appendTfmRecords([r25, r30]);

    expect(fs.existsSync(path.join(root, 'jev', 'tfm', 'forecasts-timesfm-2.5.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'jev', 'tfm', 'forecasts-timesfm-3.0.jsonl'))).toBe(true);

    const store25 = loadTfmStore('timesfm-2.5');
    const store30 = loadTfmStore(); // active = timesfm-3.0

    expect(store25.has('m25.json')).toBe(true);
    expect(store25.has('m30.json')).toBe(false);

    expect(store30.has('m30.json')).toBe(true);
    expect(store30.has('m25.json')).toBe(false);
  });
});

describe('tfmRowFields', () => {
  it('turns a record into the nine row fields plus fair_tfm', () => {
    expect(tfmRowFields(rec('a.json', 0.8126))).toEqual({
      tfm_direction: 'UP', tfm_score: 3.25, tfm_prob_up: 81.3,
      tfm_score_confidence: 81, tfm_direction_confidence: 81, tfm_confidence: 81,
      tfm_up_15m: 60, tfm_up_5m: null, tfm_ret_1h: 0.05, fair_tfm: 81.3,
    });
  });
  it('calls a probability under 0.5 DOWN with the confidence of the down side', () => {
    const f = tfmRowFields(rec('b.json', 0.3));
    expect(f.tfm_direction).toBe('DOWN');
    expect(f.tfm_score).toBe(1.2);
    expect(f.tfm_prob_up).toBe(30);
    expect(f.fair_tfm).toBe(30);
    expect(f.tfm_confidence).toBe(70);
  });
  it('gives null for every field without a record, and null 1H fields without h1', () => {
    expect(Object.values(tfmRowFields(undefined)).every((v) => v === null)).toBe(true);
    expect(Object.keys(tfmRowFields(undefined))).toHaveLength(10);
    const f = tfmRowFields({ ...rec('c.json', 0.6), h1: null });
    expect(f.tfm_prob_up).toBeNull();
    expect(f.fair_tfm).toBeNull();
    expect(f.tfm_direction).toBeNull();
    expect(f.tfm_ret_1h).toBeNull();
    expect(f.tfm_up_15m).toBe(60);
  });
});
