import { getDb } from '../db';
import { getRedemptionStatus } from './redeem';
import { ClobClient, Side, OrderType, type OrderBookSummary } from '@polymarket/clob-client';
import { getBotBudgetLimits, getTotalSpent, getRecentTrades, getTradeCount } from './db';
import { getSetting } from '../settings';
import { createLiveClient, getBotWalletConfig, walletIdentity, CLOB_HOST } from './live';
import { findRequest, reserveRequest, reservedBudget, pendingRequests, prepareSubmission, markRejected, markUnknown, finishRequest, type BotRequest } from './ledger';
import type { SignalRequest, ActiveMarketInfo, TradeResult, BotStatus, TradeOutcome } from './types';
import { OrderSide as UnifiedOrderSide, OrderType as UnifiedOrderType } from '@polymarket/client';
import { createDepositWalletClient, depositOrderHash, ensureDepositTradingApprovals, getDepositCollateralBalanceUsd } from './depositWallet';
import { fetchNegRisk } from '@polymarket/client/actions';
import { getPolymarketGeoStatus } from './geo';
export { getBotWalletConfig } from './live';
const POLYGON_CHAIN_ID = 137;
/** Default for the bot.maxAttempts setting. */
export const MAX_ATTEMPTS = 3;
export const RETRY_DELAY_MS = 2000;
const wait = () => new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));

/** True when an SDK error definitely means "nothing was bought": the FOK order was killed, or the exchange refused to create it. Anything else is ambiguous. */
const NO_FILL_RE = /invalid amounts|FOK_ORDER_NOT_FILLED|couldn't be fully filled|could not be fully filled|fully filled or killed|not fully filled|unmatched/i;

/** Log-safe summary of a thrown order error (no credentials, no full hashes) plus whether it proves a non-fill. */
export function describeOrderError(e: unknown): { noFill: boolean; text: string } {
  const raw = e instanceof Error ? e.message : String(e);
  const meta = e as { name?: string; status?: unknown; code?: unknown };
  const text = raw
    .replace(/(secret|passphrase|api[-_ ]?key|authorization|bearer|signature|private)[^,;\n]*/gi, '$1=[hidden]')
    .replace(/0x[0-9a-fA-F]{40,}/g, '0x…')
    .slice(0, 200);
  return { noFill: NO_FILL_RE.test(raw), text: [meta.name ?? 'Error', meta.status ?? meta.code ?? '', text].filter(Boolean).join(' ') };
}

/**
 * The exchange refuses a market buy unless the USDC side has at most 2 decimals and the share side at most 4
 * (both are 6-decimal base units). On 0.001-tick markets (prices above 0.96 or below 0.04) the SDK rounds the
 * share side to 5 decimals, so an order it signs can be rejected with "invalid amounts". Orders that carry no
 * amounts (test doubles) cannot be checked and pass.
 */
export function marketBuyAmountsValid(order: { makerAmount?: unknown; takerAmount?: unknown }): boolean {
  if (order.makerAmount === undefined || order.takerAmount === undefined) return true;
  try { return BigInt(order.makerAmount as string) % BigInt(10_000) === BigInt(0) && BigInt(order.takerAmount as string) % BigInt(100) === BigInt(0); }
  catch { return false; }
}

/** Sign a market buy; if the amounts would be rejected, spend a cent less and sign again (nothing is sent). */
export async function signFittingMarketBuy<T extends { makerAmount?: unknown; takerAmount?: unknown }>(
  sign: (spend: number) => Promise<T>, amount: number, maxSteps = 60,
): Promise<T> {
  let spend = Number(amount.toFixed(2));
  for (let i = 0; i <= maxSteps && spend > 0; i++, spend = Number((spend - 0.01).toFixed(2))) {
    const order = await sign(spend);
    if (marketBuyAmountsValid(order)) return order;
  }
  throw new Error('مبلغ خرید با دقت اعشاری مجاز بازار سازگار نشد؛ سفارشی ارسال نشد.');
}

/** Polymarket prices move in 0.01 (or 0.001) ticks; 0.99 is the highest price a buy is worth sending at. */
const MARKET_PRICE_CAP = 0.99;

/**
 * Worst price the FOK buy may fill at. 'slippage': best ask + N cents, rounded UP to a 0.01 tick (valid on
 * both tick sizes). 'market': the book is swept up to 0.99. The order still fills at the best available
 * prices; the cap only bounds how far the price may run before the order is killed instead of filled.
 */
export function orderPriceCap(bestAsk: number, mode: 'slippage' | 'market', slippageCents: number): number {
  const wanted = mode === 'market' ? MARKET_PRICE_CAP : Math.ceil((bestAsk + slippageCents / 100) * 100 - 1e-9) / 100;
  return Math.min(0.999, Math.max(bestAsk, wanted));
}

/** Build the hourly slug according to ET (Eastern Time) convention */
export function buildHourlyEtSlug(coin = 'btc', targetDate = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    hour12: true,
  }).formatToParts(targetDate);

  const month = parts.find((p) => p.type === 'month')?.value.toLowerCase() || '';
  const day = parts.find((p) => p.type === 'day')?.value || '';
  const year = parts.find((p) => p.type === 'year')?.value || '';
  const hour12 = parts.find((p) => p.type === 'hour')?.value || '';
  const dayPeriod = parts.find((p) => p.type === 'dayPeriod')?.value.toLowerCase() || '';

  const coinWord = coin.toLowerCase() === 'btc' ? 'bitcoin' : coin.toLowerCase() === 'eth' ? 'ethereum' : coin.toLowerCase();
  return `${coinWord}-up-or-down-${month}-${day}-${year}-${hour12}${dayPeriod}-et`;
}

/** Fetch live market info for coin and timeframe (e.g. 1H BTC) */
export async function resolveActiveMarket(coin = 'btc', timeframe = '1H', outcome: TradeOutcome = 'UP'): Promise<ActiveMarketInfo | null> {
  if (!['btc', 'btcupdow', 'btcupdown'].includes(coin.toLowerCase()) || timeframe.toUpperCase() !== '1H') return null;
  const normalizedCoin = 'btc';
  const slug = buildHourlyEtSlug(normalizedCoin);

  // 1. Try Gamma API directly
  try {
    const res = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
      headers: { 'User-Agent': 'PolymarketPulseBot/1.0' },
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        const event = data.find(e => e.slug === slug);
        if (!event) return null;
        const market = event.markets?.[0];
        if (market) {
          let tokens: string[] = [];
          try {
            tokens = Array.isArray(market.clobTokenIds) ? market.clobTokenIds : JSON.parse(market.clobTokenIds || '[]');
          } catch {}

          const outcomes: string[] = Array.isArray(market.outcomes) ? market.outcomes : JSON.parse(market.outcomes || '[]');
          const tokenUp = tokens[outcomes.findIndex(x => x.toLowerCase() === 'up')] || '';
          const tokenDown = tokens[outcomes.findIndex(x => x.toLowerCase() === 'down')] || '';
          if (!tokenUp || !tokenDown || tokenUp === tokenDown) return null;

          // Fetch orderbook for both tokens
          const clobClient = new ClobClient(CLOB_HOST, POLYGON_CHAIN_ID);
          const [bookUp, bookDown] = await Promise.all([
            tokenUp ? clobClient.getOrderBook(tokenUp).catch(() => null) : Promise.resolve(null),
            tokenDown ? clobClient.getOrderBook(tokenDown).catch(() => null) : Promise.resolve(null),
          ]);

          const getBestPrices = (book: OrderBookSummary | null) => {
            if (!book) return { bestAsk: null, bestBid: null };
            const asks = (book.asks || []).map(a => parseFloat(a.price)).filter((p: number) => Number.isFinite(p) && p > 0 && p < 1);
            const bids = (book.bids || []).map(b => parseFloat(b.price)).filter((p: number) => Number.isFinite(p) && p > 0 && p < 1);
            return {
              bestAsk: asks.length ? Math.min(...asks) : null,
              bestBid: bids.length ? Math.max(...bids) : null,
            };
          };

          const upPrices = getBestPrices(bookUp);
          const downPrices = getBestPrices(bookDown);

          const selectedTokenId = outcome === 'UP' ? tokenUp : tokenDown;
          const selectedBestAsk = outcome === 'UP' ? upPrices.bestAsk : downPrices.bestAsk;
          const selectedBook = outcome === 'UP' ? bookUp : bookDown;
          const minimumOrderSize = selectedBook?.min_order_size == null ? null : Number(selectedBook.min_order_size);

          return {
            slug,
            title: event.title || `${normalizedCoin.toUpperCase()} Up or Down 1H`,
            coin: normalizedCoin,
            timeframe: timeframe.toUpperCase(),
            endDate: market.endDate,
            acceptingOrders: market.acceptingOrders === true && !market.closed,
            closed: !!market.closed,
            tokenUp,
            tokenDown,
            bestAskUp: upPrices.bestAsk,
            bestBidUp: upPrices.bestBid,
            bestAskDown: downPrices.bestAsk,
            bestBidDown: downPrices.bestBid,
            selectedTokenId,
            selectedBestAsk,
            minimumOrderSize: Number.isFinite(minimumOrderSize) && minimumOrderSize! > 0 ? minimumOrderSize : null,
          };
        }
      }
    }
  } catch {
    console.error('Market lookup failed');
  }

  return null;
}

function resultFor(signal: SignalRequest, row?: BotRequest, error?: string): TradeResult {
  const limits = getBotBudgetLimits();
  const simulated = row ? !!row.simulated : limits.simulationMode;
  const total = getTotalSpent(simulated);
  return {
    success: false, simulated, requestId: signal.requestId, symbol: 'BTC', timeframe: '1H', outcome: signal.outcome,
    amountUsd: row?.amount ?? limits.perTrade, totalSpentAfter: total, maxBudget: limits.maxBudget,
    remainingBudget: Math.max(0, limits.maxBudget - total - reservedBudget(simulated)),
    timestamp: row?.created_at ?? Date.now(), error, status: 'FAILED', attempts: row?.attempts ?? 0,
    slug: row?.slug ?? undefined, tokenId: row?.token_id ?? undefined, orderId: row?.order_id ?? undefined,
  };
}
function settle(signal: SignalRequest, row: BotRequest, result: TradeResult): TradeResult {
  const status = result.success ? result.simulated ? 'SIMULATED' : 'FILLED' : 'FAILED';
  result.status = status;
  result.totalSpentAfter = getTotalSpent(result.simulated) + (result.success ? result.amountUsd : 0);
  result.remainingBudget = Math.max(0, getBotBudgetLimits().maxBudget - result.totalSpentAfter);
  return finishRequest(row.request_id, result, {
    timestamp: Date.now(), symbol: 'BTC', timeframe: '1H', outcome: signal.outcome,
    slug: result.slug || '', token_id: result.tokenId || '', amount_usd: result.amountUsd,
    shares: result.shares ?? null, price: result.price ?? null, status,
    order_id: result.orderId ?? null, tx_hash: result.txHash ?? null,
    source: signal.source || 'api', error_message: result.error ?? null,
  });
}
function unknown(signal: SignalRequest, row: BotRequest): TradeResult {
  const current = findRequest(row.request_id);
  if (current?.result && ['FILLED', 'SIMULATED', 'FAILED'].includes(current.state)) return JSON.parse(current.result);
  const r = { ...resultFor(signal, row, 'نتیجهٔ سفارش نامشخص است؛ بودجه رزرو مانده و خرید جدید متوقف است. وضعیت سفارش را بررسی کنید.'), status: 'UNKNOWN' as const };
  markUnknown(row.request_id, r);
  return r;
}
function signalOf(row: BotRequest): SignalRequest {
  return { ...JSON.parse(row.fingerprint), requestId: row.request_id, source: row.request_id.startsWith('tg:') ? 'telegram' : 'api' };
}

/** Read-only exchange reconciliation. A missing order/timeout NEVER proves a failed submission. */
export async function reconcileRequest(requestId: string): Promise<TradeResult> {
  const row = findRequest(requestId);
  if (!row) throw new Error('Unknown request ID');
  const signal = signalOf(row);
  if (['FILLED', 'SIMULATED', 'FAILED'].includes(row.state)) return JSON.parse(row.result!);
  // Do not race an active worker. An interrupted preparation has no posted order and can be released.
  if (row.state !== 'UNKNOWN' && Date.now() - row.updated_at < 120_000) {
    return { ...resultFor(signal, row, 'سفارش در حال پردازش است.'), status: 'PENDING' };
  }
  if (!row.order_id) return settle(signal, row, resultFor(signal, row, 'آماده‌سازی سفارش متوقف شد؛ سفارشی ارسال نشده است.'));
  if (row.wallet !== walletIdentity()) return { ...resultFor(signal, row, 'برای بررسی سفارش، کیف پول قبلی را برگردانید.'), status: 'UNKNOWN' };
  try {
    if (getBotWalletConfig().walletType === 'DEPOSIT_WALLET') {
      const { client } = await createDepositWalletClient();
      let order;
      try { order = await client.fetchOrder({ orderId: row.order_id }); }
      catch {
        // A lost POST response can leave no order endpoint record. Account trades are an
        // independent authenticated ledger and let us settle an old FOK request safely.
        const page = await client.listAccountTrades({
          assetId: row.token_id!,
          after: String(Math.floor((row.created_at - 60_000) / 1000)),
        }).firstPage();
        const own = page.items.filter(t => t.takerOrderId === row.order_id && t.side.toUpperCase() === 'BUY');
        if (own.length) {
          if (own.some(t => !['MATCHED', 'MINED', 'CONFIRMED'].includes(t.status.toUpperCase()))) return unknown(signal, row);
          const shares = own.reduce((sum, t) => sum + Number(t.size), 0);
          const amount = own.reduce((sum, t) => sum + Number(t.size) * Number(t.price), 0);
          if (!validFill(amount, shares, row)) return unknown(signal, row);
          return settle(signal, row, { ...resultFor(signal, row), success: true, amountUsd: amount, shares, price: amount / shares,
            txHash: own.find(t => t.transactionHash)?.transactionHash });
        }
        // FOK orders never rest on the book. If both the order endpoint and the
        // authenticated trade ledger are empty after five minutes, no fill occurred.
        const oldFok = Date.now() - row.created_at >= 5 * 60_000;
        if (oldFok) return settle(signal, row, resultFor(signal, row, 'سفارش در CLOB ثبت نشده و هیچ معامله‌ای انجام نشده است؛ بودجه آزاد شد.'));
        return unknown(signal, row);
      }
      if (order.id !== row.order_id || String(order.assetId) !== row.token_id || order.side.toUpperCase() !== 'BUY') return unknown(signal, row);
      if (['CANCELED', 'CANCELLED'].includes(order.status.toUpperCase()) && Number(order.sizeMatched) === 0) {
        return settle(signal, row, resultFor(signal, row, 'سفارش بدون خرید لغو شده است.'));
      }
      if (order.status.toUpperCase() === 'MATCHED' && Number(order.sizeMatched) > 0) {
        const shares = Number(order.sizeMatched), amount = shares * Number(order.price);
        if (!validFill(amount, shares, row)) return unknown(signal, row);
        return settle(signal, row, { ...resultFor(signal, row), success: true, amountUsd: amount, shares, price: amount / shares });
      }
      return unknown(signal, row);
    }
    const { client } = await createLiveClient();
    const order = await client.getOrder(row.order_id);
    if (order?.id !== row.order_id || order.asset_id !== row.token_id || order.side !== 'BUY') return unknown(signal, row);
    if (['CANCELED', 'CANCELLED'].includes(order.status?.toUpperCase()) && Number(order.size_matched) === 0) {
      return settle(signal, row, resultFor(signal, row, 'سفارش بدون خرید لغو شده است.'));
    }
    // Reconstruct actual cost from this order's trades, never from its limit price.
    if (order.status?.toUpperCase() === 'MATCHED' && Number(order.size_matched) > 0 && order.associate_trades?.length) {
      const trades = (await Promise.all(order.associate_trades.map(id => client.getTrades({ id })))).flat();
      const own = [...new Map(trades.filter(t => t.taker_order_id === row.order_id).map(t => [t.id, t])).values()];
      if (!own.length || own.some(t => !['MATCHED', 'MINED', 'CONFIRMED'].includes(t.status))) return unknown(signal, row);
      const shares = own.reduce((sum, t) => sum + Number(t.size), 0);
      const amount = own.reduce((sum, t) => sum + Number(t.size) * Number(t.price), 0);
      if (Math.abs(shares - Number(order.size_matched)) > 0.000001 || !validFill(amount, shares, row)) return unknown(signal, row);
      return settle(signal, row, { ...resultFor(signal, row), success: true, amountUsd: amount, shares, price: amount / shares });
    }
  } catch { /* retain reservation; never leak SDK credentials through errors */ }
  return unknown(signal, row);
}
function validFill(amount: number, shares: number, row: BotRequest) {
  return Number.isFinite(amount) && Number.isFinite(shares) && amount > 0 && shares > 0 && amount <= row.amount + 0.000001 &&
    row.price_cap !== null && amount / shares <= row.price_cap + 0.000001;
}
function assertStillAllowed(row: BotRequest, market: ActiveMarketInfo, identity: string, signal: SignalRequest) {
  if (signal.expiresAt !== undefined && Date.now() > signal.expiresAt) throw new Error('سیگنال منقضی شده است.');
  if (signal.forwardArmedAt !== undefined) {
    const gate = getDb().prepare('SELECT armed_at FROM bot_forward_gate WHERE id=1').get() as { armed_at: number } | undefined;
    if (!getSetting('bot.forwardEnabled') || gate?.armed_at !== signal.forwardArmedAt) throw new Error('اتصال forward خاموش شده یا دوباره فعال شده است؛ درخواست قبلی اجرا نشد.');
  }
  const limits = getBotBudgetLimits();
  if (!getSetting('bot.enabled')) throw new Error('ربات غیرفعال شد (bot disabled).');
  if (limits.simulationMode !== !!row.simulated || limits.perTrade !== row.amount || walletIdentity() !== identity) {
    throw new Error('تنظیمات معامله تغییر کرد؛ درخواست متوقف شد.');
  }
  if (getTotalSpent(!!row.simulated) + row.amount > limits.maxBudget + 0.000001) throw new Error('بودجه کاهش یافته است.');
  if (Date.parse(market.endDate) <= Date.now() || market.slug !== buildHourlyEtSlug('btc')) throw new Error('ساعت این بازار پایان یافته است.');
}

/** Fixed-size BTC 1H BUY only. Requests are durably reserved before any network operation. */
export async function executeSignal(signal: SignalRequest): Promise<TradeResult> {
  if (!['BTC', 'BTCUPDOW', 'BTCUPDOWN'].includes(String(signal.symbol).toUpperCase()) || signal.timeframe !== '1H' || !['UP', 'DOWN'].includes(signal.outcome)) {
    return resultFor(signal, undefined, 'فقط BTC/1H/UP یا BTC/1H/DOWN مجاز است.');
  }
  if (!signal.requestId || !/^[A-Za-z0-9:_-]{1,160}$/.test(signal.requestId)) return resultFor(signal, undefined, 'شناسهٔ یکتای درخواست الزامی است.');
  let reservation;
  try { reservation = reserveRequest(signal); }
  catch (e) { return resultFor(signal, undefined, e instanceof Error ? e.message : 'رزرو بودجه ناموفق بود.'); }
  let row = reservation.row;
  if (reservation.duplicate) {
    if (row.result && ['FILLED', 'SIMULATED', 'FAILED'].includes(row.state)) return JSON.parse(row.result);
    return reconcileRequest(row.request_id);
  }
  let result = resultFor(signal, row);
  try {
    const identity = walletIdentity();
    if (!row.simulated && !getBotWalletConfig().isConfigured) throw new Error('کیف پول معتبر تنظیم نشده است؛ معامله واقعی انجام نشد.');
    const market = await resolveActiveMarket('btc', '1H', signal.outcome);
    if (!market || market.closed || !market.acceptingOrders || !Number.isFinite(Date.parse(market.endDate))) throw new Error('بازار فعال و معتبر BTC یک‌ساعته پیدا نشد.');
    if (signal.expectedMarketSlug && signal.expectedMarketSlug !== market.slug) throw new Error('بازار سیگنال با بازار جاری متفاوت است؛ خرید انجام نشد.');
    const bestAsk = market.selectedBestAsk;
    if (bestAsk === null || !Number.isFinite(bestAsk) || bestAsk <= 0 || bestAsk >= 1 || !market.selectedTokenId) throw new Error('قیمت خرید معتبر در دفتر سفارش وجود ندارد.');
    // Not the exact best ask: the price moves between the read and the order, and a cap equal to the ask
    // makes the FOK order die on the first tick. The cap is what the order may pay at worst.
    let cap = orderPriceCap(bestAsk, getSetting('bot.orderPriceMode'), getSetting('bot.slippageCents'));
    const maxAttempts = getSetting('bot.maxAttempts');
    // A retry only makes sense at the CURRENT price: the first one usually failed because the ask moved.
    const refreshCap = async () => {
      const fresh = await resolveActiveMarket('btc', '1H', signal.outcome);
      const ask = fresh?.selectedBestAsk;
      if (!fresh || fresh.closed || !fresh.acceptingOrders || fresh.slug !== market.slug || fresh.selectedTokenId !== market.selectedTokenId ||
          ask === null || ask === undefined || !Number.isFinite(ask) || ask <= 0 || ask >= 1) throw new Error('قیمت تازهٔ بازار برای تلاش مجدد در دسترس نیست؛ خرید انجام نشد.');
      cap = orderPriceCap(ask, getSetting('bot.orderPriceMode'), getSetting('bot.slippageCents'));
    };
    result = { ...result, slug: market.slug, tokenId: market.selectedTokenId };
    assertStillAllowed(row, market, identity, signal);
    if (market.minimumOrderSize && row.amount / cap + 0.000001 < market.minimumOrderSize) {
      const minimumUsd = market.minimumOrderSize * cap;
      throw new Error(`مبلغ ثابت برای حداقل ${market.minimumOrderSize} سهم کافی نیست؛ در بدترین قیمت مجاز حداقل ${minimumUsd.toFixed(2)} دلار لازم است.`);
    }
    if (row.simulated) {
      return settle(signal, row, { ...result, success: true, shares: row.amount / bestAsk, price: bestAsk, orderId: `sim_${row.request_id}` });
    }
    const geo = await getPolymarketGeoStatus(true);
    if (!geo.checked) throw new Error('بررسی محدودیت جغرافیایی Polymarket ناموفق بود؛ برای ایمنی سفارش ارسال نشد.');
    if (geo.apiBlocked) throw new Error(`خرید جدید از موقعیت ${geo.country || 'فعلی'} در API پلی‌مارکت محدود است؛ سفارش ارسال نشد.`);
    if (getBotWalletConfig().walletType === 'DEPOSIT_WALLET') {
      const { client } = await createDepositWalletClient({ provisionBuilder: true });
      await ensureDepositTradingApprovals(client);
      const negRisk = market.selectedTokenId.startsWith('0x') ? false : await fetchNegRisk(client, { assetId: market.selectedTokenId });
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (attempt > 1) { await wait(); await refreshCap(); }
        assertStillAllowed(row, market, identity, signal);
        const signed = await signFittingMarketBuy(spend => client.createMarketOrder({
          assetId: market.selectedTokenId,
          amount: spend,
          maxSpend: spend,
          maxPrice: cap,
          side: UnifiedOrderSide.BUY,
          orderType: UnifiedOrderType.FOK,
        }), row.amount);
        assertStillAllowed(row, market, identity, signal);
        const orderId = depositOrderHash(signed, negRisk);
        prepareSubmission(row.request_id, orderId, market, cap, identity);
        row = findRequest(row.request_id)!;
        result = { ...result, orderId, attempts: row.attempts };
        let response;
        try { response = await client.postOrder(signed); }
        catch (e) {
          const info = describeOrderError(e);
          console.warn(`[TRADE] attempt ${attempt}/${maxAttempts} postOrder threw (${info.noFill ? 'not filled' : 'ambiguous'}): ${info.text}`);
          if (!info.noFill) return await reconcileAfterUnknown(signal, row);
          markRejected(row.request_id);
          row = findRequest(row.request_id)!;
          result = { ...result, orderId: undefined, error: 'در قیمت اولیه نقدینگی کافی نبود؛ خریدی انجام نشد.' };
          continue;
        }
        if (response.ok && response.status === 'matched' && response.orderId === orderId &&
            validFill(Number(response.makingAmount), Number(response.takingAmount), row)) {
          const amount = Number(response.makingAmount), shares = Number(response.takingAmount);
          return settle(signal, row, { ...result, success: true, error: undefined, amountUsd: amount,
            shares, price: amount / shares, txHash: response.transactionsHashes[0] });
        }
        if (!response.ok && response.code === 'unmatched') {
          markRejected(row.request_id);
          row = findRequest(row.request_id)!;
          result = { ...result, orderId: undefined, error: 'در قیمت اولیه نقدینگی کافی نبود؛ خریدی انجام نشد.' };
          continue;
        }
        if (!response.ok) {
          markRejected(row.request_id);
          row = findRequest(row.request_id)!;
          return settle(signal, row, { ...result, orderId: undefined, error: 'CLOB سفارش را رد کرد؛ موجودی، مجوز خرج‌کردن و تنظیمات کیف پول را بررسی کنید.' });
        }
        console.warn(`[TRADE] attempt ${attempt}/${maxAttempts} ambiguous response: ok=${String((response as { ok?: unknown }).ok)} status=${String((response as { status?: unknown }).status)} code=${String((response as { code?: unknown }).code)}`);
        return await reconcileAfterUnknown(signal, row);
      }
      return settle(signal, row, result);
    }
    const { client, orderHash } = await createLiveClient();
    const negRisk = await client.getNegRisk(market.selectedTokenId);
    if (typeof negRisk !== 'boolean') throw new Error('مشخصات بازار معتبر نیست.');
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) { await wait(); await refreshCap(); }
      assertStillAllowed(row, market, identity, signal);
      const signed = await signFittingMarketBuy(spend => client.createMarketOrder({ tokenID: market.selectedTokenId, amount: spend, side: Side.BUY, orderType: OrderType.FOK, price: cap }, { negRisk }), row.amount);
      assertStillAllowed(row, market, identity, signal);
      // Save the actual signed order hash BEFORE POST, so a crash cannot lose its identity.
      prepareSubmission(row.request_id, orderHash(signed, negRisk), market, cap, identity);
      row = findRequest(row.request_id)!;
      result = { ...result, orderId: row.order_id!, attempts: row.attempts };
      let response;
      try { response = await client.postOrder(signed, OrderType.FOK); }
      catch (e) {
        const info = describeOrderError(e);
        console.warn(`[TRADE] attempt ${attempt}/${maxAttempts} postOrder threw (${info.noFill ? 'not filled' : 'ambiguous'}): ${info.text}`);
        if (!info.noFill) return await reconcileAfterUnknown(signal, row);
        markRejected(row.request_id);
        row = findRequest(row.request_id)!;
        result = { ...result, orderId: undefined, error: 'در قیمت اولیه نقدینگی کافی نبود؛ خریدی انجام نشد.' };
        continue;
      }
      if (response?.success === true && response.status === 'matched' && response.orderID === row.order_id && validFill(Number(response.makingAmount), Number(response.takingAmount), row)) {
        const amount = Number(response.makingAmount), shares = Number(response.takingAmount);
        return settle(signal, row, { ...result, success: true, error: undefined, amountUsd: amount, shares, price: amount / shares, txHash: response.transactionsHashes?.[0] });
      }
      // Only a documented definitive FOK non-fill permits another freshly signed order.
      const error = typeof response?.errorMsg === 'string' && response.errorMsg ? response.errorMsg : typeof response?.error === 'string' ? response.error : '';
      const noFill = /FOK_ORDER_NOT_FILLED_ERROR|order couldn't be fully filled.*FOK|FOK.*fully filled or killed/i.test(error);
      if (response?.success !== true && !response?.orderID && noFill && (!response.status || (Number(response.status) >= 400 && Number(response.status) < 500))) {
        markRejected(row.request_id);
        row = findRequest(row.request_id)!;
        result = { ...result, orderId: undefined, error: 'در قیمت اولیه نقدینگی کافی نبود؛ خریدی انجام نشد.' };
        continue;
      }
      // Definite validation/auth rejection: stop; all other responses are ambiguous.
      if (!response?.orderID && response?.success !== true && [400, 401, 403, 422].includes(Number(response?.status)) && error && !/duplicate|delayed|timeout/i.test(error)) {
        markRejected(row.request_id);
        row = findRequest(row.request_id)!;
        return settle(signal, row, { ...result, orderId: undefined, error: 'CLOB سفارش را رد کرد؛ موجودی، مجوز خرج‌کردن و تنظیمات کیف پول را بررسی کنید.' });
      }
      return await reconcileAfterUnknown(signal, row);
    }
    return settle(signal, row, result);
  } catch (e) {
    row = findRequest(row.request_id)!;
    if (['SUBMITTING', 'UNKNOWN'].includes(row.state)) return unknown(signal, row);
    // Preparation errors cannot have submitted an order. Do not surface raw SDK error objects.
    const message = e instanceof Error && /[\u0600-\u06ff]/.test(e.message) ? e.message : 'آماده‌سازی یا ثبت معامله ناموفق بود؛ سفارشی ارسال نشد.';
    return settle(signal, row, { ...result, error: message });
  }
}
async function reconcileAfterUnknown(signal: SignalRequest, row: BotRequest) {
  unknown(signal, row);
  for (let i = 0; i < 3; i++) {
    if (i) await wait();
    const result = await reconcileRequest(row.request_id);
    if (result.status !== 'UNKNOWN') return result;
  }
  return unknown(signal, row);
}
export async function getBotStatus(): Promise<BotStatus> {
  const limits = getBotBudgetLimits();
  const totalSpent = getTotalSpent(limits.simulationMode);
  const reserved = reservedBudget(limits.simulationMode);
  const wallet = getBotWalletConfig();
  const [m, balance, geo] = await Promise.all([
    resolveActiveMarket(),
    wallet.isConfigured && wallet.walletType === 'DEPOSIT_WALLET'
      ? getDepositCollateralBalanceUsd().then(value => ({ value, connected: true as const })).catch(() => ({ value: null, connected: false as const }))
      : Promise.resolve({ value: null, connected: false as const }),
    getPolymarketGeoStatus(),
  ]);
  return {
    redemption: getRedemptionStatus(),
    enabled: getSetting('bot.enabled'), walletAddress: wallet.address, walletType: wallet.walletType,
    isConfigured: wallet.isConfigured,
    walletBalanceUsd: balance.value,
    walletConnection: !wallet.isConfigured ? 'NOT_CONFIGURED' : wallet.walletType === 'DEPOSIT_WALLET' && balance.connected ? 'CONNECTED' : wallet.walletType === 'DEPOSIT_WALLET' ? 'ERROR' : 'CONNECTED',
    geo,
    simulationMode: limits.simulationMode,
    maxTotalBudget: limits.maxBudget, totalSpent, reservedBudget: reserved,
    pendingRequests: pendingRequests(limits.simulationMode).map(r => ({ requestId: r.request_id, state: r.state, orderId: r.order_id })),
    remainingBudget: Math.max(0, limits.maxBudget - totalSpent - reserved), perTradeAmount: limits.perTrade,
    totalTradesCount: getTradeCount(), recentTrades: getRecentTrades(5),
    activeMarket: m ? { slug: m.slug, title: m.title, bestAskUp: m.bestAskUp, bestAskDown: m.bestAskDown, minimumOrderSize: m.minimumOrderSize } : null,
  };
}
