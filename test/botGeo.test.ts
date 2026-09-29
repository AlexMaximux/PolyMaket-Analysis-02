import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Polymarket frontend and API geography', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it.each(['IE', 'JP', 'MT', 'NL', 'KR'])('permits the documented API exception %s', async country => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ blocked: true, country, region: 'L', ip: 'private-ip' }))));
    const { getPolymarketGeoStatus } = await import('../src/lib/bot/geo');
    const status = await getPolymarketGeoStatus();
    expect(status).toMatchObject({ checked: true, blocked: true, apiBlocked: false, country });
    expect(status).not.toHaveProperty('ip');
  });

  it.each(['GB', 'IR', 'US', 'CA', 'UNKNOWN', null])('does not override a blocked response for %s', async country => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ blocked: true, country }))));
    const { getPolymarketGeoStatus } = await import('../src/lib/bot/geo');
    expect(await getPolymarketGeoStatus()).toMatchObject({ checked: true, apiBlocked: true });
  });

  it('fails closed on a failed fresh check and discards stale permission', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ blocked: false, country: 'SE' }))).mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    const { getPolymarketGeoStatus } = await import('../src/lib/bot/geo');
    expect(await getPolymarketGeoStatus()).toMatchObject({ checked: true, apiBlocked: false });
    expect(await getPolymarketGeoStatus(true)).toMatchObject({ checked: false, apiBlocked: true });
    expect(await getPolymarketGeoStatus()).toMatchObject({ checked: false, apiBlocked: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('fails closed on malformed responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ blocked: 'true', country: 'IE' }))));
    const { getPolymarketGeoStatus } = await import('../src/lib/bot/geo');
    expect(await getPolymarketGeoStatus()).toMatchObject({ checked: false, apiBlocked: true });
  });
});
