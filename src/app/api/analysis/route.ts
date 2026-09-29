import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Money-flow graph between wallets.
 *
 * POST { wallets: string[] } (2..6)
 *
 * For each wallet: replay the /activity ledger (TRADE + REDEEM) per (conditionId):
 *   invested = Σ BUY usdcSize, returned = Σ SELL + Σ REDEEM usdcSize, pnl = returned − invested
 *   firstBuyTs = first BUY timestamp (who entered the market first)
 * Then pairwise edges: shared conditionIds where BOTH wallets invested > 0.
 * Edge markets include per-wallet pnl + entry timing → "who led, who followed".
 */

const MAX_WALLETS = 6;

interface MarketAgg {
  conditionId: string;
  title: string;
  slug: string;
  invested: number;
  returned: number;
  pnl: number;
  boughtShares: number;
  soldShares: number;
  redeemedShares: number;
  firstBuyTs: number;
  lastTs: number;
}

async function fetchLedger(wallet: string): Promise<any[]> {
  const rows: any[] = [];
  for (let page = 0; page < 6; page++) {
    try {
      const res = await fetch(
        `https://data-api.polymarket.com/activity?user=${wallet}&limit=500&offset=${page * 500}`
      );
      if (!res.ok) break;
      const chunk: any[] = await res.json();
      if (!Array.isArray(chunk) || chunk.length === 0) break;
      rows.push(...chunk);
      if (chunk.length < 500) break;
      await new Promise(r => setTimeout(r, 250));
    } catch {
      break;
    }
  }
  return rows.filter(r => r.type === 'TRADE' || r.type === 'REDEEM');
}

function aggregate(wallet: string, rows: any[]) {
  const markets = new Map<string, MarketAgg>();
  let firstTradeTs = 0;
  let lastTradeTs = 0;
  let buyUsd = 0;
  let sellUsd = 0;
  let redeemUsd = 0;

  for (const a of rows) {
    const cid = a.conditionId;
    if (!cid) continue;
    let m = markets.get(cid);
    if (!m) {
      m = {
        conditionId: cid,
        title: a.title || '',
        slug: a.slug || a.eventSlug || '',
        invested: 0, returned: 0, pnl: 0,
        boughtShares: 0, soldShares: 0, redeemedShares: 0,
        firstBuyTs: 0, lastTs: 0,
      };
      markets.set(cid, m);
    }
    const sz = Number(a.size) || 0;
    const usd = Number(a.usdcSize) || 0;
    const ts = Number(a.timestamp) || 0;
    if (a.type === 'TRADE' && (a.side === 'BUY' || a.side === 'SELL')) {
      if (a.side === 'BUY') {
        m.invested += usd;
        m.boughtShares += sz;
        buyUsd += usd;
        if (!m.firstBuyTs || ts < m.firstBuyTs) m.firstBuyTs = ts;
      } else {
        m.returned += usd;
        m.soldShares += sz;
        sellUsd += usd;
      }
    } else if (a.type === 'REDEEM') {
      m.returned += usd;
      m.redeemedShares += sz;
      redeemUsd += usd;
    }
    if (ts > m.lastTs) m.lastTs = ts;
    if (a.type === 'TRADE') {
      if (!firstTradeTs || ts < firstTradeTs) firstTradeTs = ts;
      if (ts > lastTradeTs) lastTradeTs = ts;
    }
  }

  const list = [...markets.values()];
  for (const m of list) m.pnl = m.returned - m.invested;

  const invested = list.reduce((s, m) => s + m.invested, 0);
  const returned = list.reduce((s, m) => s + m.returned, 0);

  return {
    wallet,
    markets: list.sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl)),
    totals: {
      markets: list.length,
      invested,
      returned,
      pnl: returned - invested,
      buyUsd,
      sellUsd,
      redeemUsd,
      firstTradeTs,
      lastTradeTs,
    },
  };
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const raw: string[] = Array.isArray(body?.wallets) ? body.wallets : [];
  const wallets = [...new Set(raw.map((w: string) => String(w).trim().toLowerCase()))]
    .filter(w => /^0x[a-f0-9]{40}$/.test(w))
    .slice(0, MAX_WALLETS);

  if (wallets.length < 2) {
    return NextResponse.json({ error: 'at least 2 valid wallet addresses required (max 6)' }, { status: 400 });
  }

  const ledgerResults = await Promise.all(wallets.map(w => fetchLedger(w)));
  const nodes = ledgerResults.map((rows, i) => aggregate(wallets[i], rows));

  // pairwise edges
  const edges: any[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      const bMarkets = new Map(b.markets.map(m => [m.conditionId, m]));
      const shared: any[] = [];
      for (const ma of a.markets) {
        const mb = bMarkets.get(ma.conditionId);
        if (!mb) continue;
        if (ma.invested <= 0 || mb.invested <= 0) continue; // both must have actually bet
        shared.push({
          conditionId: ma.conditionId,
          title: ma.title,
          slug: ma.slug || mb.slug,
          a: { invested: ma.invested, returned: ma.returned, pnl: ma.pnl, firstBuyTs: ma.firstBuyTs },
          b: { invested: mb.invested, returned: mb.returned, pnl: mb.pnl, firstBuyTs: mb.firstBuyTs },
          leader: !ma.firstBuyTs || !mb.firstBuyTs ? 'unknown'
            : ma.firstBuyTs === mb.firstBuyTs ? 'tie'
            : ma.firstBuyTs < mb.firstBuyTs ? 'a' : 'b',
        });
      }
      shared.sort((x, y) => (Math.abs(y.a.pnl) + Math.abs(y.b.pnl)) - (Math.abs(x.a.pnl) + Math.abs(x.b.pnl)));
      if (shared.length === 0) continue;
      edges.push({
        a: a.wallet,
        b: b.wallet,
        sharedMarkets: shared.length,
        aNetOnShared: shared.reduce((s, m) => s + m.a.pnl, 0),
        bNetOnShared: shared.reduce((s, m) => s + m.b.pnl, 0),
        combinedVolume:
          shared.reduce((s, m) => s + m.a.invested + m.a.returned, 0) +
          shared.reduce((s, m) => s + m.b.invested + m.b.returned, 0),
        markets: shared,
      });
    }
  }

  edges.sort((x, y) => y.sharedMarkets - x.sharedMarkets || y.combinedVolume - x.combinedVolume);
  return NextResponse.json({ nodes, edges });
}
