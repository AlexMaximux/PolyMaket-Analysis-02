export type Freshness = 'fresh' | 'stale' | 'dead' | 'none';

/** Amber after 3 missed intervals, red after 10. */
export function heartbeatFreshness(lastOkAt: number | null | undefined, intervalSec: number | null, nowMs: number): Freshness {
  if (!lastOkAt || !intervalSec) return 'none';
  const age = nowMs / 1000 - lastOkAt;
  if (age > 10 * intervalSec) return 'dead';
  if (age > 3 * intervalSec) return 'stale';
  return 'fresh';
}
