/**
 * UP/DOWN signal priced against what a trade would actually cost.
 *
 * Backtest (8 weeks of Polymarket 1H history, 2026-07-31..09-25): comparing fair values with the
 * CLOB midpoint produced ~380 alerts/day that looked +1..3¢ at the mid but lost 2..4¢ per trade once the
 * spread and the taker fee were paid. So a signal now needs BOTH fair values (15m-drift and Base) to
 * beat the executable price plus the fee by a margin, on a book tight enough to trade.
 */

/** Polymarket crypto taker fee per share (feeSchedule rate 0.07, taker only): 0.07·p·(1−p). */
export const takerFee = (p: number) => 0.07 * p * (1 - p);

export const UPDOWN_RULE = {
  maxSpread: 0.04,     // skip books wider than 4¢ (alt 1H books are often 5–10¢, HYPE ~33¢)
  minNetEdge: 0.01,    // fair − (entry + fee) must be at least 1¢
  minNotional: 20,     // $ available at the best price (alt books often show a 5-share dust quote)
};

export type UpdownSignal = {
  side: 'BUY' | 'SELL';   // BUY = buy Up at the Up ask; SELL = buy Down at 1 − Up bid
  entry: number;          // price paid per share for the bought side
  fee: number;            // taker fee per share at that price
  fair: number;           // the more conservative of the two fair values, for the bought side
  netEdge: number;        // fair − entry − fee (per share, held to expiry)
};

export function updownSignal(i: {
  fv1h: number; base: number; bid: number | null; ask: number | null; mid: number | null;
  bidSize?: number; askSize?: number;
}): UpdownSignal | null {
  const { fv1h, base, bid, ask } = i;
  if (!Number.isFinite(fv1h) || !Number.isFinite(base) || bid == null || ask == null) return null;
  if (!(bid > 0 && ask < 1 && ask > bid)) return null;                   // one-sided or crossed book
  if (ask - bid > UPDOWN_RULE.maxSpread + 1e-9) return null;
  // hollow quote: mid near 50/50 while spot has already all but decided the hour
  const mid = i.mid ?? (bid + ask) / 2;
  if (mid >= 0.4 && mid <= 0.6 && (base < 0.05 || base > 0.95)) return null;

  const lo = Math.min(fv1h, base), hi = Math.max(fv1h, base);
  const buyFee = takerFee(ask);
  const buyEdge = lo - ask - buyFee;
  if (buyEdge >= UPDOWN_RULE.minNetEdge && (i.askSize ?? 0) * ask >= UPDOWN_RULE.minNotional) {
    return { side: 'BUY', entry: ask, fee: buyFee, fair: lo, netEdge: buyEdge };
  }

  const downAsk = 1 - bid;            // buying Down fills against the Up bids
  const sellFee = takerFee(downAsk);
  const sellEdge = (1 - hi) - downAsk - sellFee;
  if (sellEdge >= UPDOWN_RULE.minNetEdge && (i.bidSize ?? 0) * downAsk >= UPDOWN_RULE.minNotional) {
    return { side: 'SELL', entry: downAsk, fee: sellFee, fair: 1 - hi, netEdge: sellEdge };
  }
  return null;
}
