import { getDb } from '../db';
import { getBotBudgetLimits, getTotalSpent, initializeBotTables, recordBotTrade } from './db';
import { getSetting } from '../settings';
import type { SignalRequest, TradeRecord, TradeResult } from './types';

export type RequestState = 'RESERVED' | 'SUBMITTING' | 'UNKNOWN' | 'FILLED' | 'SIMULATED' | 'FAILED';
export interface BotRequest {
  request_id: string; fingerprint: string; state: RequestState; simulated: number;
  amount: number; created_at: number; updated_at: number; order_id: string | null;
  token_id: string | null; slug: string | null; price_cap: number | null;
  attempts: number; wallet: string | null; result: string | null;
}
function init() {
  initializeBotTables();
  getDb().exec(`CREATE TABLE IF NOT EXISTS bot_requests (
    request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL,
    simulated INTEGER NOT NULL, amount REAL NOT NULL, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, order_id TEXT, token_id TEXT, slug TEXT, price_cap REAL,
    attempts INTEGER NOT NULL DEFAULT 0, wallet TEXT, result TEXT
  )`);
}
export function findRequest(id: string): BotRequest | undefined {
  init();
  return getDb().prepare('SELECT * FROM bot_requests WHERE request_id = ?').get(id) as BotRequest | undefined;
}
export function pendingRequests(simulated: boolean): BotRequest[] {
  init();
  return getDb().prepare("SELECT * FROM bot_requests WHERE simulated = ? AND state IN ('RESERVED','SUBMITTING','UNKNOWN')")
    .all(Number(simulated)) as BotRequest[];
}
export function reservedBudget(simulated: boolean): number {
  return pendingRequests(simulated).reduce((sum, row) => sum + row.amount, 0);
}
export function reserveRequest(signal: SignalRequest): { row: BotRequest; duplicate: boolean } {
  init();
  const db = getDb();
  // Initialize settings before BEGIN; a rejected reservation rolls back its transaction.
  getBotBudgetLimits();
  return db.transaction(() => {
    const fingerprint = JSON.stringify({ symbol: 'BTC', timeframe: '1H', outcome: signal.outcome });
    const old = findRequest(signal.requestId!);
    if (old) {
      if (old.fingerprint !== fingerprint) throw new Error('Request ID already belongs to a different signal');
      return { row: old, duplicate: true };
    }
    if (!getSetting('bot.enabled')) throw new Error('ربات غیرفعال است (bot disabled)');
    const limits = getBotBudgetLimits();
    if (pendingRequests(limits.simulationMode).length) throw new Error('سفارش قبلی در حال اجرا یا نامشخص است؛ ابتدا وضعیت آن را بررسی کنید.');
    if (getTotalSpent(limits.simulationMode) + limits.perTrade > limits.maxBudget + 0.000001) {
      throw new Error('سقف بودجه کافی نیست.');
    }
    const now = Date.now();
    db.prepare(`INSERT INTO bot_requests (request_id, fingerprint, state, simulated, amount, created_at, updated_at)
      VALUES (?, ?, 'RESERVED', ?, ?, ?, ?)`).run(signal.requestId, fingerprint, Number(limits.simulationMode), limits.perTrade, now, now);
    return { row: findRequest(signal.requestId!)!, duplicate: false };
  }).immediate();
}
export function prepareSubmission(id: string, orderId: string, market: { slug: string; selectedTokenId: string }, price: number, wallet: string) {
  const result = getDb().prepare(`UPDATE bot_requests SET state = 'SUBMITTING', order_id = ?, token_id = ?, slug = ?,
    price_cap = ?, wallet = ?, attempts = attempts + 1, updated_at = ? WHERE request_id = ? AND state = 'RESERVED'`)
    .run(orderId, market.selectedTokenId, market.slug, price, wallet, Date.now(), id);
  if (result.changes !== 1) throw new Error('Request is no longer reserved');
}
export function markRejected(id: string) {
  const r = getDb().prepare("UPDATE bot_requests SET state = 'RESERVED', order_id = NULL, updated_at = ? WHERE request_id = ? AND state = 'SUBMITTING'")
    .run(Date.now(), id);
  if (r.changes !== 1) throw new Error('Cannot retry this request');
}
export function markUnknown(id: string, result: TradeResult) {
  getDb().prepare("UPDATE bot_requests SET state = 'UNKNOWN', result = ?, updated_at = ? WHERE request_id = ? AND state IN ('SUBMITTING','UNKNOWN')")
    .run(JSON.stringify(result), Date.now(), id);
}
export function finishRequest(id: string, result: TradeResult, trade: Omit<TradeRecord, 'id'>) {
  return getDb().transaction(() => {
    const row = findRequest(id);
    if (!row) throw new Error('Request not found');
    if (['FILLED', 'SIMULATED', 'FAILED'].includes(row.state)) return JSON.parse(row.result!) as TradeResult;
    recordBotTrade(trade);
    getDb().prepare('UPDATE bot_requests SET state = ?, result = ?, updated_at = ? WHERE request_id = ?')
      .run(trade.status, JSON.stringify(result), Date.now(), id);
    return result;
  }).immediate();
}
