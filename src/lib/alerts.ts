import { getDb } from './db';
import { fetchUpdownSnapshot, warnStaleServer } from './updownSnapshot';
import { updownSignal } from './updownSignal';

/**
 * Alert engine for the Up/Down app. Two rule types:
 *
 *  1. updown — BOTH fair values beat the executable price plus fee (see updownSignal), evaluated here every cycle.
 *  2. jev    — evaluated by the Jev worker as soon as a multi-model record is saved (see jevAlerts.ts);
 *              this file only stores/tests/pauses the rule and sends the Telegram message.
 */

export interface AlertRow {
  id: number;
  name: string;
  alert_type: 'updown' | 'jev';
  hours: number;
  min_bet: number;
  telegram_token: string;
  telegram_chat: string;
  enabled: number;
  last_fired_at: number | null;
  last_evaluated_at: number | null;
  created_at: number;
}

export function sendTelegram(token: string, chat: string, text: string): Promise<boolean> {
  return fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  })
    .then(r => r.ok)
    .catch(() => false);
}



/**
 * updown rule: BOTH Fair-Value-1H and Base(no-drift) beat the executable price (Up ask for BUY,
 * Down ask = 1 − Up bid for SELL) plus the taker fee by ≥1¢, on a book ≤4¢ wide (see updownSignal).
 * HYPE is excluded: its 1H books are ~33¢ wide and its midpoint is not a tradeable price.
 */
async function evaluateUpdownAlert(alert: AlertRow): Promise<any[]> {
  const coins: [string, string][] = [
    ['btc', 'Bitcoin'], ['eth', 'Ethereum'], ['sol', 'Solana'], ['xrp', 'XRP'],
    ['doge', 'Dogecoin'], ['bnb', 'BNB'],
  ];
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const COOLDOWN = 30 * 60;
  const out: any[] = [];
  for (const [coin, label] of coins) {
    try {
      const snap = await fetchUpdownSnapshot(coin);
      if (!snap) continue;
      const m1h = snap.m1h, model = snap.model, modelA = snap.modelA;
      if (!m1h || m1h.closed || !m1h.accepting) continue;
      if (!('book' in m1h)) { warnStaleServer(); continue; }
      const base = Number(modelA?.fairUp);
      // the 15m drift model is off when its price is saturated near 0/1; Base alone decides then
      const fv1h = model?.fairUp != null ? Number(model.fairUp) : base;
      const book = m1h.book;
      const sig = updownSignal({
        fv1h, base, bid: book?.bid ?? null, ask: book?.ask ?? null, mid: m1h.live ?? null,
        bidSize: book?.bidSize, askSize: book?.askSize,
      });
      if (!sig) continue;
      // cooldown per coin + hourly market + side, so a late signal doesn't mute the next hour's market
      const key = `${coin}:${m1h.slug}:${sig.side}`;
      const seen = db.prepare(`SELECT 1 FROM alert_seen WHERE alert_id = ? AND wallet = ? AND fired_at > ?`).get(alert.id, `ud:${key}`, now - COOLDOWN);
      if (seen) continue;
      out.push({
        coin, label, side: sig.side,
        fv1h: fv1h * 100, base: base * 100,
        bid: book.bid * 100, ask: book.ask * 100,
        sizeAtBest: sig.side === 'BUY' ? book.askSize : book.bidSize,
        entry: sig.entry * 100, fee: sig.fee * 100, fair: sig.fair * 100, netEdge: sig.netEdge * 100,
        slug: m1h.slug,
        seenKey: `ud:${key}`,
      });
    } catch { /* per-coin failure must not kill the loop */ }
  }
  return out;
}

function formatUpdownMessage(alert: AlertRow, signals: any[]): string {
  const lines = signals.map((s: any) => {
    const arrow = s.side === 'SELL' ? '🔴' : '🟢';
    const bought = s.side === 'SELL' ? 'DOWN' : 'UP';
    return (
      `${arrow} <b>UP/DOWN ${s.side} — ${s.label} 1H</b>\n` +
      `• Book UP: bid ${s.bid.toFixed(1)}¢ / ask ${s.ask.toFixed(1)}¢\n` +
      `• Fair Value 1H: ${s.fv1h.toFixed(1)}¢ · Base (No drift): ${s.base.toFixed(1)}¢ (UP)\n` +
      `• Signal: <b>buy ${bought} at ${s.entry.toFixed(1)}¢</b> + fee ${s.fee.toFixed(2)}¢ vs fair ${s.fair.toFixed(1)}¢ → net edge <b>${s.netEdge.toFixed(1)}¢</b>/share, held to expiry\n` +
      `• Size at that price: ${Math.floor(s.sizeAtBest)} shares ($${Math.floor(s.sizeAtBest * s.entry / 100)})\n` +
      `• https://polymarket.com/event/${s.slug}`
    );
  });
  return (
    `<b>📈 ${alert.name}</b>\n` +
    `${signals.length} signal${signals.length > 1 ? 's' : ''}:\n\n` +
    lines.join('\n\n')
  );
}

/** Mark updown signals seen (cooldown key in wallet column). */
function markUpdownSeen(alert: AlertRow, signals: any[]): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const ins = db.prepare(`INSERT OR REPLACE INTO alert_seen (alert_id, wallet, fired_at) VALUES (?, ?, ?)`);
  for (const s of signals) ins.run(alert.id, s.seenKey, now);
}


/** Telegram hard-caps messages at 4096 chars — chunk to be safe. */
function chunkMessage(msg: string, maxLen = 3500): string[] {
  if (msg.length <= maxLen) return [msg];
  const chunks: string[] = [];
  let cur = '';
  for (const block of msg.split('\n\n')) {
    if ((cur + '\n\n' + block).length > maxLen && cur) {
      chunks.push(cur);
      cur = block;
    } else {
      cur = cur ? cur + '\n\n' + block : block;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** Telegram text for an alert's matches (used by the loop and the manual run endpoint). */
export async function formatAlertMessage(alert: AlertRow, matches: any[]): Promise<string> {
  return formatUpdownMessage(alert, matches);
}

/** Mark an alert's matches as seen after a successful send (used by manual run endpoint too). */
export function markAlertSeen(alert: AlertRow, matches: any[]): void {
  markUpdownSeen(alert, matches);
}

/** Evaluate one alert (dispatch by type) and return matches (not yet sent/marked). */
export async function evaluateAlert(alert: AlertRow): Promise<any[]> {
  if (alert.alert_type === 'jev') return []; // Evaluated immediately by Jev worker on snapshot generation
  return evaluateUpdownAlert(alert);
}

/** Evaluate every enabled alert and send Telegram messages for new matches. Returns summary. */
export async function evaluateAllAlerts(): Promise<{ evaluated: number; sent: number; failed: number }> {
  const db = getDb();
  const alerts = db.prepare(`SELECT * FROM alerts WHERE enabled = 1`).all() as AlertRow[];
  let sent = 0;
  let failed = 0;

  for (const alert of alerts) {
    try {
      const matches = await evaluateAlert(alert);
      if (matches.length > 0) {
        const msg = await formatAlertMessage(alert, matches);
        const chunks = chunkMessage(msg);
        let allOk = true;
        for (const part of chunks) {
          const ok = await sendTelegram(alert.telegram_token, alert.telegram_chat, part);
          if (!ok) { allOk = false; break; }
        }
        if (allOk) {
          // mark AFTER successful send so failed sends are retried next cycle
          markAlertSeen(alert, matches);
          sent++;
          db.prepare(`UPDATE alerts SET last_fired_at = ? WHERE id = ?`).run(Math.floor(Date.now() / 1000), alert.id);
        } else {
          failed++;
        }
      }
    } catch (e) {
      console.error(`alert ${alert.id} eval error:`, e);
      failed++;
    }
    try {
      db.prepare(`UPDATE alerts SET last_evaluated_at = ? WHERE id = ?`).run(Math.floor(Date.now() / 1000), alert.id);
    } catch (e) {
      // a busy database must not abort the remaining alerts of this cycle
      console.error(`alert ${alert.id} last_evaluated_at update failed:`, e);
    }
  }

  return { evaluated: alerts.length, sent, failed };
}
