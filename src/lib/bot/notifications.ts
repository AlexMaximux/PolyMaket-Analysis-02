import { getDb } from '../db';
import { getSetting } from '../settings';
import { findRequest, type BotRequest } from './ledger';
import { initRedemptions, type Redemption } from './redeemDb';
import type { TradeResult } from './types';

export function initNotifications() {
  getDb().exec(`CREATE TABLE IF NOT EXISTS bot_notifications (
    event TEXT PRIMARY KEY, message TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'PENDING',
    attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
    message_id INTEGER, last_error TEXT
  )`);
}
export function enqueueNotification(event: string, message: string) {
  initNotifications();
  getDb().prepare('INSERT OR IGNORE INTO bot_notifications(event,message) VALUES(?,?)').run(event, message);
}
export function collectNotifications() {
  findRequest('__init__'); initRedemptions();
  const rows = getDb().prepare("SELECT * FROM bot_requests WHERE request_id LIKE 'forward:%' AND result IS NOT NULL").all() as BotRequest[];
  for (const row of rows) {
    const r = JSON.parse(row.result!) as TradeResult;
    const title = row.state === 'FILLED' ? '✅ خرید واقعی تأیید شد' : row.state === 'SIMULATED' ? '🧪 خرید آزمایشی؛ بدون خرج پول' : row.state === 'UNKNOWN' ? '⏳ وضعیت خرید نامشخص؛ سفارش جدید ارسال نمی‌شود' : '❌ خرید انجام نشد';
    enqueueNotification(`purchase:${row.request_id}:${row.state}`, `${title}\nBTC 1H ${r.outcome}\n${r.slug || ''}\nمبلغ: $${r.amountUsd}\nسهم: ${r.shares ?? '—'}\nقیمت: ${r.price ?? '—'}\nسفارش: ${r.orderId || '—'}\nشناسه: ${row.request_id}`);
  }
  const redemptions = getDb().prepare("SELECT * FROM bot_redemptions WHERE state='CONFIRMED'").all() as Redemption[];
  for (const row of redemptions) {
    enqueueNotification(`redeem:${row.id}:${row.tx_hash}`, `💰 Redeem تأیید شد\n${row.slug}\nدریافت: ${row.payout} USDC.e\nکارمزد: ${row.gas_pol} POL\nhttps://polygonscan.com/tx/${row.tx_hash}`);
  }
}
/** Durable at-least-once delivery. A timeout after Telegram accepts may duplicate a message, never a trade. */
export async function deliverNotifications(send = fetch) {
  initNotifications();
  const token = getSetting('bot.telegramToken'), chat = getSetting('bot.telegramChatId');
  if (!token || !/^\d+$/.test(chat)) return;
  for (let i = 0; i < 10; i++) {
    const row = getDb().transaction(() => {
      const r = getDb().prepare("SELECT event,message,attempts FROM bot_notifications WHERE state='PENDING' AND next_at<=? ORDER BY rowid LIMIT 1")
        .get(Date.now()) as { event: string; message: string; attempts: number } | undefined;
      if (r) getDb().prepare('UPDATE bot_notifications SET next_at=?,attempts=attempts+1 WHERE event=?').run(Date.now() + 60_000, r.event);
      return r;
    }).immediate();
    if (!row) return;
    try {
      const response = await send(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ chat_id: chat, text: row.message, disable_web_page_preview: true }),
      });
      const body = await response.json();
      if (!response.ok || body.ok !== true || !Number.isInteger(body.result?.message_id)) throw new Error('not accepted');
      getDb().prepare("UPDATE bot_notifications SET state='SENT',message_id=?,last_error=NULL WHERE event=?").run(body.result.message_id, row.event);
      console.log(`[TELEGRAM] Delivered · ${row.event}`);
    } catch {
      getDb().prepare('UPDATE bot_notifications SET next_at=?,last_error=? WHERE event=?').run(Date.now() + Math.min(3600_000, 30_000 * 2 ** Math.min(row.attempts, 7)), 'Telegram delivery unconfirmed; retry scheduled', row.event);
      return;
    }
  }
}
export function notificationStatus() {
  initNotifications();
  return getDb().prepare("SELECT COUNT(*) AS pending, COALESCE(SUM(last_error IS NOT NULL),0) AS failed FROM bot_notifications WHERE state='PENDING'").get() as { pending: number; failed: number };
}
