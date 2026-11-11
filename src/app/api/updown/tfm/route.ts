import { NextResponse } from 'next/server';
import { TFM_SYMBOLS } from '@/lib/tfm/klines';
import { tfmLive } from '@/lib/tfm/live';

export const dynamic = 'force-dynamic';

/**
 * GET /api/updown/tfm?coin=btc
 *
 * Live TimesFM forecast for the 1H / 15m / 5m Up/Down windows of one coin: forecast close with a 10-90% band and
 * P(Up) per window, the 60-minute decile path and the last 60 context prices. Always 200 for a known coin: with the
 * Python service stopped or not installed `service.ok` is false and the forecast fields are null.
 */
export async function GET(request: Request) {
  const coin = (new URL(request.url).searchParams.get('coin') || 'btc').toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(TFM_SYMBOLS, coin)) {
    return NextResponse.json({ error: 'unknown coin' }, { status: 400 });
  }
  try {
    return NextResponse.json(await tfmLive(coin), { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[api/updown/tfm]', e);
    return NextResponse.json({ error: 'tfm forecast failed' }, { status: 500 });
  }
}
