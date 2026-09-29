import fs from 'fs';
import path from 'path';

export interface ResolutionResult {
  checked: number;
  newlyResolved: number;
  pending: number;
  totalInMap: number;
}

const RESOLUTIONS_FILE = path.join(process.cwd(), 'jev', 'market_resolutions.json');
const PUBLIC_RESOLUTIONS_FILE = path.join(process.cwd(), 'public', 'jev', 'market_resolutions.json');

let isResolving = false;
let lastResolveTimestamp = 0;

/**
 * Read the current resolutions map from disk
 */
export function getResolutionsMap(): Record<string, 'UP' | 'DOWN' | 'PENDING'> {
  if (!fs.existsSync(RESOLUTIONS_FILE)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(RESOLUTIONS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('[MarketResolver] Failed to parse resolutions map:', err);
    return {};
  }
}

/**
 * Save the resolutions map atomically
 */
export function saveResolutionsMap(map: Record<string, 'UP' | 'DOWN' | 'PENDING'>): void {
  try {
    const dir = path.dirname(RESOLUTIONS_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const jsonStr = JSON.stringify(map, null, 2);
    fs.writeFileSync(RESOLUTIONS_FILE, jsonStr, 'utf8');

    // Also sync to public/jev/market_resolutions.json if directory exists
    try {
      const publicDir = path.dirname(PUBLIC_RESOLUTIONS_FILE);
      if (fs.existsSync(publicDir)) {
        fs.writeFileSync(PUBLIC_RESOLUTIONS_FILE, jsonStr, 'utf8');
      }
    } catch {}
  } catch (err) {
    console.error('[MarketResolver] Failed to save resolutions map:', err);
  }
}

/**
 * Parse market outcome from Polymarket Gamma API market object
 */
export function parseGammaMarketOutcome(market: any): {
  outcome: 'UP' | 'DOWN' | 'PENDING' | null;
  isFinal: boolean;
  status: string;
} {
  if (!market) return { outcome: null, isFinal: false, status: 'NOT_FOUND' };

  const isResolvedStatus = market.umaResolutionStatus === 'resolved' || market.closed === true;

  let prices: number[] = [];
  try {
    const raw = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : market.outcomePrices;
    if (Array.isArray(raw)) {
      prices = raw.map((p: any) => parseFloat(p));
    }
  } catch {}

  const pUp = prices[0] ?? 0;
  const pDown = prices[1] ?? 0;

  // 1. Confirmed final resolution
  if (isResolvedStatus && prices.length >= 2) {
    if (pUp >= 0.85) return { outcome: 'UP', isFinal: true, status: 'RESOLVED_UP' };
    if (pDown >= 0.85) return { outcome: 'DOWN', isFinal: true, status: 'RESOLVED_DOWN' };
  }

  // Check if candle end time has passed
  const isEnded = market.endDate && new Date(market.endDate).getTime() <= Date.now();

  // 2. Candle ended but Polymarket is still in 10-30 min UMA proposal/dispute window
  if (isEnded) {
    return {
      outcome: 'PENDING',
      isFinal: false,
      status: market.umaResolutionStatus || 'PROPOSED_WINDOW',
    };
  }

  // 3. Candle is still ongoing (active trading)
  return { outcome: null, isFinal: false, status: 'ACTIVE_TRADING' };
}

const FILENAME_TIMESTAMP_RE = /_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})_ET\.json$/;

// Filenames are "{coin}_updown_{date}_{time}_ET.json" -- the coin prefix varies (btc, bnb, eth, ...),
// so sorting the raw filename string does NOT sort chronologically across coins. Extract the embedded
// timestamp instead. Returns null for a name that doesn't match (caller keeps it rather than dropping it).
function filenameTimestampMs(filename: string): number | null {
  const m = filename.match(FILENAME_TIMESTAMP_RE);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`).getTime();
}

/**
 * Scan recent history files and find all 1-hour market slugs
 */
export function collectHistoryMarketSlugs(maxDays = 3, historyDirOverride?: string): Set<string> {
  const historyDir = historyDirOverride ?? path.join(process.cwd(), 'jev', 'history');
  const slugs = new Set<string>();
  if (!fs.existsSync(historyDir)) return slugs;

  try {
    const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000;
    const files = fs.readdirSync(historyDir).filter(f => f.endsWith('.json'));

    // A real elapsed-time cutoff, applied per file regardless of which coin it belongs to --
    // no fixed file-count budget that a fast-growing, multi-coin dataset can silently exhaust
    // for whichever coin's filename prefix happens to sort last.
    for (const f of files) {
      const fileMs = filenameTimestampMs(f);
      if (fileMs != null && fileMs < cutoff) continue;
      try {
        const filePath = path.join(historyDir, f);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const slug = data.cards?.['1h']?.slug;
        if (slug && typeof slug === 'string') {
          slugs.add(slug);
        }
      } catch {}
    }
  } catch (err) {
    console.error('[MarketResolver] Error reading history directory:', err);
  }

  return slugs;
}

/**
 * Poll Polymarket Gamma API and update market_resolutions.json
 */
export async function updateMarketResolutions(force = false): Promise<ResolutionResult> {
  // Concurrency guard
  if (isResolving) {
    return { checked: 0, newlyResolved: 0, pending: 0, totalInMap: 0 };
  }

  // Throttle guard: don't run more often than every 30 seconds unless forced
  const now = Date.now();
  if (!force && now - lastResolveTimestamp < 30000) {
    return { checked: 0, newlyResolved: 0, pending: 0, totalInMap: 0 };
  }

  isResolving = true;
  lastResolveTimestamp = now;

  let checkedCount = 0;
  let newlyResolvedCount = 0;
  let pendingCount = 0;

  try {
    const resMap = getResolutionsMap();
    const allSlugs = collectHistoryMarketSlugs(4);

    // Filter to slugs that are either not resolved yet (missing from map or marked PENDING)
    const pendingSlugs: string[] = [];
    for (const slug of allSlugs) {
      const current = resMap[slug];
      if (!current || current === 'PENDING') {
        pendingSlugs.push(slug);
      }
    }

    if (pendingSlugs.length === 0) {
      return {
        checked: 0,
        newlyResolved: 0,
        pending: 0,
        totalInMap: Object.keys(resMap).length,
      };
    }

    let modified = false;

    for (const slug of pendingSlugs) {
      checkedCount++;
      try {
        const url = `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`;
        const res = await fetch(url, { headers: { 'User-Agent': 'PolymarketPulse/1.0' } });
        if (!res.ok) {
          continue;
        }

        const data = await res.json();
        const event = Array.isArray(data) ? data[0] : null;
        const market = event?.markets?.[0];

        if (!market) {
          continue;
        }

        const { outcome, isFinal, status } = parseGammaMarketOutcome(market);

        if (isFinal && (outcome === 'UP' || outcome === 'DOWN')) {
          console.log(`[MarketResolver] 🎯 RESOLVED: ${slug} -> ${outcome} (UMA status: ${market.umaResolutionStatus || 'closed'})`);
          resMap[slug] = outcome;
          newlyResolvedCount++;
          modified = true;
        } else if (outcome === 'PENDING') {
          pendingCount++;
          if (resMap[slug] !== 'PENDING') {
            resMap[slug] = 'PENDING';
            modified = true;
          }
        }
      } catch (err: any) {
        // Soft error, skip to next slug
      }

      // Small delay between requests to be gentle to Gamma API
      await new Promise(r => setTimeout(r, 120));
    }

    if (modified) {
      saveResolutionsMap(resMap);
      console.log(
        `[MarketResolver] 💾 Updated market_resolutions.json | Newly resolved: ${newlyResolvedCount} | Pending (10-30m lag): ${pendingCount}`
      );
    }

    return {
      checked: checkedCount,
      newlyResolved: newlyResolvedCount,
      pending: pendingCount,
      totalInMap: Object.keys(resMap).length,
    };
  } catch (err: any) {
    console.error('[MarketResolver] Error updating resolutions:', err.message || err);
    return { checked: checkedCount, newlyResolved: newlyResolvedCount, pending: pendingCount, totalInMap: 0 };
  } finally {
    isResolving = false;
  }
}
