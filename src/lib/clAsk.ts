import fs from 'fs';
import path from 'path';
import { callMultiModelDecisions, consensusOf } from './jevSnapshot';
import { CL_DIR, type Rec } from './clSnapshot';

/**
 * Asks the models (CL_MODELS: Jev and Span) about a CL record and stores the answers in that same file.
 *
 * The record is sent as it is: cards plus the old fair values plus `fair_values.claude`. Jev, Kev, Solar,
 * Tev, Mercury and Liquid forward `fair_values` whole; Span's prompt adds the Claude value when it is there
 * (callSpanDecision). Only the models that have no answer in the file yet are asked, so adding a model later
 * (or retrying after a failure) never repeats or overwrites an earlier answer unless forced. The answers are
 * stored in the same shape as the original records (prediction, predictions, consensus) so the analysis
 * pages can read them unchanged. The original records in jev/history are never touched.
 */
export type AskResult = { status: 'asked' | 'skipped-answered' | 'missing' | 'no-answers'; cost: number };

const MODELS = ['jev', 'kev', 'span', 'solar', 'tev', 'mercury', 'liquid'] as const;
/** Which models CL records are asked about, by the user's choice. The others stay null in the file. */
export const CL_MODELS: readonly string[] = ['jev', 'span'];

/** The models of `models` that the record has no answer from yet (all of them when forced). */
export function missingModels(rec: Rec, models: readonly string[] = CL_MODELS, force = false): string[] {
  return models.filter((m) => force || rec.predictions?.[m] == null);
}

export async function askClFile(
  filename: string,
  opts: { dir?: string; force?: boolean; models?: readonly string[]; ask?: (rec: Rec, models: readonly string[]) => Promise<Rec> } = {},
): Promise<AskResult> {
  const dir = opts.dir ?? CL_DIR;
  const ask: (rec: Rec, models: readonly string[]) => Promise<Rec> = opts.ask ?? ((rec, only) => callMultiModelDecisions(rec, undefined, only));
  const filePath = path.join(dir, path.basename(filename));
  let rec: Rec;
  try {
    rec = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return { status: 'missing', cost: 0 };
  }
  const wanted = missingModels(rec, opts.models ?? CL_MODELS, opts.force);
  if (wanted.length === 0) return { status: 'skipped-answered', cost: 0 };

  const multi = await ask(rec, wanted);
  const answered = wanted.filter((m) => multi[m] != null);
  if (answered.length === 0) return { status: 'no-answers', cost: 0 };

  const predictions: Rec = {};
  for (const m of MODELS) predictions[m] = (answered.includes(m) ? multi[m] : rec.predictions?.[m]) ?? null;
  predictions.consensus = consensusOf(predictions.jev, predictions.kev, predictions.span);
  const next = {
    ...rec,
    prediction: predictions.jev ?? predictions.kev ?? predictions.span ?? null,
    predictions,
    asked_at: new Date().toISOString(),
    inputs_variant: 'old+claude',
  };
  // write-then-rename so the API never reads a half-written file
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
  const cost = answered.reduce((s, m) => s + (Number(multi[m]?.cost) || 0), 0);
  return { status: 'asked', cost };
}
