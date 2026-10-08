import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as dbModule from '../src/lib/db';
import { applySettingChanges } from '../src/lib/settings';
import { walletBalanceLine, withBalanceLine } from '../src/lib/bot/balance';
import { runForwardCycle } from '../src/lib/bot/forward';
import { buildHourlyEtSlug } from '../src/lib/bot/executor';
import type { SnapshotRow } from '../src/lib/signalAnalysis';
import { setBotSetting } from '../src/lib/bot/db';
import type { TradeResult } from '../src/lib/bot/types';

const KEY = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const PROXY = '0x23673C5e7603e13399dbBe35c846EbAeF0a071a1';
const NOW = Date.parse('2026-09-28T18:40:00Z');
let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:'); dbModule.initializeDb(db); vi.spyOn(dbModule, 'getDb').mockReturnValue(db);
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

const depositWallet = () => applySettingChanges({ 'bot.privateKey': KEY, 'bot.walletType': 'DEPOSIT_WALLET', 'bot.proxyAddress': PROXY });

describe('walletBalanceLine', () => {
  it('is empty when no balance can be read for the wallet, so those messages stay as they were', async () => {
    const read = vi.fn().mockResolvedValue(10);
    expect(await walletBalanceLine(read)).toBe(''); // no wallet set up
    applySettingChanges({ 'bot.privateKey': KEY }); // an EOA wallet: the bot reads a balance for Deposit Wallets only
    expect(await walletBalanceLine(read)).toBe('');
    expect(read).not.toHaveBeenCalled();
  });
  it('shows the balance in dollars with two decimals', async () => {
    depositWallet();
    expect(await walletBalanceLine(async () => 123.456)).toBe('💼 موجودی کیف پول قبل از سفارش: $123.46');
    expect(await walletBalanceLine(async () => 0)).toBe('💼 موجودی کیف پول قبل از سفارش: $0.00');
  });
  it('says the balance is unknown when the read fails or returns nonsense, and never throws', async () => {
    depositWallet();
    const unknown = '💼 موجودی کیف پول قبل از سفارش: نامشخص (خواندن ممکن نشد)';
    expect(await walletBalanceLine(async () => { throw new Error('network'); })).toBe(unknown);
    expect(await walletBalanceLine(async () => NaN)).toBe(unknown);
  });
  it('gives up after the timeout instead of holding the order back', async () => {
    depositWallet();
    const never = () => new Promise<number>(() => {});
    vi.useFakeTimers();
    const pending = walletBalanceLine(never, 50);
    await vi.advanceTimersByTimeAsync(60);
    expect(await pending).toContain('نامشخص');
    vi.useRealTimers();
  });
  it('puts the line first, with a blank line before the message', () => {
    expect(withBalanceLine('💼 line', 'message')).toBe('💼 line\n\nmessage');
    expect(withBalanceLine('', 'message')).toBe('message');
  });
});

describe('forward signal message', () => {
  function row(): SnapshotRow {
    return { filename: 'btc_39.json', coin: 'BTC', timestamp: '2026-09-28T18:39:00Z', et_time: '2026-09-28 14:39:00 ET', market_slug: buildHourlyEtSlug('btc'), score: 4, score_confidence: 95, direction: 'UP', kev_direction: 'UP', span_direction: 'UP', up_1h_num: 50 };
  }
  const queued = () => db.prepare("SELECT message FROM bot_notifications WHERE event LIKE 'signal:%'").all() as { message: string }[];
  function arm() {
    applySettingChanges({ 'bot.enabled': true, 'bot.forwardEnabled': true, 'bot.forwardStrategy': 'v2' });
    setBotSetting('forward.strategy', 'v2'); // the strategy last scanned: a different one would re-arm the bridge
    db.prepare('UPDATE bot_forward_gate SET armed_at=?').run(NOW - 120_000);
  }

  it('starts with the wallet balance, read before the order is sent', async () => {
    arm();
    const order: string[] = [];
    const balance = vi.fn(async () => { order.push('balance'); return '💼 موجودی کیف پول قبل از سفارش: $42.00'; });
    const execute = vi.fn(async () => { order.push('order'); return { success: false } as TradeResult; });
    await runForwardCycle([row()], execute, balance);
    expect(order).toEqual(['balance', 'order']);
    const [m] = queued();
    expect(m.message.startsWith('💼 موجودی کیف پول قبل از سفارش: $42.00\n\n📥')).toBe(true);
  });
  it('is unchanged when there is no balance line', async () => {
    arm();
    await runForwardCycle([row()], vi.fn(async () => ({ success: false }) as TradeResult), async () => '');
    expect(queued()[0].message.startsWith('📥')).toBe(true);
  });
});
