import { normCdf, normInv } from '@/lib/normal';
import { TFM_QUANTILE_LEVELS, type TfmWindowForecast, type TfmWindowKey } from './types';

const P_MIN = 0.001;
const P_MAX = 0.999;

const clampP = (p: number) => Math.min(P_MAX, Math.max(P_MIN, p));

/** The three UTC-aligned market windows that contain `tMs`, with the minutes left in each. */
export function windowsAt(tMs: number): Record<TfmWindowKey, { startMs: number; endMs: number; minutesLeft: number }> {
  const one = (lenMs: number) => {
    const startMs = Math.floor(tMs / lenMs) * lenMs;
    const endMs = startMs + lenMs;
    return { startMs, endMs, minutesLeft: (endMs - tMs) / 60_000 };
  };
  return { h1: one(3_600_000), m15: one(900_000), m5: one(300_000) };
}

/**
 * P(price >= level) read from forecast deciles of the price at one horizon.
 * Works in log-return space against `last`, interpolates the probit of the decile levels linearly over the
 * log returns (first and last segment extended as straight lines) and returns 1 - Phi(z*), clamped to
 * [0.001, 0.999]. `scale` multiplies the log returns (the spread shrinks or grows with it).
 */
export function probAtOrAbove(level: number, last: number, deciles: number[], scale = 1): number {
  const n = Math.min(deciles.length, TFM_QUANTILE_LEVELS.length);
  if (n < 2 || !(last > 0) || !(level > 0) || !Number.isFinite(level) || !Number.isFinite(scale)) return 0.5;
  const y: number[] = [];
  const z: number[] = [];
  for (let i = 0; i < n; i++) {
    const d = deciles[i];
    if (!(d > 0) || !Number.isFinite(d)) return 0.5;
    let yi = Math.log(d / last) * scale;
    if (i > 0 && yi < y[i - 1] + 1e-9) yi = y[i - 1] + 1e-9;
    y.push(yi);
    z.push(normInv(TFM_QUANTILE_LEVELS[i]));
  }
  const ys = Math.log(level / last);
  // the segment that holds ys; outside the knots the first or last segment is extended
  let j = 0;
  if (ys >= y[n - 1]) j = n - 2;
  else if (ys > y[0]) {
    while (j < n - 2 && ys > y[j + 1]) j++;
  }
  const zs = z[j] + ((ys - y[j]) / (y[j + 1] - y[j])) * (z[j + 1] - z[j]);
  if (!Number.isFinite(zs)) return 0.5;
  return clampP(1 - normCdf(zs));
}

/**
 * Forecast of one market window from the 60-step decile path: the step that covers the time left,
 * log returns scaled by sqrt(minutesLeft / step).
 */
export function windowForecast(a: { open: number; last: number; minutesLeft: number; quantiles: number[][] }): TfmWindowForecast {
  const { open, last, minutesLeft, quantiles } = a;
  const k = Math.min(quantiles.length, Math.max(1, Math.ceil(minutesLeft)));
  const scale = Math.sqrt(Math.max(0, minutesLeft) / k);
  const row = quantiles[k - 1];
  const at = (i: number) => last * Math.exp(Math.log(row[i] / last) * scale);
  return {
    open,
    minutesLeft,
    probUp: probAtOrAbove(open, last, row, scale),
    median: at(4),
    q10: at(0),
    q90: at(8),
  };
}
