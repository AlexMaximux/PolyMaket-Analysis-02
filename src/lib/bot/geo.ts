export interface PolymarketGeoStatus {
  checked: boolean;
  blocked: boolean;
  apiBlocked: boolean;
  country: string | null;
  region: string | null;
}

const CACHE_MS = 60_000;
// Official API documentation: these jurisdictions restrict the frontend only.
// Malta's frontend restriction is sports-only; its API is unrestricted.
// Verified 2026-09-29: https://docs.polymarket.com/api-reference/geoblock
const FRONTEND_ONLY_COUNTRIES = new Set(['IE', 'JP', 'MT', 'NL', 'KR']);
let cached: { at: number; value: PolymarketGeoStatus } | null = null;

/** Check Polymarket's own location decision without retaining or exposing the server IP. */
export async function getPolymarketGeoStatus(fresh = false): Promise<PolymarketGeoStatus> {
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.value;

  try {
    const response = await fetch('https://polymarket.com/api/geoblock', {
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
      headers: { 'User-Agent': 'PolymarketPulseBot/1.0' },
    });
    if (!response.ok) throw new Error('Geoblock endpoint failed');
    const body = await response.json() as Record<string, unknown>;
    if (typeof body.blocked !== 'boolean') throw new Error('Invalid geoblock response');
    const country = typeof body.country === 'string' ? body.country.trim().toUpperCase() : null;
    const value: PolymarketGeoStatus = {
      checked: true,
      blocked: body.blocked,
      apiBlocked: body.blocked && !FRONTEND_ONLY_COUNTRIES.has(country || ''),
      country,
      region: typeof body.region === 'string' ? body.region : null,
    };
    cached = { at: Date.now(), value };
    return value;
  } catch {
    cached = null;
    return { checked: false, blocked: false, apiBlocked: true, country: null, region: null };
  }
}
