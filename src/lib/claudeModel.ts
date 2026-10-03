import { normCdf } from './normal';

/**
 * "Claude" fair value of a 1H Up/Down market: P(close >= open), from price action alone.
 *
 * The 1H market resolves on the Binance 1h candle, so with x = ln(St/S0) and the remaining hour modelled as a
 * random walk, P(Up) = P(x + future move >= 0). Compared with the Base formula (/api/updown "A"), this model
 * changes three things, each kept only because it improved held-out log loss on 150 days of Binance 1m bars for
 * BTC, ETH, SOL, XRP, DOGE, BNB and HYPE (walk-forward: it beat Base in all four test blocks, -0.0033 log loss on
 * average, about 0.7%):
 *
 *   1. Variance is not spread evenly over the hour. Per-minute variance falls from about 1.3x the average in the
 *      first minutes to 0.77x in the last, with a spike at :30. The remaining variance is W(t) "effective
 *      minutes", not 60 - t. A window of the last 60 minutes always holds one of each minute, so it still
 *      measures the average level.
 *   2. Sigma is forecast from four windows (last 15, 60, 240 and 960 one-minute bars), blended on log variance
 *      (a HAR regression of the realized remaining variance), instead of the last 60 bars alone. Floored at 0.1%
 *      per hour so a flat hour cannot produce absurd confidence.
 *   3. Sigma is uncertain and returns have fat tails, so z is averaged over a log-normal error on sigma
 *      (9-point Gauss-Hermite). Base said 0.4% for outcomes that happened 1.3% of the time.
 *
 * What it does NOT use, because testing showed no signal: the 15m/5m market prices (the drift they imply made
 * log loss worse than Base on live BTC snapshots), momentum, and Binance taker order flow.
 *
 * Constants were fitted on all 150 days (May 5 to Oct 2, 2026). Re-fit them if the regime changes.
 */
export const CLAUDE_MODEL_VERSION = '2026-10-02.claude-har-mix';

/** Per-minute volatility (rms of ln(close/open) over 1m bars) for each look-back window. */
export interface ClaudeVolInputs {
  rv15: number;
  rv60: number;
  rv240: number;
  rv960: number;
}

export interface ClaudeModelResult {
  version: string;
  fairUp: number;
  fairDown: number;
  x: number;
  t: number;
  z: number; // standardised lead: x / (sigmaMin * sqrt(W)), before the tail adjustment
  W: number; // effective minutes of variance left in the hour
  sigma1h: number;
  sigmaMin: number;
  vol: ClaudeVolInputs;
  k: number;
  s: number;
}

// Minute-of-hour variance profile: smooth downward trend, a spike at :30 and a small bump in the first 3 minutes.
const PROFILE = { a: 0.2022, trend: -0.4883, spike30: 0.5403, open3: 0.0714 };
// log(variance per minute) = c + sum(beta * log(rv^2)); fitted on the realized remaining variance.
const HAR = { c: -0.8814, rv15: 0.2326, rv60: 0.4021, rv240: 0.1439, rv960: 0.1663 };
const K = 1.05; // scale on z, fitted on log loss
const S = 0.28; // sd of the log-normal error on sigma
const SIGMA_1H_MIN = 0.001;
const SIGMA_1H_MAX = 0.2;
const RV_FLOOR = 2e-5; // keeps log() finite on a window with no price change
const MIN_W = 0.01; // effective minutes; avoids dividing by zero in the final instants
const P_MIN = 0.0005;
const P_MAX = 0.9995;
const MIN_BARS = 960;

// 9-point Gauss-Hermite rule for N(0,1): nodes and weights (weights sum to 1).
const GH_NODES = [-4.5127458634, -3.2054290029, -2.0768479787, -1.0232556638, 0, 1.0232556638, 2.0768479787, 3.2054290029, 4.5127458634];
const GH_WEIGHTS = [2.23458e-5, 0.0027891413, 0.0499164068, 0.2440975029, 0.4063492063, 0.2440975029, 0.0499164068, 0.0027891413, 2.23458e-5];

const V: number[] = (() => {
  const raw = Array.from({ length: 60 }, (_, m) =>
    Math.exp(PROFILE.a + (PROFILE.trend * m) / 60 + (m === 30 ? PROFILE.spike30 : 0) + (m < 3 ? PROFILE.open3 : 0)));
  const mean = raw.reduce((s, v) => s + v, 0) / 60;
  return raw.map((v) => v / mean);
})();
// SUFFIX[m] = V[m] + ... + V[59]; SUFFIX[60] = 0
const SUFFIX: number[] = (() => {
  const out = new Array<number>(61).fill(0);
  for (let m = 59; m >= 0; m--) out[m] = out[m + 1] + V[m];
  return out;
})();

/** Effective minutes of variance left at t minutes into the hour (fractional). 60 at t = 0, 0 at t >= 60. */
export function remainingVarianceMinutes(t: number): number {
  if (!(t < 60)) return 0;
  const tt = Math.max(t, 0);
  const k = Math.floor(tt);
  return (1 - (tt - k)) * V[k] + SUFFIX[k + 1];
}

export function forecastSigma(v: ClaudeVolInputs): { sigma1h: number; sigmaMin: number } {
  const lg = (r: number) => 2 * Math.log(Math.max(r, RV_FLOOR));
  const logVar = HAR.c + HAR.rv15 * lg(v.rv15) + HAR.rv60 * lg(v.rv60) + HAR.rv240 * lg(v.rv240) + HAR.rv960 * lg(v.rv960);
  const sigma1h = Math.min(Math.max(Math.sqrt(Math.exp(logVar)) * Math.sqrt(60), SIGMA_1H_MIN), SIGMA_1H_MAX);
  return { sigma1h, sigmaMin: sigma1h / Math.sqrt(60) };
}

export function claudeFairUp(input: { x: number; t: number; vol: ClaudeVolInputs }): ClaudeModelResult {
  const { x, t, vol } = input;
  const { sigma1h, sigmaMin } = forecastSigma(vol);
  const W = Math.max(remainingVarianceMinutes(t), MIN_W);
  const z = x / (sigmaMin * Math.sqrt(W));
  let p = 0;
  for (let i = 0; i < GH_NODES.length; i++) p += GH_WEIGHTS[i] * normCdf(K * z * Math.exp(-S * GH_NODES[i]));
  const fairUp = Math.min(Math.max(p, P_MIN), P_MAX);
  return { version: CLAUDE_MODEL_VERSION, fairUp, fairDown: 1 - fairUp, x, t, z, W, sigma1h, sigmaMin, vol, k: K, s: S };
}

/**
 * Volatility windows from raw Binance 1m klines ([openTime, open, high, low, close, volume, closeTime, ...]).
 * Only bars that already closed count, so the bar in progress never leaks in. Null when the payload is unusable
 * or holds fewer than 960 closed bars: a shorter window would silently change the model.
 */
export function volWindowsFromKlines(klines: unknown[][] | null | undefined, nowMs: number): ClaudeVolInputs | null {
  if (!Array.isArray(klines)) return null;
  const sq: number[] = [];
  for (const k of klines) {
    if (!Array.isArray(k) || Number(k[6]) >= nowMs) continue;
    const r = Math.log(parseFloat(String(k[4])) / parseFloat(String(k[1])));
    if (!Number.isFinite(r)) return null;
    sq.push(r * r);
  }
  if (sq.length < MIN_BARS) return null;
  const rms = (n: number) => {
    let sum = 0;
    for (let i = sq.length - n; i < sq.length; i++) sum += sq[i];
    return Math.sqrt(sum / n);
  };
  return { rv15: rms(15), rv60: rms(60), rv240: rms(240), rv960: rms(960) };
}
