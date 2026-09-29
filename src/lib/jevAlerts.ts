import fs from 'fs';
import path from 'path';
import { loadEnvConfig } from '@next/env';
import { sendTelegram } from './alerts';
import { getSetting } from './settings';
import { getDb } from './db';

try {
  loadEnvConfig(process.cwd());
} catch {}

/**
 * Check if the UP/DOWN / JEV alert rule is enabled in the database.
 * If paused by the user in /alerts, returns enabled: false.
 */
export function getJevAlertRule(): { enabled: boolean; alertRow?: any } {
  try {
    const db = getDb();
    const row = db
      .prepare("SELECT * FROM alerts WHERE alert_type IN ('jev', 'updown') ORDER BY CASE WHEN alert_type = 'jev' THEN 0 ELSE 1 END, id ASC LIMIT 1")
      .get() as any;
    if (!row) {
      return { enabled: true };
    }
    return { enabled: Boolean(row.enabled), alertRow: row };
  } catch (e) {
    return { enabled: true };
  }
}

const ALERTS_TRACKER_FILE = path.join(process.cwd(), 'jev', 'alerts_sent.json');

/** Load or initialize the list of alerted filenames to prevent duplicates */
function loadSentAlerts(): Set<string> {
  try {
    if (fs.existsSync(ALERTS_TRACKER_FILE)) {
      const data = JSON.parse(fs.readFileSync(ALERTS_TRACKER_FILE, 'utf8'));
      if (Array.isArray(data)) {
        return new Set(data);
      }
    }
  } catch (e) {
    console.error('Error loading sent Jev alerts tracker:', e);
  }
  return new Set();
}

/** Save alerted filenames to tracker file */
function saveSentAlert(filename: string) {
  try {
    const sent = loadSentAlerts();
    sent.add(filename);
    const jevDir = path.join(process.cwd(), 'jev');
    if (!fs.existsSync(jevDir)) {
      fs.mkdirSync(jevDir, { recursive: true });
    }
    fs.writeFileSync(ALERTS_TRACKER_FILE, JSON.stringify(Array.from(sent), null, 2), 'utf8');
  } catch (e) {
    console.error('Error saving sent Jev alerts tracker:', e);
  }
}

/**
 * Initialize tracker on first startup:
 * If alerts_sent.json does NOT exist, mark all existing historical files as already seen
 * so we do not spam 100+ past alerts to Telegram!
 */
export function initializeAlertTracker() {
  if (!fs.existsSync(ALERTS_TRACKER_FILE)) {
    try {
      const historyDir = path.join(process.cwd(), 'jev', 'history');
      if (fs.existsSync(historyDir)) {
        const files = fs.readdirSync(historyDir).filter((f) => f.endsWith('.json'));
        const jevDir = path.join(process.cwd(), 'jev');
        if (!fs.existsSync(jevDir)) fs.mkdirSync(jevDir, { recursive: true });
        fs.writeFileSync(ALERTS_TRACKER_FILE, JSON.stringify(files, null, 2), 'utf8');
        console.log(`[JEV ALERTS] Initialized tracker with ${files.length} existing historical files.`);
      }
    } catch (e) {
      console.error('Error initializing alert tracker:', e);
    }
  }
}

export interface JevSignalResult {
  isSignal: boolean;
  type?: 'BULLISH' | 'BEARISH';
  score?: number;
  confidence?: number;
  direction?: 'UP' | 'DOWN';
  rule?: string;
  hourKey?: string;
  minute?: number;
  hour?: number;
  date?: string;
}

/**
 * Evaluate if a record matches the Frozen Strategy v2 conditional rule:
 * 1. Coin: BTC only
 * 2. Minute filter: Strictly after minute 31 of the hour (minute >= 32, i.e. 32-59)
 * 3. Jev signal:
 *    - BULLISH (تیک آبی): Jev Score > 3.5 AND Score Confidence >= 90% (0.90) -> UP
 *    - BEARISH (تیک قرمز): Jev Score < 0.5 AND Score Confidence >= 90% (0.90) -> DOWN
 * 4. 3 of 3 consensus: Kev-4b AND Span-01 directions must strictly match Jev's direction
 * 5. Deduplication key: Hour market key (first signal per hour)
 */
export function evaluateJevRecordSignal(record: any): JevSignalResult {
  // 1. Coin check: strictly BTC
  const coin = (record?.coin || (record?.filename ? String(record.filename).split('_')[0] : '')).toUpperCase();
  if (coin !== 'BTC') {
    return { isSignal: false };
  }

  // 2. Parse time and minute
  const et = record?.et_time || '';
  const m = et.match(/^(\d{4}-\d{2}-\d{2})[ _T](\d{2})[:-](\d{2})/);
  let hour = m ? parseInt(m[2], 10) : null;
  let minute = m ? parseInt(m[3], 10) : null;
  let date = m ? m[1] : '';

  if (minute == null && record?.timestamp) {
    const d = new Date(record.timestamp);
    if (!isNaN(d.getTime())) {
      minute = d.getUTCMinutes();
      hour = d.getUTCHours();
      date = d.toISOString().slice(0, 10);
    }
  }

  // 3. Minute filter: only signals after minute 31 of the hour (minute >= 32)
  if (minute == null || minute <= 31) {
    return { isSignal: false };
  }

  // 4. Jev model evaluation
  const p = record?.prediction || record?.predictions?.jev;
  if (!p || p.score == null) {
    return { isSignal: false };
  }

  const score = Number(p.score);

  // Extract score_confidence strictly (0 to 1 converted to 0-100)
  let rawConf = p.score_confidence;
  if (rawConf == null && p.raw_decision?.answers?.one_hour_score?.confidence != null) {
    rawConf = p.raw_decision.answers.one_hour_score.confidence;
  }

  if (rawConf == null) {
    return { isSignal: false };
  }

  const confPercent = Number(rawConf) <= 1 ? Number(rawConf) * 100 : Number(rawConf);

  let dir: 'UP' | 'DOWN' | null = null;
  let type: 'BULLISH' | 'BEARISH' | null = null;

  if (score > 3.5 && confPercent >= 90) {
    dir = 'UP';
    type = 'BULLISH';
  } else if (score < 0.5 && confPercent >= 90) {
    dir = 'DOWN';
    type = 'BEARISH';
  } else {
    return { isSignal: false };
  }

  // 5. 3 of 3 consensus: Kev-4b and Span-01 must BOTH agree with Jev's direction
  const pKev = record?.predictions?.kev;
  const pSpan = record?.predictions?.span;

  if (!pKev || !pSpan) {
    return { isSignal: false };
  }

  const kevDir = (pKev.direction || '').toUpperCase();
  const spanDir = (pSpan.direction || '').toUpperCase();

  if (kevDir !== dir || spanDir !== dir) {
    return { isSignal: false };
  }

  const marketSlug = record?.cards?.['1h']?.slug || '';
  const hourKey = marketSlug ? `btc_hour_${marketSlug}` : `btc_hour_${date}_${hour}`;

  return {
    isSignal: true,
    type,
    score,
    confidence: Math.round(confPercent),
    direction: dir,
    rule: 'BTC · Jev + Kev + Span all agree · first signal after minute 31 of the hour',
    hourKey,
    minute,
    hour: hour ?? undefined,
    date,
  };
}

/**
 * Helper to format coin spot price nicely with appropriate decimals
 */
export function formatCoinPrice(price: number | null | undefined): string {
  if (price == null || isNaN(price) || price <= 0) return '—';
  if (price >= 1000) {
    return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } else if (price >= 1) {
    return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  } else {
    return price.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 6 });
  }
}

/**
 * Fallback fetcher for spot price if missing in record
 */
export async function fetchSpotPriceFallback(coin: string): Promise<number | null> {
  const c = coin.toUpperCase();
  try {
    if (c === 'HYPE') {
      const res = await fetch('https://www.okx.com/api/v5/market/ticker?instId=HYPE-USDT', {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      if (res.ok) {
        const d = await res.json();
        const p = parseFloat(d.data?.[0]?.last);
        if (!isNaN(p) && p > 0) return p;
      }
    } else {
      const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${c}USDT`);
      if (res.ok) {
        const d = await res.json();
        const p = parseFloat(d.price);
        if (!isNaN(p) && p > 0) return p;
      }
    }
  } catch {}
  return null;
}

/**
 * Fallback fetcher for 1-hour open price (Price to Beat) if missing in record
 */
export async function fetchOpenPriceFallback(coin: string): Promise<number | null> {
  const c = coin.toUpperCase();
  try {
    if (c === 'HYPE') {
      const res = await fetch('https://fapi.binance.com/fapi/v1/klines?symbol=HYPEUSDT&interval=1h&limit=1');
      if (res.ok) {
        const d = await res.json();
        const p = parseFloat(d?.[0]?.[1]);
        if (!isNaN(p) && p > 0) return p;
      }
      const okxRes = await fetch('https://www.okx.com/api/v5/market/candles?instId=HYPE-USDT&bar=1H&limit=1', {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      if (okxRes.ok) {
        const d = await okxRes.json();
        const p = parseFloat(d.data?.[0]?.[1]);
        if (!isNaN(p) && p > 0) return p;
      }
    } else {
      const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${c}USDT&interval=1h&limit=1`);
      if (res.ok) {
        const d = await res.json();
        const p = parseFloat(d?.[0]?.[1]);
        if (!isNaN(p) && p > 0) return p;
      }
    }
  } catch {}
  return null;
}

/**
 * Format Telegram HTML message for Jev Signal
 */
export function formatTelegramSignalMessage(
  record: any,
  filename: string,
  signal: { type: 'BULLISH' | 'BEARISH'; score: number; confidence: number; direction?: string; minute?: number; hour?: number },
  spotPriceOverride?: number | null,
  openPriceOverride?: number | null
): string {
  const isBullish = signal.type === 'BULLISH';
  const headerIcon = isBullish ? '🔵' : '🔴';
  const actionWord = isBullish ? 'خرید UP (صعودی)' : 'خرید DOWN (نزولی)';
  const signalTitle = isBullish
    ? 'تیک آبی (سیگنال صعودی / BUY UP)'
    : 'تیک قرمز (سیگنال نزولی / BUY DOWN)';

  const coin = 'BTC';
  const coinLabel = 'Bitcoin';
  const p = record.prediction || record.predictions?.jev || {};
  const cards = record.cards || {};
  const fv = record.fair_values || {};

  // Extract spot price
  const spotPrice =
    spotPriceOverride != null
      ? spotPriceOverride
      : record.spot_price != null
      ? Number(record.spot_price)
      : record.spotPrice != null
      ? Number(record.spotPrice)
      : record.model?.st != null
      ? Number(record.model.st)
      : null;

  // Extract open price / Price To Beat
  const openPrice =
    openPriceOverride != null
      ? openPriceOverride
      : record.price_to_beat != null
      ? Number(record.price_to_beat)
      : record.open_price != null
      ? Number(record.open_price)
      : record.openPrice != null
      ? Number(record.openPrice)
      : record.model?.s0 != null
      ? Number(record.model.s0)
      : null;

  // Build price comparison block
  let priceBlock = `💵 <b>قیمت لحظه‌ای بیت‌کوین:</b> <code>$${formatCoinPrice(spotPrice)}</code>\n`;
  if (openPrice != null && openPrice > 0) {
    priceBlock += `🎯 <b>قیمت مبنا (Price To Beat / Open):</b> <code>$${formatCoinPrice(openPrice)}</code>\n`;
    if (spotPrice != null && spotPrice > 0) {
      const diff = spotPrice - openPrice;
      const pctVal = ((diff / openPrice) * 100).toFixed(2);
      const sign = diff >= 0 ? '+' : '';
      const statusIcon = diff >= 0 ? '🟢' : '🔴';
      const statusText = diff >= 0 ? 'بالاتر از مبنا (Up)' : 'پایین‌تر از مبنا (Down)';
      priceBlock += `📊 <b>فاصله تا مبنا:</b> <code>${sign}$${formatCoinPrice(Math.abs(diff))} (${sign}${pctVal}%)</code> ${statusIcon} <i>${statusText}</i>\n`;
    }
  }

  const scoreText = Number(signal.score).toFixed(2);
  const direction = signal.direction || p.direction || (isBullish ? 'UP' : 'DOWN');
  const interpretation = p.score_interpretation || (isBullish ? 'Strong Up' : 'Strong Down');

  const probUp =
    p.direction_probabilities?.UP != null
      ? (p.direction_probabilities.UP * 100).toFixed(0) + '%'
      : '—';
  const probDown =
    p.direction_probabilities?.DOWN != null
      ? (p.direction_probabilities.DOWN * 100).toFixed(0) + '%'
      : '—';

  const up1h = cards['1h']?.up_display || (cards['1h']?.up != null ? (cards['1h'].up * 100).toFixed(1) + '%' : '—');
  const down1h = cards['1h']?.down_display || (cards['1h']?.down != null ? (cards['1h'].down * 100).toFixed(1) + '%' : '—');
  const up15m = cards['15m']?.up_display || '—';
  const fair15m = fv.model_15m != null ? (fv.model_15m * 100).toFixed(1) + '%' : '—';

  const preds = record.predictions || {};
  let multiModelBlock = `🤖 <b>اجماع کامل مدل‌های هوش مصنوعی (3/3 Consensus):</b>\n`;
  multiModelBlock += `• <b>Jev (1.13):</b> امتیاز <code>${scoreText} / 4.0</code> (اطمینان <b>${signal.confidence}%</b>) ➔ جهت <b>${direction}</b>\n`;
  if (preds.kev) {
    const kScore = preds.kev.score != null ? `اسکور: ${preds.kev.score.toFixed(2)}` : '';
    multiModelBlock += `• <b>Kev-4b:</b> جهت <b>${preds.kev.direction || '—'}</b> (${kScore})\n`;
  }
  if (preds.span) {
    const sScore = preds.span.score != null ? `اسکور: ${Number(preds.span.score).toFixed(2)}` : '';
    const sProb = preds.span.prob_up != null ? `${preds.span.prob_up}% UP` : '';
    const sDetails = [sScore, sProb].filter(Boolean).join(' | ');
    multiModelBlock += `• <b>Span-01:</b> جهت <b>${preds.span.direction || '—'}</b> (${sDetails})\n`;
  }
  if (preds.solar) {
    const soScore = preds.solar.score != null ? `اسکور: ${Number(preds.solar.score).toFixed(2)}` : '';
    const soConf = preds.solar.score_confidence != null ? `اطمینان: ${Math.round(preds.solar.score_confidence * 100)}%` : '';
    multiModelBlock += `• <b>Solar-Decide (فیلتر اضافه):</b> جهت <b>${preds.solar.direction || '—'}</b> (${[soScore, soConf].filter(Boolean).join(' | ')})\n`;
  }
  multiModelBlock += `• <b>نتیجه اجماع:</b> <code>${preds.consensus?.summary || '3/3 Agreement (تمام مدل‌ها موافق)'}</code> ✅\n\n`;

  const minuteStr = signal.minute != null ? `دقیقه ${signal.minute}` : 'بعد از دقیقه ۳۱';
  const hourStr = signal.hour != null ? `ساعت ${signal.hour}:00` : '';

  return (
    `${headerIcon} <b>هشدار سیگنال معاملاتی — ${signalTitle}</b>\n\n` +
    `🎯 <b>استراتژی:</b> <code>BTC · اجماع ۳ مدل (Jev+Kev+Span) · اولین سیگنال بعد از ۳۱</code>\n` +
    `⚡ <b>اقدام پیشنهادی:</b> <b>${actionWord}</b>\n` +
    `⏱️ <b>زمان سیگنال:</b> <b>${minuteStr}</b> ${hourStr ? `از ${hourStr}` : ''} (ET)\n\n` +
    `🪙 <b>ارز:</b> <b>${coinLabel} (${coin})</b>\n` +
    `${priceBlock}\n` +
    `${multiModelBlock}` +
    `📈 <b>داده‌های بازار یک‌ساعته Polymarket:</b>\n` +
    `• قیمت ۱ ساعته: UP: <b>${up1h}</b> | DOWN: <b>${down1h}</b>\n` +
    `• بازار ۱۵ دقیقه‌ای: UP: <b>${up15m}</b>\n` +
    `• ارزش منصفانه (Fair Value 15m): <b>${fair15m}</b>\n\n` +
    `⏰ <b>زمان اسنپ‌شات (ET):</b> <code>${record.et_time || record.current_time_et || 'Now'}</code>\n` +
    `📁 <b>فایل:</b> <code>${filename}</code>\n` +
    `🔍 <b>مشاهده در داشبورد:</b> <a href="http://localhost:8000/cloud-analysis">پنل تحلیل و بک‌تست ابر (Cloud Analysis)</a>`
  );
}

/**
 * Check if the record qualifies for an alert, and send Telegram notification if not already sent.
 */
export async function checkAndSendJevSignalAlert(
  record: any,
  filename: string
): Promise<{ sent: boolean; reason?: string }> {
  try {
    const signal = evaluateJevRecordSignal(record);
    if (!signal.isSignal || !signal.type || signal.score == null || signal.confidence == null) {
      return { sent: false, reason: 'Does not match strategy criteria' };
    }

    const { enabled, alertRow } = getJevAlertRule();
    if (!enabled) {
      console.log(`[JEV TELEGRAM ALERT] ⏸️ Skipped sending (${filename}) — Alert is PAUSED in /alerts dashboard.`);
      return { sent: false, reason: 'Alert is paused in dashboard' };
    }

    const sentSet = loadSentAlerts();
    if (sentSet.has(filename)) {
      return { sent: false, reason: 'Already alerted for this file' };
    }

    // Deduplication per hour: only the FIRST signal after minute 31 is alerted
    if (signal.hourKey && sentSet.has(signal.hourKey)) {
      console.log(`[JEV TELEGRAM ALERT] ℹ️ Skipped (${filename}) — Hour ${signal.hourKey} already alerted.`);
      return { sent: false, reason: 'Already alerted for this hour' };
    }

    if (signal.hourKey && alertRow?.id) {
      try {
        const db = getDb();
        const seenHour = db.prepare('SELECT 1 FROM alert_seen WHERE alert_id = ? AND wallet = ?').get(alertRow.id, signal.hourKey);
        if (seenHour) {
          saveSentAlert(signal.hourKey);
          return { sent: false, reason: 'Already alerted for this hour in database' };
        }
      } catch {}
    }

    // Resolve spot price
    let spotPrice = record.spot_price != null ? Number(record.spot_price) : null;
    if (spotPrice == null || isNaN(spotPrice) || spotPrice <= 0) {
      spotPrice = await fetchSpotPriceFallback('BTC');
    }

    // Resolve open price / price to beat
    let openPrice =
      record.price_to_beat != null
        ? Number(record.price_to_beat)
        : record.open_price != null
        ? Number(record.open_price)
        : null;
    if (openPrice == null || isNaN(openPrice) || openPrice <= 0) {
      openPrice = await fetchOpenPriceFallback('BTC');
    }

    const message = formatTelegramSignalMessage(
      record,
      filename,
      {
        type: signal.type,
        score: signal.score,
        confidence: signal.confidence,
        direction: signal.direction,
        minute: signal.minute,
        hour: signal.hour,
      },
      spotPrice,
      openPrice
    );

    const botToken = alertRow?.telegram_token || getSetting('jev.telegramToken');
    const chatId = alertRow?.telegram_chat || getSetting('jev.telegramChat');

    console.log(`[JEV TELEGRAM ALERT] Firing ${signal.type} alert for BTC (${filename}, minute ${signal.minute})...`);
    const ok = await sendTelegram(botToken, chatId, message);

    if (ok) {
      saveSentAlert(filename);
      if (signal.hourKey) {
        saveSentAlert(signal.hourKey);
      }
      console.log(`[JEV TELEGRAM ALERT] ✅ Alert successfully delivered to Telegram chat ${chatId}!`);
      if (alertRow?.id) {
        try {
          const db = getDb();
          const now = Math.floor(Date.now() / 1000);
          db.prepare(`UPDATE alerts SET last_fired_at = ?, last_evaluated_at = ? WHERE id = ?`).run(now, now, alertRow.id);
          const alertSeenKey = `BTC_${filename}`;
          db.prepare(`INSERT OR IGNORE INTO alert_seen (alert_id, wallet, fired_at) VALUES (?, ?, ?)`).run(alertRow.id, alertSeenKey, now);
          if (signal.hourKey) {
            db.prepare(`INSERT OR IGNORE INTO alert_seen (alert_id, wallet, fired_at) VALUES (?, ?, ?)`).run(alertRow.id, signal.hourKey, now);
          }
        } catch (dbErr) {
          console.error('[JEV TELEGRAM ALERT] Error updating alerts stats in DB:', dbErr);
        }
      }
      return { sent: true };
    } else {
      console.error(`[JEV TELEGRAM ALERT] ❌ Telegram API call failed for file ${filename}`);
      return { sent: false, reason: 'Telegram API returned error' };
    }
  } catch (err: any) {
    console.error('[JEV TELEGRAM ALERT] Exception during alert evaluation:', err.message || err);
    return { sent: false, reason: err.message };
  }
}
