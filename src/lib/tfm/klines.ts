import type { MinuteBar } from './types';

export const TFM_SYMBOLS: Record<string, { symbol: string; futures: boolean }> = {
  btc: { symbol: 'BTCUSDT', futures: false },
  eth: { symbol: 'ETHUSDT', futures: false },
  sol: { symbol: 'SOLUSDT', futures: false },
  xrp: { symbol: 'XRPUSDT', futures: false },
  doge: { symbol: 'DOGEUSDT', futures: false },
  bnb: { symbol: 'BNBUSDT', futures: false },
  hype: { symbol: 'HYPEUSDT', futures: true },
};

const SPOT_HOST = 'https://api.binance.com/api/v3';
const FUTURES_HOST = 'https://fapi.binance.com/fapi/v1';
const MIN_MS = 60_000;
const PAGE = 1000;
const TIMEOUT_MS = 8000;
const TRIES = 3;

async function getJson(url: string): Promise<unknown[]> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < TRIES; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (!Array.isArray(body)) throw new Error('unexpected klines body');
      return body;
    } catch (e) {
      lastErr = e;
      if (attempt < TRIES - 1) await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('klines request failed');
}

/**
 * 1-minute bars with openTime in [fromMs, toMs], ascending and without duplicates. A coin that is not in
 * TFM_SYMBOLS gives []. Throws when Binance cannot be reached after the retries.
 */
export async function fetchMinuteBars(coin: string, fromMs: number, toMs: number): Promise<MinuteBar[]> {
  const cfg = TFM_SYMBOLS[coin.toLowerCase()];
  if (!cfg) return [];
  const host = cfg.futures ? FUTURES_HOST : SPOT_HOST;
  const out: MinuteBar[] = [];
  let start = Math.floor(fromMs / MIN_MS) * MIN_MS;
  let lastOpen = -1;
  while (start <= toMs) {
    const rows = await getJson(`${host}/klines?symbol=${cfg.symbol}&interval=1m&startTime=${start}&limit=${PAGE}`);
    if (rows.length === 0) break;
    for (const r of rows as unknown[][]) {
      const openTime = Number(r[0]);
      const open = Number(r[1]);
      const close = Number(r[4]);
      if (!Number.isFinite(openTime) || !Number.isFinite(open) || !Number.isFinite(close)) continue;
      if (openTime <= lastOpen || openTime > toMs) continue;
      out.push({ openTime, open, close });
      lastOpen = openTime;
    }
    const last = Number((rows[rows.length - 1] as unknown[])[0]);
    if (!Number.isFinite(last) || last + MIN_MS <= start) break;
    start = last + MIN_MS;
    if (rows.length < PAGE) break;
  }
  return out;
}
