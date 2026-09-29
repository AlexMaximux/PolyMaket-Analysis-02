import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ClobClient } from '@polymarket/clob-client';
import * as dbModule from '../src/lib/db';
import * as live from '../src/lib/bot/live';
import * as geo from '../src/lib/bot/geo';
import { applySettingChanges } from '../src/lib/settings';
import { executeSignal, getBotWalletConfig, reconcileRequest, MAX_ATTEMPTS, buildHourlyEtSlug } from '../src/lib/bot/executor';
import { getRecentTrades, getTotalSpent, initializeBotTables } from '../src/lib/bot/db';
import { findRequest, pendingRequests, reservedBudget } from '../src/lib/bot/ledger';

const KEY = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const signal = (requestId = 'test-1') => ({ symbol: 'BTC', timeframe: '1H', outcome: 'UP' as const, requestId });
const rejected = { error: "order couldn't be fully filled. FOK orders are fully filled or killed.", status: 400 };

describe('fixed BTC 1H execution', () => {
  let db: Database.Database;
  let postOrder: ReturnType<typeof vi.fn>;
  let createMarketOrder: ReturnType<typeof vi.fn>;
  let getOrder: ReturnType<typeof vi.fn>;
  let getTrades: ReturnType<typeof vi.fn>;
  let sequence: number;
  beforeEach(() => {
    db = new Database(':memory:');
    dbModule.initializeDb(db);
    vi.spyOn(dbModule, 'getDb').mockReturnValue(db);
    vi.spyOn(geo, 'getPolymarketGeoStatus').mockResolvedValue({ checked: true, blocked: false, apiBlocked: false, country: 'SE', region: null });
    initializeBotTables();
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify([{ slug: buildHourlyEtSlug('btc'), title: 'BTC', markets: [{
      clobTokenIds: '["tok-down","tok-up"]', outcomes: '["Down","Up"]', acceptingOrders: true, closed: false,
      endDate: new Date(Date.now() + 3600_000).toISOString(),
    }] }]))));
    vi.spyOn(ClobClient.prototype, 'getOrderBook').mockResolvedValue({ asks: [{ price: '0.5', size: '100' }], bids: [] } as never);
    sequence = 0;
    createMarketOrder = vi.fn().mockImplementation(async () => ({ hash: `order-${++sequence}` }));
    postOrder = vi.fn().mockImplementation(async (order: { hash: string }) => ({ success: true, status: 'matched', orderID: order.hash, makingAmount: '10', takingAmount: '20', transactionsHashes: ['tx-1'] }));
    getOrder = vi.fn().mockResolvedValue({ error: 'not found' });
    getTrades = vi.fn().mockResolvedValue([]);
    vi.spyOn(live, 'createLiveClient').mockResolvedValue({
      client: { createMarketOrder, postOrder, getOrder, getTrades, getNegRisk: vi.fn().mockResolvedValue(false) },
      orderHash: (order: { hash: string }) => order.hash,
    } as never);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); db.close(); });
  function enable(real = false, amount = 10, budget = 100) {
    expect(applySettingChanges({ 'bot.enabled': true, 'bot.privateKey': KEY, 'bot.simulationMode': !real, 'bot.perTradeAmount': amount, 'bot.maxBudget': budget }, db).ok).toBe(true);
  }
  async function run(id = 'test-1') {
    const p = executeSignal(signal(id));
    await vi.runAllTimersAsync();
    return p;
  }
  it('does no network work while disabled', async () => {
    expect((await run()).error).toMatch(/disabled/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('allows an Irish API order despite the frontend geoblock', async () => {
    enable(true);
    vi.mocked(geo.getPolymarketGeoStatus).mockResolvedValue({ checked: true, blocked: true, apiBlocked: false, country: 'IE', region: 'L' });
    expect((await run()).success).toBe(true);
    expect(postOrder).toHaveBeenCalledTimes(1);
  });
  it('blocks UK buys before signing and releases the reservation', async () => {
    enable(true);
    vi.mocked(geo.getPolymarketGeoStatus).mockResolvedValue({ checked: true, blocked: true, apiBlocked: true, country: 'GB', region: 'ENG' });
    expect((await run()).status).toBe('FAILED');
    expect(createMarketOrder).not.toHaveBeenCalled();
    expect(reservedBudget(false)).toBe(0);
  });
  it('rejects another coin/timeframe and missing identity', async () => {
    enable();
    for (const s of [{ ...signal(), symbol: 'ETH' }, { ...signal(), timeframe: '5M' }, { ...signal(), requestId: undefined }]) expect((await executeSignal(s)).success).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('refuses to execute a signal against a different market', async () => {
    enable(true);
    const result = await executeSignal({ ...signal(), expectedMarketSlug: 'old-market' });
    expect(result.success).toBe(false); expect(postOrder).not.toHaveBeenCalled();
  });
  it('cancels a forward order when the bridge is paused during market lookup', async () => {
    enable(true); applySettingChanges({ 'bot.forwardEnabled': true });
    const gate = db.prepare('SELECT armed_at FROM bot_forward_gate').get() as { armed_at: number };
    vi.mocked(fetch).mockImplementationOnce(async () => {
      applySettingChanges({ 'bot.forwardEnabled': false });
      return new Response(JSON.stringify([{ slug: buildHourlyEtSlug('btc'), markets: [{ clobTokenIds: '[\"tok-down\",\"tok-up\"]', outcomes: '[\"Down\",\"Up\"]', acceptingOrders: true, closed: false, endDate: new Date(Date.now() + 3600_000).toISOString() }] }]));
    });
    const r = await executeSignal({ ...signal(), forwardArmedAt: gate.armed_at });
    expect(r.success).toBe(false); expect(postOrder).not.toHaveBeenCalled();
  });
  it('uses configured fixed amount even if caller requests smaller or larger amounts', async () => {
    enable();
    for (const amountUsd of [3, 9999]) {
      const r = await executeSignal({ ...signal(`amount-${amountUsd}`), amountUsd });
      expect(r.amountUsd).toBe(10); expect(r.success).toBe(true); expect(r.tokenId).toBe('tok-up');
    }
  });
  it('atomically blocks concurrent requests and refuses overspending', async () => {
    enable(false, 10, 10);
    const [a, b] = await Promise.all([executeSignal(signal('a')), executeSignal(signal('b'))]);
    expect([a, b].filter(r => r.success)).toHaveLength(1);
    expect(getTotalSpent()).toBe(10);
    expect((await run('c')).error).toMatch(/بودجه/);
  });
  it('returns persisted duplicate result without new orders, even after settings change', async () => {
    enable(true);
    const first = await run();
    applySettingChanges({ 'bot.perTradeAmount': 15 }, db);
    expect(await run()).toEqual(first);
    expect(postOrder).toHaveBeenCalledTimes(1);
    expect(getRecentTrades()).toHaveLength(1);
    expect((await executeSignal({ ...signal(), outcome: 'DOWN' })).success).toBe(false);
  });
  it('keeps paper and real budgets separate', async () => {
    enable(false, 10, 10); await run('paper');
    enable(true, 10, 10); expect((await run('live')).success).toBe(true);
    expect(getTotalSpent(false)).toBe(10); expect(getTotalSpent(true)).toBe(10);
  });
  it('retries definite FOK rejection at the same original price and records actual fill', async () => {
    enable(true);
    postOrder.mockResolvedValueOnce(rejected).mockResolvedValueOnce(rejected).mockImplementationOnce(async (o: { hash: string }) => ({ success: true, status: 'matched', orderID: o.hash, makingAmount: '9.8', takingAmount: '20', transactionsHashes: ['real-tx'] }));
    const r = await run();
    expect(r).toMatchObject({ success: true, attempts: 3, amountUsd: 9.8, txHash: 'real-tx' });
    expect(r.price).toBeCloseTo(0.49);
    expect(r.error).toBeUndefined();
    expect(createMarketOrder.mock.calls.every(([order]) => order.price === 0.5 && order.amount === 10)).toBe(true);
    expect(getRecentTrades()).toHaveLength(1); expect(getTotalSpent(false)).toBe(9.8);
  });
  it('stops after five rejected attempts and releases the budget', async () => {
    enable(true); postOrder.mockResolvedValue(rejected);
    const r = await run();
    expect(r.success).toBe(false); expect(postOrder).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(pendingRequests(false)).toHaveLength(0); expect(getTotalSpent(false)).toBe(0);
  });
  it('does not retry an ambiguous timeout and keeps its durable reservation', async () => {
    enable(true); postOrder.mockRejectedValue(new Error('network error containing credentials'));
    const r = await run();
    expect(r.status).toBe('UNKNOWN'); expect(JSON.stringify(r)).not.toContain('credentials');
    expect(postOrder).toHaveBeenCalledTimes(1); expect(reservedBudget(false)).toBe(10);
    expect((await run('another')).success).toBe(false);
    await run(); expect(postOrder).toHaveBeenCalledTimes(1);
    expect(findRequest('test-1')?.order_id).toBe('order-1');
  });
  it('reconciles an accepted order after a lost response without another POST', async () => {
    enable(true); postOrder.mockRejectedValue(new Error('timeout'));
    getOrder.mockResolvedValue({ id: 'order-1', asset_id: 'tok-up', side: 'BUY', status: 'MATCHED', size_matched: '20', associate_trades: ['trade-1'] });
    getTrades.mockResolvedValue([{ id: 'trade-1', taker_order_id: 'order-1', status: 'CONFIRMED', size: '20', price: '0.49' }]);
    const r = await run(); expect(r).toMatchObject({ success: true, amountUsd: 9.8 });
    expect(postOrder).toHaveBeenCalledTimes(1); expect(reservedBudget(false)).toBe(0);
  });
  it('never labels error or delayed responses filled', async () => {
    enable(true); postOrder.mockResolvedValue({ success: true, status: 'delayed', orderID: 'order-1' });
    expect((await run()).status).toBe('UNKNOWN'); expect(getRecentTrades()).toHaveLength(0);
  });
  it('does not retry permanent rejection', async () => {
    enable(true); postOrder.mockResolvedValue({ error: 'not enough balance / allowance', status: 400 });
    expect((await run()).status).toBe('FAILED'); expect(postOrder).toHaveBeenCalledTimes(1);
  });
  it('rechecks the kill switch between attempts', async () => {
    enable(true); postOrder.mockImplementation(async () => { applySettingChanges({ 'bot.enabled': false }, db); return rejected; });
    expect((await run()).success).toBe(false); expect(postOrder).toHaveBeenCalledTimes(1);
  });
  it('fails closed if persistence fails after an accepted order', async () => {
    enable(true);
    db.exec("CREATE TRIGGER reject_trade BEFORE INSERT ON bot_trades BEGIN SELECT RAISE(ABORT, 'disk failed'); END");
    expect((await run()).status).toBe('UNKNOWN'); expect(reservedBudget(false)).toBe(10);
    expect(postOrder).toHaveBeenCalledTimes(1);
  });
  it('can settle a canceled unknown order with zero fill', async () => {
    enable(true); postOrder.mockRejectedValue(new Error('timeout')); await run();
    getOrder.mockResolvedValue({ id: 'order-1', asset_id: 'tok-up', side: 'BUY', status: 'CANCELED', size_matched: '0' });
    expect((await reconcileRequest('test-1')).status).toBe('FAILED'); expect(reservedBudget(false)).toBe(0);
  });
  it('does not treat an empty orderbook as a fictitious 50-cent fill', async () => {
    enable(); vi.mocked(ClobClient.prototype.getOrderBook).mockResolvedValue({ asks: [], bids: [] } as never);
    expect((await run()).success).toBe(false); expect(getRecentTrades()[0].status).toBe('FAILED');
  });
  it('validates and derives both EOA and Safe wallet configuration', () => {
    expect(getBotWalletConfig().isConfigured).toBe(false);
    enable(); expect(getBotWalletConfig().address).toBe(ADDRESS);
    expect(applySettingChanges({ 'bot.walletType': 'POLY_GNOSIS_SAFE' }, db).ok).toBe(false);
    expect(applySettingChanges({ 'bot.walletType': 'POLY_GNOSIS_SAFE', 'bot.proxyAddress': '0x1111111111111111111111111111111111111111' }, db).ok).toBe(true);
    expect(getBotWalletConfig().address).toBe('0x1111111111111111111111111111111111111111');
  });
  it('does not submit after the market expires during signing', async () => {
    enable(true);
    createMarketOrder.mockImplementation(async () => {
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 7200_000);
      return { hash: 'late-order' };
    });
    expect((await run()).success).toBe(false); expect(postOrder).not.toHaveBeenCalled();
  });
  it('does not simulate a live request with a missing wallet', async () => {
    applySettingChanges({ 'bot.enabled': true }, db);
    db.prepare("UPDATE settings SET value = 'false' WHERE key = 'bot.simulationMode'").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('bot.simulationMode', 'false', 0)").run();
    expect((await run()).success).toBe(false); expect(postOrder).not.toHaveBeenCalled();
    expect(getRecentTrades()[0].status).toBe('FAILED');
  });
  it('fails closed if spending history cannot be read', async () => {
    enable(true);
    db.exec('ALTER TABLE bot_trades RENAME COLUMN amount_usd TO unavailable');
    await expect(executeSignal(signal())).rejects.toThrow();
    expect(postOrder).not.toHaveBeenCalled();
  });
  it('retains a reservation when reported execution exceeds the price cap', async () => {
    enable(true);
    postOrder.mockResolvedValue({ success: true, status: 'matched', orderID: 'order-1', makingAmount: '10', takingAmount: '10' });
    expect((await run()).status).toBe('UNKNOWN'); expect(reservedBudget(false)).toBe(10);
  });

});
