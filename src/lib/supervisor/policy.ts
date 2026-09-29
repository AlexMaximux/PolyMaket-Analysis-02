export const BACKOFF_STEPS_MS = [2_000, 4_000, 8_000, 16_000, 32_000, 60_000];
export const CRASH_WINDOW_MS = 5 * 60_000;
export const CRASH_LIMIT = 5;
/** A run this long counts as healthy and resets the backoff. */
export const STABLE_RESET_MS = 5 * 60_000;

export function backoffDelay(attempt: number): number {
  const i = Math.min(Math.max(attempt, 0), BACKOFF_STEPS_MS.length - 1);
  return BACKOFF_STEPS_MS[i];
}

/** Add a crash time; crashLoop is true once CRASH_LIMIT crashes fall inside CRASH_WINDOW_MS. */
export function recordCrash(history: number[], now: number): { history: number[]; crashLoop: boolean } {
  const recent = history.filter(t => now - t < CRASH_WINDOW_MS);
  recent.push(now);
  return { history: recent, crashLoop: recent.length >= CRASH_LIMIT };
}
