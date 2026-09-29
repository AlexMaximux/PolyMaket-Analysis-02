import { forwardStatus } from '@/lib/bot/forward';
import { notificationStatus } from '@/lib/bot/notifications';
import { NextResponse } from 'next/server';
import { executeSignal, getBotStatus } from '@/lib/bot/executor';
import { parseTradeSignal } from '@/lib/bot/telegramBot';

export const dynamic = 'force-dynamic';
export async function GET() {
  try { return NextResponse.json({ ...await getBotStatus(), forward: forwardStatus(), notifications: notificationStatus() }); }
  catch { return NextResponse.json({ error: 'Bot status unavailable' }, { status: 500 }); }
}
/** BTC 1H only. Reuse Idempotency-Key when retrying a signal. Amount is read from settings. */
export async function POST(req: Request) {
  const key = req.headers.get('Idempotency-Key');
  if (!key || !/^[A-Za-z0-9:_-]{1,120}$/.test(key)) return NextResponse.json({ error: 'A stable Idempotency-Key is required' }, { status: 400 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'JSON object required' }, { status: 400 });
  const parsed = typeof body.signal === 'string' ? parseTradeSignal(body.signal) :
    typeof body.symbol === 'string' && typeof body.outcome === 'string' && (body.timeframe === undefined || typeof body.timeframe === 'string') ?
      { symbol: body.symbol.toUpperCase(), timeframe: (body.timeframe || '1H').toUpperCase(), outcome: body.outcome.toUpperCase() } : null;
  if (!parsed || !['BTC', 'BTCUPDOW', 'BTCUPDOWN'].includes(parsed.symbol) || parsed.timeframe !== '1H' || !['UP', 'DOWN'].includes(parsed.outcome)) {
    return NextResponse.json({ error: 'Only BTC/1H/UP or BTC/1H/DOWN is supported' }, { status: 400 });
  }
  try {
    const result = await executeSignal({ ...parsed, outcome: parsed.outcome as 'UP' | 'DOWN', source: 'api', requestId: `api:${key}` });
    return NextResponse.json(result, { status: result.success ? 200 : ['PENDING', 'UNKNOWN'].includes(result.status || '') ? 409 : 400 });
  } catch { return NextResponse.json({ error: 'Execution state unavailable. Keep the same Idempotency-Key and check status; do not send a new signal.' }, { status: 503 }); }
}
