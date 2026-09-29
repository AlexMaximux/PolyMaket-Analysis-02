import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { maskSecret } from '@/lib/secrets';

export const dynamic = 'force-dynamic';

export async function GET() {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT a.*,
              (SELECT COUNT(*) FROM alert_seen s WHERE s.alert_id = a.id) as fired_count
       FROM alerts a ORDER BY a.id`
    )
    .all() as Array<Record<string, unknown> & { telegram_token: string }>;
  // Bot tokens stay server-side: anyone holding one controls the bot.
  const alerts = rows.map(({ telegram_token, ...rest }) => ({ ...rest, telegram_token_masked: maskSecret(telegram_token) }));
  return NextResponse.json({ alerts });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });

  const name = String(body.name || '').trim();
  const alertType = body.alertType === 'jev' ? 'jev' : 'updown';
  const token = String(body.telegramToken || '').trim();
  const chat = String(body.telegramChat || '').trim();

  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 });
  if (!token || !/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) return NextResponse.json({ error: 'telegramToken looks invalid' }, { status: 400 });
  if (!chat) return NextResponse.json({ error: 'telegramChat required' }, { status: 400 });

  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const res = db
    .prepare(
      `INSERT INTO alerts (name, alert_type, hours, min_bet, telegram_token, telegram_chat, enabled, created_at)
       VALUES (?, ?, 24, 0, ?, ?, 1, ?)`
    )
    .run(name, alertType, token, chat, now);

  return NextResponse.json({ id: Number(res.lastInsertRowid) }, { status: 201 });
}
