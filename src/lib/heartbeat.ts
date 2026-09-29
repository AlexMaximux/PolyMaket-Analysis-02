import type Database from 'better-sqlite3';
import { getDb } from './db';

/** "Last successful cycle" per worker, shown on /control to tell a stuck worker from a working one. */
export interface Heartbeat {
  worker: string;
  last_ok_at: number | null;
  last_error_at: number | null;
  last_error: string | null;
}

const prepared = new WeakSet<Database.Database>();
function ensureTable(db: Database.Database) {
  if (prepared.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS worker_heartbeat (
    worker TEXT PRIMARY KEY,
    last_ok_at INTEGER,
    last_error_at INTEGER,
    last_error TEXT
  )`);
  prepared.add(db);
}

/** Record one loop iteration. Never throws: a heartbeat must not be able to break a worker. */
export function beat(worker: string, ok: boolean, error?: string, db?: Database.Database): void {
  try {
    const d = db ?? getDb();
    ensureTable(d);
    const now = Math.floor(Date.now() / 1000);
    if (ok) {
      d.prepare(`INSERT INTO worker_heartbeat (worker, last_ok_at) VALUES (?, ?)
                 ON CONFLICT(worker) DO UPDATE SET last_ok_at = excluded.last_ok_at`).run(worker, now);
    } else {
      d.prepare(`INSERT INTO worker_heartbeat (worker, last_error_at, last_error) VALUES (?, ?, ?)
                 ON CONFLICT(worker) DO UPDATE SET last_error_at = excluded.last_error_at, last_error = excluded.last_error`)
        .run(worker, now, String(error ?? 'error').slice(0, 500));
    }
  } catch {
    // ignore
  }
}

export function readHeartbeats(db?: Database.Database): Record<string, Heartbeat> {
  const d = db ?? getDb();
  ensureTable(d);
  const rows = d.prepare(`SELECT worker, last_ok_at, last_error_at, last_error FROM worker_heartbeat`).all() as Heartbeat[];
  return Object.fromEntries(rows.map(r => [r.worker, r]));
}
