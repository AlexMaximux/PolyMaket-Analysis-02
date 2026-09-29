import { NextResponse } from 'next/server';
import { reconcileRequest } from '@/lib/bot/executor';
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (typeof body?.requestId !== 'string') return NextResponse.json({ error: 'requestId required' }, { status: 400 });
  try { return NextResponse.json(await reconcileRequest(body.requestId)); }
  catch { return NextResponse.json({ error: 'Unable to reconcile request. No new order was sent.' }, { status: 503 }); }
}
