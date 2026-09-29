import {
  executeSignal,
  getBotStatus,
  reconcileRequest,
  buildHourlyEtSlug,
} from './executor';
import {
  getRecentTrades,
  getBotSetting,
  setBotSetting,
} from './db';
import { getSetting, applySettingChanges } from '../settings';
import type { TradeResult } from './types';

const TELEGRAM_API = 'https://api.telegram.org';

export async function sendTelegramMessage(token: string, chatId: string | number, text: string): Promise<boolean> {
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    return res.ok;
  } catch {
    console.error('Failed to send Telegram message');
    return false;
  }
}

/** Parses commands like "buy: BTCUPDOW/1H/UP" or "buy: BTCUPDOW/1H/DOWN" */
export function parseTradeSignal(text: string): { symbol: string; timeframe: string; outcome: 'UP' | 'DOWN' } | null {
  const clean = text.trim();
  // Regex to match "buy: BTCUPDOW/1H/UP", "BUY BTC/1H/DOWN", "خرید: BTCUPDOW/1H/UP", etc.
  const regex = /^(?:\/buy|buy|خرید)[\s:]*([A-Za-z0-9_-]+)\/([0-9]+[A-Za-z]+)\/(UP|DOWN|بالا|پایین)$/i;
  const match = clean.match(regex);
  if (!match) return null;

  const rawSymbol = match[1].toUpperCase();
  const timeframe = match[2].toUpperCase();
  let rawOutcome = match[3].toUpperCase();

  if (rawOutcome === 'بالا') rawOutcome = 'UP';
  if (rawOutcome === 'پایین') rawOutcome = 'DOWN';

  return {
    symbol: rawSymbol,
    timeframe,
    outcome: rawOutcome as 'UP' | 'DOWN',
  };
}

export function formatTradeNotification(res: TradeResult): string {
  const modeTag = res.simulated ? '🟡 [آزمایشی / SIMULATION]' : '🟢 [ترید واقعی / LIVE]';
  const outcomeEmoji = res.outcome === 'UP' ? '📈 صعودی (UP)' : '📉 نزولی (DOWN)';

  if (res.status === 'UNKNOWN' || res.status === 'PENDING') {
    return `<b>⏳ وضعیت سفارش ${res.status === 'UNKNOWN' ? 'نامشخص' : 'در حال پردازش'}</b>\n` +
      `خرید جدید تا تعیین وضعیت متوقف است؛ دستور خرید دیگری نفرستید.\n` +
      `بررسی مجدد: <code>/check ${res.requestId}</code>\nشناسه سفارش: <code>${res.orderId || '-'}</code>`;
  }
  if (!res.success) {
    return (
      `<b>❌ شکست در معامله ${res.symbol}/${res.timeframe}</b>\n` +
      `${modeTag}\n\n` +
      `• جهت: ${outcomeEmoji}\n` +
      `• مبلغ درخواستی: $${res.amountUsd.toFixed(2)}\n` +
      `• دلیل خطا:\n<code>${res.error || 'خطای نامشخص'}</code>\n\n` +
      `💰 باقی‌مانده بودجه مجاز: $${res.remainingBudget.toFixed(2)} از $${res.maxBudget.toFixed(2)}`
    );
  }

  const pricePercent = res.price ? (res.price * 100).toFixed(1) : '-';
  const eventUrl = res.slug ? `https://polymarket.com/event/${res.slug}` : 'https://polymarket.com';

  return (
    `<b>✅ خرید موفق در Polymarket</b>\n` +
    `${modeTag}\n\n` +
    `• نماد: <b>${res.symbol}/${res.timeframe}</b>\n` +
    `• جهت معامله: <b>${outcomeEmoji}</b>\n` +
    `• قیمت خرید: <b>$${res.price?.toFixed(3)}</b> (${pricePercent}¢)\n` +
    `• تعداد سهام (Shares): <b>${res.shares?.toLocaleString()}</b>\n` +
    `• مبلغ معامله: <b>$${res.amountUsd.toFixed(2)}</b>\n` +
    `• شناسه سفارش: <code>${res.orderId || '-'}</code>\n` +
    `• تعداد تلاش: ${res.attempts || 0}\n\n` +
    `💰 <b>مدیریت سرمایه:</b>\n` +
    `• کل مصرف‌شده: <b>$${res.totalSpentAfter.toFixed(2)}</b> / $${res.maxBudget.toFixed(2)}\n` +
    `• باقی‌مانده سقف مجاز: <b>$${res.remainingBudget.toFixed(2)}</b>\n\n` +
    `🔗 <a href="${eventUrl}">مشاهده بازار در پلی‌مارکت</a>`
  );
}

export async function formatStatusMessage(): Promise<string> {
  const status = await getBotStatus();
  const modeText = !getSetting('bot.enabled')
    ? '⛔ غیرفعال (Kill switch off — Control → Trading Bot)'
    : status.simulationMode
    ? '🟡 آزمایشی (Paper Trading)'
    : status.isConfigured
    ? '🟢 فعال (Live CLOB)'
    : '🔴 والت تنظیم نشده (نیاز به Private Key)';

  const activeMarketText = status.activeMarket
    ? `• بازار ۱ ساعته فعال: <a href="https://polymarket.com/event/${status.activeMarket.slug}">${status.activeMarket.title}</a>\n` +
      `  - قیمت خرید UP (Ask): <b>$${status.activeMarket.bestAskUp?.toFixed(3) ?? '-'}</b>\n` +
      `  - قیمت خرید DOWN (Ask): <b>$${status.activeMarket.bestAskDown?.toFixed(3) ?? '-'}</b>`
    : '• بازار ۱ ساعته فعال: یافت نشد';

  return (
    `<b>🤖 وضعیت ربات ترید Polymarket</b>\n\n` +
    `• حالت کاری: ${modeText}\n` +
    `• آدرس والت: <code>${status.walletAddress || 'تنظیم نشده'}</code> (${status.walletType})\n\n` +
    `💰 <b>محدودیت‌های ریسک و سرمایه:</b>\n` +
    `• سقف کل بودجه مجاز: <b>$${status.maxTotalBudget.toFixed(2)}</b>\n` +
    `• کل هزینه شده تا الان: <b>$${status.totalSpent.toFixed(2)}</b>\n` +
    `• باقی‌مانده بودجه مجاز: <b>$${status.remainingBudget.toFixed(2)}</b>\n` +
    `• بودجه رزروشده: <b>$${status.reservedBudget.toFixed(2)}</b>\n` +
    status.pendingRequests.map(r => `⏳ ${r.state}: <code>/check ${r.requestId}</code>\n`).join('') +
    `• مبلغ هر معامله: <b>$${status.perTradeAmount.toFixed(2)}</b>\n\n` +
    `♻️ Redeem خودکار: ${status.redemption.active ? 'فعال' : 'متوقف'} | دریافتی تأییدشده: ${status.redemption.totalRedeemed.toFixed(2)} USDC.e\n` +
    status.redemption.recent.slice(0, 3).map(r => `• Redeem: ${r.state}${r.payout ? ` — ${r.payout} USDC.e` : ''}\n`).join('') +
    `📊 <b>مارکت بیت‌کوین:</b>\n` +
    `${activeMarketText}\n\n` +
    `دستور خرید سریع:\n` +
    `<code>buy: BTCUPDOW/1H/UP</code>\n` +
    `<code>buy: BTCUPDOW/1H/DOWN</code>`
  );
}

export function formatHistoryMessage(): string {
  const trades = getRecentTrades(5);
  if (!trades.length) {
    return '📝 هنوز هیچ معامله‌ای توسط ربات ثبت نشده است.';
  }

  const lines = trades.map((t, idx) => {
    const time = new Date(t.timestamp).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
    const emoji = t.outcome === 'UP' ? '📈 UP' : '📉 DOWN';
    const statusEmoji = t.status === 'FILLED' ? '✅' : t.status === 'SIMULATED' ? '🟡' : '❌';
    return (
      `${idx + 1}. ${statusEmoji} <b>${t.symbol}/${t.timeframe}</b> (${emoji})\n` +
      `   مبلغ: $${t.amount_usd.toFixed(2)} | قیمت: $${t.price?.toFixed(3) ?? '-'} | ساعت: ${time}`
    );
  });

  return `<b>📜 تاریخچه ۵ معامله اخیر:</b>\n\n` + lines.join('\n\n');
}

export function formatHelpMessage(): string {
  return (
    `<b>📖 راهنمای دستورات ربات ترید پلی‌مارکت:</b>\n\n` +
    `🔹 <b>سیگنال‌های خرید:</b>\n` +
    `• <code>buy: BTCUPDOW/1H/UP</code> -> خرید سهام بالا رفتن بیت‌کوین ۱ ساعته\n` +
    `• <code>buy: BTCUPDOW/1H/DOWN</code> -> خرید سهام پایین آمدن بیت‌کوین ۱ ساعته\n\n` +
    `🔹 <b>مدیریت و تنظیمات:</b>\n` +
    `• <code>/status</code> یا <code>وضعیت</code> -> گزارش مانده بودجه و والت\n` +
    `• <code>/bot on</code> -> فعال‌سازی ربات (روشن کردن Kill switch)\n` +
    `• <code>/bot off</code> -> غیرفعال‌سازی موقت ربات (Kill switch)\n` +
    `• <code>/set_budget 200</code> -> تنظیم سقف کل بودجه مجاز (مثلاً ۲۰۰ دلار)\n` +
    `• <code>/set_trade 15</code> -> تنظیم مقدار هر معامله (مثلاً ۱۵ دلار)\n` +
    `• <code>/sim on</code> -> فعال‌سازی حالت آزمایشی بدون خرج پول واقعی\n` +
    `• <code>/sim off</code> -> فعال‌سازی معامله زنده و واقعی روی والت\n` +
    `• <code>/check REQUEST_ID</code> -> بررسی سفارش نامشخص بدون خرید مجدد\n` +
    `• <code>/history</code> -> تاریخچه معاملات اخیر\n` +
    `• <code>/help</code> -> نمایش همین راهنما`
  );
}

/**
 * Main Telegram Polling Loop
 */
export async function startTelegramBotListener() {
  // Read once at startup — a token/chat change in /control restarts this worker (settings.ts: restarts: ['bot']).
  const token = getSetting('bot.telegramToken');
  const authorizedChatId = getSetting('bot.telegramChatId');

  if (!token) {
    console.error('[TELEGRAM BOT] No Telegram bot token configured — set it on Control → Trading Bot.');
    return;
  }
  if (!/^[1-9][0-9]*$/.test(authorizedChatId)) {
    // Never start an unauthenticated listener: without a chat id every message would be treated as
    // authorized (see the check below), letting anyone who finds the bot issue buy/budget commands.
    console.error('[TELEGRAM BOT] No authorized chat id configured — refusing to start. Set it on Control → Trading Bot.');
    return;
  }

  // Fetch bot info for logging
  try {
    const meRes = await fetch(`${TELEGRAM_API}/bot${token}/getMe`);
    const meData = await meRes.json();
    if (meData?.ok) {
      console.log(`[TELEGRAM BOT] Connected as @${meData.result.username} (${meData.result.first_name})`);
    }
  } catch {}

  console.log(`[TELEGRAM BOT] Starting listener with authorized chat: ${authorizedChatId || 'ANY'}`);
  const offsetKey = `telegram-offset:${token.split(':')[0]}`;
  let offset = Number(getBotSetting(offsetKey, '0'));

  while (true) {
    try {
      const res = await fetch(`${TELEGRAM_API}/bot${token}/getUpdates?offset=${offset}&timeout=30`, {
        cache: 'no-store',
      });

      if (!res.ok) {
        await new Promise((r) => setTimeout(r, 4000));
        continue;
      }

      const data = await res.json();
      if (!data.ok || !Array.isArray(data.result)) {
        await new Promise((r) => setTimeout(r, 4000));
        continue;
      }

      for (const update of data.result) {
        offset = update.update_id + 1;
        try {
          const msg = update.message;
          if (!msg || !msg.text) continue;

          const chatId = msg.chat.id.toString();
          const text = msg.text.trim();

          // Security: only allow the authorized chat ID
          if (chatId !== authorizedChatId || msg.chat.type !== 'private' || String(msg.from?.id) !== authorizedChatId) {
            console.warn(`[TELEGRAM BOT] Unauthorized message attempt from chat ID: ${chatId}`);
            await sendTelegramMessage(token, chatId, '⛔ دسترسی غیرمجاز. این ربات خصوصی است.');
            continue;
          }

          // Do not execute stale queued commands after downtime (especially previous-hour buys).
          if (!Number.isFinite(msg.date) || Date.now() / 1000 - msg.date > 120) {
            await sendTelegramMessage(token, chatId, 'دستور قدیمی اجرا نشد؛ در صورت نیاز دستور جدید بفرستید.');
            continue;
          }
          const check = text.match(/^\/check\s+([A-Za-z0-9:_-]{1,160})$/);
          if (check) {
            try { await sendTelegramMessage(token, chatId, formatTradeNotification(await reconcileRequest(check[1]))); }
            catch { await sendTelegramMessage(token, chatId, 'بررسی سفارش ممکن نشد. خرید جدیدی ارسال نشد.'); }
            continue;
          }
          // 1. Check for Buy Signal
          const signal = parseTradeSignal(text);
          if (signal) {
            if (buildHourlyEtSlug('btc', new Date(msg.date * 1000)) !== buildHourlyEtSlug('btc')) {
              await sendTelegramMessage(token, chatId, 'دستور مربوط به ساعت قبلی است و اجرا نشد.');
              continue;
            }
            await sendTelegramMessage(
              token,
              chatId,
              `⏳ دریافت دستور خرید: <b>${signal.symbol}/${signal.timeframe} ${signal.outcome}</b>\nدر حال بررسی بازار و ثبت سفارش در پلی‌مارکت...`
            );

            try {
              const result = await executeSignal({
                symbol: signal.symbol,
                timeframe: signal.timeframe,
                outcome: signal.outcome,
                source: 'telegram',
                requestId: `tg:${token.split(':')[0]}:${update.update_id}`,
              });
              const notifyText = formatTradeNotification(result);
              await sendTelegramMessage(token, chatId, notifyText);
            } catch {
              await sendTelegramMessage(token, chatId, '❌ وضعیت سفارش قابل تأیید نیست؛ قبل از دستور جدید وضعیت را بررسی کنید.');
            }
            continue;
          }

          // 2. Status Command
          if (text === '/status' || text.toLowerCase() === 'status' || text === 'وضعیت') {
            const statusText = await formatStatusMessage();
            await sendTelegramMessage(token, chatId, statusText);
            continue;
          }

          // 3. History Command
          if (text === '/history' || text === 'تاریخچه') {
            const historyText = formatHistoryMessage();
            await sendTelegramMessage(token, chatId, historyText);
            continue;
          }

          // 4. Set Budget Command: "/set_budget 150"
          // Writes through applySettingChanges — the same validated path as /control, so Telegram
          // can never save a budget config the dashboard's cross-field checks would reject.
          const setBudgetMatch = text.match(/^\/set_budget\s+(\d+(?:\.\d+)?)$/i);
          if (setBudgetMatch) {
            const newBudget = parseFloat(setBudgetMatch[1]);
            const r = applySettingChanges({ 'bot.maxBudget': newBudget });
            if (r.ok) {
              await sendTelegramMessage(token, chatId, `✅ سقف کل بودجه مجاز به <b>$${newBudget.toFixed(2)}</b> تغییر یافت.`);
            } else {
              await sendTelegramMessage(token, chatId, `❌ ${Object.values(r.errors)[0]}`);
            }
            continue;
          }

          // 5. Set Per-Trade Amount: "/set_trade 20"
          const setTradeMatch = text.match(/^\/set_trade\s+(\d+(?:\.\d+)?)$/i);
          if (setTradeMatch) {
            const newTrade = parseFloat(setTradeMatch[1]);
            const r = applySettingChanges({ 'bot.perTradeAmount': newTrade });
            if (r.ok) {
              await sendTelegramMessage(token, chatId, `✅ مبلغ مجاز هر معامله به <b>$${newTrade.toFixed(2)}</b> تغییر یافت.`);
            } else {
              await sendTelegramMessage(token, chatId, `❌ ${Object.values(r.errors)[0]}`);
            }
            continue;
          }

          // 6. Toggle Simulation Mode: "/sim on" or "/sim off"
          // Turning simulation off is also validated here: applySettingChanges refuses it without a
          // saved wallet private key, the same rule /control enforces.
          if (text.toLowerCase() === '/sim on') {
            applySettingChanges({ 'bot.simulationMode': true });
            await sendTelegramMessage(token, chatId, '🟡 حالت آزمایشی (Simulation) <b>فعال</b> شد. هیچ پول واقعی خرج نخواهد شد.');
            continue;
          }
          if (text.toLowerCase() === '/sim off') {
            const r = applySettingChanges({ 'bot.simulationMode': false });
            if (r.ok) {
              await sendTelegramMessage(token, chatId, '🟢 حالت معامله واقعی (Live CLOB) <b>فعال</b> شد.');
            } else {
              await sendTelegramMessage(token, chatId, `❌ ${Object.values(r.errors)[0]}`);
            }
            continue;
          }

          // 7. Toggle Bot Kill Switch: "/bot on" or "/bot off"
          if (text.toLowerCase() === '/bot on' || text.toLowerCase() === '/enable') {
            applySettingChanges({ 'bot.enabled': true });
            await sendTelegramMessage(token, chatId, '🟢 ربات تریدر <b>فعال</b> شد (Kill switch روشن). آماده دریافت سیگنال‌های خرید.');
            continue;
          }
          if (text.toLowerCase() === '/bot off' || text.toLowerCase() === '/disable') {
            applySettingChanges({ 'bot.enabled': false });
            await sendTelegramMessage(token, chatId, '⛔ ربات تریدر <b>غیرفعال</b> شد (Kill switch خاموش). هیچ سفارشی ثبت نخواهد شد.');
            continue;
          }

          // 8. Help Command
          if (text === '/help' || text === '/start' || text === 'راهنما') {
            const helpText = formatHelpMessage();
            await sendTelegramMessage(token, chatId, helpText);
            continue;
          }

          // Default hint
          if (text.startsWith('/')) {
            await sendTelegramMessage(token, chatId, 'دستور نامعتبر است. برای مشاهده راهنما /help را ارسال کنید.');
          }
        } finally {
          setBotSetting(offsetKey, String(offset));
        }
      }
    } catch {
      console.error('[TELEGRAM BOT] Polling failed');
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
