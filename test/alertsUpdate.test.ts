import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as dbModule from '../src/lib/db';
import { POST as postAlertAction } from '../src/app/api/alerts/[id]/route';

const TOKEN_A = '123456789:AAHfakeTokenValueForTests_abcd';
const TOKEN_B = '987654321:BBHanotherFakeTokenForTests_wxyz';

const act = (id: number, body: Record<string, unknown>) =>
  postAlertAction(new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: String(id) }),
  });

describe('POST /api/alerts/[id] — update action', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    dbModule.initializeDb(db);
    vi.spyOn(dbModule, 'getDb').mockReturnValue(db);
    db.prepare(
      `INSERT INTO alerts (name, hours, min_bet, telegram_token, telegram_chat, enabled, created_at)
       VALUES ('Test alert', 24, 1000, ?, '111', 1, 0)`
    ).run(TOKEN_A);
  });
  afterEach(() => vi.restoreAllMocks());

  it('updates the bot token and chat id', async () => {
    const res = await act(1, { action: 'update', telegramToken: TOKEN_B, telegramChat: '222' });
    expect(res.status).toBe(200);
    const row = db.prepare(`SELECT telegram_token, telegram_chat FROM alerts WHERE id = 1`).get() as any;
    expect(row.telegram_token).toBe(TOKEN_B);
    expect(row.telegram_chat).toBe('222');
  });

  it('keeps the current token when an empty token is submitted (chat-only change)', async () => {
    const res = await act(1, { action: 'update', telegramToken: '', telegramChat: '333' });
    expect(res.status).toBe(200);
    const row = db.prepare(`SELECT telegram_token, telegram_chat FROM alerts WHERE id = 1`).get() as any;
    expect(row.telegram_token).toBe(TOKEN_A);
    expect(row.telegram_chat).toBe('333');
  });

  it('rejects a malformed token and changes nothing', async () => {
    const res = await act(1, { action: 'update', telegramToken: 'not-a-token' });
    expect(res.status).toBe(400);
    const row = db.prepare(`SELECT telegram_token FROM alerts WHERE id = 1`).get() as any;
    expect(row.telegram_token).toBe(TOKEN_A);
  });

  it('rejects an empty chat id', async () => {
    const res = await act(1, { action: 'update', telegramChat: '' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown alert id', async () => {
    const res = await act(999, { action: 'update', telegramChat: '5' });
    expect(res.status).toBe(404);
  });
});
