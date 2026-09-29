import { describe, it, expect } from 'vitest';
import { backoffDelay, recordCrash, CRASH_WINDOW_MS } from '../src/lib/supervisor/policy';

describe('restart policy', () => {
  it('backs off 2s, 4s, 8s … capped at 60s', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 50].map(backoffDelay)).toEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
    expect(backoffDelay(-3)).toBe(2000);
  });
  it('flags a crash loop at 5 exits within 5 minutes', () => {
    let h: number[] = [];
    let loop = false;
    for (let i = 0; i < 5; i++) ({ history: h, crashLoop: loop } = recordCrash(h, 1000 + i * 1000));
    expect(loop).toBe(true);
  });
  it('forgets crashes older than the window', () => {
    const { history, crashLoop } = recordCrash([0, 1, 2, 3], CRASH_WINDOW_MS + 10);
    expect(history).toEqual([CRASH_WINDOW_MS + 10]);
    expect(crashLoop).toBe(false);
  });
});
