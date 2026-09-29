import { describe, it, expect } from 'vitest';
import { watchdogStep, type WatchCheck } from '../src/lib/watchdog';

const check = (over: Partial<WatchCheck> = {}): WatchCheck => ({ id: 'jev', label: 'jev worker', ageSec: 10, limitSec: 600, ...over });

describe('watchdogStep', () => {
  it('stays silent while everything is fresh', () => {
    const s = watchdogStep([check()], new Set());
    expect(s.messages).toEqual([]);
    expect(s.down.size).toBe(0);
  });
  it('alerts once when a check goes stale, not on every tick', () => {
    const stale = [check({ ageSec: 1200 })];
    const first = watchdogStep(stale, new Set());
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0]).toContain('stalled');
    expect(watchdogStep(stale, first.down).messages).toEqual([]);
  });
  it('announces recovery once', () => {
    const s = watchdogStep([check()], new Set(['jev']));
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toContain('recovered');
    expect(s.down.size).toBe(0);
  });
  it('ignores workers that never reported', () => {
    expect(watchdogStep([check({ ageSec: null })], new Set()).messages).toEqual([]);
  });
});
