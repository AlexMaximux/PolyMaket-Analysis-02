import fs from 'fs';
import path from 'path';
import { claudeFairUp, volWindowsFromKlines, type ClaudeModelResult } from './claudeModel';

/**
 * "CL" snapshots: a second copy of each Jev record that also carries the Claude model's fair value.
 *
 * The originals in jev/history are never touched. CL files live in jev/cl/, named CL-<original name>, so
 * every reader of jev/history (the analysis pages, the strategies' forward tests, the Telegram alerts, the
 * market resolver) keeps seeing exactly the data it saw before. A CL file holds the same snapshot plus
 * `claude_model` and `fair_values.claude`, and `prediction(s)` are null: the models are asked later, on
 * whichever input variant is being tested, so nothing recorded under the old inputs is passed off as new.
 */
export const CL_DIR = path.join(process.cwd(), 'jev', 'cl');
const CL_PREFIX = 'CL-';

export const clFilename = (filename: string) => (filename.startsWith(CL_PREFIX) ? filename : `${CL_PREFIX}${filename}`);

// Snapshot JSON: the shape varies between eras (the oldest records lack spot, open and model_inputs).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Rec = Record<string, any>;

const CARRIED = [
  'et_time', 'date_et', 'current_time_et', 'current_time_et_24h', 'timestamp', 'coin', 'coin_label',
  'spot_price', 'open_price', 'price_to_beat', 'cards',
] as const;

/** The CL record for a snapshot, or null when the Claude model had no value for it. */
export function buildClRecord(snapshot: Rec, sourceFile: string): Rec | null {
  const cm = snapshot.claude_model;
  if (!cm || typeof cm.fairUp !== 'number' || !Number.isFinite(cm.fairUp)) return null;
  const rec: Rec = {};
  for (const k of CARRIED) rec[k] = snapshot[k] ?? null;
  rec.fair_values = { ...(snapshot.fair_values ?? {}), claude: Number(cm.fairUp.toFixed(4)) };
  rec.claude_model = cm;
  rec.model_inputs = snapshot.model_inputs ?? null;
  rec.books = snapshot.books ?? null;
  rec.source_file = sourceFile;
  rec.prediction = null;
  rec.predictions = null;
  return rec;
}

/** Writes CL-<sourceFile> into `dir`. Never overwrites: a recorded file is kept forever, like the originals. */
export function saveClRecord(snapshot: Rec, sourceFile: string, dir = CL_DIR): { filename: string; written: boolean } {
  const filename = clFilename(sourceFile);
  const rec = buildClRecord(snapshot, sourceFile);
  if (!rec) return { filename, written: false };
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(path.join(dir, filename), JSON.stringify(rec, null, 2), { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') return { filename, written: false };
    throw err;
  }
  return { filename, written: true };
}

/**
 * S0 and spot for the oldest records, saved before the snapshot kept them: S0 is the open of the hour's first
 * 1m bar (the same source the live model uses); spot is the open of the 1m bar holding the timestamp, so it can
 * be up to a minute stale. Callers must flag the result as reconstructed.
 */
export function reconstructPrices(record: Rec, klines: unknown[][]): { open: number; spot: number } | null {
  const tsMs = Date.parse(record.timestamp ?? '');
  if (!Number.isFinite(tsMs)) return null;
  const hourStart = Math.floor(tsMs / 3_600_000) * 3_600_000;
  const minuteStart = Math.floor(tsMs / 60_000) * 60_000;
  let open: number | null = null;
  let spot: number | null = null;
  for (const k of klines) {
    const opened = Number(k[0]);
    if (opened === hourStart) open = parseFloat(String(k[1]));
    if (opened === minuteStart) spot = parseFloat(String(k[1]));
    if (open != null && spot != null) break;
  }
  return open != null && spot != null && open > 0 && spot > 0 ? { open, spot } : null;
}

/**
 * The Claude model as it would have run when an old record was taken: x from the recorded spot and open,
 * t from model_inputs (else the timestamp), volatility from the last closed 1m bars before the timestamp.
 * `klines` is raw Binance 1m klines covering at least the 960 bars before the record; later bars are ignored.
 */
export function claudeModelAt(record: Rec, klines: unknown[][]): (ClaudeModelResult & { edge: number | null }) | null {
  const spot = Number(record.spot_price);
  const open = Number(record.open_price);
  const tsMs = Date.parse(record.timestamp ?? '');
  if (!(spot > 0) || !(open > 0) || !Number.isFinite(tsMs)) return null;
  const vol = volWindowsFromKlines(klines, tsMs);
  if (!vol) return null;
  const t = Number.isFinite(Number(record.model_inputs?.t)) && record.model_inputs?.t != null ? Number(record.model_inputs.t) : ((tsMs / 1000) % 3600) / 60;
  const r = claudeFairUp({ x: Math.log(spot / open), t, vol });
  const up = record.cards?.['1h']?.up;
  return { ...r, edge: typeof up === 'number' ? r.fairUp - up : null };
}
