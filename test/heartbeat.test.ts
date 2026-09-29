import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { beat, readHeartbeats } from '../src/lib/heartbeat';
import { heartbeatFreshness } from '../src/lib/staleness';

describe('heartbeat', () => {
  it('records success and error separately', () => {
    const db = new Database(':memory:');
    beat('crawl', true, undefined, db);
    beat('crawl', false, 'x'.repeat(900), db);
    const hb = readHeartbeats(db).crawl;
    expect(hb.last_ok_at).toBeGreaterThan(0);
    expect(hb.last_error_at).toBeGreaterThan(0);
    expect(hb.last_error!.length).toBe(500);
  });
  it('never throws, even on a closed database', () => {
    const db = new Database(':memory:');
    db.close();
    expect(() => beat('crawl', true, undefined, db)).not.toThrow();
  });
  it('classifies freshness by interval multiples', () => {
    const now = 1_000_000_000;
    expect(heartbeatFreshness(null, 30, now)).toBe('none');
    expect(heartbeatFreshness(now / 1000 - 60, 30, now)).toBe('fresh');
    expect(heartbeatFreshness(now / 1000 - 91, 30, now)).toBe('stale');
    expect(heartbeatFreshness(now / 1000 - 301, 30, now)).toBe('dead');
  });
});
