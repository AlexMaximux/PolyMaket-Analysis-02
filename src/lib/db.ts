import { chmodSync, closeSync, existsSync, openSync } from 'node:fs';
import Database from 'better-sqlite3';
import path from 'path';

let db: Database.Database;

export function getDb() {
  if (db) return db;

  const dbPath = path.join(process.cwd(), 'updown.db');
  closeSync(openSync(dbPath, 'a', 0o600));
  chmodSync(dbPath, 0o600);
  db = new Database(dbPath, {
    // several processes (jev worker, alerts worker, bot, web server) write this file; wait up to 15 s
    // for a lock instead of the 5 s default
    timeout: 15_000,
  });

  db.pragma('journal_mode = WAL');
  // Durable reservations must survive a crash before an external order is submitted.
  db.pragma('synchronous = FULL');
  for (const suffix of ['-wal', '-shm']) if (existsSync(dbPath + suffix)) chmodSync(dbPath + suffix, 0o600);
  db.pragma('foreign_keys = OFF');

  return db;
}

export function initializeDb(dbInstance?: Database.Database) {
  const db = dbInstance || getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      alert_type TEXT NOT NULL DEFAULT 'updown',
      hours INTEGER NOT NULL DEFAULT 24,
      min_bet REAL NOT NULL DEFAULT 0,
      telegram_token TEXT NOT NULL,
      telegram_chat TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_fired_at INTEGER,
      last_evaluated_at INTEGER,
      created_at INTEGER NOT NULL
    );

    -- "wallet" is a legacy column name: it holds the dedupe key of an alert event (e.g. "ud:btc:<slug>:BUY")
    CREATE TABLE IF NOT EXISTS alert_seen (
      alert_id INTEGER NOT NULL,
      wallet TEXT NOT NULL,
      fired_at INTEGER NOT NULL,
      first_trade_at INTEGER,
      PRIMARY KEY (alert_id, wallet)
    );

    CREATE TABLE IF NOT EXISTS updown_signal_seen (
      key TEXT PRIMARY KEY,
      fired_at INTEGER NOT NULL
    );
  `);
}
