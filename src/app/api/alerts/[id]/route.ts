import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { evaluateAlert, sendTelegram, formatAlertMessage, AlertRow } from '@/lib/alerts';
import { markAlertSeen } from '@/lib/alerts';

export const dynamic = 'force-dynamic';

type Action = 'enable' | 'disable' | 'delete' | 'test' | 'run' | 'update';

const TELEGRAM_TOKEN_RE = /^\d+:[A-Za-z0-9_-]{20,}$/;

/** POST /api/alerts/[id]  body: { action, telegramToken?, telegramChat? } */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: idStr } = await params;
  const id = parseInt(idStr);
  const body = await request.json().catch(() => ({ action: undefined }));
  const { action } = body;
  if (!id || !action) return NextResponse.json({ error: 'id and action required' }, { status: 400 });

  const db = getDb();
  const alert = db.prepare(`SELECT * FROM alerts WHERE id = ?`).get(id) as AlertRow | undefined;
  if (!alert) return NextResponse.json({ error: 'alert not found' }, { status: 404 });

  switch (action as Action) {
    case 'enable':
      db.prepare(`UPDATE alerts SET enabled = 1 WHERE id = ?`).run(id);
      return NextResponse.json({ ok: true, enabled: true });

    case 'disable':
      db.prepare(`UPDATE alerts SET enabled = 0 WHERE id = ?`).run(id);
      return NextResponse.json({ ok: true, enabled: false });

    case 'delete':
      db.prepare(`DELETE FROM alerts WHERE id = ?`).run(id);
      db.prepare(`DELETE FROM alert_seen WHERE alert_id = ?`).run(id);
      return NextResponse.json({ ok: true, deleted: true });

    case 'test': {
      // Sends a sample message WITHOUT touching dedupe tables — pure connectivity check.
      const sample =
        `📈 <b>تست هشدار: ${alert.name}</b>\nاتصال بات تلگرام با سیستم سیگنال‌های UP/DOWN و مدل‌های هوش مصنوعی (Jev + Kev + Span + Solar) با موفقیت تأیید شد ✅\nوضعیت در پنل: <b>${alert.enabled ? 'روشن (ACTIVE)' : 'متوقف (PAUSED)'}</b>`;
      const ok = await sendTelegram(alert.telegram_token, alert.telegram_chat, sample);
      return NextResponse.json({ ok, sent: ok }, { status: ok ? 200 : 502 });
    }

    case 'run': {
      // Manual evaluation right now (respects dedupe — only NEW events fire).
      const matches = await evaluateAlert(alert);
      let sent = false;
      if (matches.length > 0) {
        const msg = await formatAlertMessage(alert, matches);
        sent = await sendTelegram(alert.telegram_token, alert.telegram_chat, msg);
        if (sent) {
          markAlertSeen(alert, matches);
          db.prepare(`UPDATE alerts SET last_fired_at = ? WHERE id = ?`).run(Math.floor(Date.now() / 1000), alert.id);
        }
      }
      return NextResponse.json({ ok: true, matched: matches.length, sent });
    }

    case 'update': {
      // Each alert rule owns its own Telegram bot token/chat (see /control — Alert Rules Telegram).
      // An empty token means "keep the current one", matching the masked-secret convention elsewhere.
      const rawToken = typeof body.telegramToken === 'string' ? body.telegramToken.trim() : '';
      const rawChat = typeof body.telegramChat === 'string' ? body.telegramChat.trim() : undefined;
      if (rawToken && !TELEGRAM_TOKEN_RE.test(rawToken)) {
        return NextResponse.json({ error: 'telegramToken looks invalid' }, { status: 400 });
      }
      if (rawChat !== undefined && !rawChat) {
        return NextResponse.json({ error: 'telegramChat cannot be empty' }, { status: 400 });
      }
      const sets: string[] = [];
      const vals: unknown[] = [];
      if (rawToken) {
        sets.push('telegram_token = ?');
        vals.push(rawToken);
      }
      if (rawChat) {
        sets.push('telegram_chat = ?');
        vals.push(rawChat);
      }
      if (sets.length) {
        vals.push(id);
        db.prepare(`UPDATE alerts SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      }
      return NextResponse.json({ ok: true });
    }

    default:
      return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  }
}
