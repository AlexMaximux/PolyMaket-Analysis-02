/** Shared types and constants of the TimesFM (TFM) forecast. */

/** Decile levels of the quantiles the service returns (index 0 = q10 ... index 8 = q90). */
export const TFM_QUANTILE_LEVELS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9] as const;
export const TFM_HORIZON = 60; // minutes forecast on every call
export const TFM_MAX_CONTEXT = 1024; // 1-minute points sent to the model
export const TFM_MIN_CONTEXT = 256;

export type TfmWindowKey = 'h1' | 'm15' | 'm5';

/** One 1-minute bar; openTime in ms. */
export interface MinuteBar {
  openTime: number;
  open: number;
  close: number;
}

export interface TfmWindowForecast {
  open: number;
  minutesLeft: number;
  probUp: number;
  median: number;
  q10: number;
  q90: number;
}

export interface TfmRecord {
  file: string;
  coin: string;
  ts: string;
  model: string;
  context: number;
  last: number;
  h1: TfmWindowForecast | null;
  m15: TfmWindowForecast | null;
  m5: TfmWindowForecast | null;
  source: 'live' | 'backfill';
}
