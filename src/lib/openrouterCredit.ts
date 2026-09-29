import { getSetting } from './settings';

export interface OpenRouterCredit {
  label: string | null;
  usage: number | null;
  limit: number | null;
  remaining: number | null;
}

const TTL_MS = 5 * 60_000;
let cache: { at: number; key: string; value: OpenRouterCredit } | null = null;

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Key info from OpenRouter's free /api/v1/key endpoint (no model call), cached 5 minutes. */
export async function getOpenRouterCredit(opts: { fresh?: boolean } = {}): Promise<OpenRouterCredit> {
  const key = getSetting('openrouter.apiKey');
  if (!key) throw new Error('OpenRouter API key is not set');
  if (!opts.fresh && cache && cache.key === key && Date.now() - cache.at < TTL_MS) return cache.value;
  const res = await fetch('https://openrouter.ai/api/v1/key', {
    headers: { Authorization: `Bearer ${key}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`OpenRouter answered HTTP ${res.status}`);
  const d = ((await res.json()) as any)?.data ?? {};
  const value = { label: d.label ?? null, usage: num(d.usage), limit: num(d.limit), remaining: num(d.limit_remaining) };
  cache = { at: Date.now(), key, value };
  return value;
}
