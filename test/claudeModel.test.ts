import { describe, it, expect } from 'vitest';
import {
  CLAUDE_MODEL_VERSION,
  claudeFairUp,
  forecastSigma,
  remainingVarianceMinutes,
  volWindowsFromKlines,
  type ClaudeVolInputs,
} from '@/lib/claudeModel';

const vol = (rv15: number, rv60: number, rv240: number, rv960: number): ClaudeVolInputs => ({ rv15, rv60, rv240, rv960 });

// Reference values from the scalar Python implementation of the same spec (the research code that was validated on
// 150 days of Binance 1m bars for 7 coins). Same constants, same A&S normal CDF, so they must agree to ~1e-6.
const GOLDEN = [
  { x: 0.001, t: 30.0, rv15: 0.0004, rv60: 0.0005, rv240: 0.0005, rv960: 0.0006, p: 0.66943593, z: 0.404817, sigma1h: 0.00370822, W: 26.625828 },
  { x: -0.002, t: 45.5, rv15: 0.0006, rv60: 0.0005, rv240: 0.0004, rv960: 0.0005, p: 0.11240534, z: -1.180748, sigma1h: 0.00382834, W: 11.74558 },
  { x: 0.0, t: 20.0, rv15: 0.0005, rv60: 0.0005, rv240: 0.0005, rv960: 0.0005, p: 0.5, z: 0, sigma1h: 0.00378912, W: 36.774812 },
  { x: 0.01, t: 58.0, rv15: 0.0003, rv60: 0.0003, rv240: 0.0003, rv960: 0.0003, p: 0.9995, z: 26.704122, sigma1h: 0.00233837, W: 1.538746 },
  { x: 0.0004, t: 12.25, rv15: 1e-5, rv60: 2e-5, rv240: 2e-5, rv960: 2e-5, p: 0.69064743, z: 0.460708, sigma1h: 0.001, W: 45.229325 },
  { x: -0.0003, t: 59.99, rv15: 0.0004, rv60: 0.0004, rv240: 0.0004, rv960: 0.0004, p: 0.0005, z: -7.572309, sigma1h: 0.0030688, W: 0.01 },
  { x: 0.0007, t: 0.5, rv15: 0.0008, rv60: 0.0006, rv240: 0.0006, rv960: 0.0007, p: 0.56178463, z: 0.14255, sigma1h: 0.004938, W: 59.334916 },
  { x: -0.015, t: 5.0, rv15: 0.001, rv60: 0.0008, rv240: 0.0007, rv960: 0.0006, p: 0.00780067, z: -2.726559, sigma1h: 0.00581876, W: 53.634287 },
  { x: 0.0025, t: 30.0, rv15: 0.0007, rv60: 0.0006, rv240: 0.0006, rv960: 0.0006, p: 0.80280809, z: 0.804332, sigma1h: 0.00466583, W: 26.625828 },
  { x: 0.0002, t: 40.2, rv15: 0.0003, rv60: 0.0004, rv240: 0.0005, rv960: 0.0006, p: 0.5523766, z: 0.12067, sigma1h: 0.00317057, W: 16.396036 },
];

describe('claudeFairUp', () => {
  it.each(GOLDEN)('matches the reference implementation: x=$x t=$t', (c) => {
    const r = claudeFairUp({ x: c.x, t: c.t, vol: vol(c.rv15, c.rv60, c.rv240, c.rv960) });
    expect(r.fairUp).toBeCloseTo(c.p, 6);
    expect(r.z).toBeCloseTo(c.z, 4);
    expect(r.sigma1h).toBeCloseTo(c.sigma1h, 7);
    expect(r.W).toBeCloseTo(c.W, 4);
    expect(r.fairDown).toBeCloseTo(1 - r.fairUp, 12);
  });

  it('is 50% when spot sits on the open (to the normal CDF approximation, 7.5e-8)', () => {
    expect(claudeFairUp({ x: 0, t: 33.3, vol: vol(0.0004, 0.0005, 0.0005, 0.0005) }).fairUp).toBeCloseTo(0.5, 7);
  });

  it('is symmetric: P(up | x) + P(up | -x) = 1', () => {
    for (const x of [0.0003, 0.001, 0.004]) {
      const a = claudeFairUp({ x, t: 41, vol: vol(0.0005, 0.0005, 0.0005, 0.0005) }).fairUp;
      const b = claudeFairUp({ x: -x, t: 41, vol: vol(0.0005, 0.0005, 0.0005, 0.0005) }).fairUp;
      expect(a + b).toBeCloseTo(1, 9);
    }
  });

  it('rises with x and, for a lead that stays the same, with elapsed time', () => {
    const v = vol(0.0005, 0.0005, 0.0005, 0.0005);
    let prev = 0;
    for (const x of [-0.004, -0.002, -0.0005, 0, 0.0005, 0.002, 0.004]) {
      const p = claudeFairUp({ x, t: 35, vol: v }).fairUp;
      expect(p).toBeGreaterThan(prev);
      prev = p;
    }
    prev = 0;
    for (const t of [5, 20, 35, 50, 57]) {
      const p = claudeFairUp({ x: 0.001, t, vol: v }).fairUp;
      expect(p).toBeGreaterThan(prev);
      prev = p;
    }
  });

  it('never claims certainty: probabilities stay inside [0.05%, 99.95%]', () => {
    const v = vol(0.0003, 0.0003, 0.0003, 0.0003);
    expect(claudeFairUp({ x: 0.05, t: 59.9, vol: v }).fairUp).toBe(0.9995);
    expect(claudeFairUp({ x: -0.05, t: 59.9, vol: v }).fairUp).toBe(0.0005);
  });

  it('survives the last instant of the hour and an hour that already ended', () => {
    const v = vol(0.0004, 0.0004, 0.0004, 0.0004);
    for (const t of [59.999, 60, 61]) {
      const r = claudeFairUp({ x: 0.0002, t, vol: v });
      expect(Number.isFinite(r.fairUp)).toBe(true);
      expect(r.fairUp).toBeGreaterThan(0.9);
    }
  });

  it('reports its version', () => {
    expect(claudeFairUp({ x: 0.001, t: 30, vol: vol(0.0004, 0.0004, 0.0004, 0.0004) }).version).toBe(CLAUDE_MODEL_VERSION);
  });
});

describe('remainingVarianceMinutes', () => {
  it('starts at 60 effective minutes (the profile averages 1) and ends at 0', () => {
    expect(remainingVarianceMinutes(0)).toBeCloseTo(60, 9);
    expect(remainingVarianceMinutes(60)).toBe(0);
  });
  it('shrinks continuously within a minute', () => {
    const a = remainingVarianceMinutes(20);
    const b = remainingVarianceMinutes(20.5);
    const c = remainingVarianceMinutes(21);
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
    expect(a - b).toBeCloseTo((a - c) / 2, 9);
  });
  it('puts more variance early in the hour: the last 30 minutes hold less than half of it', () => {
    expect(remainingVarianceMinutes(30)).toBeLessThan(30);
    expect(remainingVarianceMinutes(30)).toBeCloseTo(26.6258, 3);
  });
  it('carries the half-hour spike: minute :30 is worth more than any neighbour', () => {
    const m30 = remainingVarianceMinutes(30) - remainingVarianceMinutes(31);
    const m29 = remainingVarianceMinutes(29) - remainingVarianceMinutes(30);
    const m31 = remainingVarianceMinutes(31) - remainingVarianceMinutes(32);
    expect(m30).toBeGreaterThan(1.5);
    expect(m30).toBeGreaterThan(m29 * 1.4);
    expect(m30).toBeGreaterThan(m31 * 1.4);
  });
});

describe('forecastSigma', () => {
  it('blends the four windows on log variance', () => {
    const f = forecastSigma(vol(0.0005, 0.0005, 0.0005, 0.0005));
    expect(f.sigma1h).toBeCloseTo(0.00378912, 7);
    expect(f.sigmaMin).toBeCloseTo(f.sigma1h / Math.sqrt(60), 12);
  });
  it('floors the hourly sigma at 0.1% so a flat last hour cannot produce absurd confidence', () => {
    expect(forecastSigma(vol(0, 0, 0, 0)).sigma1h).toBe(0.001);
  });
  it('caps the hourly sigma at 20%', () => {
    expect(forecastSigma(vol(0.5, 0.5, 0.5, 0.5)).sigma1h).toBe(0.2);
  });
  it('responds more to the 60-minute window than to the 4-hour window', () => {
    const base = forecastSigma(vol(0.0005, 0.0005, 0.0005, 0.0005)).sigma1h;
    const up60 = forecastSigma(vol(0.0005, 0.0010, 0.0005, 0.0005)).sigma1h;
    const up240 = forecastSigma(vol(0.0005, 0.0005, 0.0010, 0.0005)).sigma1h;
    expect(up60 / base).toBeGreaterThan(up240 / base);
  });
});

// bar i opens at i minutes; bar `i` is complete when closeTime < now
const klines = (rets: number[]) =>
  rets.map((r, i) => [i * 60_000, '100', '101', '99', String(100 * Math.exp(r)), '1', (i + 1) * 60_000 - 1]);

describe('volWindowsFromKlines', () => {
  const N = 1000;
  const rets = Array.from({ length: N }, (_, i) => 0.0001 * (1 + (i % 4)));
  const rms = (xs: number[]) => Math.sqrt(xs.reduce((s, v) => s + v * v, 0) / xs.length);

  it('uses the last 15 / 60 / 240 / 960 completed bars and ignores the bar still in progress', () => {
    // now sits half way through bar 999, so bars 0..998 are complete
    const now = 999 * 60_000 + 30_000;
    const w = volWindowsFromKlines(klines(rets), now)!;
    const done = rets.slice(0, 999);
    expect(w.rv15).toBeCloseTo(rms(done.slice(-15)), 9);
    expect(w.rv60).toBeCloseTo(rms(done.slice(-60)), 9);
    expect(w.rv240).toBeCloseTo(rms(done.slice(-240)), 9);
    expect(w.rv960).toBeCloseTo(rms(done.slice(-960)), 9);
  });

  it('a spike in the in-progress bar does not leak in', () => {
    const spiky = [...rets.slice(0, 999), 0.05];
    const now = 999 * 60_000 + 30_000;
    expect(volWindowsFromKlines(klines(spiky), now)!.rv15).toBeCloseTo(rms(rets.slice(984, 999)), 9);
  });

  it('returns null when fewer than 960 completed bars exist', () => {
    expect(volWindowsFromKlines(klines(rets.slice(0, 900)), 899 * 60_000 + 59_999 + 1)).toBeNull();
  });

  it('returns null for a non-array payload or bad prices', () => {
    expect(volWindowsFromKlines(null as unknown as unknown[][], 0)).toBeNull();
    const bad = klines(rets);
    bad[500][4] = 'NaN';
    expect(volWindowsFromKlines(bad, 1000 * 60_000)).toBeNull();
  });
});
