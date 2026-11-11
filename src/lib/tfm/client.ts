/** HTTP client of the local TimesFM service (tfm/server.py). Never throws. */

export const TFM_URL: string = process.env.TFM_URL || 'http://127.0.0.1:8002';

export async function tfmHealth(timeoutMs = 1500): Promise<{ ok: boolean; model?: string }> {
  try {
    const res = await fetch(`${TFM_URL}/health`, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
    if (!res.ok) return { ok: false };
    const body = (await res.json()) as { ok?: unknown; model?: unknown };
    if (body?.ok !== true) return { ok: false };
    return { ok: true, model: typeof body.model === 'string' ? body.model : undefined };
  } catch {
    return { ok: false };
  }
}

const isNumArray = (v: unknown): v is number[] => Array.isArray(v) && v.every((x) => typeof x === 'number');

/** deciles for every series and step: quantiles[series][step][9]; null on any failure (service down, 400, bad shape). */
export async function tfmForecast(
  series: number[][],
  horizon: number,
  timeoutMs = 60_000,
): Promise<{ model: string; mean: number[][]; quantiles: number[][][] } | null> {
  try {
    const res = await fetch(`${TFM_URL}/forecast`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ series, horizon }),
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { model?: unknown; mean?: unknown; quantiles?: unknown };
    if (typeof body.model !== 'string') return null;
    if (!Array.isArray(body.mean) || !Array.isArray(body.quantiles)) return null;
    if (body.mean.length !== series.length || body.quantiles.length !== series.length) return null;
    if (!body.mean.every(isNumArray)) return null;
    for (const q of body.quantiles as unknown[]) {
      if (!Array.isArray(q) || q.length !== horizon || !q.every(isNumArray)) return null;
    }
    return { model: body.model, mean: body.mean as number[][], quantiles: body.quantiles as number[][][] };
  } catch {
    return null;
  }
}
