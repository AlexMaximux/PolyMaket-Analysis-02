import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());

import fs from 'fs';
import path from 'path';
import { CL_DIR, claudeModelAt, clFilename, reconstructPrices, saveClRecord, type Rec } from '../src/lib/clSnapshot';

/**
 * Builds CL-<name> copies (jev/cl/) of the records already in jev/history, adding the Claude model's fair value
 * as it would have been at the time of each record (spot, open and t from the record, volatility from the Binance
 * 1m bars before its timestamp; the oldest records saved no spot/open, so those are reconstructed from klines and
 * flagged claude_model.source = "klines-reconstructed"). Nothing in jev/history is changed, existing CL files are never overwritten, and
 * no LLM is called: this only reads the history and Binance's public klines, so it is free and safe to re-run.
 *
 *   npm run backfill:cl                 # every coin
 *   npm run backfill:cl -- --coin=btc   # one coin
 *   npm run backfill:cl -- --dry        # count only, write nothing
 *   npm run backfill:cl -- --limit=50   # at most 50 new files
 */

// Same venues the 1H markets resolve on as /api/updown (HYPE is on USD-M futures). ZEC has no market config.
const SYMBOLS: Record<string, { symbol: string; futures: boolean }> = {
  btc: { symbol: 'BTCUSDT', futures: false },
  eth: { symbol: 'ETHUSDT', futures: false },
  sol: { symbol: 'SOLUSDT', futures: false },
  xrp: { symbol: 'XRPUSDT', futures: false },
  doge: { symbol: 'DOGEUSDT', futures: false },
  bnb: { symbol: 'BNBUSDT', futures: false },
  hype: { symbol: 'HYPEUSDT', futures: true },
};
const LOOKBACK_MS = 17 * 3600_000; // 1020 bars before the earliest record; the model needs 960
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function getJson(url: string): Promise<unknown> {
  let last: unknown;
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (res.ok) return await res.json();
      last = new Error(`HTTP ${res.status}`);
    } catch (err) {
      last = err;
    }
    await sleep(1500 * (i + 1));
  }
  throw last;
}

async function fetchKlines(coin: string, fromMs: number, toMs: number): Promise<unknown[][]> {
  const { symbol, futures } = SYMBOLS[coin];
  const host = futures ? 'https://fapi.binance.com/fapi/v1' : 'https://api.binance.com/api/v3';
  const out: unknown[][] = [];
  let cur = fromMs;
  while (cur < toMs) {
    const page = await getJson(`${host}/klines?symbol=${symbol}&interval=1m&startTime=${cur}&endTime=${toMs}&limit=1000`);
    if (!Array.isArray(page) || page.length === 0) break;
    out.push(...page);
    cur = Number(page[page.length - 1][0]) + 60_000;
    await sleep(80);
  }
  return out;
}

async function run() {
  const args = process.argv.slice(2);
  const coinArg = args.find(a => a.startsWith('--coin='))?.split('=')[1]?.toLowerCase();
  const limit = Number(args.find(a => a.startsWith('--limit='))?.split('=')[1] ?? Infinity);
  const dry = args.includes('--dry');

  const historyDir = path.join(process.cwd(), 'jev', 'history');
  if (!fs.existsSync(historyDir)) {
    console.error('jev/history does not exist');
    return;
  }
  fs.mkdirSync(CL_DIR, { recursive: true });

  const skipped = { exists: 0, unknownCoin: 0, unreadable: 0 };
  let legacy = 0;
  const byCoin = new Map<string, { file: string; rec: Rec }[]>();
  for (const file of fs.readdirSync(historyDir).filter(f => f.endsWith('.json')).sort()) {
    const coin = file.split('_')[0].toLowerCase();
    if (coinArg && coinArg !== 'all' && coin !== coinArg) continue;
    if (!SYMBOLS[coin]) { skipped.unknownCoin++; continue; }
    if (fs.existsSync(path.join(CL_DIR, clFilename(file)))) { skipped.exists++; continue; }
    let rec: Rec;
    try {
      rec = JSON.parse(fs.readFileSync(path.join(historyDir, file), 'utf8'));
    } catch {
      skipped.unreadable++;
      continue;
    }
    if (!rec.timestamp) { skipped.unreadable++; continue; }
    if (!rec.spot_price || !rec.open_price) legacy++;
    if (!byCoin.has(coin)) byCoin.set(coin, []);
    byCoin.get(coin)!.push({ file, rec });
  }

  const total = [...byCoin.values()].reduce((s, v) => s + v.length, 0);
  console.log(`To build: ${total} CL files (${legacy} are legacy records without spot/open: reconstructed from klines and flagged). Already done: ${skipped.exists}. Coin without market config (e.g. ZEC): ${skipped.unknownCoin}. Unreadable: ${skipped.unreadable}.`);
  if (dry || total === 0) return;

  let written = 0, noModel = 0;
  for (const [coin, items] of byCoin) {
    if (written >= limit) break;
    const times = items.map(i => Date.parse(i.rec.timestamp)).filter(Number.isFinite);
    const klines = await fetchKlines(coin, Math.min(...times) - LOOKBACK_MS, Math.max(...times) + 120_000);
    console.log(`[${coin.toUpperCase()}] ${items.length} records, ${klines.length} 1m bars fetched`);
    for (const { file, rec } of items) {
      if (written >= limit) break;
      let r = rec;
      let source = 'klines-backfill';
      if (!rec.spot_price || !rec.open_price) {
        const p = reconstructPrices(rec, klines);
        if (!p) { noModel++; continue; }
        r = { ...rec, spot_price: p.spot, open_price: p.open, price_to_beat: p.open };
        source = 'klines-reconstructed';
      }
      const cm = claudeModelAt(r, klines);
      if (!cm) { noModel++; continue; }
      const res = saveClRecord({ ...r, claude_model: { ...cm, source } }, file);
      if (res.written) written++;
    }
  }
  console.log(`Done. Wrote ${written} CL files into jev/cl/. Records the model could not run on (too little Binance history): ${noModel}.`);
}

if (require.main === module) {
  run().catch(err => { console.error(err); process.exit(1); });
}
