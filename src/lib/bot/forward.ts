import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getDb } from '../db';
import { getSetting } from '../settings';
import { FROZEN_STRATEGY, FROZEN_STRATEGY_5, buildTrades, filterBaseRows, type FrozenStrategy, type SnapshotRow } from '../signalAnalysis';
import { forwardSnapshotRow } from '../forwardSnapshot';
import { buildHourlyEtSlug, executeSignal, reconcileRequest } from './executor';
import { findRequest, pendingRequests } from './ledger';
import { enqueueNotification, collectNotifications, deliverNotifications } from './notifications';
import { walletBalanceLine, withBalanceLine } from './balance';
import { getBotSetting, setBotSetting } from './db';
import type { SignalRequest, TradeResult } from './types';

export const FORWARD_MAX_AGE_MS = 120_000;
// The strategies setting bot.forwardStrategy can pick. Each may use only the fields forwardSnapshotRow fills in.
export const BOT_STRATEGIES: FrozenStrategy[] = [FROZEN_STRATEGY, FROZEN_STRATEGY_5];
export function botStrategy(): FrozenStrategy | null {
  return BOT_STRATEGIES.find(s => s.id === getSetting('bot.forwardStrategy')) ?? null;
}
export function selectForwardSignal(rows: SnapshotRow[], now: number, armedAt: number, slug: string, strategy: FrozenStrategy): SignalRequest | null {
  const rule = strategy.rule;
  // Deduplicate BEFORE freshness/activation filtering: never substitute a later signal in the same hour.
  const trades = buildTrades(filterBaseRows(rows.filter(r => Date.parse(r.timestamp || '') >= Date.parse(strategy.frozenAt)), rule), rule);
  const t = trades.find(t => t.row.market_slug === slug);
  if (!t || t.time <= armedAt || t.time > now || now - t.time > FORWARD_MAX_AGE_MS) return null;
  return {
    symbol: 'BTC', timeframe: '1H', outcome: t.dir, source: 'signal', expectedMarketSlug: slug,
    forwardArmedAt: armedAt, expiresAt: t.time + FORWARD_MAX_AGE_MS,
    requestId: `forward:${createHash('sha256').update(`${strategy.id}:${slug}`).digest('hex')}`,
  };
}
function readRows(now: number): SnapshotRow[] {
  const dir = path.join(process.cwd(), 'jev', 'history');
  if (!fs.existsSync(dir)) return [];
  const rows: SnapshotRow[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!/^btc_.*\.json$/i.test(name)) continue;
    const file = path.join(dir, name);
    if (fs.statSync(file).mtimeMs < now - 2 * 3600_000) continue;
    rows.push(forwardSnapshotRow(name, JSON.parse(fs.readFileSync(file, 'utf8'))));
  }
  return rows;
}
export async function runForwardCycle(
  rows?: SnapshotRow[],
  execute: (signal: SignalRequest) => Promise<TradeResult> = executeSignal,
  balanceLine: () => Promise<string> = walletBalanceLine,
) {
  if (!getSetting('bot.forwardEnabled') || !getSetting('bot.enabled')) return;
  const strategy = botStrategy();
  if (!strategy) throw new Error(`Unknown forward strategy ${getSetting('bot.forwardStrategy')}`);
  getDb().exec('CREATE TABLE IF NOT EXISTS bot_forward_gate (id INTEGER PRIMARY KEY, armed_at INTEGER NOT NULL)');
  getDb().prepare('INSERT OR IGNORE INTO bot_forward_gate VALUES(1,?)').run(Date.now());
  // A strategy other than the one last scanned (a new setting, or a new default after an update) re-arms the
  // bridge, as switching it on does: only signals after this moment trade.
  if (getBotSetting('forward.strategy', '') !== strategy.id) {
    getDb().prepare('UPDATE bot_forward_gate SET armed_at=? WHERE id=1').run(Date.now());
    setBotSetting('forward.strategy', strategy.id);
  }
  const gate = getDb().prepare('SELECT armed_at FROM bot_forward_gate WHERE id=1').get() as { armed_at: number };
  const signal = selectForwardSignal(rows ?? readRows(Date.now()), Date.now(), gate.armed_at, buildHourlyEtSlug('btc'), strategy);
  setBotSetting('forward.lastScan', String(Date.now()));
  if (!signal || findRequest(signal.requestId!)) return;
  // Persist the event BEFORE executing. A crash here skips an order rather than placing it late.
  getDb().exec('CREATE TABLE IF NOT EXISTS bot_forward_events (id TEXT PRIMARY KEY, signal TEXT NOT NULL, created_at INTEGER NOT NULL)');
  // One forward trade per market hour, whichever strategy claimed it: a switch mid-hour must not buy the hour twice.
  const hourClaimed = getDb().prepare("SELECT 1 FROM bot_forward_events WHERE json_extract(signal, '$.expectedMarketSlug') = ? LIMIT 1").get(signal.expectedMarketSlug);
  if (hourClaimed) return;
  const inserted = getDb().prepare('INSERT OR IGNORE INTO bot_forward_events VALUES(?,?,?)').run(signal.requestId, JSON.stringify(signal), Date.now());
  if (!inserted.changes) return;
  console.log(`[FORWARD] Signal received: BTC 1H ${signal.outcome} · ${signal.expectedMarketSlug} · ${signal.requestId}`);
  // The wallet balance just before the order goes first in the message. The read is capped (see balance.ts), so it
  // cannot hold the order back for long.
  const balance = await balanceLine();
  enqueueNotification(`signal:${signal.requestId}`, withBalanceLine(balance, `📥 سیگنال forward دریافت شد؛ هنوز خرید تأیید نشده\nBTC 1H ${signal.outcome}\n${signal.expectedMarketSlug}\n${signal.requestId}`));
  const result = await execute(signal);
  // A limit order that is now resting on the book: say so, the purchase message follows when it fills or is cancelled.
  if (result.status === 'PENDING' && result.price) {
    enqueueNotification(`resting:${signal.requestId}`, `🕒 سفارش لیمیت روی دفتر سفارش گذاشته شد؛ هنوز خرید انجام نشده\nBTC 1H ${result.outcome}\nقیمت لیمیت: ${(result.price * 100).toFixed(0)}¢ · سهم: ${result.shares ?? '—'}\nتا دقیقهٔ ۵۷ ساعت منتظر می‌ماند و بعد لغو می‌شود.\n${signal.requestId}`);
  }
  console.log(`[TRADE] ${result.status || (result.success ? 'FILLED' : 'FAILED')} · BTC 1H ${result.outcome || signal.outcome} · $${result.amountUsd ?? '—'} · attempts=${result.attempts ?? 0} · ${result.requestId || signal.requestId}`);
  if (!result.success && !findRequest(signal.requestId!)) enqueueNotification(`blocked:${signal.requestId}`, `⛔ سیگنال forward اجرا نشد؛ وضعیت بات و بودجه را بررسی کنید.\n${signal.expectedMarketSlug}\n${signal.requestId}`);
}
export function forwardStatus() {
  const strategy = botStrategy();
  return { enabled: getSetting('bot.forwardEnabled'), strategy: strategy?.id ?? getSetting('bot.forwardStrategy'), strategyName: strategy?.name ?? 'unknown strategy', lastScan: Number(getBotSetting('forward.lastScan', '0')) || null, lastError: getBotSetting('forward.lastError', '') || null };
}
export async function startForwardWorker() {
  while (true) {
    try {
      // Real orders awaiting confirmation, and paper limit orders resting against the real book
      for (const row of [...pendingRequests(false), ...pendingRequests(true).filter(r => r.state === 'RESTING')]) if (row.order_id) {
        const result = await reconcileRequest(row.request_id);
        if (result.status && result.status !== row.state) console.log(`[RECONCILE] ${row.state} → ${result.status} · ${row.request_id}`);
      }
      await runForwardCycle();
      setBotSetting('forward.lastError', '');
    } catch { setBotSetting('forward.lastError', 'Forward scan failed; no blind retry performed.'); }
    try { collectNotifications(); await deliverNotifications(); }
    catch { console.error('[BOT] Notification queue retained for retry.'); }
    await new Promise(resolve => setTimeout(resolve, 10_000));
  }
}
