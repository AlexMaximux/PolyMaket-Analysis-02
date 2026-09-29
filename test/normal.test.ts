import { describe, it, expect } from 'vitest';
import { normCdf, normInv } from '../src/lib/normal';

// Reference values from scipy.stats.norm (double precision).
const CDF_REF: [number, number][] = [
  [0, 0.5],
  [0.5, 0.6914624612740131],
  [1, 0.8413447460685429],
  [-1, 0.15865525393145707],
  [1.96, 0.9750021048517795],
  [-2.5, 0.006209665325776134],
  [3, 0.9986501019683699],
];

const INV_REF: [number, number][] = [
  [0.01, -2.3263478740408408],
  [0.025, -1.9599639845400545],
  [0.5, 0],
  [0.975, 1.959963984540054],
  [0.999, 3.090232306167813],
];

describe('normCdf', () => {
  it.each(CDF_REF)('matches Phi(%f) within 1e-7', (x, ref) => {
    expect(Math.abs(normCdf(x) - ref)).toBeLessThan(1e-7);
  });

  it('is symmetric: Phi(x) + Phi(-x) = 1', () => {
    for (const x of [0.1, 0.7, 1.3, 2.2, 4]) {
      expect(normCdf(x) + normCdf(-x)).toBeCloseTo(1, 12);
    }
  });
});

describe('normInv', () => {
  it.each(INV_REF)('matches PhiInv(%f) within 1e-8', (p, ref) => {
    expect(Math.abs(normInv(p) - ref)).toBeLessThan(1e-8);
  });

  it('round-trips through normCdf', () => {
    for (const p of [0.001, 0.02, 0.1, 0.33, 0.5, 0.67, 0.9, 0.98, 0.999]) {
      expect(Math.abs(normCdf(normInv(p)) - p)).toBeLessThan(1e-7);
    }
  });
});
