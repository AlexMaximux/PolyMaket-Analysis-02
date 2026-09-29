import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as dbModule from '../src/lib/db';
import { applySettingChanges } from '../src/lib/settings';
import { POST as testRoute } from '../src/app/api/settings/test/route';

const TEST_PRIVATE_KEY = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const TG_TOKEN = '123456789:AAHfakeTokenValueForTests_abcd';

const post = (target: string) => testRoute(new Request('http://localhost/x', { method: 'POST', body: JSON.stringify({ target }) }));

describe('/api/settings/test — bot targets', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    dbModule.initializeDb(db);
    vi.spyOn(dbModule, 'getDb').mockReturnValue(db);
    global.fetch = vi.fn().mockResolvedValue(new Response('not found', { status: 404 }));
  });
  afterEach(() => vi.restoreAllMocks());

  it('bot: reports not configured with no private key, without any network call', async () => {
    const body = await (await post('bot')).json();
    expect(body.ok).toBe(false);
    expect(body.message).toMatch(/private key/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('bot: derives and reports the wallet address without placing any order', async () => {
    applySettingChanges({ 'bot.privateKey': TEST_PRIVATE_KEY }, db);
    const body = await (await post('bot')).json();
    expect(body.ok).toBe(true);
    expect(body.message).toContain(TEST_ADDRESS);
  });

  it('bot-telegram: requires token and chat id to be saved first', async () => {
    const body = await (await post('bot-telegram')).json();
    expect(body.ok).toBe(false);
  });

  it('bot-telegram: sends a test message through the saved trader bot token', async () => {
    applySettingChanges({ 'bot.telegramToken': TG_TOKEN, 'bot.telegramChatId': '42' }, db);
    (global.fetch as any).mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const body = await (await post('bot-telegram')).json();
    expect(body.ok).toBe(true);
    const [url] = (global.fetch as any).mock.calls[0];
    expect(String(url)).toContain(TG_TOKEN);
  });
});
