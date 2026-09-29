import { runOutcomeCycle } from './outcomes';
import { getSetting } from '../settings';
import { getBotSetting, setBotSetting } from './db';
import { getBotWalletConfig, walletIdentity } from './live';
import { createRedemptionChain, RedemptionError, type RedemptionChain } from './redeemChain';
import {
  discoverRedemptions, claimRedemption, releaseRedemption, saveSignedRedemption,
  submittedRedemption, claimBroadcast, finishRedemption, redemptionSummary, type Redemption,
} from './redeemDb';
import type { Hex } from 'viem';
import { inspectDepositRedemption, reconcileDepositRedemption, submitDepositRedemption } from './depositRedeem';

export const REDEEM_INTERVAL_MS = 60_000;
function enabled() {
  // Redemption only considers confirmed real purchases from the durable ledger, so it can
  // remain active while the buy kill switch is off or paper trading is selected.
  return getSetting('bot.autoRedeem');
}
function publicError(e: unknown) {
  return e instanceof RedemptionError ? e.message : 'بررسی یا ارسال Redeem ناموفق بود؛ وضعیت ذخیره‌شده حفظ شد و تراکنش تازه‌ای جایگزین نشد.';
}
async function reconcile(row: Redemption, chain: RedemptionChain) {
  const receipt = await chain.receipt(row);
  if (receipt.state !== 'PENDING') {
    finishRedemption(row, receipt.state, receipt.payout, receipt.gas, receipt.error);
    return;
  }
  // Recover a crash after signing or an ambiguous broadcast by resending identical bytes only.
  if (enabled() && row.wallet === walletIdentity() && row.raw_tx && claimBroadcast(row)) {
    await chain.broadcast(row.raw_tx as Hex);
  }
}
/** One serialized scan; independently runnable from Telegram. Never runs during a status GET. */
export async function runRedemptionCycle(factory: () => RedemptionChain = createRedemptionChain) {
  const cfg = getBotWalletConfig();
  if (!cfg.isConfigured || !cfg.signerAddress || !cfg.address) return;
  const identity = walletIdentity();
  try {
    setBotSetting('redeem.lastError', '');
    const outstanding = submittedRedemption(cfg.signerAddress);
    if (outstanding) {
      if (cfg.walletType === 'DEPOSIT_WALLET') await reconcileDepositRedemption(outstanding);
      else await reconcile(outstanding, factory());
      return;
    }
    if (!enabled()) return;
    discoverRedemptions(identity, cfg.signerAddress, cfg.address);
    const chain = factory();
    for (let i = 0; i < 10 && enabled() && identity === walletIdentity(); i++) {
      const row = claimRedemption(identity, cfg.signerAddress);
      if (!row) break;
      try {
        if (cfg.walletType === 'DEPOSIT_WALLET') {
          const inspection = await inspectDepositRedemption(row);
          if (inspection.state !== 'WINNER') {
            releaseRedemption(row, inspection.state, null);
            continue;
          }
          if (!enabled() || identity !== walletIdentity()) {
            releaseRedemption(row, 'WAITING', 'تنظیمات تغییر کرد؛ Redeem ارسال نشد.');
            break;
          }
          await submitDepositRedemption(row, inspection.conditionId);
          break;
        }
        const inspection = await chain.inspect(row);
        if (inspection.state !== 'WINNER') {
          releaseRedemption(row, inspection.state, null);
          continue;
        }
        if (!enabled() || identity !== walletIdentity()) {
          releaseRedemption(row, 'WAITING', 'تنظیمات تغییر کرد؛ Redeem ارسال نشد.');
          break;
        }
        const signed = await chain.prepare(inspection.position);
        if (!enabled() || identity !== walletIdentity()) {
          releaseRedemption(row, 'WAITING', 'تنظیمات تغییر کرد؛ Redeem ارسال نشد.');
          break;
        }
        // This write MUST commit before the first broadcast; a restart retains the hash and nonce.
        const submitted = saveSignedRedemption(row, inspection.position.condition, inspection.position.indexSet, signed.raw, signed.hash);
        if (claimBroadcast(submitted)) await chain.broadcast(signed.raw);
        break; // only one in-flight transaction per signer, including Proxy/Safe wallets
      } catch (e) {
        // No-op for SUBMITTED: ambiguous broadcast/DB failure must never create a fresh transaction.
        releaseRedemption(row, 'ERROR', publicError(e), 300_000);
        setBotSetting('redeem.lastError', publicError(e));
        break;
      }
    }
  } catch (e) {
    setBotSetting('redeem.lastError', publicError(e));
  } finally {
    setBotSetting('redeem.lastScan', String(Date.now()));
  }
}
export async function startRedemptionWorker() {
  while (true) {
    try { await runRedemptionCycle(); await runOutcomeCycle(); }
    catch { console.error('[REDEEM] Scan failed; no unsafe retry performed.'); }
    await new Promise(resolve => setTimeout(resolve, REDEEM_INTERVAL_MS));
  }
}
export function getRedemptionStatus() {
  const depositWallet = getBotWalletConfig().walletType === 'DEPOSIT_WALLET';
  return {
    enabled: getSetting('bot.autoRedeem'),
    active: enabled(), collateral: depositWallet ? 'Polymarket collateral' : 'USDC.e',
    gasless: depositWallet, maxGasPol: getSetting('bot.redeemMaxGasPol'),
    lastScan: Number(getBotSetting('redeem.lastScan', '0')) || null,
    lastError: getBotSetting('redeem.lastError', '') || null,
    ...redemptionSummary(),
  };
}
