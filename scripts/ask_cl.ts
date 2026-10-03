import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());

import fs from 'fs';
import path from 'path';
import { CL_DIR } from '../src/lib/clSnapshot';
import { askClFile, CL_MODELS, missingModels } from '../src/lib/clAsk';
import { getSetting } from '../src/lib/settings';

/**
 * Asks Jev and Span (CL_MODELS; --models=jev,span,kev,... to change) about the CL records in jev/cl/, only the
 * models that have no answer in a record yet, with the CL inputs (old fair values plus the Claude fair value),
 * and stores the answers in the same files. jev/history is never touched. It spends OpenRouter credit, so it
 * only counts and estimates unless --run.
 *
 *   npm run ask:cl                          # count what is waiting and estimate the cost
 *   npm run ask:cl -- --run --limit=20      # ask about the newest 20
 *   npm run ask:cl -- --run                 # ask about everything waiting
 *   npm run ask:cl -- --run --coin=btc --since=2026-09-29
 *   npm run ask:cl -- --run --force         # also re-ask records that already have answers
 */

// Approximate cost per call in dollars, from the costs recorded in the snapshots on 2026-10-02.
const UNIT_COST: Record<string, number> = { jev: 3.6e-5, kev: 2.1e-5, span: 6.2e-6, solar: 7.2e-5, tev: 4.0e-5, mercury: 0, liquid: 3.8e-5 };
const CONCURRENCY = 6;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function run() {
  const args = process.argv.slice(2);
  const arg = (k: string) => args.find(a => a.startsWith(`--${k}=`))?.split('=')[1];
  const go = args.includes('--run');
  const force = args.includes('--force');
  const coin = arg('coin')?.toLowerCase();
  const since = arg('since'); // YYYY-MM-DD, from the file name
  const limit = Number(arg('limit') ?? Infinity);

  if (!fs.existsSync(CL_DIR)) {
    console.error('jev/cl does not exist: run npm run backfill:cl first');
    return;
  }
  let files = fs.readdirSync(CL_DIR).filter(f => f.startsWith('CL-') && f.endsWith('.json'));
  if (coin && coin !== 'all') files = files.filter(f => f.toLowerCase().startsWith(`cl-${coin}_`));
  if (since) files = files.filter(f => (f.match(/(\d{4}-\d{2}-\d{2})_\d{2}-\d{2}-\d{2}/)?.[1] ?? '') >= since);
  const stamp = (f: string) => f.match(/(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})/)?.slice(1).join('_') ?? f;
  files.sort((a, b) => stamp(b).localeCompare(stamp(a))); // newest first

  const models = arg('models')?.split(',').map(m => m.trim().toLowerCase()) ?? [...CL_MODELS];
  const settings = getSetting('jev.models') as Record<string, boolean>;
  const enabled = models.filter(m => settings[m]); // a model switched off in settings is not called

  // a record is waiting when at least one of the models has no answer in it yet (all of them with --force)
  const calls: Record<string, number> = {};
  const waiting = files.filter(f => {
    try {
      const todo = missingModels(JSON.parse(fs.readFileSync(path.join(CL_DIR, f), 'utf8')), enabled, force);
      for (const m of todo) calls[m] = (calls[m] ?? 0) + 1;
      return todo.length > 0;
    } catch { return false; }
  }).slice(0, limit);
  const estimate = Object.entries(calls).reduce((s, [m, n]) => s + n * (UNIT_COST[m] ?? 0), 0);
  console.log(`Records waiting: ${waiting.length}. Models: ${enabled.join(', ') || 'none enabled'}. Calls still needed: ${Object.entries(calls).map(([m, n]) => `${m} ${n}`).join(', ') || 'none'}.`);
  console.log(`Estimated cost: about $${estimate.toFixed(2)}${Number.isFinite(limit) ? ' (before --limit)' : ''}.`);
  if (!go) {
    console.log('Nothing was asked. Add --run to spend it.');
    return;
  }

  let done = 0, asked = 0, failed = 0, spent = 0;
  for (let i = 0; i < waiting.length; i += CONCURRENCY) {
    const chunk = waiting.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map(f => askClFile(f, { force, models }).catch(err => {
      console.error(`[ERROR] ${f}:`, err instanceof Error ? err.message : err);
      return { status: 'no-answers' as const, cost: 0 };
    })));
    for (const r of results) {
      if (r.status === 'asked') asked++; else if (r.status === 'no-answers') failed++;
      spent += r.cost;
    }
    done += chunk.length;
    if (done % 40 === 0 || done === waiting.length) console.log(`Progress: ${done}/${waiting.length} · answered ${asked} · no answer ${failed} · spent $${spent.toFixed(4)}`);
    await sleep(300);
  }
  console.log(`Done. Answered ${asked}, no answer ${failed} (run again to retry those). Spent about $${spent.toFixed(4)}.`);
}

if (require.main === module) {
  run().catch(err => { console.error(err); process.exit(1); });
}
