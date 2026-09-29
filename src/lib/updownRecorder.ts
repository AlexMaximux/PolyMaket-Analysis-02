import fs from 'fs';
import path from 'path';
import { fetchUpdownSnapshot, warnStaleServer } from './updownSnapshot';

/**
 * Appends one line per coin per call to ticks/updown-YYYY-MM-DD.jsonl (UTC date): spot, opens, sigma,
 * 1H/15m/5m midpoints, the tradeable 1H/15m Up books and all fair values, taken from one /api/updown
 * response so they share a timestamp. Polymarket keeps no order-book history, so these files are the
 * only way to backtest signals at executable prices instead of midpoints. Rows carry model_version so
 * backtests can split them when the fair-value formulas change.
 */
export const RECORDER_COINS = ['btc', 'eth', 'sol', 'xrp', 'doge', 'hype', 'bnb'];

const r = (v: unknown, d = 6) => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(d)) : null);

/** Returns the coins that could not be recorded this time. */
export async function recordUpdownTicks(coins = RECORDER_COINS): Promise<string[]> {
  const snaps = await Promise.all(coins.map(c => fetchUpdownSnapshot(c)));
  const lines: string[] = [];
  const missing: string[] = [];
  snaps.forEach((d, i) => {
    if (!d || !d.m1h) { missing.push(coins[i]); return; }
    if (!d.modelVersion) warnStaleServer();
    lines.push(JSON.stringify({
      ts: d.serverTime, coin: d.coin, t: r(d.t, 3), model_version: d.modelVersion ?? null, venue: d.priceVenue ?? null,
      s0: d.openPrice ?? null, sa: d.model?.sa ?? null, sa5: d.sa5 ?? null, st: d.spotPrice ?? null,
      open_sources: d.openSources ?? null,
      sigma1h: r(d.sigma1h), sigma_source: d.sigmaSource ?? null, sigma60m: r(d.sigma60m), sigma7d: r(d.sigma7d),
      slug1h: d.m1h.slug, mid1h: r(d.m1h.live, 4), book1h: d.m1h.book ?? null,
      slug15: d.m15?.slug ?? null, mid15: r(d.m15?.live, 4), book15: d.m15?.book ?? null,
      mid5: r(d.m5?.live, 4),
      fair: {
        model_15m: r(d.model?.fairUp), model_5m: r(d.model5?.fairUp),
        base_no_drift: r(d.modelA?.fairUp), joint_solve: d.modelC?.valid ? r(d.modelC?.fairUp) : null,
      },
    }));
  });
  if (lines.length) {
    const dir = path.join(process.cwd(), 'ticks');
    fs.mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(path.join(dir, `updown-${day}.jsonl`), lines.join('\n') + '\n', 'utf8');
  }
  return missing;
}
