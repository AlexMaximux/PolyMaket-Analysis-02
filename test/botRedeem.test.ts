import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as dbModule from '../src/lib/db';
import { applySettingChanges } from '../src/lib/settings';
import { runRedemptionCycle, getRedemptionStatus } from '../src/lib/bot/redeem';
import { initRedemptions, redemptionSummary, claimRedemption, redemption, discoverRedemptions } from '../src/lib/bot/redeemDb';
import { walletIdentity, getBotWalletConfig } from '../src/lib/bot/live';
import { getTotalSpent, recordBotTrade } from '../src/lib/bot/db';
import { RedemptionError, type RedemptionChain } from '../src/lib/bot/redeemChain';

const KEY = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const condition = `0x${'a'.repeat(64)}` as const;
describe('automatic redemption worker', () => {
  let db: Database.Database, clock: number;
  let chain: RedemptionChain;
  beforeEach(() => {
    db = new Database(':memory:');
    dbModule.initializeDb(db);
    vi.spyOn(dbModule, 'getDb').mockReturnValue(db);
    clock = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => clock);
    applySettingChanges({ 'bot.enabled': true, 'bot.privateKey': KEY, 'bot.simulationMode': false }, db);
    initRedemptions();
    chain = {
      inspect: vi.fn().mockResolvedValue({ state: 'WINNER', position: { condition, indexSet: 1, balance: BigInt(20_000_000) } }),
      prepare: vi.fn().mockResolvedValue({ raw: '0x1234', hash: `0x${'b'.repeat(64)}` }),
      broadcast: vi.fn().mockResolvedValue(undefined),
      receipt: vi.fn().mockResolvedValue({ state: 'PENDING' }),
    };
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); });
  function seed(id = 'purchase-1', token = '1234', wallet = walletIdentity(), simulated = 0) {
    db.prepare(`INSERT INTO bot_requests(request_id,fingerprint,state,simulated,amount,created_at,updated_at,token_id,slug,wallet,result)
      VALUES(?,?,'FILLED',?,10,0,0,?,'bitcoin-up-or-down-test-et',?,?)`)
      .run(id, '{}', simulated, token, wallet, JSON.stringify({ shares: 20 }));
  }
  const cycle = () => runRedemptionCycle(() => chain);
  it('signs and saves one transaction before broadcasting, then confirms exactly once', async () => {
    seed();
    vi.mocked(chain.broadcast).mockImplementation(async () => {
      const row = db.prepare('SELECT state,raw_tx,tx_hash FROM bot_redemptions').get();
      expect(row).toMatchObject({ state: 'SUBMITTED', raw_tx: '0x1234' });
    });
    await cycle();
    expect(chain.broadcast).toHaveBeenCalledTimes(1);
    vi.mocked(chain.receipt).mockResolvedValue({ state: 'CONFIRMED', payout: '20', gas: '0.002', error: null });
    await cycle(); await cycle();
    expect(redemptionSummary().totalRedeemed).toBe(20);
    expect(chain.prepare).toHaveBeenCalledTimes(1);
    expect(chain.broadcast).toHaveBeenCalledTimes(1);
    expect(redemption(1).raw_tx).toBeNull();
  });
  it('does not touch simulation or another wallet or untracked historical trades', async () => {
    seed('sim', '1', walletIdentity(), 1); seed('other', '2', 'different-wallet');
    recordBotTrade({ timestamp: 0, symbol: 'BTC', timeframe: '1H', outcome: 'UP', slug: 'old', token_id: '3', amount_usd: 10, shares: 20, price: 0.5, status: 'FILLED', order_id: null, tx_hash: null, source: 'api', error_message: null });
    await cycle(); expect(chain.inspect).not.toHaveBeenCalled(); expect(chain.prepare).not.toHaveBeenCalled();
  });
  it.each(['WAITING', 'LOSER', 'EMPTY'] as const)('does not sign for %s', async state => {
    seed(); vi.mocked(chain.inspect).mockResolvedValue({ state });
    await cycle(); expect(chain.prepare).not.toHaveBeenCalled(); expect(redemption(1).state).toBe(state);
  });
  it('resends identical signed bytes after ambiguous broadcast, never another nonce', async () => {
    seed(); vi.mocked(chain.broadcast).mockRejectedValueOnce(new Error('RPC timeout with sensitive contents'));
    await cycle(); expect(redemption(1).state).toBe('SUBMITTED');
    clock += 61_000; await cycle();
    expect(chain.prepare).toHaveBeenCalledTimes(1);
    expect(chain.broadcast).toHaveBeenNthCalledWith(1, '0x1234');
    expect(chain.broadcast).toHaveBeenNthCalledWith(2, '0x1234');
    expect(JSON.stringify(getRedemptionStatus())).not.toContain('sensitive');
  });
  it('blocks a second redemption while an earlier transaction is unconfirmed', async () => {
    seed(); seed('second', '5678'); await cycle();
    clock += 61_000; await cycle();
    expect(chain.prepare).toHaveBeenCalledTimes(1);
    expect(redemptionSummary().recent.filter(r => r.state === 'SUBMITTED')).toHaveLength(1);
  });
  it('serializes concurrent workers with a durable lease', async () => {
    seed(); await Promise.all([cycle(), cycle()]);
    expect(chain.prepare).toHaveBeenCalledTimes(1); expect(chain.broadcast).toHaveBeenCalledTimes(1);
  });
  it('stops new transactions and rebroadcasts when auto-redeem is disabled, but can record a confirmed receipt', async () => {
    seed(); applySettingChanges({ 'bot.autoRedeem': false }, db); await cycle();
    expect(chain.prepare).not.toHaveBeenCalled();
    applySettingChanges({ 'bot.autoRedeem': true }, db); await cycle();
    applySettingChanges({ 'bot.autoRedeem': false }, db); clock += 61_000; await cycle();
    expect(chain.broadcast).toHaveBeenCalledTimes(1);
    vi.mocked(chain.receipt).mockResolvedValue({ state: 'CONFIRMED', payout: '20', gas: '0.002', error: null });
    await cycle(); expect(redemptionSummary().totalRedeemed).toBe(20);
  });
  it('checks the kill switch again after signing', async () => {
    seed(); vi.mocked(chain.prepare).mockImplementation(async () => {
      applySettingChanges({ 'bot.autoRedeem': false }, db);
      return { raw: '0x1234', hash: `0x${'b'.repeat(64)}` };
    });
    await cycle(); expect(chain.broadcast).not.toHaveBeenCalled(); expect(redemption(1).state).toBe('WAITING');
  });
  it('does not send if the database cannot persist the signed transaction', async () => {
    seed();
    db.exec("CREATE TRIGGER refuse_submission BEFORE UPDATE ON bot_redemptions WHEN NEW.state='SUBMITTED' BEGIN SELECT RAISE(ABORT,'disk failure'); END");
    await cycle(); expect(chain.broadcast).not.toHaveBeenCalled();
  });
  it('recovers a stale preparation lease after restart', async () => {
    seed(); const cfg = getBotWalletConfig();
    discoverRedemptions(walletIdentity(), cfg.signerAddress!, cfg.address!);
    const old = claimRedemption(walletIdentity(), cfg.signerAddress!);
    expect(old).not.toBeNull(); clock += 121_000;
    await cycle(); expect(chain.broadcast).toHaveBeenCalledTimes(1);
  });
  it('does not send if its preparation lease expires', async () => {
    seed(); vi.mocked(chain.prepare).mockImplementation(async () => {
      clock += 121_000; return { raw: '0x1234', hash: `0x${'b'.repeat(64)}` };
    });
    await cycle(); expect(chain.broadcast).not.toHaveBeenCalled();
  });
  it('reports gas/ownership errors without spending or retrying every second', async () => {
    seed(); vi.mocked(chain.prepare).mockRejectedValue(new RedemptionError('POL کافی نیست'));
    await cycle(); await cycle();
    expect(chain.prepare).toHaveBeenCalledTimes(1); expect(chain.broadcast).not.toHaveBeenCalled();
    expect(redemption(1).error).toContain('POL');
  });
  it('does not increase buying budget after redemption', async () => {
    seed(); recordBotTrade({ timestamp: 0, symbol: 'BTC', timeframe: '1H', outcome: 'UP', slug: 'old', token_id: '1234', amount_usd: 10, shares: 20, price: 0.5, status: 'FILLED', order_id: 'order-1', tx_hash: null, source: 'api', error_message: null });
    await cycle(); vi.mocked(chain.receipt).mockResolvedValue({ state: 'CONFIRMED', payout: '20', gas: '0.002', error: null });
    await cycle(); expect(getTotalSpent(false)).toBe(10);
  });
  it('caps fresh attempts after three confirmed failures', async () => {
    seed(); vi.mocked(chain.receipt).mockResolvedValue({ state: 'FAILED', payout: null, gas: '0.001', error: 'reverted' });
    for (let i = 0; i < 4; i++) { await cycle(); await cycle(); clock += 301_000; }
    expect(chain.prepare).toHaveBeenCalledTimes(3); expect(redemption(1).state).toBe('FAILED');
  });
});
