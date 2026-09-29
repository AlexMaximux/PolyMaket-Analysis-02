import { NextResponse } from 'next/server';
import { supervisorRequest } from '@/lib/supervisor/client';
import { WORKER_NAMES } from '@/lib/settings';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  if (!['web', ...WORKER_NAMES].includes(name)) return NextResponse.json({ error: 'unknown worker' }, { status: 400 });
  const tail = Math.min(Math.max(parseInt(new URL(request.url).searchParams.get('tail') || '200') || 200, 1), 500);
  const r = await supervisorRequest(`/workers/${name}/logs?tail=${tail}`);
  if (!r) return NextResponse.json({ error: 'supervisor is not running' }, { status: 503 });
  return NextResponse.json(r.body, { status: r.status });
}
