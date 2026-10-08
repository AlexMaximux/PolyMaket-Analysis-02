import fs from 'node:fs';
import path from 'node:path';
import { forwardSnapshotRow } from './forwardSnapshot';
import type { SnapshotRow } from './signalAnalysis';

/** How many of the newest snapshot files the test messages search for a strategy's latest signal (5 minutes each: about 33 hours). */
export const TEST_SIGNAL_FILES = 400;

/** The newest snapshot rows of one coin from jev/history, oldest first. */
export function readRecentRows(limit = TEST_SIGNAL_FILES, coin = 'btc'): SnapshotRow[] {
  const dir = path.join(process.cwd(), 'jev', 'history');
  if (!fs.existsSync(dir)) return [];
  const names = fs.readdirSync(dir).filter(n => n.toLowerCase().startsWith(`${coin}_`) && n.endsWith('.json')).sort().slice(-limit);
  const rows: SnapshotRow[] = [];
  for (const name of names) {
    try { rows.push(forwardSnapshotRow(name, JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')))); } catch { /* a half-written file */ }
  }
  return rows;
}

/** One full snapshot record (everything a message needs), or null. */
export function readRecord(filename: string): Record<string, unknown> | null {
  try { return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'jev', 'history', path.basename(filename)), 'utf8')); } catch { return null; }
}
