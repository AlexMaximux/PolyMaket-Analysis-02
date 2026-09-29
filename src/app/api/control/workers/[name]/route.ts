import { NextResponse } from 'next/server';
import { supervisorRequest } from '@/lib/supervisor/client';
import { WORKER_NAMES } from '@/lib/settings';

export const dynamic = 'force-dynamic';

const ACTIONS = ['start', 'stop', 'restart'];

export async function POST(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const body = await request.json().catch(() => null);
  const action = body?.action;
  if (!(WORKER_NAMES as string[]).includes(name) || !ACTIONS.includes(action)) {
    return NextResponse.json({ error: 'unknown worker or action' }, { status: 400 });
  }
  const r = await supervisorRequest(`/workers/${name}/${action}`, 'POST');
  if (!r) return NextResponse.json({ error: 'supervisor is not running — start it with npm run supervisor' }, { status: 503 });
  return NextResponse.json(r.body, { status: r.status });
}
