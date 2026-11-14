import fs from 'fs';
import path from 'path';

/**
 * The full price path the TFM tab draws for one snapshot: the last 60 context prices and the 60-step forecast
 * (mean and 9 deciles q10..q90 per step). Prices are rounded to 7 significant digits to keep the file small.
 */
export interface TfmPathRecord {
  file: string;
  coin: string;
  ts: string;
  model: string;
  last: number;
  history: number[]; // last 60 context prices, oldest first, the last one is `last`
  mean: number[]; // 60 steps, step i = i + 1 minutes after ts
  q: number[][]; // 60 steps x 9 deciles
}

export const roundSig = (x: number): number => (Number.isFinite(x) && x !== 0 ? Number(x.toPrecision(7)) : x);

/** <cwd>/jev/tfm/paths/<coin>-<YYYY-MM-DD>.jsonl (UTC day of the record's ts), append-only. */
export function tfmPathFile(coin: string, dayUtc: string): string {
  return path.join(process.cwd(), 'jev', 'tfm', 'paths', `${coin.toLowerCase()}-${dayUtc}.jsonl`);
}

/** Appends one record. Never throws: a failed write must not stop the collector or the forecast store. */
export function appendTfmPath(rec: TfmPathRecord): void {
  try {
    const file = tfmPathFile(rec.coin, rec.ts.slice(0, 10));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
  } catch {
    // swallow write errors
  }
}
