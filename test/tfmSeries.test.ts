import { describe, it, expect } from 'vitest';
import { contextAsOf, openAt } from '@/lib/tfm/series';

const bars = (n: number) => Array.from({ length: n }, (_, m) => ({ openTime: m * 60_000, open: 100 + m - 0.5, close: 100 + m }));

describe('contextAsOf', () => {
  it('keeps only bars that closed by the time, then the spot price', () => {
    const t = 5 * 60_000 + 28_000; // inside bar 5
    expect(contextAsOf(bars(10), t, 104.7)).toEqual([100, 101, 102, 103, 104, 104.7]);
    expect(contextAsOf(bars(10), t, null)).toEqual([100, 101, 102, 103, 104]);
    expect(contextAsOf(bars(10), t, 104.7)).not.toContain(105); // bar 5 closes after t
  });
  it('counts a bar that closes exactly at the time', () => {
    expect(contextAsOf(bars(10), 5 * 60_000, null)).toEqual([100, 101, 102, 103, 104]);
  });
  it('keeps the most recent maxLen points', () => {
    const c = contextAsOf(bars(2000), 1500 * 60_000 + 1, 9999, 1024);
    expect(c.length).toBe(1024);
    expect(c[1023]).toBe(9999);
    expect(c[1022]).toBe(100 + 1499);
    expect(c[0]).toBe(100 + 1499 - 1022);
  });
  it('ignores a spot price that is not a positive number', () => {
    expect(contextAsOf(bars(10), 5 * 60_000, NaN)).toEqual([100, 101, 102, 103, 104]);
    expect(contextAsOf(bars(10), 5 * 60_000, 0)).toEqual([100, 101, 102, 103, 104]);
  });
});

describe('openAt', () => {
  it('returns the open of the bar that starts at that time, or null', () => {
    expect(openAt(bars(10), 3 * 60_000)).toBe(102.5);
    expect(openAt(bars(10), 3 * 60_000 + 1000)).toBeNull();
  });
});
