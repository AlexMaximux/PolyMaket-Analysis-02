import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as dbModule from '../src/lib/db';
import * as resolver from '../src/lib/marketResolver';
import { applySettingChanges, getSetting } from '../src/lib/settings';
import { initializeBotTables, recordBotTrade } from '../src/lib/bot/db';
import { findRequest } from '../src/lib/bot/ledger';
import { decideStake, isStakePlanRequest, lastForwardTradeLost, MIN_STAKE_USD } from '../src/lib/bot/stake';
import type { SignalRequest } from '../src/lib/bot/types';

const KEY = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const forward = (requestId = 'forward:test'): SignalRequest => ({ symbol: 'BTC', timeframe: '1H', outcome: 'UP', requestId, source: 'signal' });
const balance = (usd: number) => async () => ({ usd });
const unreadable = (error: string) => async () => ({ error });

describe('P4 stake decision', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    dbModule.initializeDb(db);
    vi.spyOn(dbModule, 'getDb').mockReturnValue(db);
    initializeBotTables();
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); });
  function configure(over: Record<string, unknown> = {}, real = true) {
    const r = applySettingChanges({
      'bot.enabled': true, 'bot.privateKey': KEY, 'bot.simulationMode': !real, 'bot.perTradeAmount': 10, 'bot.maxBudget': 100_000,
      'bot.stakePlan': 'p4', 'bot.stakePercent': 10, 'bot.stakeCap': 800, ...over,
    }, db);
    expect(r.ok).toBe(true);
  }
  // the table is created on the first message
  const notifications = () => {
    try { return db.prepare('SELECT event, message FROM bot_notifications').all() as { event: string; message: string }[]; }
    catch { return []; }
  };

  it('is off by default and accepts only fixed or p4', () => {
    expect(getSetting('bot.stakePlan', db)).toBe('fixed');
    expect(applySettingChanges({ 'bot.stakePlan': 'martingale' }, db).ok).toBe(false);
    expect(applySettingChanges({ 'bot.stakePercent': 0 }, db).ok).toBe(false);
    expect(applySettingChanges({ 'bot.stakePercent': 101 }, db).ok).toBe(false);
    expect(applySettingChanges({ 'bot.stakeCap': 4 }, db).ok).toBe(false);
  });

  it('keeps the fixed amount under the fixed plan and for every signal that is not a forward signal', async () => {
    configure({ 'bot.stakePlan': 'fixed' });
    const read = vi.fn(balance(1000));
    expect(await decideStake(forward(), { readBalance: read })).toMatchObject({ amount: 10, plan: 'fixed', fallback: false });
    configure({ 'bot.stakePlan': 'p4' });
    for (const source of ['api', 'telegram', 'manual', undefined] as const) {
      expect(isStakePlanRequest({ ...forward(), source })).toBe(false);
      expect(await decideStake({ ...forward(), source }, { readBalance: read })).toMatchObject({ amount: 10, plan: 'fixed' });
    }
    expect(read).not.toHaveBeenCalled();
    expect(notifications()).toEqual([]);
  });

  it('stakes the percentage of the wallet balance, rounded down to the cent', async () => {
    configure();
    const d = await decideStake(forward(), { readBalance: balance(1234.567), lastTradeLost: () => false });
    expect(d).toMatchObject({ plan: 'p4', amount: 123.45, balance: 1234.567, percent: 10, afterLoss: false, fallback: false });
  });

  it('stakes twice the percentage after a lost trade', async () => {
    configure();
    const d = await decideStake(forward(), { readBalance: balance(1000), lastTradeLost: () => true });
    expect(d).toMatchObject({ plan: 'p4', amount: 200, percent: 20, afterLoss: true });
  });

  it('never stakes more than the cap, also after a loss, nor more than the balance', async () => {
    configure();
    expect((await decideStake(forward(), { readBalance: balance(100_000), lastTradeLost: () => false })).amount).toBe(800);
    expect((await decideStake(forward(), { readBalance: balance(100_000), lastTradeLost: () => true })).amount).toBe(800);
    configure({ 'bot.stakePercent': 90, 'bot.stakeCap': 5000 });
    expect((await decideStake(forward(), { readBalance: balance(100), lastTradeLost: () => true })).amount).toBe(100);
  });

  it('never stakes less than the $5 minimum order', async () => {
    configure();
    expect(MIN_STAKE_USD).toBe(5);
    expect((await decideStake(forward(), { readBalance: balance(20), lastTradeLost: () => false })).amount).toBe(5);
  });

  it('uses the fixed amount and sends a Telegram message when the balance cannot be read', async () => {
    configure({ 'bot.perTradeAmount': 25 });
    const d = await decideStake(forward('forward:fb1'), { readBalance: unreadable('خواندن موجودی ناموفق بود') });
    expect(d).toMatchObject({ plan: 'fixed', amount: 25, fallback: true, balance: null });
    const n = notifications();
    expect(n).toHaveLength(1);
    expect(n[0].event).toBe('stake-fallback:forward:fb1');
    expect(n[0].message).toContain('$25');
    expect(n[0].message).toContain('خواندن موجودی ناموفق بود');
    // the same signal never sends the message twice
    await decideStake(forward('forward:fb1'), { readBalance: unreadable('x') });
    expect(notifications()).toHaveLength(1);
  });

  it('treats a balance below the minimum order as unreadable', async () => {
    configure({ 'bot.perTradeAmount': 10 });
    const d = await decideStake(forward(), { readBalance: balance(3) });
    expect(d).toMatchObject({ plan: 'fixed', amount: 10, fallback: true });
    expect(notifications()).toHaveLength(1);
  });

  it('cannot read a balance for a wallet that is not a configured Deposit Wallet, so it falls back', async () => {
    configure({ 'bot.walletType': 'EOA' });
    const d = await decideStake(forward());
    expect(d).toMatchObject({ plan: 'fixed', fallback: true, amount: 10 });
    expect(notifications()[0].message).toContain('Deposit Wallet');
  });

  it('takes the percentage of the budget cap in paper mode, without reading a wallet', async () => {
    configure({ 'bot.maxBudget': 500 }, false);
    const read = vi.fn(balance(99999));
    const d = await decideStake(forward(), { readBalance: read, lastTradeLost: () => false });
    expect(d).toMatchObject({ plan: 'p4', amount: 50, balance: 500 });
    expect(read).not.toHaveBeenCalled();
  });

  it('reads no balance and sends nothing while the bot is off or an order is still pending', async () => {
    configure();
    const read = vi.fn(unreadable('x'));
    applySettingChanges({ 'bot.enabled': false }, db);
    expect(await decideStake(forward(), { readBalance: read })).toMatchObject({ plan: 'fixed', fallback: false });
    applySettingChanges({ 'bot.enabled': true }, db);
    findRequest('__init__'); // creates the table
    db.prepare("INSERT INTO bot_requests (request_id, fingerprint, state, simulated, amount, created_at, updated_at) VALUES ('p', 'f', 'RESERVED', 0, 10, 1, 1)").run();
    expect(await decideStake(forward(), { readBalance: read })).toMatchObject({ plan: 'fixed', fallback: false });
    expect(read).not.toHaveBeenCalled();
    expect(notifications()).toEqual([]);
  });

  describe('lastForwardTradeLost', () => {
    const trade = (over: Partial<Parameters<typeof recordBotTrade>[0]> = {}) => recordBotTrade({
      timestamp: Date.now(), symbol: 'BTC', timeframe: '1H', outcome: 'UP', slug: 'btc-1', token_id: 't', amount_usd: 10,
      shares: 20, price: 0.5, status: 'FILLED', source: 'signal', ...over,
    } as never);
    const resolved = (map: Record<string, 'UP' | 'DOWN' | 'PENDING'>) => vi.spyOn(resolver, 'getResolutionsMap').mockReturnValue(map);

    it('is false without any trade', () => {
      resolved({});
      expect(lastForwardTradeLost(false)).toBe(false);
    });
    it('is true when the last trade went against the resolved market, false when it won', () => {
      trade({ outcome: 'UP', slug: 'btc-1' });
      resolved({ 'btc-1': 'DOWN' });
      expect(lastForwardTradeLost(false)).toBe(true);
      resolved({ 'btc-1': 'UP' });
      expect(lastForwardTradeLost(false)).toBe(false);
    });
    it('counts an unresolved market as not lost', () => {
      trade({ slug: 'btc-1' });
      resolved({});
      expect(lastForwardTradeLost(false)).toBe(false);
      resolved({ 'btc-1': 'PENDING' });
      expect(lastForwardTradeLost(false)).toBe(false);
    });
    it('looks only at the most recent trade, not at older losses', () => {
      trade({ outcome: 'UP', slug: 'btc-1' });
      trade({ outcome: 'UP', slug: 'btc-2' });
      resolved({ 'btc-1': 'DOWN', 'btc-2': 'UP' });
      expect(lastForwardTradeLost(false)).toBe(false);
    });
    it('ignores failed trades, trades that are not forward trades, and the other mode', () => {
      trade({ outcome: 'UP', slug: 'btc-1' });
      trade({ outcome: 'UP', slug: 'btc-2', status: 'FAILED' });
      trade({ outcome: 'UP', slug: 'btc-3', source: 'telegram' });
      trade({ outcome: 'UP', slug: 'btc-4', status: 'SIMULATED' });
      resolved({ 'btc-1': 'DOWN', 'btc-2': 'UP', 'btc-3': 'UP', 'btc-4': 'UP' });
      expect(lastForwardTradeLost(false)).toBe(true); // btc-1 is the last live forward trade
      expect(lastForwardTradeLost(true)).toBe(false); // btc-4 won in paper mode
    });
    it('feeds the decision: a loss makes the next stake twice the percentage', async () => {
      configure();
      trade({ outcome: 'DOWN', slug: 'btc-1' });
      resolved({ 'btc-1': 'UP' });
      const d = await decideStake(forward(), { readBalance: balance(1000) });
      expect(d).toMatchObject({ amount: 200, percent: 20, afterLoss: true });
    });
  });
});
