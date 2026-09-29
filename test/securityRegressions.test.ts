import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as dbModule from '../src/lib/db';
import { GET as getAlerts } from '../src/app/api/alerts/route';
import { GET as predictGet, POST as predictPost } from '../src/app/api/jev/predict/route';
import { isHttpUrl } from '../src/lib/validate';
import { maskSecret } from '../src/lib/secrets';

const TOKEN = '123456789:AAHfakeTokenValueForTests_abcd';

describe('security regressions', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    vi.spyOn(dbModule, 'getDb').mockReturnValue(db);
    dbModule.initializeDb(db);
    global.fetch = vi.fn();
  });
  afterEach(() => vi.restoreAllMocks());

  it('GET /api/alerts never returns the Telegram token', async () => {
    db.prepare(`INSERT INTO alerts (name, hours, min_bet, telegram_token, telegram_chat, enabled, created_at)
                VALUES ('a', 24, 1000, ?, '42', 1, 0)`).run(TOKEN);
    const res = await getAlerts();
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    const body = JSON.parse(text);
    expect(body.alerts[0].telegram_token).toBeUndefined();
    expect(body.alerts[0].telegram_token_masked).toBe('…abcd');
    expect(body.alerts[0].telegram_chat).toBe('42');
  });

  it('predict rejects unknown coins (no path tricks)', async () => {
    const res = await predictGet(new Request('http://localhost/api/jev/predict?coin=../../etc/passwd'));
    expect(res.status).toBe(400);
    const res2 = await predictPost(new Request('http://localhost/api/jev/predict', { method: 'POST', body: JSON.stringify({ coin: 'zzz' }) }));
    expect(res2.status).toBe(400);
  });

  it('helpers', () => {
    expect(isHttpUrl('https://openrouter.ai/api/v1')).toBe(true);
    expect(isHttpUrl('http://178.104.62.47:20128/v1')).toBe(true);
    expect(isHttpUrl('ftp://x')).toBe(false);
    expect(isHttpUrl('not a url')).toBe(false);
    expect(maskSecret(TOKEN)).toBe('…abcd');
    expect(maskSecret('short')).toBe('…');
    expect(maskSecret('')).toBeNull();
  });
});
