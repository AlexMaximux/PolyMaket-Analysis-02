import { NextResponse } from 'next/server';
import { supervisorRequest } from '@/lib/supervisor/client';
import { readHeartbeats } from '@/lib/heartbeat';
import { getSetting, WORKER_NAMES } from '@/lib/settings';

export const dynamic = 'force-dynamic';

function intervalSec(name: string): number | null {
  if (name === 'alerts') return getSetting('alerts.intervalSec');
  if (name === 'jev') return getSetting('jev.snapshotIntervalSec');
  if (name === 'bot') return 35; // Telegram long-poll timeout (30s) + a little slack
  return null;
}

export async function GET() {
  const sup = await supervisorRequest('/status');
  const heartbeats = readHeartbeats();
  const running: any[] = sup?.ok ? sup.body?.workers ?? [] : [];
  const workers = ['web', ...WORKER_NAMES].map(name => ({
    name,
    state: 'unknown',
    controllable: name !== 'web',
    ...(running.find(w => w.name === name) ?? {}),
    heartbeat: heartbeats[name] ?? null,
    intervalSec: intervalSec(name),
  }));
  return NextResponse.json({ supervisor: sup?.ok ? sup.body.supervisor : null, workers, now: Date.now() });
}
