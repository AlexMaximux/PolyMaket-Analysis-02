import { TFM_MAX_CONTEXT, type MinuteBar } from './types';

const MIN_MS = 60_000;

/** Index of the last bar that has closed by `tMs` (openTime + 60 s <= tMs), or -1. Binary search; bars ascending. */
function lastClosedIndex(bars: MinuteBar[], tMs: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].openTime + MIN_MS <= tMs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * The price context the model sees at time `tMs`: closes of the bars that had closed by then (never the bar that
 * contains `tMs`, so no look-ahead), then the spot price when it is a positive number. The most recent `maxLen`
 * points are kept.
 */
export function contextAsOf(bars: MinuteBar[], tMs: number, spot: number | null, maxLen: number = TFM_MAX_CONTEXT): number[] {
  const hasSpot = typeof spot === 'number' && Number.isFinite(spot) && spot > 0;
  const end = lastClosedIndex(bars, tMs);
  const room = Math.max(0, maxLen - (hasSpot ? 1 : 0));
  const out: number[] = [];
  for (let i = Math.max(0, end - room + 1); i <= end; i++) out.push(bars[i].close);
  if (hasSpot) out.push(spot as number);
  return out;
}

/** Open of the bar that starts exactly at `startMs`, or null when there is none. */
export function openAt(bars: MinuteBar[], startMs: number): number | null {
  let lo = 0;
  let hi = bars.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const ot = bars[mid].openTime;
    if (ot === startMs) return bars[mid].open;
    if (ot < startMs) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}
