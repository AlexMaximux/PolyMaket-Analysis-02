import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as dbModule from '../src/lib/db';
import { applySettingChanges } from '../src/lib/settings';
import { sendTestSignal, latestSignal, orderPreview } from '../src/lib/bot/testSignal';
import { FROZEN_STRATEGY_5, type SnapshotRow } from '../src/lib/signalAnalysis';
import type { ActiveMarketInfo } from '../src/lib/bot/types';

const TOKEN = '123456789:abcdefghijklmnopqrstuvwxyz123456789';
let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); dbModule.initializeDb(db); vi.spyOn(dbModule, 'getDb').mockReturnValue(db); });
afterEach(() => { vi.restoreAllMocks(); db.close(); });

const row = (hour: number, minute: number, over: Partial<SnapshotRow> = {}): SnapshotRow => {
  const hh = String(hour).padStart(2, '0'), mm = String(minute).padStart(2, '0');
  return {
    filename: `btc_${hh}${mm}.json`, coin: 'BTC', et_time: `2026-10-05 ${hh}:${mm}:00 ET`, timestamp: `2026-10-05T${String(hour + 4).padStart(2, '0')}:${mm}:00Z`,
    market_slug: `bitcoin-up-or-down-october-5-2026-${hour}am-et`, score: 3.8, score_confidence: 95, direction: 'UP', kev_direction: 'UP', span_direction: 'UP',
    up_1h_num: 50, ...over,
  };
};
const down = { score: 0.6, score_confidence: 40, direction: 'DOWN', kev_direction: 'DOWN', span_direction: 'DOWN' } as const;
const market = (ask: number | null): ActiveMarketInfo => ({ selectedBestAsk: ask, minimumOrderSize: 5 }) as ActiveMarketInfo;
const telegram = () => applySettingChanges({ 'bot.telegramToken': TOKEN, 'bot.telegramChatId': '12345' });
const deps = (rows: SnapshotRow[], ask: number | null = 0.5) => ({
  send: vi.fn().mockResolvedValue(true), rows: () => rows, market: async () => market(ask), balance: async () => '💼 موجودی کیف پول قبل از سفارش: $42.00',
});

describe('latestSignal', () => {
  it("is the strategy's newest signal by its own rule, not just the newest snapshot", () => {
    const rows = [row(4, 40), row(5, 42, down), row(5, 50, { score: 2 })]; // the last snapshot is no signal
    expect(latestSignal(rows, FROZEN_STRATEGY_5)).toMatchObject({ outcome: 'DOWN', minute: 42, matched: true, slug: 'bitcoin-up-or-down-october-5-2026-5am-et' });
  });
  it('falls back to the newest snapshot direction, flagged as not matched', () => {
    expect(latestSignal([row(4, 10, { score: 2, direction: 'DOWN' })], FROZEN_STRATEGY_5)).toMatchObject({ outcome: 'DOWN', matched: false });
    expect(latestSignal([], FROZEN_STRATEGY_5)).toBeNull();
  });
});

describe('orderPreview', () => {
  it('shows what the saved order settings would do right now', () => {
    applySettingChanges({ 'bot.orderPriceMode': 'limit', 'bot.limitOffsetCents': 4, 'bot.perTradeAmount': 10 });
    expect(orderPreview(market(0.5))).toContain('روی 46¢ برای 21.73 سهم');
    applySettingChanges({ 'bot.orderPriceMode': 'market' });
    expect(orderPreview(market(0.5))).toContain('99¢');
    applySettingChanges({ 'bot.orderPriceMode': 'slippage', 'bot.slippageCents': 2 });
    expect(orderPreview(market(0.5))).toContain('52¢');
    expect(orderPreview(market(null))).toContain('در دسترس نیست');
  });
});

describe('sendTestSignal', () => {
  it('needs the trading bot Telegram settings, and sends nothing without them', async () => {
    const d = deps([row(4, 40)]);
    expect((await sendTestSignal(d)).ok).toBe(false);
    expect(d.send).not.toHaveBeenCalled();
  });
  it('sends the latest real signal in the forward message format, starting with the balance, and marks it as a test', async () => {
    telegram();
    applySettingChanges({ 'bot.orderPriceMode': 'limit' });
    const d = deps([row(4, 40), row(5, 42, down)]);
    const r = await sendTestSignal(d);
    expect(r.ok).toBe(true);
    expect(d.send).toHaveBeenCalledTimes(1);
    const [token, chat, text] = d.send.mock.calls[0] as [string, string, string];
    expect([token, chat]).toEqual([TOKEN, '12345']);
    expect(text.startsWith('💼 موجودی کیف پول قبل از سفارش: $42.00\n\n🧪 پیام آزمایشی')).toBe(true);
    expect(text).toContain('📥 سیگنال forward دریافت شد؛ هنوز خرید تأیید نشده\nBTC 1H DOWN\nbitcoin-up-or-down-october-5-2026-5am-et\nforward:TEST');
    expect(text).toContain('دقیقه 42');
    expect(text).toContain('روی 46¢');
    expect(text).toContain('هیچ سفارشی ثبت نشد');
    expect(text).not.toMatch(/[<>&]/); // the message is sent as HTML
  });
  it('places no order and writes nothing to the ledger or the notification queue', async () => {
    telegram();
    await sendTestSignal(deps([row(4, 40)]));
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(t => t.name);
    for (const t of ['bot_requests', 'bot_forward_events', 'bot_notifications', 'bot_trades']) {
      if (tables.includes(t)) expect(db.prepare(`SELECT count(*) AS n FROM ${t}`).get()).toEqual({ n: 0 });
    }
  });
  it('says so when the strategy has had no signal, and when Telegram rejects the message', async () => {
    telegram();
    const d = deps([row(4, 10, { score: 2 })]);
    expect((await sendTestSignal(d)).message).toContain('no recent signal');
    expect(d.send.mock.calls[0][2]).toContain('سیگنالی از استراتژی');
    const bad = deps([row(4, 40)]);
    bad.send.mockResolvedValue(false);
    expect(await sendTestSignal(bad)).toMatchObject({ ok: false });
    expect(await sendTestSignal(deps([]))).toMatchObject({ ok: false });
  });
  it('still sends when the market read fails', async () => {
    telegram();
    const d = { ...deps([row(4, 40)]), market: async () => { throw new Error('network'); } };
    expect((await sendTestSignal(d)).ok).toBe(true);
    expect(d.send.mock.calls[0][2]).toContain('در دسترس نیست');
  });
});
