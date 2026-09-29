import { getDb } from '../db';
import { getSetting } from '../settings';
import type { TradeRecord } from './types';

export function initializeBotTables() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bot_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      outcome TEXT NOT NULL,
      slug TEXT,
      token_id TEXT,
      amount_usd REAL NOT NULL,
      shares REAL,
      price REAL,
      status TEXT NOT NULL,
      order_id TEXT,
      tx_hash TEXT,
      source TEXT DEFAULT 'telegram',
      error_message TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_bot_trades_timestamp ON bot_trades(timestamp);
    CREATE INDEX IF NOT EXISTS idx_bot_trades_status ON bot_trades(status);
  `);
}

export function getBotSetting(key: string, defaultValue: string): string {
  initializeBotTables();
  const db = getDb();
  try {
    const row = db.prepare('SELECT value FROM bot_settings WHERE key = ?').get(key) as { value: string } | undefined;
    if (row && row.value !== undefined) {
      return row.value;
    }
  } catch (err) {
    throw new Error(`Failed to read bot setting ${key}`, { cause: err });
  }
  return defaultValue;
}

export function setBotSetting(key: string, value: string): void {
  initializeBotTables();
  const db = getDb();
  try {
    db.prepare(`
      INSERT INTO bot_settings (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  } catch (err) {
    throw new Error(`Failed to persist bot setting ${key}`, { cause: err });
  }
}

/** Budget/simulation config, from /control settings (src/lib/settings.ts, keys bot.*). */
export function getBotBudgetLimits(): { maxBudget: number; perTrade: number; simulationMode: boolean } {
  return {
    maxBudget: getSetting('bot.maxBudget'),
    perTrade: getSetting('bot.perTradeAmount'),
    simulationMode: getSetting('bot.simulationMode'),
  };
}

export function getTotalSpent(simulated = getSetting('bot.simulationMode')): number {
  initializeBotTables();
  const db = getDb();
  const row = db.prepare(`
    SELECT COALESCE(SUM(amount_usd), 0) AS total FROM bot_trades WHERE status = ?
  `).get(simulated ? 'SIMULATED' : 'FILLED') as { total: number };
  return row.total;

}

export function recordBotTrade(trade: Omit<TradeRecord, 'id'>): number {
  initializeBotTables();
  const db = getDb();
  try {
    const result = db.prepare(`
      INSERT INTO bot_trades (
        timestamp, symbol, timeframe, outcome, slug, token_id,
        amount_usd, shares, price, status, order_id, tx_hash,
        source, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      trade.timestamp,
      trade.symbol,
      trade.timeframe,
      trade.outcome,
      trade.slug || null,
      trade.token_id || null,
      trade.amount_usd,
      trade.shares || null,
      trade.price || null,
      trade.status,
      trade.order_id || null,
      trade.tx_hash || null,
      trade.source || 'telegram',
      trade.error_message || null
    );
    return Number(result.lastInsertRowid);
  } catch (err) {
    throw new Error('Failed to persist bot trade', { cause: err });
  }
}

export function getRecentTrades(limit = 10): TradeRecord[] {
  initializeBotTables();
  const db = getDb();
  try {
    return db.prepare(`
      SELECT * FROM bot_trades
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(limit) as TradeRecord[];
  } catch (err) {
    console.error('Error fetching recent bot trades:', err);
    return [];
  }
}

export function getTradeCount(): number {
  initializeBotTables();
  return (getDb().prepare('SELECT COUNT(*) AS total FROM bot_trades').get() as { total: number }).total;
}
