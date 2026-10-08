import { getSetting } from './settings';
import { sendTelegram } from './alerts';
import { buildTrades, filterBaseRows, type SnapshotRow } from './signalAnalysis';
import { alertStrategy, formatTelegramSignalMessage, getJevAlertRule } from './jevAlerts';
import { readRecentRows, readRecord } from './recentRows';

export interface JevTestAlertDeps {
  send: (token: string, chat: string, text: string) => Promise<boolean>;
  rows: () => SnapshotRow[];
  record: (filename: string) => Record<string, unknown> | null;
}

/**
 * Send the Jev Telegram chat a sample of the alert, built from the latest real signal of the strategy the alert follows
 * (jev.alertStrategy), so you see exactly what an alert looks like. Nothing is recorded: the sent-alerts list and the
 * alert's counters are untouched, so it never suppresses or duplicates a real alert. Without a recent signal the newest
 * snapshot is used and the message says so.
 */
export async function sendJevTestAlert(deps: Partial<JevTestAlertDeps> = {}): Promise<{ ok: boolean; message: string }> {
  const { send = sendTelegram, rows = readRecentRows, record = readRecord } = deps;
  // The same target a real alert uses: the alert rule's own bot and chat when it has them, else the settings.
  const { alertRow } = getJevAlertRule();
  const token = alertRow?.telegram_token || getSetting('jev.telegramToken');
  const chat = alertRow?.telegram_chat || getSetting('jev.telegramChat');
  if (!token || !chat) return { ok: false, message: 'Save the Jev Telegram bot token and chat ID first' };

  const strategy = alertStrategy();
  const recent = rows();
  const trade = buildTrades(filterBaseRows(recent, strategy.rule), strategy.rule).at(-1);
  const row = trade?.row ?? [...recent].reverse().find(r => r.direction === 'UP' || r.direction === 'DOWN');
  if (!row) return { ok: false, message: 'No snapshots found to build a test alert from' };
  const full = record(row.filename);
  if (!full) return { ok: false, message: `Could not read the snapshot ${row.filename}` };

  const direction = trade?.dir ?? (row.direction as 'UP' | 'DOWN');
  const signal = {
    type: direction === 'UP' ? ('BULLISH' as const) : ('BEARISH' as const),
    score: trade?.modelScore ?? row.score ?? 0,
    confidence: trade?.modelConf ?? row.score_confidence ?? 0,
    direction,
    minute: trade?.minute ?? undefined,
    hour: trade?.hour ?? undefined,
  };
  const header = trade
    ? `🧪 <b>پیام آزمایشی؛ فقط نمونهٔ قالب هشدار است</b>\nنمونه از آخرین سیگنال قانون ${strategy.id}: ${row.et_time}\n\n`
    : `🧪 <b>پیام آزمایشی؛ فقط نمونهٔ قالب هشدار است</b>\nدر ۳۳ ساعت اخیر سیگنالی از قانون ${strategy.id} نبود؛ نمونه از آخرین اسنپ‌شات (${row.et_time}) ساخته شد.\n\n`;
  const ok = await send(token, chat, header + formatTelegramSignalMessage(full, row.filename, signal, strategy, null, null));
  return ok
    ? { ok: true, message: `Test alert sent (${strategy.id}, ${direction}${trade ? ', latest real signal' : ', no recent signal: newest snapshot'}). Nothing was recorded.` }
    : { ok: false, message: 'Telegram rejected the message; check token and chat ID' };
}
