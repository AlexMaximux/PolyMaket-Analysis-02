import { randomUUID } from 'node:crypto';
import { getDb } from '../db';
import { findRequest } from './ledger';

export type RedemptionState = 'WAITING' | 'PREPARING' | 'SUBMITTED' | 'CONFIRMED' | 'LOSER' | 'EMPTY' | 'ERROR' | 'FAILED';
export interface Redemption {
  id: number; wallet: string; signer: string; holder: string; token_id: string; slug: string;
  shares: number; state: RedemptionState; condition_id: string | null; index_set: number | null;
  tx_hash: string | null; tx_id: string | null; raw_tx: string | null; payout: string | null; gas_pol: string | null;
  attempts: number; broadcasts: number; owner: string | null; lease_until: number;
  next_check: number; updated_at: number; error: string | null;
}
export function initRedemptions() {
  // Initializes the existing request ledger without requiring any network calls.
  findRequest('__init__');
  getDb().exec(`CREATE TABLE IF NOT EXISTS bot_redemptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, wallet TEXT NOT NULL, signer TEXT NOT NULL,
    holder TEXT NOT NULL, token_id TEXT NOT NULL, slug TEXT NOT NULL, shares REAL NOT NULL,
    state TEXT NOT NULL DEFAULT 'WAITING', condition_id TEXT, index_set INTEGER, tx_hash TEXT, tx_id TEXT,
    raw_tx TEXT, payout TEXT, gas_pol TEXT, attempts INTEGER NOT NULL DEFAULT 0,
    broadcasts INTEGER NOT NULL DEFAULT 0, owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
    next_check INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, error TEXT,
    UNIQUE(wallet, token_id)
  )`);
  const columns = getDb().prepare('PRAGMA table_info(bot_redemptions)').all() as { name: string }[];
  if (!columns.some(c => c.name === 'tx_id')) getDb().exec('ALTER TABLE bot_redemptions ADD COLUMN tx_id TEXT');
}
export function discoverRedemptions(wallet: string, signer: string, holder: string) {
  initRedemptions();
  // Only confirmed real bot purchases with a known original wallet; never guess legacy ownership.
  const rows = getDb().prepare(`SELECT token_id, slug, SUM(json_extract(result, '$.shares')) AS shares
    FROM bot_requests WHERE state = 'FILLED' AND simulated = 0 AND wallet = ?
    AND token_id IS NOT NULL AND slug IS NOT NULL GROUP BY token_id, slug`).all(wallet) as { token_id: string; slug: string; shares: number }[];
  const put = getDb().prepare(`INSERT INTO bot_redemptions(wallet,signer,holder,token_id,slug,shares,updated_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(wallet,token_id) DO UPDATE SET shares=excluded.shares`);
  getDb().transaction(() => {
    for (const r of rows) {
      if ((/^\d+$/.test(r.token_id) || /^0x[0-9a-fA-F]{64}$/.test(r.token_id)) &&
          r.slug.startsWith('bitcoin-up-or-down-') && r.shares > 0) {
        put.run(wallet, signer.toLowerCase(), holder, r.token_id, r.slug, r.shares, Date.now());
      }
    }
  })();
}
export function redemption(id: number): Redemption {
  return getDb().prepare('SELECT * FROM bot_redemptions WHERE id=?').get(id) as Redemption;
}
export function submittedRedemption(signer: string): Redemption | undefined {
  initRedemptions();
  return getDb().prepare("SELECT * FROM bot_redemptions WHERE signer=? AND state='SUBMITTED' ORDER BY id LIMIT 1")
    .get(signer.toLowerCase()) as Redemption | undefined;
}
export function claimRedemption(wallet: string, signer: string): Redemption | null {
  initRedemptions();
  const db = getDb();
  return db.transaction(() => {
    const now = Date.now();
    const active = db.prepare("SELECT id FROM bot_redemptions WHERE signer=? AND (state='SUBMITTED' OR (state='PREPARING' AND lease_until>?)) LIMIT 1")
      .get(signer.toLowerCase(), now);
    if (active) return null;
    const row = db.prepare(`SELECT * FROM bot_redemptions WHERE wallet=? AND attempts<3 AND next_check<=?
      AND (state IN ('WAITING','ERROR','FAILED') OR (state='PREPARING' AND lease_until<=?)) ORDER BY updated_at,id LIMIT 1`)
      .get(wallet, now, now) as Redemption | undefined;
    if (!row) return null;
    db.prepare("UPDATE bot_redemptions SET state='PREPARING',owner=?,lease_until=?,updated_at=? WHERE id=?")
      .run(randomUUID(), now + 120_000, now, row.id);
    return redemption(row.id);
  }).immediate();
}
export function releaseRedemption(row: Redemption, state: RedemptionState, error: string | null, delay = 60_000) {
  getDb().prepare(`UPDATE bot_redemptions SET state=?,error=?,owner=NULL,lease_until=0,next_check=?,updated_at=?
    WHERE id=? AND owner=? AND state='PREPARING'`).run(state, error, Date.now() + delay, Date.now(), row.id, row.owner);
}
export function saveSignedRedemption(row: Redemption, condition: string, indexSet: number, raw: string, hash: string): Redemption {
  const r = getDb().prepare(`UPDATE bot_redemptions SET state='SUBMITTED',condition_id=?,index_set=?,raw_tx=?,tx_hash=?,
    attempts=attempts+1,broadcasts=0,updated_at=?,error=NULL WHERE id=? AND owner=? AND state='PREPARING' AND lease_until>?`)
    .run(condition, indexSet, raw, hash, Date.now(), row.id, row.owner, Date.now());
  if (r.changes !== 1) throw new Error('Redemption lease expired; no transaction sent');
  return redemption(row.id);
}
export function saveGaslessRedemption(row: Redemption, condition: string, transactionId: string, hash: string | null): Redemption {
  const r = getDb().prepare(`UPDATE bot_redemptions SET state='SUBMITTED',condition_id=?,index_set=NULL,raw_tx=NULL,
    tx_hash=?,tx_id=?,attempts=attempts+1,broadcasts=0,owner=NULL,lease_until=0,updated_at=?,error=NULL
    WHERE id=? AND owner=? AND state='PREPARING' AND lease_until>?`)
    .run(condition, hash, transactionId, Date.now(), row.id, row.owner, Date.now());
  if (r.changes !== 1) throw new Error('Redemption lease expired after gasless submission');
  return redemption(row.id);
}
export function updateGaslessHash(row: Redemption, hash: string | null) {
  if (!hash) return;
  getDb().prepare("UPDATE bot_redemptions SET tx_hash=?,updated_at=? WHERE id=? AND tx_id=? AND state='SUBMITTED'")
    .run(hash, Date.now(), row.id, row.tx_id);
}
export function claimBroadcast(row: Redemption): boolean {
  // Sending the SAME serialized transaction is idempotent, even if two workers race recovery.
  return getDb().prepare(`UPDATE bot_redemptions SET broadcasts=broadcasts+1,next_check=?,updated_at=?
    WHERE id=? AND state='SUBMITTED' AND next_check<=? AND broadcasts<3`)
    .run(Date.now() + 60_000, Date.now(), row.id, Date.now()).changes === 1;
}
export function finishRedemption(row: Redemption, state: 'CONFIRMED' | 'FAILED', payout: string | null, gas: string, error: string | null) {
  getDb().prepare(`UPDATE bot_redemptions SET state=?,payout=?,gas_pol=?,error=?,raw_tx=NULL,owner=NULL,lease_until=0,
    next_check=?,updated_at=? WHERE id=? AND tx_hash=? AND state='SUBMITTED'`)
    .run(state, payout, gas, error, Date.now() + 300_000, Date.now(), row.id, row.tx_hash);
}
export function finishGaslessRedemption(row: Redemption, state: 'CONFIRMED' | 'FAILED', payout: string | null, error: string | null) {
  getDb().prepare(`UPDATE bot_redemptions SET state=?,payout=?,gas_pol='0',error=?,raw_tx=NULL,owner=NULL,lease_until=0,
    next_check=?,updated_at=? WHERE id=? AND tx_id=? AND state='SUBMITTED'`)
    .run(state, payout, error, Date.now() + 300_000, Date.now(), row.id, row.tx_id);
}
export function redemptionSummary() {
  initRedemptions();
  const rows = getDb().prepare(`SELECT id,slug,state,tx_hash,payout,gas_pol,error,updated_at FROM bot_redemptions
    ORDER BY updated_at DESC LIMIT 8`).all() as Pick<Redemption, 'id' | 'slug' | 'state' | 'tx_hash' | 'payout' | 'gas_pol' | 'error' | 'updated_at'>[];
  const total = getDb().prepare("SELECT COALESCE(SUM(CAST(payout AS REAL)),0) AS amount FROM bot_redemptions WHERE state='CONFIRMED'").get() as { amount: number };
  return { totalRedeemed: total.amount, recent: rows };
}
