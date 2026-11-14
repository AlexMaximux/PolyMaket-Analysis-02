import { getDb } from '../db';
import { getSetting } from '../settings';
import { getResolutionsMap } from '../marketResolver';
import { getBotBudgetLimits, initializeBotTables } from './db';
import { pendingRequests } from './ledger';
import { getBotWalletConfig } from './live';
import { getDepositCollateralBalanceUsd } from './depositWallet';
import { enqueueNotification } from './notifications';
import type { SignalRequest } from './types';

// Polymarket normally wants at least 5 shares; $5 covers that at any valid price.
export const MIN_STAKE_USD = 5;
// The balance read must never hold an order back for long (same cap as the balance line of the Telegram message).
export const STAKE_BALANCE_TIMEOUT_MS = 3_000;

export interface StakeDecision {
  amount: number;
  plan: 'fixed' | 'p4';
  balance: number | null; // the balance the percentage was taken of (null: fixed amount, or the balance could not be read)
  percent: number | null; // the percentage actually staked, doubled after a loss
  afterLoss: boolean;
  fallback: boolean; // P4 was chosen but the balance could not be read, so the fixed amount was used
  reason?: string;
}

export interface StakeDeps {
  /** The wallet balance in dollars, or null with a reason when it cannot be read. */
  readBalance?: () => Promise<{ usd: number } | { error: string }>;
  /** True when the last forward trade of this mode lost. */
  lastTradeLost?: (simulated: boolean) => boolean;
}

/** P4 applies to forward-bridge buys only (source 'signal'), never to Telegram or API buys. */
export const isStakePlanRequest = (signal: SignalRequest) => signal.source === 'signal' && getSetting('bot.stakePlan') === 'p4';

const floorCents = (n: number) => Math.floor(n * 100 + 1e-9) / 100;

/** The balance of a Deposit Wallet on Polymarket; the only wallet type the bot can read a balance for. Never throws. */
async function readWalletBalance(): Promise<{ usd: number } | { error: string }> {
  try {
    const wallet = getBotWalletConfig();
    if (!wallet.isConfigured) return { error: 'کیف پول معتبر تنظیم نشده است' };
    if (wallet.walletType !== 'DEPOSIT_WALLET') return { error: 'خواندن موجودی فقط برای Deposit Wallet ممکن است' };
  } catch {
    return { error: 'تنظیمات کیف پول خوانده نشد' };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const usd = await Promise.race([
      getDepositCollateralBalanceUsd(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), STAKE_BALANCE_TIMEOUT_MS); }),
    ]);
    return Number.isFinite(usd) ? { usd } : { error: 'موجودی عدد معتبر نبود' };
  } catch (e) {
    return { error: e instanceof Error && e.message === 'timeout' ? 'خواندن موجودی بیش از حد طول کشید' : 'خواندن موجودی ناموفق بود' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * True when the most recent forward trade of this mode (paper or real) lost: its market resolved against the side bought.
 * A market that has not resolved yet (the 10-30 minute resolution window after the hour) counts as not lost, so an
 * unknown result never doubles a stake.
 */
export function lastForwardTradeLost(simulated: boolean): boolean {
  try {
    initializeBotTables();
    const row = getDb().prepare("SELECT slug, outcome FROM bot_trades WHERE status = ? AND source = 'signal' AND slug IS NOT NULL AND slug <> '' ORDER BY id DESC LIMIT 1")
      .get(simulated ? 'SIMULATED' : 'FILLED') as { slug: string; outcome: string } | undefined;
    if (!row) return false;
    const resolved = getResolutionsMap()[row.slug];
    return (resolved === 'UP' || resolved === 'DOWN') && resolved !== row.outcome;
  } catch {
    return false;
  }
}

/**
 * How many dollars this signal stakes. fixed (the default) and every non-forward signal: bot.perTradeAmount.
 * P4: bot.stakePercent of the wallet balance (paper mode: of bot.maxBudget), twice that percent when the last forward trade
 * lost, at least $5, never above bot.stakeCap or the balance. When the balance cannot be read the fixed amount is used and a
 * Telegram message says so. Never throws.
 */
export async function decideStake(signal: SignalRequest, deps: StakeDeps = {}): Promise<StakeDecision> {
  const limits = getBotBudgetLimits();
  const fixed: StakeDecision = { amount: limits.perTrade, plan: 'fixed', balance: null, percent: null, afterLoss: false, fallback: false };
  try {
    if (!isStakePlanRequest(signal)) return fixed;
    // reserveRequest refuses these; do not read a balance or send a message for a request that cannot go on
    if (!getSetting('bot.enabled') || pendingRequests(limits.simulationMode).length) return fixed;
    const simulated = limits.simulationMode;
    const percent = getSetting('bot.stakePercent');
    const cap = getSetting('bot.stakeCap');
    let balance: number | null = null;
    let reason = '';
    if (simulated) balance = limits.maxBudget;
    else {
      const read = await (deps.readBalance ?? readWalletBalance)();
      if ('usd' in read) balance = read.usd;
      else reason = read.error;
    }
    if (balance != null && !(balance >= MIN_STAKE_USD)) { reason = `موجودی ($${balance.toFixed(2)}) کمتر از حداقل مبلغ سفارش است`; balance = null; }
    if (balance == null) {
      const decision: StakeDecision = { ...fixed, fallback: true, reason };
      console.warn(`[STAKE] P4: balance unavailable (${reason}); using the fixed amount $${fixed.amount}`);
      try {
        enqueueNotification(`stake-fallback:${signal.requestId}`, `⚠️ P4: موجودی کیف پول خوانده نشد؛ برای این معامله مبلغ ثابت $${fixed.amount} استفاده شد.\nعلت: ${reason}\nBTC 1H ${signal.outcome}\nشناسه: ${signal.requestId}`);
      } catch { /* a failed message must not stop the order */ }
      return decision;
    }
    const afterLoss = (deps.lastTradeLost ?? lastForwardTradeLost)(simulated);
    const used = percent * (afterLoss ? 2 : 1);
    const amount = Math.min(Math.max(floorCents((used / 100) * balance), MIN_STAKE_USD), cap, balance);
    console.log(`[STAKE] P4: ${used}% of $${balance.toFixed(2)}${afterLoss ? ' (after a loss)' : ''}${simulated ? ' (paper: budget cap)' : ''} -> $${amount.toFixed(2)}`);
    return { amount: floorCents(amount), plan: 'p4', balance, percent: used, afterLoss, fallback: false };
  } catch (e) {
    console.error('[STAKE] P4 failed, using the fixed amount:', e instanceof Error ? e.message : e);
    return { ...fixed, fallback: true, reason: 'خطای محاسبه' };
  }
}
