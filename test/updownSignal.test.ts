import { describe, it, expect } from 'vitest';
import { takerFee, updownSignal } from '../src/lib/updownSignal';

describe('takerFee', () => {
  it('matches the 0.07·p·(1−p) crypto schedule', () => {
    expect(takerFee(0.5)).toBeCloseTo(0.0175, 10);
    expect(takerFee(0.9)).toBeCloseTo(0.0063, 10);
    expect(takerFee(0.1)).toBeCloseTo(takerFee(0.9), 12);
  });
});

describe('updownSignal', () => {
  const book = { bid: 0.60, ask: 0.61, mid: 0.605, bidSize: 100, askSize: 100 };

  it('BUY when both fair values clear ask + fee + 1¢', () => {
    // fee at 0.61 = 0.07·0.61·0.39 ≈ 0.01665 → need fair ≥ 0.61 + 0.01665 + 0.01 ≈ 0.6367
    const s = updownSignal({ fv1h: 0.66, base: 0.64, ...book });
    expect(s?.side).toBe('BUY');
    expect(s?.entry).toBe(0.61);
    expect(s?.fair).toBe(0.64);
    expect(s?.netEdge).toBeCloseTo(0.64 - 0.61 - takerFee(0.61), 10);
  });

  it('no signal when the edge only exists against the mid', () => {
    // 3¢ over the mid, but only 2¢ over the ask and less than fee + 1¢
    expect(updownSignal({ fv1h: 0.635, base: 0.635, ...book })).toBeNull();
  });

  it('SELL buys Down at 1 − bid and uses the higher fair value', () => {
    // Down ask = 0.40, fee ≈ 0.0168 → need 1 − max(fair) ≥ 0.4268
    const s = updownSignal({ fv1h: 0.55, base: 0.56, ...book });
    expect(s?.side).toBe('SELL');
    expect(s?.entry).toBeCloseTo(0.40, 12);
    expect(s?.fair).toBeCloseTo(0.44, 12);
    expect(s?.netEdge).toBeCloseTo(0.44 - 0.40 - takerFee(0.40), 10);
  });

  it('requires both fair values to agree', () => {
    expect(updownSignal({ fv1h: 0.70, base: 0.60, ...book })).toBeNull();
  });

  it('skips wide, one-sided, crossed or missing books', () => {
    expect(updownSignal({ fv1h: 0.9, base: 0.9, bid: 0.55, ask: 0.61, mid: 0.58 })).toBeNull();
    expect(updownSignal({ fv1h: 0.9, base: 0.9, bid: null, ask: 0.61, mid: null })).toBeNull();
    expect(updownSignal({ fv1h: 0.9, base: 0.9, bid: 0.62, ask: 0.61, mid: 0.615 })).toBeNull();
    expect(updownSignal({ fv1h: 0.9, base: 0.9, bid: 0, ask: 0.02, mid: 0.01 })).toBeNull();
  });

  it('skips hollow quotes (mid near 50/50 while Base says the hour is decided)', () => {
    const hollow = { bid: 0.49, ask: 0.51, bidSize: 500, askSize: 500 };
    expect(updownSignal({ fv1h: 0.98, base: 0.98, mid: 0.50, ...hollow })).toBeNull();
    // midpoint call failed: the guard uses the book mid instead of failing open
    expect(updownSignal({ fv1h: 0.98, base: 0.98, mid: null, ...hollow })).toBeNull();
  });

  it('needs at least $20 at the best price on the side it buys', () => {
    // 20 shares × 0.61 = $12.2 at the Up ask → no BUY
    expect(updownSignal({ fv1h: 0.66, base: 0.64, ...book, askSize: 20 })).toBeNull();
    expect(updownSignal({ fv1h: 0.66, base: 0.64, ...book, askSize: 40 })?.side).toBe('BUY');
    // SELL buys Down against the Up bids: 40 shares × (1 − 0.60) = $16 → no SELL; 60 × 0.40 = $24 → SELL
    expect(updownSignal({ fv1h: 0.55, base: 0.56, ...book, bidSize: 40 })).toBeNull();
    expect(updownSignal({ fv1h: 0.55, base: 0.56, ...book, bidSize: 60 })?.side).toBe('SELL');
    // size unknown (older server without book sizes) → no signal
    expect(updownSignal({ fv1h: 0.66, base: 0.64, bid: 0.60, ask: 0.61, mid: 0.605 })).toBeNull();
  });

  it('ignores non-finite fair values', () => {
    expect(updownSignal({ fv1h: NaN, base: 0.9, ...book })).toBeNull();
  });
});
