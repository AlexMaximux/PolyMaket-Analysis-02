import { NextResponse } from 'next/server';
import { normCdf, normInv } from '@/lib/normal';

export const dynamic = 'force-dynamic';

// rv60 sigma, window-limited drift, 1.5¢ saturation gate, HYPE on USD-M futures
const MODEL_VERSION = '2026-09-26.rv60-win';

/**
 * GET /api/updown?coin=btc
 *
 * Live state for the Up/Down markets dashboard:
 *  - active 1H, 15m, 5m Polymarket markets (slug constructed from current time, verified)
 *  - BTC spot prices from Binance: hour open (S0), active-15m open (Sa), latest (St)
 *  - CLOB midpoints for every active market (real-time market prices)
 *  - fair value of the 1H Up market, per user's drift-extraction model:
 *      x_t = ln(St/S0), y = ln(St/Sa)
 *      z = Phi^-1(p15); mu = (z*sigma_m*sqrt(tau15) - y) / tau15
 *      fair = Phi((x_t + mu*tau15) / (sigma_m*sqrt(tau60)))
 *    The implied drift applies only over the window the 15m market prices (tau15), not the rest of
 *    the hour: extrapolating it over tau60 doubled log loss on a 4-week backfill (1.00 vs 0.485).
 *    sigma_1h defaults to realized vol of the last 60 one-minute bars (fallback: last 7 days of 1h
 *    candles), overridable via ?sigma=. rv60 calibrated Base best out of sample on an untouched holdout.
 */

const COINS: Record<string, { binance: string; label: string; slugPrefix: string; hourWord: string; futures?: boolean }> = {
  btc: { binance: 'BTCUSDT', label: 'Bitcoin', slugPrefix: 'btc-updown', hourWord: 'bitcoin' },
  eth: { binance: 'ETHUSDT', label: 'Ethereum', slugPrefix: 'eth-updown', hourWord: 'ethereum' },
  sol: { binance: 'SOLUSDT', label: 'Solana', slugPrefix: 'sol-updown', hourWord: 'solana' },
  xrp: { binance: 'XRPUSDT', label: 'XRP', slugPrefix: 'xrp-updown', hourWord: 'xrp' },
  doge: { binance: 'DOGEUSDT', label: 'Dogecoin', slugPrefix: 'doge-updown', hourWord: 'dogecoin' },
  // HYPE 1H markets resolve on the Binance USD-M futures HYPEUSDT candle, not spot
  hype: { binance: 'HYPEUSDT', label: 'Hyperliquid', slugPrefix: 'hype-updown', hourWord: 'hype', futures: true },
  bnb: { binance: 'BNBUSDT', label: 'BNB', slugPrefix: 'bnb-updown', hourWord: 'bnb' },
};

function etParts(d: Date) {
  // America/New_York wall clock, so the 1h slug stays right across EDT/EST switches and years
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', hour12: true,
  }).formatToParts(d)) parts[p.type] = p.value;
  return {
    year: parts.year, month: parts.month.toLowerCase(), day: Number(parts.day),
    h12: Number(parts.hour), ampm: parts.dayPeriod.toLowerCase(),
  };
}

async function j(url: string, timeoutMs = 8000): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; } finally { clearTimeout(t); }
}

// ---------- module-level caches (survive between requests) ----------
const openPriceCache = new Map<string, { value: number | null; expires: number }>();
const gammaCache = new Map<string, { value: any; expires: number }>();
const klineCache = new Map<string, { value: number | null; expires: number }>();

// openPrice of a window is fixed once the window starts — cache a found price until window end + slack;
// a miss (page not showing this window's price yet) is retried after 15 s instead of pinning null
async function polymarketOpenPriceCached(slug: string, startSec: number, winSec: number): Promise<number | null> {
  const hit = openPriceCache.get(slug);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await polymarketOpenPrice(slug, startSec);
  const ttl = value != null ? winSec * 1000 + 60_000 : 15_000;
  openPriceCache.set(slug, { value, expires: Date.now() + ttl });
  return value;
}

async function gammaEventCached(key: string, url: string): Promise<any> {
  const hit = gammaCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const d = await j(url);
  if (Array.isArray(d) && d.length) gammaCache.set(key, { value: d, expires: Date.now() + 20_000 });
  return d;
}

const binanceHost = (futures: boolean) => (futures ? 'https://fapi.binance.com/fapi/v1' : 'https://api.binance.com/api/v3');

async function binanceKlineCached(symbol: string, startSec: number, futures: boolean): Promise<number | null> {
  const key = `${futures ? 'f' : 's'}:${symbol}:${startSec}`;
  const hit = klineCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const v = await binanceKline(symbol, startSec, futures);
  // historical 1m open never changes; a miss (candle not published yet) is retried after 5 s
  klineCache.set(key, { value: v, expires: Date.now() + (v != null ? 120_000 : 5_000) });
  return v;
}

// periodic cleanup so maps don't grow unbounded
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of openPriceCache) if (v.expires < now - 600_000) openPriceCache.delete(k);
  for (const [k, v] of gammaCache) if (v.expires < now) gammaCache.delete(k);
  for (const [k, v] of klineCache) if (v.expires < now - 300_000) klineCache.delete(k);
}, 120_000).unref();

async function eventBySlug(slug: string) {
  const d = await gammaEventCached(slug, `https://gamma-api.polymarket.com/events?slug=${slug}`);
  if (!Array.isArray(d) || !d.length) return null;
  const m = d[0]?.markets?.[0];
  if (!m) return null;
  const prices = JSON.parse(m.outcomePrices || '["0.5","0.5"]');
  let tokens: string[] = [];
  try { tokens = JSON.parse(m.clobTokenIds || '[]'); } catch {}
  return {
    slug, title: d[0].title, up: parseFloat(prices[0]), down: parseFloat(prices[1]), live: null as number | null, liveDown: null as number | null,
    closed: !!m.closed, accepting: !!m.acceptingOrders,
    endDate: m.endDate, startDate: m.startDate,
    tokenUp: tokens[0] || '', tokenDown: tokens[1] || '',
    book: null as UpBook | null,
  };
}

async function clobMid(token: string): Promise<number | null> {
  if (!token) return null;
  const d = await j(`https://clob.polymarket.com/midpoint?token_id=${token}`, 5000);
  return d?.mid ? parseFloat(d.mid) : null;
}

// Top of the Up-token order book: what a trade would actually pay (ask) or receive (bid),
// plus size at best and depth within 5¢ — saved in snapshots so backtests can use real spreads.
type UpBook = { bid: number | null; ask: number | null; spread: number | null; bidSize: number; askSize: number; bidDepth5c: number; askDepth5c: number };
async function clobBook(token: string): Promise<UpBook | null> {
  if (!token) return null;
  const d = await j(`https://clob.polymarket.com/book?token_id=${token}`, 5000);
  if (!d || !Array.isArray(d.bids) || !Array.isArray(d.asks)) return null;
  const lv = (xs: any[]) => xs.map(x => ({ p: parseFloat(x.price), s: parseFloat(x.size) })).filter(x => x.p > 0 && x.s > 0);
  const bids = lv(d.bids).sort((a, b) => b.p - a.p);
  const asks = lv(d.asks).sort((a, b) => a.p - b.p);
  const bid = bids[0]?.p ?? null, ask = asks[0]?.p ?? null;
  const depth = (xs: { p: number; s: number }[], best: number | null) =>
    best == null ? 0 : xs.filter(x => Math.abs(x.p - best) <= 0.05 + 1e-9).reduce((s, x) => s + x.s, 0);
  return {
    bid, ask, spread: bid != null && ask != null ? +(ask - bid).toFixed(4) : null,
    bidSize: bids[0]?.s ?? 0, askSize: asks[0]?.s ?? 0,
    bidDepth5c: depth(bids, bid), askDepth5c: depth(asks, ask),
  };
}

// Polymarket's UI displays the market's official opening price (Chainlink for 15m/5m,
// exact boundary price for 1h). It's embedded in the event page's dehydrated react-query state as
//   {"state":{"data":{"openPrice":X,"closePrice":null},…},"queryKey":["crypto-prices","price","BTC","<start ISO>",…]}
// The same page also lists openPrice for past windows (and 5m pages often omit the live window's
// query), so only the query keyed by THIS window's start time is accepted; otherwise null → Binance fallback.
async function polymarketOpenPrice(slug: string, startSec: number): Promise<number | null> {
  if (!slug) return null;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 9000);   // covers the body read too, not just the headers
  try {
    const res = await fetch(`https://polymarket.com/event/${slug}`, {
      signal: ctl.signal,
      cache: 'no-store',
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
    });
    if (!res.ok) return null;
    const html = (await res.text()).replace(/\\+"/g, '"');
    const startIso = new Date(startSec * 1000).toISOString().replace('.000Z', 'Z');
    const m = html.match(new RegExp(`"openPrice":\\s*([0-9.]+)[^\\]]{0,800}"queryKey":\\["crypto-prices","price","[A-Z0-9]+","${startIso}"`));
    const v = m ? parseFloat(m[1]) : NaN;
    return v > 0 ? v : null;
  } catch { return null; } finally { clearTimeout(t); }
}

async function binanceKline(symbol: string, startSec: number, futures: boolean): Promise<number | null> {
  if (!symbol) return null;
  // resolution venue only (spot, or USD-M futures for HYPE): the other venue trades at a basis of several bps,
  // so a miss falls through to the Polymarket open instead of silently mixing venues
  const d = await j(`${binanceHost(futures)}/klines?symbol=${symbol}&interval=1m&startTime=${startSec * 1000}&limit=1`);
  return Array.isArray(d) && d[0] && d[0][1] ? parseFloat(d[0][1]) : null;
}

// Realized hourly vol: sample stdev of ln(close/open) over the last 7 days of Binance 1h candles
// (in-progress candle excluded). Refreshed every 10 min; a failed refresh keeps the previous value.
const sigmaCache = new Map<string, { value: number | null; expires: number }>();
async function realizedSigma1h(symbol: string, futures: boolean): Promise<number | null> {
  const key = `${futures ? 'f' : 's'}:${symbol}`;
  const hit = sigmaCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const d = await j(`${binanceHost(futures)}/klines?symbol=${symbol}&interval=1h&limit=169`);
  let value: number | null = null;
  if (Array.isArray(d) && d.length >= 25) {
    const r = d.slice(0, -1).map((k: any) => Math.log(parseFloat(k[4]) / parseFloat(k[1]))).filter(Number.isFinite);
    const mean = r.reduce((s: number, x: number) => s + x, 0) / r.length;
    value = Math.sqrt(r.reduce((s: number, x: number) => s + (x - mean) ** 2, 0) / (r.length - 1));
  }
  value = value ?? hit?.value ?? null;
  sigmaCache.set(key, { value, expires: Date.now() + (value != null ? 600_000 : 60_000) });
  return value;
}

// Trailing 60-min realized vol in hourly units: sqrt(60 · mean of ln(close/open)²) over the 1m bars
// that closed within the last hour (at least 45 of them). On a 4-week backfill and an untouched
// 4-week holdout it calibrated Base better than the 7-day sigma (log loss −0.013, t≈5).
// Cached until the next 1m bar closes. A failed refresh keeps a value computed within the last 5 min
// (the 7-day sigma is 1.6–3× rv60, so one Binance timeout must not swing every fair value).
const rv60Cache = new Map<string, { value: number | null; expires: number; at: number }>();
async function realizedVol60m(symbol: string, futures: boolean): Promise<number | null> {
  const key = `${futures ? 'f' : 's'}:${symbol}`;
  const hit = rv60Cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const d = await j(`${binanceHost(futures)}/klines?symbol=${symbol}&interval=1m&limit=61`);
  let value: number | null = null;
  if (Array.isArray(d)) {
    const now = Date.now();
    const r2 = d
      .filter((k: any) => Number(k[6]) < now)                      // close time passed → bar is final
      .slice(-60)
      .map((k: any) => Math.log(parseFloat(k[4]) / parseFloat(k[1])) ** 2)
      .filter(Number.isFinite);
    if (r2.length >= 45) value = Math.sqrt((60 * r2.reduce((s: number, x: number) => s + x, 0)) / r2.length);
  }
  if (value != null) {
    const nextBar = (Math.floor(Date.now() / 60_000) + 1) * 60_000 + 2_000;
    rv60Cache.set(key, { value, expires: nextBar, at: Date.now() });
    return value;
  }
  const recent = hit?.value != null && Date.now() - hit.at < 300_000 ? hit.value : null;
  rv60Cache.set(key, { value: recent, expires: Date.now() + 10_000, at: recent != null ? hit!.at : 0 });
  return recent;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const coinKey = (searchParams.get('coin') || 'btc').toLowerCase();
  const cfg = COINS[coinKey];
  if (!cfg) return NextResponse.json({ error: 'unknown coin' }, { status: 400 });
  const sigmaParam = parseFloat(searchParams.get('sigma') || '');
  const sigmaManual = Number.isFinite(sigmaParam) && sigmaParam > 0;
  const futures = !!cfg.futures;
  // started now, awaited just before the models so the kline fetches overlap the market lookups
  const sigmasP = Promise.all([realizedVol60m(cfg.binance, futures), realizedSigma1h(cfg.binance, futures)]);

  const now = new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  const secIntoHour = nowSec % 3600;
  const t = secIntoHour / 60;                    // minutes into hour (float)
  const hourStartSec = nowSec - secIntoHour;
  const win15Sec = nowSec - (nowSec % 900);
  const win5Sec = nowSec - (nowSec % 300);
  const next15Sec = win15Sec + 900;
  const next5Sec = win5Sec + 300;

  // ---- Polymarket events (constructed slugs, hour/15m/5m) ----
  const { year, month, day, h12, ampm } = etParts(now);
  const genericHourSlug = `${cfg.hourWord}-up-or-down-${month}-${day}-${year}-${h12}${ampm}-et`;

  const [m1h, m15, m5, n15, n5] = await Promise.all([
    eventBySlug(genericHourSlug),
    eventBySlug(`${cfg.slugPrefix}-15m-${win15Sec}`),
    eventBySlug(`${cfg.slugPrefix}-5m-${win5Sec}`),
    eventBySlug(`${cfg.slugPrefix}-15m-${next15Sec}`),
    eventBySlug(`${cfg.slugPrefix}-5m-${next5Sec}`),
  ]);

  // ---- Opening prices: Binance 1m open at each window start. Same venue as St, so the
  //      Binance/Chainlink basis cancels in x_t, y and y5 (the 1h market itself resolves on the
  //      Binance 1h candle; 15m/5m resolve on Chainlink, whose window-to-window moves track Binance).
  //      The Polymarket page's Chainlink open is fetched only when Binance has no candle. ----
  const [s0b, sab, sa5b, stRaw] = await Promise.all([
    binanceKlineCached(cfg.binance, hourStartSec, futures),
    binanceKlineCached(cfg.binance, win15Sec, futures),
    binanceKlineCached(cfg.binance, win5Sec, futures),
    j(`${binanceHost(futures)}/ticker/price?symbol=${cfg.binance}`, 5000),
  ]);
  const [s0pm, sapm, sa5pm] = await Promise.all([
    m1h && s0b == null ? polymarketOpenPriceCached(m1h.slug, hourStartSec, 3600) : Promise.resolve(null),
    m15 && sab == null ? polymarketOpenPriceCached(m15.slug, win15Sec, 900) : Promise.resolve(null),
    m5 && sa5b == null ? polymarketOpenPriceCached(m5.slug, win5Sec, 300) : Promise.resolve(null),
  ]);
  const s0 = s0b ?? s0pm;
  const sa = sab ?? sapm;
  const sa5 = sa5b ?? sa5pm;
  let st = stRaw?.price ? parseFloat(stRaw.price) : null;
  if (st == null) {
    // same venue first: close of the in-progress 1m kline is the last trade price
    const k = await j(`${binanceHost(futures)}/klines?symbol=${cfg.binance}&interval=1m&limit=1`, 5000);
    st = Array.isArray(k) && k[0]?.[4] ? parseFloat(k[0][4]) : null;
  }
  if (st == null && !futures) {
    // spot coins only: OKX then Gate.io spot tickers (a futures-resolved coin must not take a spot price)
    const symbolPair = `${coinKey.toUpperCase()}-USDT`;
    const okx = await j(`https://www.okx.com/api/v5/market/ticker?instId=${symbolPair}`, 5000);
    st = okx?.data?.[0]?.last ? parseFloat(okx.data[0].last) : null;
    if (st == null) {
      const gate = await j(`https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${coinKey.toUpperCase()}_USDT`, 5000);
      st = Array.isArray(gate) && gate[0]?.last ? parseFloat(gate[0].last) : null;
    }
  }

  // ---- CLOB midpoints (true live market prices) + Up-token books for the 1H and 15m markets ----
  const [mid1hUp, mid1hDn, mid15Up, mid15Dn, mid5Up, mid5Dn, book1h, book15] = await Promise.all([
    m1h ? clobMid(m1h.tokenUp) : Promise.resolve(null),
    m1h ? clobMid(m1h.tokenDown) : Promise.resolve(null),
    m15 ? clobMid(m15.tokenUp) : Promise.resolve(null),
    m15 ? clobMid(m15.tokenDown) : Promise.resolve(null),
    m5 ? clobMid(m5.tokenUp) : Promise.resolve(null),
    m5 ? clobMid(m5.tokenDown) : Promise.resolve(null),
    m1h ? clobBook(m1h.tokenUp) : Promise.resolve(null),
    m15 ? clobBook(m15.tokenUp) : Promise.resolve(null),
  ]);
  if (m1h) m1h.book = book1h;
  if (m15) m15.book = book15;
  if (m1h) { m1h.live = mid1hUp ?? (mid1hDn != null ? 1 - mid1hDn : null); m1h.liveDown = mid1hDn ?? (mid1hUp != null ? 1 - mid1hUp : null); }
  if (m15) { m15.live = mid15Up ?? (mid15Dn != null ? 1 - mid15Dn : null); m15.liveDown = mid15Dn ?? (mid15Up != null ? 1 - mid15Up : null); }
  if (m5) { m5.live = mid5Up ?? (mid5Dn != null ? 1 - mid5Dn : null); m5.liveDown = mid5Dn ?? (mid5Up != null ? 1 - mid5Up : null); }

  // ---- Fair value models (same drift-extraction, calibrated on 15m and 5m markets separately) ----
  const p15 = m15?.live ?? m15?.up ?? null;
  const p5 = m5?.live ?? m5?.up ?? null;
  let model: any = null;
  let model5: any = null;
  const [sigma60m, sigma7d] = await sigmasP;
  const sigmaSource = sigmaManual ? 'manual' : sigma60m != null ? 'realized-60m' : sigma7d != null ? 'realized-7d' : 'default';
  const sigma1h = Math.min(Math.max(sigmaManual ? sigmaParam : (sigma60m ?? sigma7d ?? 0.02), 0.002), 0.2);
  const sigmaM = sigma1h / Math.sqrt(60);
  const a = 15 * Math.floor(t / 15);
  const q = t - a;
  const tau15 = 15 - q;
  const tau60 = 60 - t;
  const xt = s0 && st ? Math.log(st / s0) : null;
  const y = xt != null && sa && st != null ? Math.log(st / sa) : null;
  const a5 = 5 * Math.floor(t / 5);
  const q5 = t - a5;
  const tau5 = 5 - q5;
  const y5 = xt != null && sa5 && st != null ? Math.log(st / sa5) : null;

  // A 15m/5m price within 1.5¢ of 0 or 1 sits on the 1¢ tick floor/ceiling and no longer reflects how far
  // spot has moved, so the drift it implies is meaningless (log loss +0.053 vs Base on those rows).
  const usable = (p: number | null): p is number => p != null && p > 0.015 && p < 0.985;

  if (s0 && st && usable(p15) && xt != null && y != null) {
    const z15 = normInv(p15);
    const mu = tau15 > 0.01 ? (z15 * sigmaM * Math.sqrt(tau15) - y) / tau15 : 0;
    // drift only until the 15m window ends (zero drift for the rest of the hour)
    const fair = normCdf((xt + mu * tau15) / (sigmaM * Math.sqrt(tau60)));
    model = {
      t, a, q, tau15, tau60, sigma1h, sigmaM,
      s0, sa, st, xt, y, p15, z15, mu,
      fairUp: fair, fairDown: 1 - fair,
      market1hUp: m1h?.live ?? m1h?.up ?? null,
      edge: m1h?.live != null ? fair - (m1h.live as number) : null,   // fair - market (>0 = Up underpriced)
    };
  }

  // 5m-calibrated variant: drift implied by the live 5-minute market
  if (s0 && st && usable(p5) && xt != null && y5 != null) {
    const z5 = normInv(p5);
    const mu5 = tau5 > 0.01 ? (z5 * sigmaM * Math.sqrt(tau5) - y5) / tau5 : 0;
    const fair5 = normCdf((xt + mu5 * tau5) / (sigmaM * Math.sqrt(tau60)));   // drift only over the 5m window
    model5 = {
      a5, q5, tau5, y5, p5, z5, mu5,
      sa5,
      fairUp: fair5, fairDown: 1 - fair5,
      edge: m1h?.live != null ? fair5 - (m1h.live as number) : null,
    };
  }

  // ---- Part A: base 1H valuation (no drift, Black-Scholes style) ----
  // fair_A = Φ( x_t / (σ_1h · √τ_hours) ),  x_t = ln(St/S0), τ_hours = (60−t)/60
  let modelA: any = null;
  if (s0 && st && xt != null) {
    const tauHours = (60 - t) / 60;
    const fairA = normCdf(xt / (sigma1h * Math.sqrt(tauHours)));
    modelA = {
      tauHours, x_t: xt, sigma1h,
      fairUp: fairA, fairDown: 1 - fairA,
      edge: m1h?.live != null ? fairA - (m1h.live as number) : null,
    };
  }

  // ---- Part C: joint solve — BOTH windows (5m + 15m) determine σ_m AND μ simultaneously ----
  // system:  Φ⁻¹(p₅)  = (y₅  + μ·τ₅)  / (σ_m·√τ₅)
  //          Φ⁻¹(p₁₅) = (y₁₅ + μ·τ₁₅) / (σ_m·√τ₁₅)
  // → σ_m = (y₁₅·τ₅ − y₅·τ₁₅) / (b·τ₅·√τ₁₅ − a·τ₁₅·√τ₅),  μ = (a·σ_m·√τ₅ − y₅)/τ₅
  // fair = Φ((x_t + μ·τ₁₅)/(σ_m·√τ₆₀)): drift only until the 15m window ends (log loss 0.96 → 0.54 on the backfill)
  let modelC: any = null;
  if (xt != null && y != null && y5 != null && usable(p5) && usable(p15)) {
    const aq = normInv(p5);    // z of the 5m market
    const bq = normInv(p15);   // z of the 15m market
    const denom = bq * tau5 * Math.sqrt(tau15) - aq * tau15 * Math.sqrt(tau5);
    if (Math.abs(denom) > 1e-9) {
      const sigmaMj = (y * tau5 - y5 * tau15) / denom;
      const sigma1hJ = sigmaMj * Math.sqrt(60);
      const muJ = tau5 > 0.01 ? (aq * sigmaMj * Math.sqrt(tau5) - y5) / tau5 : 0;
      const fairJ = sigmaMj > 0 ? normCdf((xt + muJ * tau15) / (sigmaMj * Math.sqrt(tau60))) : null;
      modelC = {
        tau5, tau15, y5, y15: y, p5, p15, z5: aq, z15: bq,
        sigmaM: sigmaMj, sigma1h: sigma1hJ, mu: muJ,
        valid: sigmaMj > 0,
        fairUp: fairJ, fairDown: fairJ != null ? 1 - fairJ : null,
        edge: fairJ != null && m1h?.live != null ? fairJ - (m1h.live as number) : null,
      };
    }
  }

  return NextResponse.json({
    coin: coinKey, label: cfg.label, binanceSymbol: cfg.binance,
    spotPrice: st, openPrice: s0,
    // labels mirror the precedence above: Binance first, Polymarket (Chainlink) fallback
    openSources: {
      s0: s0b != null ? 'binance' : s0pm != null ? 'polymarket-chainlink' : null,
      sa: sab != null ? 'binance' : sapm != null ? 'polymarket-chainlink' : null,
      sa5: sa5b != null ? 'binance' : sa5pm != null ? 'polymarket-chainlink' : null,
    },
    // bump when the fair-value formulas change, so recorded ticks/snapshots can be split by model
    modelVersion: MODEL_VERSION,
    sigma1h, sigmaSource, sigma60m, sigma7d, priceVenue: futures ? 'binance-futures' : 'binance-spot',
    serverTime: nowSec, t, hourStartSec, win15Sec, win5Sec, next15Sec, next5Sec,
    m1h, m15, m5, n15, n5, model, model5, modelA, modelC, sa5,
  });
}
