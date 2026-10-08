import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ClobClient } from '@polymarket/clob-client';
import * as dbModule from '../src/lib/db';
import * as geo from '../src/lib/bot/geo';
import * as deposit from '../src/lib/bot/depositWallet';
import { applySettingChanges } from '../src/lib/settings';
import { executeSignal, reconcileRequest, buildHourlyEtSlug, limitBuyPrice, limitBuySize } from '../src/lib/bot/executor';
import { getRecentTrades, getTotalSpent, initializeBotTables } from '../src/lib/bot/db';
import { findRequest, reservedBudget, isLimitOrder } from '../src/lib/bot/ledger';
import { collectNotifications, initNotifications } from '../src/lib/bot/notifications';
import { runForwardCycle } from '../src/lib/bot/forward';
import { setBotSetting } from '../src/lib/bot/db';
import type { SnapshotRow } from '../src/lib/signalAnalysis';
import type { TradeResult } from '../src/lib/bot/types';

vi.mock('@polymarket/client/actions', async importOriginal => ({ ...(await importOriginal<object>()), fetchNegRisk: vi.fn().mockResolvedValue(false) }));

const KEY = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const PROXY = '0x23673C5e7603e13399dbBe35c846EbAeF0a071a1';
const signal = (requestId = 'forward:limit-1') => ({ symbol: 'BTC', timeframe: '1H', outcome: 'UP' as const, requestId });
const at = (hhmmss: string) => new Date(`2026-10-08T${hhmmss}Z`); // 08:xx UTC is 04:xx ET: the same minute of the hour

describe('limit order mode', () => {
  let db: Database.Database;
  let createLimitOrder: ReturnType<typeof vi.fn>;
  let postOrder: ReturnType<typeof vi.fn>;
  let fetchOrder: ReturnType<typeof vi.fn>;
  let cancelOrder: ReturnType<typeof vi.fn>;
  let bestAsk: string;
  const open = (over: Record<string, unknown> = {}) => ({
    id: 'ord-1', assetId: 'tok-up', side: 'BUY', price: '0.46', originalSize: '21.73', sizeMatched: '0', status: 'LIVE', orderType: 'GTC', ...over,
  });

  beforeEach(() => {
    db = new Database(':memory:');
    dbModule.initializeDb(db);
    vi.spyOn(dbModule, 'getDb').mockReturnValue(db);
    vi.spyOn(geo, 'getPolymarketGeoStatus').mockResolvedValue({ checked: true, blocked: false, apiBlocked: false, country: 'SE', region: null });
    initializeBotTables();
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    vi.setSystemTime(at('08:30:00'));
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify([{ slug: buildHourlyEtSlug('btc'), title: 'BTC', markets: [{
      clobTokenIds: '["tok-down","tok-up"]', outcomes: '["Down","Up"]', acceptingOrders: true, closed: false, endDate: at('09:00:00').toISOString(),
    }] }]))));
    bestAsk = '0.5';
    vi.spyOn(ClobClient.prototype, 'getOrderBook').mockImplementation((async () => ({ asks: [{ price: bestAsk, size: '100' }], bids: [], min_order_size: '5' })) as never);
    createLimitOrder = vi.fn().mockImplementation(async (r: object) => ({ hash: 'ord-1', ...r }));
    postOrder = vi.fn().mockImplementation(async (o: { hash: string }) => ({ ok: true, orderId: o.hash, status: 'live', makingAmount: '0', takingAmount: '0', transactionsHashes: [], tradeIds: [] }));
    fetchOrder = vi.fn().mockImplementation(async () => open());
    cancelOrder = vi.fn().mockResolvedValue({});
    vi.spyOn(deposit, 'createDepositWalletClient').mockResolvedValue({ client: { createLimitOrder, postOrder, fetchOrder, cancelOrder } } as never);
    vi.spyOn(deposit, 'ensureDepositTradingApprovals').mockResolvedValue({ changed: false } as never);
    vi.spyOn(deposit, 'depositOrderHash').mockImplementation(((o: { hash: string }) => o.hash) as never);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); db.close(); });

  function enable(real = true, over: Record<string, unknown> = {}) {
    expect(applySettingChanges({
      'bot.enabled': true, 'bot.privateKey': KEY, 'bot.walletType': 'DEPOSIT_WALLET', 'bot.proxyAddress': PROXY, 'bot.simulationMode': !real,
      'bot.perTradeAmount': 10, 'bot.maxBudget': 100, 'bot.orderPriceMode': 'limit', 'bot.limitOffsetCents': 4, ...over,
    }, db).ok).toBe(true);
  }
  const run = async (id?: string) => { const p = executeSignal(signal(id)); await vi.runAllTimersAsync(); return p; };

  it('prices the order N cents under the best ask, rounded down, with shares rounded down', () => {
    expect(limitBuyPrice(0.5, 4)).toBe(0.46);
    expect(limitBuyPrice(0.972, 4)).toBe(0.93);
    expect(limitBuyPrice(0.88, 4)).toBe(0.84);
    expect(limitBuySize(10, 0.46)).toBe(21.73);
    expect(limitBuySize(35, 0.84) * 0.84).toBeLessThanOrEqual(35);
  });

  it('rests a GTC buy 4 cents under the ask: pending, budget kept reserved, nothing bought yet', async () => {
    enable();
    const r = await run();
    expect(createLimitOrder).toHaveBeenCalledWith({ assetId: 'tok-up', price: 0.46, size: 21.73, side: expect.anything() });
    expect(postOrder).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ success: false, status: 'PENDING', price: 0.46, shares: 21.73 });
    expect(findRequest('forward:limit-1')?.state).toBe('RESTING');
    expect(isLimitOrder('forward:limit-1')).toBe(true);
    expect(reservedBudget(false)).toBe(10);
    expect(getRecentTrades(5)).toHaveLength(0);
  });

  it('blocks a second order while one rests, and keeps resting before minute 57 without cancelling', async () => {
    enable();
    await run();
    vi.setSystemTime(at('08:50:00'));
    const again = await reconcileRequest('forward:limit-1');
    expect(again.status).toBe('PENDING');
    expect(cancelOrder).not.toHaveBeenCalled();
    expect((await run('forward:limit-2')).error).toMatch(/سفارش قبلی/);
  });

  it('settles a full fill from the exchange, at the limit price', async () => {
    enable();
    await run();
    fetchOrder.mockResolvedValue(open({ status: 'MATCHED', sizeMatched: '21.73' }));
    const r = await reconcileRequest('forward:limit-1');
    expect(r).toMatchObject({ success: true, status: 'FILLED', shares: 21.73 });
    expect(r.price).toBeCloseTo(0.46);
    expect(findRequest('forward:limit-1')?.state).toBe('FILLED');
    expect(reservedBudget(false)).toBe(0);
    expect(getTotalSpent(false)).toBeCloseTo(21.73 * 0.46);
  });

  it('settles at once when the order is matched on placement', async () => {
    enable();
    fetchOrder.mockResolvedValue(open({ status: 'MATCHED', sizeMatched: '21.73' }));
    postOrder.mockImplementation(async (o: { hash: string }) => ({ ok: true, orderId: o.hash, status: 'matched', makingAmount: '9.9958', takingAmount: '21.73', transactionsHashes: ['t'], tradeIds: ['1'] }));
    expect(await run()).toMatchObject({ success: true, status: 'FILLED', shares: 21.73 });
  });

  it('at minute 57 cancels an unfilled order and skips the trade', async () => {
    enable();
    await run();
    vi.setSystemTime(at('08:57:05'));
    fetchOrder.mockResolvedValueOnce(open()).mockResolvedValueOnce(open({ status: 'CANCELED' }));
    const r = await reconcileRequest('forward:limit-1');
    expect(cancelOrder).toHaveBeenCalledWith({ orderId: 'ord-1' });
    expect(r).toMatchObject({ success: false, status: 'FAILED' });
    expect(r.error).toMatch(/لغو شد/);
    expect(findRequest('forward:limit-1')?.state).toBe('FAILED');
    expect(reservedBudget(false)).toBe(0);
  });

  it('keeps a partial fill when the rest is cancelled', async () => {
    enable();
    await run();
    vi.setSystemTime(at('08:57:05'));
    fetchOrder.mockResolvedValueOnce(open({ sizeMatched: '5' })).mockResolvedValueOnce(open({ status: 'CANCELED', sizeMatched: '5' }));
    const r = await reconcileRequest('forward:limit-1');
    expect(r).toMatchObject({ success: true, status: 'FILLED', shares: 5 });
    expect(r.amountUsd).toBeCloseTo(5 * 0.46);
  });

  it('keeps resting, and does not guess, when the read or the cancel fails', async () => {
    enable();
    await run();
    vi.setSystemTime(at('08:57:05'));
    fetchOrder.mockRejectedValueOnce(new Error('network'));
    expect((await reconcileRequest('forward:limit-1')).status).toBe('PENDING');
    fetchOrder.mockResolvedValueOnce(open());
    cancelOrder.mockRejectedValueOnce(new Error('network'));
    expect((await reconcileRequest('forward:limit-1')).status).toBe('PENDING');
    expect(findRequest('forward:limit-1')?.state).toBe('RESTING');
    expect(reservedBudget(false)).toBe(10);
  });

  it('flags an order that outlived its market, so someone looks at it', async () => {
    enable();
    await run();
    vi.setSystemTime(at('09:11:00'));
    fetchOrder.mockRejectedValue(new Error('network'));
    expect((await reconcileRequest('forward:limit-1')).status).toBe('UNKNOWN');
  });

  it('does not send a limit order after minute 57, or one that cannot reach the minimum size', async () => {
    enable();
    vi.setSystemTime(at('08:58:00'));
    expect((await run()).error).toMatch(/دیر است/);
    expect(postOrder).not.toHaveBeenCalled();
    vi.setSystemTime(at('08:30:00'));
    enable(true, { 'bot.perTradeAmount': 2 }); // 2 dollars buys 4 shares at 0.46: under the 5 share minimum
    expect((await run('forward:limit-2')).error).toMatch(/کافی نیست/);
    expect(postOrder).not.toHaveBeenCalled();
  });

  it('is for Deposit Wallet only', async () => {
    enable(true, { 'bot.walletType': 'EOA' });
    const r = await run();
    expect(r.error).toMatch(/Deposit Wallet/);
    expect(postOrder).not.toHaveBeenCalled();
  });

  it('after a lost response, finds the live order and follows it instead of treating it as a failed FOK', async () => {
    enable();
    postOrder.mockRejectedValueOnce(new Error('socket hang up'));
    const r = await run();
    expect(r.status).toBe('PENDING');
    expect(findRequest('forward:limit-1')?.state).toBe('RESTING');
    expect(findRequest('forward:limit-1')?.result).toBeNull(); // the UNKNOWN result it had must not leak into a purchase message
  });

  it('never settles a limit order as "not placed" just because the exchange cannot find it for a while', async () => {
    enable();
    postOrder.mockRejectedValue(new Error('socket hang up'));
    fetchOrder.mockRejectedValue(new Error('not found'));
    (deposit.createDepositWalletClient as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ client: { createLimitOrder, postOrder, fetchOrder, cancelOrder, listAccountTrades: () => ({ firstPage: async () => ({ items: [] }) }) } });
    await run();
    vi.setSystemTime(at('08:50:00'));
    const r = await reconcileRequest('forward:limit-1');
    expect(r.status).toBe('UNKNOWN');
    expect(findRequest('forward:limit-1')?.state).toBe('UNKNOWN');
    expect(reservedBudget(false)).toBe(10);
  });

  it('simulation: rests against the real book, fills when the ask reaches the price, otherwise misses at minute 57', async () => {
    enable(false);
    const r = await run();
    expect(r).toMatchObject({ status: 'PENDING', simulated: true, price: 0.46 });
    expect(postOrder).not.toHaveBeenCalled();
    bestAsk = '0.46';
    expect(await reconcileRequest('forward:limit-1')).toMatchObject({ success: true, status: 'SIMULATED', shares: 21.73 });

    bestAsk = '0.5';
    await run('forward:limit-2');
    expect((await reconcileRequest('forward:limit-2')).status).toBe('PENDING');
    vi.setSystemTime(at('08:57:10'));
    expect(await reconcileRequest('forward:limit-2')).toMatchObject({ success: false, status: 'FAILED' });
  });

  it('a resting order produces no purchase message; the fill and the miss each produce one, with the reason for a miss', async () => {
    enable();
    await run();
    initNotifications();
    collectNotifications();
    expect(db.prepare("SELECT event FROM bot_notifications WHERE event LIKE 'purchase:%'").all()).toHaveLength(0);
    vi.setSystemTime(at('08:57:05'));
    fetchOrder.mockResolvedValueOnce(open()).mockResolvedValueOnce(open({ status: 'CANCELED' }));
    await reconcileRequest('forward:limit-1');
    collectNotifications();
    const [m] = db.prepare("SELECT message FROM bot_notifications WHERE event LIKE 'purchase:%'").all() as { message: string }[];
    expect(m.message).toContain('خرید انجام نشد');
    expect(m.message).toContain('لغو شد');
  });

  it('the forward bridge tells you when a limit order is resting, once', async () => {
    vi.setSystemTime(at('08:40:00'));
    enable(true, { 'bot.forwardEnabled': true, 'bot.forwardStrategy': 'v2' });
    setBotSetting('forward.strategy', 'v2');
    db.prepare('UPDATE bot_forward_gate SET armed_at=?').run(at('08:30:00').getTime());
    const row: SnapshotRow = { filename: 'btc_39.json', coin: 'BTC', timestamp: '2026-10-08T08:39:00Z', et_time: '2026-10-08 04:39:00 ET', market_slug: buildHourlyEtSlug('btc'), score: 4, score_confidence: 95, direction: 'UP', kev_direction: 'UP', span_direction: 'UP', up_1h_num: 50 };
    const execute = vi.fn(async () => ({ success: false, status: 'PENDING', price: 0.46, shares: 21.73, outcome: 'UP' }) as TradeResult);
    await runForwardCycle([row], execute, async () => '');
    await runForwardCycle([row], execute, async () => '');
    expect(execute).toHaveBeenCalledTimes(1);
    const rows = db.prepare("SELECT message FROM bot_notifications WHERE event LIKE 'resting:%'").all() as { message: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toContain('قیمت لیمیت: 46¢');
  });
});
