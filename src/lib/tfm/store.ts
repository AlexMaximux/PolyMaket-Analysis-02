import fs from 'fs';
import path from 'path';
import { activeTfmModelKey, tfmModelKeyOf, type TfmModelKey } from './config';
import { TFM_MAX_CONTEXT, type TfmRecord } from './types';

// Context lengths a forecast store can be built with (1-minute points). TFM_MAX_CONTEXT is the live one.
export const TFM_CONTEXT_MIN = 32;
export const TFM_CONTEXT_MAX = 16384;

/** A context length from untrusted input, or null when it is not a whole number in range. */
export function tfmContextOf(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n >= TFM_CONTEXT_MIN && n <= TFM_CONTEXT_MAX ? n : null;
}

/**
 * <cwd>/jev/tfm/forecasts-<key>.jsonl: append-only, one TfmRecord per line, the last line for a file wins.
 * A store built with another context length (backfill --context=N) is forecasts-<key>-ctx<N>.jsonl; the live
 * collector, the bot and the frozen strategies use only the default store (context TFM_MAX_CONTEXT).
 */
export function tfmStorePath(key?: TfmModelKey, context: number = TFM_MAX_CONTEXT): string {
  const k = key ?? activeTfmModelKey();
  const suffix = context === TFM_MAX_CONTEXT ? '' : `-ctx${context}`;
  return path.join(process.cwd(), 'jev', 'tfm', `forecasts-${k}${suffix}.jsonl`);
}

/** Context lengths that have a store for this model, ascending (the default one included when it exists). */
export function listTfmContexts(key?: TfmModelKey): number[] {
  const k = key ?? activeTfmModelKey();
  let names: string[];
  try {
    names = fs.readdirSync(path.join(process.cwd(), 'jev', 'tfm'));
  } catch {
    return [];
  }
  const out = new Set<number>();
  const prefix = `forecasts-${k}`;
  for (const n of names) {
    if (n === `${prefix}.jsonl`) out.add(TFM_MAX_CONTEXT);
    else if (n.startsWith(`${prefix}-ctx`) && n.endsWith('.jsonl')) {
      const c = tfmContextOf(n.slice(prefix.length + 4, -6));
      if (c != null) out.add(c);
    }
  }
  return [...out].sort((a, b) => a - b);
}

function appendRecordsToKey(key: TfmModelKey, records: TfmRecord[], context: number): void {
  if (records.length === 0) return;
  const file = tfmStorePath(key, context);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let prefix = '';
  try {
    const { size } = fs.statSync(file);
    if (size > 0) {
      const fd = fs.openSync(file, 'r');
      try {
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, size - 1);
        // a torn last line (crash mid-write): end it so the new records start on their own line
        if (last[0] !== 0x0a) prefix = '\n';
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    // no file yet
  }
  fs.appendFileSync(file, prefix + records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

export function appendTfmRecords(records: TfmRecord[], context: number = TFM_MAX_CONTEXT): void {
  if (records.length === 0) return;
  const active = activeTfmModelKey();
  const groups = new Map<TfmModelKey, TfmRecord[]>();
  for (const r of records) {
    const k = tfmModelKeyOf(r.model) ?? active;
    const arr = groups.get(k);
    if (arr) arr.push(r);
    else groups.set(k, [r]);
  }
  for (const [k, recs] of groups) {
    appendRecordsToKey(k, recs, context);
  }
}

const cacheByKey = new Map<string, { file: string; size: number; mtimeMs: number; map: Map<string, TfmRecord> }>();

/** key = TfmRecord.file. Cached per store file (size + mtime); re-read only when the file's size or mtime changed. Do not mutate the result. */
export function loadTfmStore(key?: TfmModelKey, context: number = TFM_MAX_CONTEXT): Map<string, TfmRecord> {
  const file = tfmStorePath(key, context);
  const k = file;
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    cacheByKey.delete(k);
    return new Map();
  }
  const cached = cacheByKey.get(k);
  if (cached && cached.file === file && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
    return cached.map;
  }
  const map = new Map<string, TfmRecord>();
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return new Map();
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as TfmRecord;
      if (r && typeof r === 'object' && typeof r.file === 'string') map.set(r.file, r);
    } catch {
      // half-written or corrupt line
    }
  }
  cacheByKey.set(k, { file, size: st.size, mtimeMs: st.mtimeMs, map });
  return map;
}

export interface TfmRowFields {
  tfm_direction: 'UP' | 'DOWN' | null;
  tfm_score: number | null;
  tfm_prob_up: number | null;
  tfm_score_confidence: number | null;
  tfm_direction_confidence: number | null;
  tfm_confidence: number | null;
  tfm_up_15m: number | null;
  tfm_up_5m: number | null;
  tfm_ret_1h: number | null;
  /** TimesFM's 1H P(Up) as a fair value in cents (0-100); equals tfm_prob_up. */
  fair_tfm: number | null;
}

const pct = (p: number) => Number((p * 100).toFixed(1));
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The history-row fields of a record (the nine tfm_* fields and fair_tfm); probabilities 0-1 in the store become 0-100 here. */
export function tfmRowFields(rec: TfmRecord | undefined): TfmRowFields {
  const h1 = rec?.h1 ?? null;
  const m15 = rec?.m15 ?? null;
  const m5 = rec?.m5 ?? null;
  const out: TfmRowFields = {
    tfm_direction: null, tfm_score: null, tfm_prob_up: null,
    tfm_score_confidence: null, tfm_direction_confidence: null, tfm_confidence: null,
    tfm_up_15m: m15 && num(m15.probUp) ? pct(m15.probUp) : null,
    tfm_up_5m: m5 && num(m5.probUp) ? pct(m5.probUp) : null,
    tfm_ret_1h: null,
    fair_tfm: null,
  };
  if (rec && h1 && num(h1.probUp)) {
    const p = h1.probUp;
    const conf = Math.round(Math.max(p, 1 - p) * 100);
    out.tfm_prob_up = pct(p);
    out.fair_tfm = out.tfm_prob_up;
    out.tfm_direction = p >= 0.5 ? 'UP' : 'DOWN';
    out.tfm_score = Number((4 * p).toFixed(2));
    out.tfm_score_confidence = conf;
    out.tfm_direction_confidence = conf;
    out.tfm_confidence = conf;
    if (num(h1.median) && num(rec.last) && rec.last > 0) out.tfm_ret_1h = Number(((h1.median / rec.last - 1) * 100).toFixed(3));
  }
  return out;
}
