import { getSetting } from '../settings';
import { sendTelegram } from '../alerts';
import { buildTrades, filterBaseRows, type FrozenStrategy, type SnapshotRow } from '../signalAnalysis';
import { readRecentRows } from '../recentRows';
import { botStrategy } from './forward';
import { resolveActiveMarket, orderPriceCap, limitBuyPrice, limitBuySize } from './executor';
import { walletBalanceLine, withBalanceLine } from './balance';
import type { ActiveMarketInfo, TradeOutcome } from './types';

export interface TestSignal {
  outcome: TradeOutcome;
  slug: string;
  etTime: string;
  minute: number | null;
  score: number | null;
  confidence: number | null;
  /** false when no snapshot matched the strategy and the newest snapshot's own Jev direction is shown instead */
  matched: boolean;
}

/** The strategy's most recent signal in the given rows (its own rule, no activation date), or the newest snapshot's direction. */
export function latestSignal(rows: SnapshotRow[], strategy: FrozenStrategy): TestSignal | null {
  const rule = strategy.rule;
  const last = buildTrades(filterBaseRows(rows, rule), rule).at(-1);
  if (last) {
    return { outcome: last.dir, slug: last.row.market_slug || '—', etTime: last.row.et_time, minute: last.minute, score: last.modelScore, confidence: last.modelConf, matched: true };
  }
  const row = [...rows].reverse().find(r => r.direction === 'UP' || r.direction === 'DOWN');
  if (!row) return null;
  return { outcome: row.direction as TradeOutcome, slug: row.market_slug || '—', etTime: row.et_time, minute: null, score: row.score ?? null, confidence: row.score_confidence ?? null, matched: false };
}

/** What the bot would do with an order right now, from the live book and the saved order settings. Reads only. */
export function orderPreview(market: ActiveMarketInfo | null): string {
  const ask = market?.selectedBestAsk;
  if (!market || ask === null || ask === undefined || !Number.isFinite(ask)) return 'پیش‌نمایش سفارش: قیمت فعلی بازار در دسترس نیست.';
  const mode = getSetting('bot.orderPriceMode');
  const cents = (x: number) => `${(x * 100).toFixed(0)}¢`;
  if (mode === 'limit') {
    const offset = getSetting('bot.limitOffsetCents');
    const price = limitBuyPrice(ask, offset);
    const size = limitBuySize(getSetting('bot.perTradeAmount'), price);
    return `پیش‌نمایش سفارش (limit): قیمت فعلی فروش ${cents(ask)}؛ سفارش ${offset} سنت پایین‌تر روی ${cents(price)} برای ${size} سهم گذاشته می‌شود.`;
  }
  if (mode === 'market') return `پیش‌نمایش سفارش (market): قیمت فعلی فروش ${cents(ask)}؛ خرید تا سقف 99¢ پر می‌شود.`;
  const cap = orderPriceCap(ask, mode, getSetting('bot.slippageCents'));
  return `پیش‌نمایش سفارش (slippage): قیمت فعلی فروش ${cents(ask)}؛ حداکثر قیمت پرداختی ${cents(cap)}.`;
}

export function formatTestSignalMessage(signal: TestSignal, strategy: FrozenStrategy, preview: string, balance: string): string {
  const detail = signal.matched
    ? `آخرین سیگنال استراتژی ${strategy.id}: ${signal.etTime} (دقیقه ${signal.minute}) · امتیاز ${signal.score} · اطمینان ${signal.confidence}%`
    : `در این بازه سیگنالی از استراتژی ${strategy.id} نبود؛ جهت آخرین اسنپ‌شات Jev نمایش داده شد (${signal.etTime}).`;
  return withBalanceLine(
    balance,
    `🧪 پیام آزمایشی؛ هیچ سفارشی ثبت نشد\n` +
      `📥 سیگنال forward دریافت شد؛ هنوز خرید تأیید نشده\n` +
      `BTC 1H ${signal.outcome}\n${signal.slug}\nforward:TEST\n\n` +
      `${detail}\n${preview}`,
  );
}

export interface TestSignalDeps {
  send: (token: string, chat: string, text: string) => Promise<boolean>;
  rows: () => SnapshotRow[];
  market: (outcome: TradeOutcome) => Promise<ActiveMarketInfo | null>;
  balance: () => Promise<string>;
}

/**
 * Send the bot's Telegram chat a sample of the message a forward signal produces, built from the strategy's latest real
 * signal, the real wallet balance and a preview of the order. Nothing is bought, queued or recorded: it only reads.
 */
export async function sendTestSignal(deps: Partial<TestSignalDeps> = {}): Promise<{ ok: boolean; message: string }> {
  const { send = sendTelegram, rows = readRecentRows, market = (o: TradeOutcome) => resolveActiveMarket('btc', '1H', o), balance = walletBalanceLine } = deps;
  const token = getSetting('bot.telegramToken'), chat = getSetting('bot.telegramChatId');
  if (!token || !chat) return { ok: false, message: 'Save the trading bot Telegram token and chat ID first' };
  const strategy = botStrategy();
  if (!strategy) return { ok: false, message: `Unknown forward strategy ${getSetting('bot.forwardStrategy')}` };
  const signal = latestSignal(rows(), strategy);
  if (!signal) return { ok: false, message: 'No BTC snapshots found to build a test signal from' };
  const [preview, line] = await Promise.all([market(signal.outcome).then(orderPreview).catch(() => orderPreview(null)), balance()]);
  const ok = await send(token, chat, formatTestSignalMessage(signal, strategy, preview, line));
  return ok
    ? { ok: true, message: `Test signal sent (${strategy.id}, ${signal.outcome}${signal.matched ? ', latest real signal' : ', no recent signal: newest snapshot'}). No order was placed.` }
    : { ok: false, message: 'Telegram rejected the message; check token and chat ID' };
}
