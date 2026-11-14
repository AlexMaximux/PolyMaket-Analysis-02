import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ANALYSIS_CONFIG,
  buildTrades,
  priceMoveOf,
  type AnalysisConfig,
  type SnapshotRow,
} from '@/lib/signalAnalysis';
import { sanitizeLabConfig } from '@/lib/jevLab';

let seq = 0;
// A BTC snapshot in the 11 ET hour of 2026-11-12 (16 UTC). Every row is a qualifying UP signal unless overridden.
function row(minute: number, spot: number, p: Partial<SnapshotRow> = {}): SnapshotRow {
  seq++;
  const m = String(minute).padStart(2, '0');
  return {
    filename: `btc_updown_2026-11-12_11-${m}-00_ET_${seq}.json`,
    coin: 'BTC',
    et_time: `2026-11-12 11:${m}:00 ET`,
    timestamp: `2026-11-12T16:${m}:00.000Z`,
    market_slug: 'bitcoin-up-or-down-november-12-2026-11am-et',
    score: 3.8,
    score_confidence: 95,
    direction: 'UP',
    up_1h_num: 70,
    spot_price: spot,
    market_outcome: 'UP',
    ...p,
  };
}

const noSignal = { score: 2, score_confidence: 50 };
const cfg = (over: Partial<AnalysisConfig>): AnalysisConfig => ({ ...DEFAULT_ANALYSIS_CONFIG, dedupe: 'all', ...over });

describe('priceMoveOf', () => {
  it('measures the change since the earlier snapshot inside the window, in dollars or percent', () => {
    const a = row(0, 70000);
    const b = row(5, 70250);
    expect(priceMoveOf(b, [a], { moveUnit: 'usd', moveWindowMin: 5 })).toBe(250);
    expect(priceMoveOf(b, [a], { moveUnit: 'pct', moveWindowMin: 5 })).toBeCloseTo(0.3571, 4);
  });

  it('keeps the largest move when several earlier snapshots are inside the window', () => {
    const rows = [row(0, 70000), row(5, 70300), row(10, 70100)];
    expect(priceMoveOf(rows[2], rows.slice(0, 2), { moveUnit: 'usd', moveWindowMin: 10 })).toBe(200);
    expect(priceMoveOf(rows[2], rows.slice(0, 2), { moveUnit: 'usd', moveWindowMin: 5 })).toBe(200);
  });

  it('ignores snapshots older than the window plus one minute of grace', () => {
    const a = row(0, 70000);
    expect(priceMoveOf(row(6, 70500), [a], { moveUnit: 'usd', moveWindowMin: 5 })).toBe(500);
    expect(priceMoveOf(row(7, 70500), [a], { moveUnit: 'usd', moveWindowMin: 5 })).toBeNull();
  });

  it('is null without a price', () => {
    expect(priceMoveOf(row(5, 70000, { spot_price: null }), [row(0, 70000)], { moveUnit: 'usd', moveWindowMin: 5 })).toBeNull();
  });
});

describe('fast-move filter in buildTrades', () => {
  // 11:30 calm, 11:35 jumps 300, 11:40 calm again (change 50).
  const rows = () => [row(30, 70000, noSignal), row(35, 70300), row(40, 70350)];

  it('changes nothing when off', () => {
    expect(buildTrades(rows(), cfg({ moveFilter: 'off' })).map((t) => t.minute)).toEqual([35, 40]);
  });

  it('snapshot mode drops only the snapshot with the fast move', () => {
    const trades = buildTrades(rows(), cfg({ moveFilter: 'snapshot', moveThreshold: 200 }));
    expect(trades.map((t) => t.minute)).toEqual([40]);
    expect(trades[0].priceMove).toBe(50);
  });

  it('restOfHour mode drops the fast snapshot and the rest of that hour', () => {
    expect(buildTrades(rows(), cfg({ moveFilter: 'restOfHour', moveThreshold: 200 }))).toEqual([]);
  });

  it('restOfHour mode keeps signals from before the fast move', () => {
    const r = [row(25, 70000), row(30, 70050), row(35, 70400)];
    expect(buildTrades(r, cfg({ moveFilter: 'restOfHour', moveThreshold: 200 })).map((t) => t.minute)).toEqual([25, 30]);
  });

  it('a move equal to the limit does not trip it', () => {
    expect(buildTrades(rows(), cfg({ moveFilter: 'snapshot', moveThreshold: 300 })).map((t) => t.minute)).toEqual([35, 40]);
  });

  it('works in percent', () => {
    // 300 / 70000 = 0.43%
    expect(buildTrades(rows(), cfg({ moveFilter: 'snapshot', moveUnit: 'pct', moveThreshold: 0.4 })).map((t) => t.minute)).toEqual([40]);
    expect(buildTrades(rows(), cfg({ moveFilter: 'snapshot', moveUnit: 'pct', moveThreshold: 0.5 })).map((t) => t.minute)).toEqual([35, 40]);
  });

  it('with first-signal-per-hour, the next calm signal becomes the trade', () => {
    const trades = buildTrades(rows(), cfg({ moveFilter: 'snapshot', moveThreshold: 200, dedupe: 'firstPerHour' }));
    expect(trades.map((t) => t.minute)).toEqual([40]);
  });

  it('compares prices per coin only', () => {
    const eth = row(35, 2500, { coin: 'ETH', filename: 'eth_x.json', market_slug: 'eth-11am' });
    const trades = buildTrades([row(30, 70000, noSignal), eth, row(35, 70050)], cfg({ moveFilter: 'snapshot', moveThreshold: 200 }));
    expect(trades.map((t) => t.coin)).toEqual(['ETH', 'BTC']);
  });
});

describe('sanitizeLabConfig fast-move fields', () => {
  it('keeps valid values and falls back on bad ones', () => {
    const ok = sanitizeLabConfig({ moveFilter: 'restOfHour', moveUnit: 'pct', moveThreshold: 0.3, moveWindowMin: 10 });
    expect([ok.moveFilter, ok.moveUnit, ok.moveThreshold, ok.moveWindowMin]).toEqual(['restOfHour', 'pct', 0.3, 10]);
    const bad = sanitizeLabConfig({ moveFilter: 'x', moveUnit: 'y', moveThreshold: -5, moveWindowMin: 0 });
    expect([bad.moveFilter, bad.moveUnit, bad.moveThreshold, bad.moveWindowMin]).toEqual(['off', 'usd', 0, 1]);
  });
});
