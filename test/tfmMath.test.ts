import { describe, it, expect } from 'vitest';
import { normInv } from '@/lib/normal';
import { TFM_QUANTILE_LEVELS } from '@/lib/tfm/types';
import { probAtOrAbove, windowForecast, windowsAt } from '@/lib/tfm/math';

const Z = TFM_QUANTILE_LEVELS.map((q) => normInv(q));
const deciles = (last: number, sigma: number) => Z.map((z) => last * Math.exp(sigma * z));

describe('probAtOrAbove', () => {
  const d = deciles(100, 0.004);
  it('reads a normal forecast exactly, inside and outside the deciles', () => {
    expect(probAtOrAbove(100, 100, d)).toBeCloseTo(0.5, 4);
    expect(probAtOrAbove(100 * Math.exp(0.004), 100, d)).toBeCloseTo(0.158655, 3);
    expect(probAtOrAbove(100 * Math.exp(-0.008), 100, d)).toBeCloseTo(0.97725, 3);
  });
  it('shrinks the spread with scale', () => {
    expect(probAtOrAbove(100 * Math.exp(0.002), 100, d, 0.5)).toBeCloseTo(0.158655, 3);
  });
  it('stays inside 0.001-0.999 and finite on extreme or flat input', () => {
    expect(probAtOrAbove(100 * Math.exp(0.1), 100, d)).toBe(0.001);
    expect(probAtOrAbove(100 * Math.exp(-0.1), 100, d)).toBe(0.999);
    const flat = probAtOrAbove(100.01, 100, Array(9).fill(100));
    expect(Number.isFinite(flat) && flat >= 0.001 && flat <= 0.999).toBe(true);
  });
});

describe('windowsAt', () => {
  it('finds the three UTC-aligned windows and the minutes left', () => {
    const w = windowsAt(Date.parse('2026-11-05T19:34:28.881Z'));
    expect(w.h1.startMs).toBe(Date.parse('2026-11-05T19:00:00.000Z'));
    expect(w.h1.endMs).toBe(Date.parse('2026-11-05T20:00:00.000Z'));
    expect(w.h1.minutesLeft).toBeCloseTo(25.51865, 4);
    expect(w.m15.startMs).toBe(Date.parse('2026-11-05T19:30:00.000Z'));
    expect(w.m15.minutesLeft).toBeCloseTo(10.51865, 4);
    expect(w.m5.endMs).toBe(Date.parse('2026-11-05T19:35:00.000Z'));
    expect(w.m5.minutesLeft).toBeCloseTo(0.51865, 4);
  });
  it('puts an exact boundary in the new window', () => {
    const w = windowsAt(Date.parse('2026-11-05T19:35:00.000Z'));
    expect(w.m5.startMs).toBe(Date.parse('2026-11-05T19:35:00.000Z'));
    expect(w.m5.minutesLeft).toBe(5);
  });
});

describe('windowForecast', () => {
  const last = 76000;
  const quantiles = Array.from({ length: 60 }, (_, i) => deciles(last, 0.0005 * Math.sqrt(i + 1)));
  it('uses the step that covers the time left, scaled by the square root of time', () => {
    const m = 25.51865;
    const even = windowForecast({ open: last, last, minutesLeft: m, quantiles });
    expect(even.probUp).toBeCloseTo(0.5, 4);
    expect(even.median).toBeCloseTo(last, 4);
    expect(Math.log(even.q10 / last)).toBeCloseTo(-0.0005 * Math.sqrt(m) * 1.2815516, 6);
    const ahead = windowForecast({ open: last * Math.exp(-0.0005 * Math.sqrt(m)), last, minutesLeft: m, quantiles });
    expect(ahead.probUp).toBeCloseTo(0.841345, 3);
    expect(ahead.minutesLeft).toBe(m);
  });
  it('handles the last seconds of a window and a time beyond the horizon', () => {
    expect(windowForecast({ open: last, last, minutesLeft: 0.51865, quantiles }).probUp).toBeCloseTo(0.5, 4);
    const far = windowForecast({ open: last, last, minutesLeft: 75, quantiles });
    expect(Math.log(far.q90 / last)).toBeCloseTo(0.0005 * Math.sqrt(60) * Math.sqrt(75 / 60) * 1.2815516, 6);
  });
});
