import { getDb } from '../db';
import { getBotWalletConfig, walletIdentity } from './live';
import { createRedemptionChain, type RedemptionChain } from './redeemChain';
import { discoverRedemptions, type Redemption } from './redeemDb';
import { enqueueNotification } from './notifications';

/** Read-only settlement watcher, also runs while new purchases/auto-redeem are paused. */
export async function runOutcomeCycle(factory: () => RedemptionChain = createRedemptionChain) {
  const cfg = getBotWalletConfig();
  if (!cfg.isConfigured || !cfg.signerAddress || !cfg.address) return;
  const wallet = walletIdentity();
  discoverRedemptions(wallet, cfg.signerAddress, cfg.address);
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS bot_outcomes (redemption_id INTEGER PRIMARY KEY, outcome TEXT, next_at INTEGER NOT NULL DEFAULT 0)`);
  db.prepare('INSERT OR IGNORE INTO bot_outcomes(redemption_id) SELECT id FROM bot_redemptions WHERE wallet=?').run(wallet);
  const rows = db.prepare(`SELECT r.* FROM bot_redemptions r JOIN bot_outcomes o ON o.redemption_id=r.id
    WHERE r.wallet=? AND o.outcome IS NULL AND o.next_at<=? ORDER BY o.next_at,r.id LIMIT 10`).all(wallet, Date.now()) as Redemption[];
  if (!rows.length) return;
  const chain = factory();
  for (const row of rows) {
    db.prepare('UPDATE bot_outcomes SET next_at=? WHERE redemption_id=?').run(Date.now() + 60_000, row.id);
    try {
      const state = row.state === 'CONFIRMED' ? 'WINNER' : (await chain.inspect(row)).state;
      if (state !== 'WINNER' && state !== 'LOSER') continue;
      const cost = db.prepare("SELECT COALESCE(SUM(json_extract(result,'$.amountUsd')),0) AS amount FROM bot_requests WHERE wallet=? AND token_id=? AND state='FILLED' AND simulated=0").get(wallet, row.token_id) as { amount: number };
      const win = state === 'WINNER', payout = win ? row.shares : 0;
      db.transaction(() => {
        enqueueNotification(`outcome:${row.id}`, `${win ? '🏆 نتیجه نهایی: برد' : '🔴 نتیجه نهایی: باخت'}\n${row.slug}\nبازپرداخت اسمی: $${payout.toFixed(4)}\nسود/زیان پیش از گس: $${(payout - cost.amount).toFixed(4)}\n${win ? 'تأیید دریافت وجه در پیام جداگانهٔ Redeem اعلام می‌شود.' : 'سهم بازنده بازپرداخت ندارد.'}`);
        db.prepare('UPDATE bot_outcomes SET outcome=? WHERE redemption_id=?').run(win ? 'WIN' : 'LOSS', row.id);
      })();
    } catch { /* Metadata/RPC uncertainty must never be announced as a result. */ }
  }
}
