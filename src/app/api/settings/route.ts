import { NextResponse } from 'next/server';
import { applySettingChanges, publicSettings } from '@/lib/settings';
import { supervisorRequest } from '@/lib/supervisor/client';
import { JEV_COINS } from '@/lib/coins';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ settings: publicSettings(), coins: JEV_COINS });
}

/** Save settings, then restart the affected workers that the supervisor is running. */
export async function PUT(request: Request) {
  const body = await request.json().catch(() => null);
  const changes = body?.changes;
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    return NextResponse.json({ ok: false, errors: { _: 'changes object required' } }, { status: 400 });
  }
  const result = applySettingChanges(changes);
  if (!result.ok) return NextResponse.json(result, { status: 400 });

  const status = result.restarts.length ? await supervisorRequest('/status') : null;
  const states = new Map<string, string>((status?.ok ? status.body?.workers ?? [] : []).map((w: any) => [w.name, w.state]));
  const restarted: string[] = [];
  const pending: string[] = [];
  for (const name of result.restarts) {
    const state = states.get(name);
    if (state === 'running' || state === 'restarting') {
      const r = await supervisorRequest(`/workers/${name}/restart`, 'POST');
      (r?.ok ? restarted : pending).push(name);
    } else {
      pending.push(name);
    }
  }
  return NextResponse.json({ ok: true, restarted, pending, supervisor: !!status?.ok });
}
