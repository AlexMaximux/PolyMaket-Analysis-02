import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as dbModule from '../src/lib/db';
import { applySettingChanges, getSetting } from '../src/lib/settings';
import { getRecentTrades, getTotalSpent, initializeBotTables, recordBotTrade } from '../src/lib/bot/db';
import { reserveRequest } from '../src/lib/bot/ledger';

const KEY = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const trade = (timestamp: number, amount: number, status: 'FILLED' | 'SIMULATED' = 'FILLED') => recordBotTrade({
  timestamp, symbol: 'BTC', timeframe: '1H', outcome: 'UP', amount_usd: amount, status, source: 'signal',
} as never);

describe('bot.budgetResetAt: the total budget cap counts only trades from that moment', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    dbModule.initializeDb(db);
    vi.spyOn(dbModule, 'getDb').mockReturnValue(db);
    initializeBotTables();
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); });

  it('defaults to 0, so every trade counts', () => {
    expect(getSetting('bot.budgetResetAt', db)).toBe(0);
    trade(1_000, 100); trade(2_000, 100);
    expect(getTotalSpent(false)).toBe(200);
  });

  it('a reset time hides older trades from the cap and keeps every row', () => {
    trade(1_000, 100); trade(2_000, 100); trade(3_000, 50);
    expect(applySettingChanges({ 'bot.budgetResetAt': 2_500 }, db).ok).toBe(true);
    expect(getTotalSpent(false)).toBe(50);
    expect(getRecentTrades(10)).toHaveLength(3);
    expect(db.prepare('SELECT COUNT(*) AS n FROM bot_trades').get()).toEqual({ n: 3 });
  });

  it('a trade at exactly the reset time counts; a later one adds up', () => {
    trade(1_000, 100);
    expect(applySettingChanges({ 'bot.budgetResetAt': 5_000 }, db).ok).toBe(true);
    expect(getTotalSpent(false)).toBe(0);
    trade(5_000, 10); trade(6_000, 20);
    expect(getTotalSpent(false)).toBe(30);
  });

  it('applies to simulated trades too, and setting 0 again counts everything again', () => {
    trade(1_000, 40, 'SIMULATED'); trade(9_000, 5, 'SIMULATED');
    expect(applySettingChanges({ 'bot.budgetResetAt': 5_000 }, db).ok).toBe(true);
    expect(getTotalSpent(true)).toBe(5);
    expect(applySettingChanges({ 'bot.budgetResetAt': 0 }, db).ok).toBe(true);
    expect(getTotalSpent(true)).toBe(45);
  });

  it('a spent-out cap refuses a new request until the reset time passes it', () => {
    expect(applySettingChanges({ 'bot.enabled': true, 'bot.privateKey': KEY, 'bot.simulationMode': false, 'bot.perTradeAmount': 100, 'bot.maxBudget': 200 }, db).ok).toBe(true);
    trade(1_000, 100); trade(2_000, 100);
    const signal = (requestId: string) => ({ symbol: 'BTC', timeframe: '1H', outcome: 'UP' as const, requestId });
    expect(() => reserveRequest(signal('before-reset'))).toThrow('سقف بودجه کافی نیست.');
    expect(applySettingChanges({ 'bot.budgetResetAt': Date.now() }, db).ok).toBe(true);
    expect(reserveRequest(signal('after-reset')).row.amount).toBe(100);
  });

  it('rejects values that are not a time in epoch milliseconds', () => {
    for (const bad of [-1, 1.5, 'abc', null, 9e15]) {
      expect(applySettingChanges({ 'bot.budgetResetAt': bad as never }, db).ok).toBe(false);
    }
    expect(applySettingChanges({ 'bot.budgetResetAt': '1794700000000' }, db).ok).toBe(true);
    expect(getSetting('bot.budgetResetAt', db)).toBe(1794700000000);
  });
});
