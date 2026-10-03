import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { claudeFairUp, volWindowsFromKlines } from '@/lib/claudeModel';
import { buildClRecord, claudeModelAt, clFilename, reconstructPrices, saveClRecord } from '@/lib/clSnapshot';

const FILE = 'btc_updown_2026-10-02_12-45-00_ET.json';

function snapshot(over: Record<string, unknown> = {}) {
  return {
    et_time: '2026-10-02 12:45:00 ET',
    date_et: '2026-10-02',
    current_time_et: '12:45:00 PM',
    current_time_et_24h: '12:45:00',
    timestamp: '2026-10-02T16:45:00.000Z',
    coin: 'BTC',
    coin_label: 'Bitcoin',
    spot_price: 86500,
    open_price: 86300,
    price_to_beat: 86300,
    cards: { '1h': { slug: 'bitcoin-up-or-down-october-2-2026-12pm-et', up: 0.78, down: 0.22 }, '15m': null, '5m': null },
    fair_values: { model_15m: 0.8, model_5m: 0.81, base_no_drift: 0.79, joint_solve: null },
    model_inputs: { model_version: 'x', t: 45, s0: 86300, st: 86500 },
    books: { '1h': { bid: 0.77, ask: 0.79 }, '15m': null },
    claude_model: { version: 'v-test', fairUp: 0.812345678, fairDown: 0.187654322, x: 0.0023, t: 45, z: 1.1, W: 12.1, sigma1h: 0.003, edge: 0.03 },
    ...over,
  };
}

describe('clFilename', () => {
  it('puts CL- in front of the original name and keeps the timestamp', () => {
    expect(clFilename(FILE)).toBe(`CL-${FILE}`);
  });
  it('is idempotent', () => {
    expect(clFilename(clFilename(FILE))).toBe(`CL-${FILE}`);
  });
});

describe('buildClRecord', () => {
  it('returns null when the Claude model had no value for this snapshot', () => {
    expect(buildClRecord(snapshot({ claude_model: null }), FILE)).toBeNull();
    expect(buildClRecord(snapshot({ claude_model: undefined }), FILE)).toBeNull();
    expect(buildClRecord(snapshot({ claude_model: { fairUp: NaN } }), FILE)).toBeNull();
  });

  it('keeps the old fair values and adds claude beside them, rounded to 4 decimals', () => {
    const r = buildClRecord(snapshot(), FILE)!;
    expect(r.fair_values).toEqual({ model_15m: 0.8, model_5m: 0.81, base_no_drift: 0.79, joint_solve: null, claude: 0.8123 });
  });

  it('carries everything a later backtest or LLM replay needs, and points back to the original file', () => {
    const s = snapshot();
    const r = buildClRecord(s, FILE)!;
    expect(r.source_file).toBe(FILE);
    for (const k of ['et_time', 'date_et', 'current_time_et', 'current_time_et_24h', 'timestamp', 'coin', 'coin_label', 'spot_price', 'open_price', 'price_to_beat', 'cards', 'model_inputs', 'books', 'claude_model']) {
      expect(r[k]).toEqual((s as Record<string, unknown>)[k]);
    }
  });

  it('has no predictions yet: the models are asked later, so nothing old is passed off as new', () => {
    const r = buildClRecord(snapshot(), FILE)!;
    expect(r.prediction).toBeNull();
    expect(r.predictions).toBeNull();
  });

  it('does not modify the snapshot it is given (the original record must stay as it was)', () => {
    const s = snapshot();
    const before = JSON.stringify(s);
    buildClRecord(s, FILE);
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe('saveClRecord', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-test-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes CL-<name> into the folder, creating it when missing', () => {
    const target = path.join(dir, 'nested', 'cl');
    const res = saveClRecord(snapshot(), FILE, target);
    expect(res).toEqual({ filename: `CL-${FILE}`, written: true });
    const saved = JSON.parse(fs.readFileSync(path.join(target, `CL-${FILE}`), 'utf8'));
    expect(saved).toEqual(JSON.parse(JSON.stringify(buildClRecord(snapshot(), FILE))));
  });

  it('never overwrites a file that already exists', () => {
    saveClRecord(snapshot(), FILE, dir);
    const first = fs.readFileSync(path.join(dir, `CL-${FILE}`), 'utf8');
    const res = saveClRecord(snapshot({ spot_price: 1 }), FILE, dir);
    expect(res.written).toBe(false);
    expect(fs.readFileSync(path.join(dir, `CL-${FILE}`), 'utf8')).toBe(first);
  });

  it('writes nothing when there is no Claude value', () => {
    const res = saveClRecord(snapshot({ claude_model: null }), FILE, dir);
    expect(res.written).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

// bar i opens at base + i minutes; closed when closeTime < now
const BASE = Date.parse('2026-10-02T00:00:00Z');
const klines = (rets: number[]) =>
  rets.map((r, i) => [BASE + i * 60_000, '100', '101', '99', String(100 * Math.exp(r)), '1', BASE + (i + 1) * 60_000 - 1]);
const rets = Array.from({ length: 1300 }, (_, i) => 0.0002 * (1 + (i % 5)));

describe('claudeModelAt (backfill for an old snapshot)', () => {
  // snapshot taken 1100 minutes after BASE + 20 s, i.e. 18:20:20 UTC: 1100 bars are closed
  const tsMs = BASE + 1100 * 60_000 + 20_000;
  const record = (over: Record<string, unknown> = {}) => ({
    timestamp: new Date(tsMs).toISOString(),
    spot_price: 86500,
    open_price: 86300,
    cards: { '1h': { up: 0.78 } },
    model_inputs: { t: 20.3 },
    ...over,
  });

  it('gives the same answer the live model would: same x, t and the last closed bars before the snapshot', () => {
    const kl = klines(rets);
    const got = claudeModelAt(record(), kl)!;
    const vol = volWindowsFromKlines(kl, tsMs)!;
    const want = claudeFairUp({ x: Math.log(86500 / 86300), t: 20.3, vol });
    expect(got.fairUp).toBeCloseTo(want.fairUp, 12);
    expect(got.vol).toEqual(want.vol);
  });

  it('ignores bars that closed after the snapshot', () => {
    const calm = klines(rets.slice(0, 1100));
    const withFuture = klines([...rets.slice(0, 1100), ...Array.from({ length: 200 }, () => 0.05)]);
    expect(claudeModelAt(record(), withFuture)!.vol).toEqual(claudeModelAt(record(), calm)!.vol);
  });

  it('takes t from model_inputs when present, otherwise from the timestamp', () => {
    const kl = klines(rets);
    expect(claudeModelAt(record(), kl)!.t).toBe(20.3);
    const noInputs = claudeModelAt(record({ model_inputs: undefined }), kl)!;
    expect(noInputs.t).toBeCloseTo(((tsMs / 1000) % 3600) / 60, 9); // 20 min 20 s into the hour
  });

  it('adds the edge against the 1h market price recorded in the snapshot', () => {
    const got = claudeModelAt(record(), klines(rets))!;
    expect(got.edge).toBeCloseTo(got.fairUp - 0.78, 12);
    expect(claudeModelAt(record({ cards: {} }), klines(rets))!.edge).toBeNull();
  });

  describe('reconstructPrices (legacy records saved without spot and open)', () => {
    // bars open at BASE + i min with open price 1000 + i, so every bar has a distinguishable open
    const kl = Array.from({ length: 1300 }, (_, i) => [BASE + i * 60_000, String(1000 + i), '0', '0', '0', '0', BASE + (i + 1) * 60_000 - 1]);
    const hourStart = BASE + 18 * 3600_000; // bar 1080 opens the 18:00 UTC hour
    const at = (ms: number) => ({ timestamp: new Date(ms).toISOString() });

    it('uses the open of the hour first bar as S0 and the open of the bar holding the timestamp as spot', () => {
      const got = reconstructPrices(at(hourStart + 20 * 60_000 + 20_000), kl);
      expect(got).toEqual({ open: 1000 + 1080, spot: 1000 + 1100 });
    });

    it('works for a record stamped in the first seconds of the hour', () => {
      expect(reconstructPrices(at(hourStart + 5_000), kl)).toEqual({ open: 1080 + 1000, spot: 1080 + 1000 });
    });

    it('returns null when a needed bar is missing or the timestamp is bad', () => {
      expect(reconstructPrices(at(BASE + 5000 * 60_000), kl)).toBeNull();
      expect(reconstructPrices({ timestamp: 'nope' }, kl)).toBeNull();
    });
  });

  it('returns null without spot or open, or with fewer than 960 closed bars', () => {
    const kl = klines(rets);
    expect(claudeModelAt(record({ spot_price: null }), kl)).toBeNull();
    expect(claudeModelAt(record({ open_price: 0 }), kl)).toBeNull();
    expect(claudeModelAt(record(), klines(rets.slice(0, 900)))).toBeNull();
  });
});
