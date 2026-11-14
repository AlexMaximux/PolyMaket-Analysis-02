import fs from 'fs';
import path from 'path';
import { tfmHealth } from '../src/lib/tfm/client';
import { activeTfmModelKey, tfmModelKeyOf, TFM_MODELS } from '../src/lib/tfm/config';
import { fetchMinuteBars, TFM_SYMBOLS } from '../src/lib/tfm/klines';
import { contextAsOf } from '../src/lib/tfm/series';
import { forecastSnapshots, snapshotInputOf, type SnapshotInput } from '../src/lib/tfm/snapshot';
import { appendTfmRecords, loadTfmStore, tfmContextOf, tfmStorePath, TFM_CONTEXT_MAX, TFM_CONTEXT_MIN } from '../src/lib/tfm/store';
import { minContextFor } from '../src/lib/tfm/snapshot';
import { TFM_MAX_CONTEXT, type MinuteBar } from '../src/lib/tfm/types';

/**
 * Forecasts every history snapshot with TimesFM and appends the result to jev/tfm/forecasts.jsonl, using only
 * prices that existed at each snapshot's time. Reads jev/history (never writes there) and Binance 1-minute bars;
 * needs the local TimesFM service (npm run tfm). Snapshots that are already in the store are skipped, so a stopped
 * or failed run resumes where it ended.
 *
 *   npm run backfill:tfm -- [--coin=btc,eth] [--since=YYYY-MM-DD] [--limit=N] [--batch=16] [--force] [--context=N]
 *
 *   --context 1-minute points sent to the model per forecast (default 1024, the live one). Another value writes its
 *             own store, jev/tfm/forecasts-<model>-ctx<N>.jsonl, which the Strategy Lab can pick; the live collector,
 *             the bot and the frozen strategies keep the default store. Above 1024 the service must be started with
 *             TFM_MAX_CONTEXT=N or more (for example: TFM_MAX_CONTEXT=2048 npm run tfm).
 *   --coin    comma list of coins (default: every coin in jev/history)
 *   --since   only files whose (ET) date in the file name is on or after this day
 *   --limit   forecast at most N snapshots in this run (after dropping the ones already stored)
 *   --batch   series per service call, 1-64 (default 16)
 *   --force   forecast snapshots that are already stored too (the new line replaces the old one)
 */

const MIN_MS = 60_000;
// Bars fetched before each segment: the context plus a margin for the bar that has not closed yet.
const barsBackMin = (context: number): number => Math.max(1030, context + 30);
const SEGMENT_GAP_MS = 3 * 24 * 3600_000; // fetch bars per segment when two snapshots are further apart than this
const PROGRESS_EVERY = 500;

interface Args {
  coins: string[] | null;
  since: string | null;
  limit: number;
  batch: number;
  force: boolean;
  context: number;
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { coins: null, since: null, limit: Infinity, batch: 16, force: false, context: TFM_MAX_CONTEXT };
  for (const a of argv) {
    const [key, ...rest] = a.split('=');
    const val = rest.join('=');
    if (key === '--force' && rest.length === 0) args.force = true;
    else if (key === '--coin') {
      const list = val.split(',').map((c) => c.trim().toLowerCase()).filter(Boolean);
      if (list.length === 0) fail('--coin needs a coin or a comma list, for example --coin=btc,eth');
      args.coins = list;
    } else if (key === '--since') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) fail('--since needs a date like 2026-10-01');
      args.since = val;
    } else if (key === '--limit') {
      const n = Number(val);
      if (!Number.isInteger(n) || n < 1) fail('--limit needs a whole number of at least 1');
      args.limit = n;
    } else if (key === '--batch') {
      const n = Number(val);
      if (!Number.isInteger(n) || n < 1) fail('--batch needs a whole number from 1 to 64');
      args.batch = Math.min(64, n);
    } else if (key === '--context') {
      const c = tfmContextOf(val);
      if (c == null) fail(`--context needs a whole number from ${TFM_CONTEXT_MIN} to ${TFM_CONTEXT_MAX}`);
      args.context = c;
    } else fail(`Unknown argument: ${a}\nUsage: npm run backfill:tfm -- [--coin=btc] [--since=YYYY-MM-DD] [--limit=N] [--batch=16] [--force] [--context=N]`);
  }
  return args;
}

const coinOfFile = (name: string): string => name.split('_')[0].toLowerCase();
const dateOfFile = (name: string): string | null => /_(\d{4}-\d{2}-\d{2})_/.exec(name)?.[1] ?? null;
const fmtTs = (ms: number): string => new Date(ms).toISOString();
const rate = (n: number, startMs: number): string => (n / Math.max(0.001, (Date.now() - startMs) / 1000)).toFixed(1);

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const activeKey = activeTfmModelKey();
  console.log(`Active model: ${activeKey} (${TFM_MODELS[activeKey]})`);

  const health = await tfmHealth();
  if (!health.ok) {
    fail('The TimesFM service is not running on http://127.0.0.1:8002. Start it with: npm run tfm');
  }
  const runningKey = tfmModelKeyOf(health.model);
  if (runningKey !== activeKey) {
    fail(`The TimesFM service is running model ${health.model ?? 'unknown'} (${runningKey ?? 'unknown'}), but the active model is ${activeKey}.`);
  }
  // The service silently keeps only its last max_context points, so a longer context would store mislabelled forecasts.
  if (health.maxContext != null && health.maxContext < args.context) {
    fail(`The TimesFM service keeps at most ${health.maxContext} points, less than --context=${args.context}. Restart it with: TFM_MAX_CONTEXT=${args.context} npm run tfm`);
  }
  console.log(`Context: ${args.context} points, store ${tfmStorePath(activeKey, args.context)}`);

  const historyDir = path.join(process.cwd(), 'jev', 'history');
  let names: string[];
  try {
    names = fs.readdirSync(historyDir).filter((n) => n.endsWith('.json')).sort();
  } catch {
    return fail(`Cannot read ${historyDir}`);
  }

  const stored = args.force ? new Set<string>() : new Set(loadTfmStore(activeKey, args.context).keys());
  const wanted = args.coins ? new Set(args.coins) : null;

  // Pick the files: coin filter, date filter, not yet stored. Files of coins without a Binance symbol are counted.
  let unknownCoinFiles = 0;
  let alreadyStored = 0;
  const byCoin = new Map<string, string[]>();
  for (const name of names) {
    const coin = coinOfFile(name);
    if (wanted && !wanted.has(coin)) continue;
    if (!TFM_SYMBOLS[coin]) {
      unknownCoinFiles++;
      continue;
    }
    if (args.since) {
      const d = dateOfFile(name);
      if (!d || d < args.since) continue;
    }
    if (stored.has(name)) {
      alreadyStored++;
      continue;
    }
    const list = byCoin.get(coin);
    if (list) list.push(name);
    else byCoin.set(coin, [name]);
  }
  const coins = [...byCoin.keys()].sort();
  const candidates = coins.reduce((n, c) => n + byCoin.get(c)!.length, 0);
  const total = Math.min(candidates, args.limit);
  console.log(
    `TFM backfill: ${candidates} snapshot file(s) to forecast${Number.isFinite(args.limit) ? `, this run at most ${args.limit}` : ''}` +
      ` (${alreadyStored} already stored, ${unknownCoinFiles} of coins without a Binance symbol); batch ${args.batch}.`,
  );

  const startMs = Date.now();
  let stored_ = 0;
  let skippedShort = 0;
  let unreadable = 0;
  let planned = 0;
  let nextProgress = PROGRESS_EVERY;

  const summary = (): void => {
    const secs = (Date.now() - startMs) / 1000;
    console.log(
      `Stored ${stored_} forecast(s); skipped, not enough price history: ${skippedShort}; unreadable files: ${unreadable};` +
        ` files of unknown coins: ${unknownCoinFiles}; ${secs.toFixed(1)} s, ${(stored_ / Math.max(0.001, secs)).toFixed(1)} records/s.`,
    );
  };
  const stop = (msg: string): never => {
    console.error(msg);
    summary();
    process.exit(1);
  };

  for (const coin of coins) {
    if (planned >= total) break;
    const left = total - planned;

    // Read files (oldest name first) until the run's limit is reached.
    const inputs: SnapshotInput[] = [];
    for (const name of byCoin.get(coin)!) {
      if (inputs.length >= left) break;
      try {
        const input = snapshotInputOf(name, JSON.parse(fs.readFileSync(path.join(historyDir, name), 'utf8')));
        if (!input) {
          unreadable++;
          continue;
        }
        input.coin = coin.toUpperCase(); // the coin is the file name prefix, whatever the content says
        inputs.push(input);
      } catch {
        unreadable++;
      }
    }
    if (inputs.length === 0) continue;
    inputs.sort((a, b) => a.tsMs - b.tsMs || (a.file < b.file ? -1 : 1));
    planned += inputs.length;

    // Bars: one range per segment; a gap of more than 3 days between snapshots starts a new segment.
    const segments: { from: number; to: number }[] = [];
    for (const input of inputs) {
      const last = segments[segments.length - 1];
      if (last && input.tsMs - last.to <= SEGMENT_GAP_MS) last.to = input.tsMs;
      else segments.push({ from: input.tsMs, to: input.tsMs });
    }
    const bars: MinuteBar[] = [];
    for (const seg of segments) {
      const from = seg.from - barsBackMin(args.context) * MIN_MS;
      try {
        for (const b of await fetchMinuteBars(coin, from, seg.to)) bars.push(b);
      } catch (e) {
        stop(`Binance failed for ${coin.toUpperCase()} bars ${fmtTs(from)} to ${fmtTs(seg.to)}: ${e instanceof Error ? e.message : e}. What is already saved stays; run the same command again to continue.`);
      }
    }
    console.log(`[${coin.toUpperCase()}] ${inputs.length} snapshot(s), ${bars.length} bars in ${segments.length} range(s), ${fmtTs(inputs[0].tsMs)} to ${fmtTs(inputs[inputs.length - 1].tsMs)}`);

    for (let i = 0; i < inputs.length; i += args.batch) {
      const batch = inputs.slice(i, i + args.batch);
      const enough = batch.filter((inp) => contextAsOf(bars, inp.tsMs, inp.spot, args.context).length >= minContextFor(args.context)).length;
      const records = await forecastSnapshots(batch, () => bars, 'backfill', undefined, undefined, args.context);
      if (enough > 0 && records.length === 0) {
        stop(`The TimesFM service gave no answer for a batch of ${batch.length} (${coin.toUpperCase()}, ${fmtTs(batch[0].tsMs)} to ${fmtTs(batch[batch.length - 1].tsMs)}). Is it still running? Check npm run tfm, then run the same command again to continue.`);
      }
      appendTfmRecords(records, args.context);
      stored_ += records.length;
      skippedShort += batch.length - enough;
      while (stored_ >= nextProgress) {
        console.log(`  ${stored_} / ${total} done, ${rate(stored_, startMs)} records/s`);
        nextProgress += PROGRESS_EVERY;
      }
    }
  }

  summary();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
