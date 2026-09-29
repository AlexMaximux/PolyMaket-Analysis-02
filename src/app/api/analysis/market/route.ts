import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * POST { walletA, walletB, conditionId } -> per-trade rows for both wallets on that market,
 * newest first: { wallet, side, size, price, usdcSize, timestamp, type }.
 * Used by the flow-graph edge drill-down.
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const conditionId = String(body?.conditionId || '');
  const walletA = String(body?.walletA || '').trim().toLowerCase();
  const walletB = String(body?.walletB || '').trim().toLowerCase();
  if (!conditionId || !/^0x[a-f0-9]{40}$/.test(walletA) || !/^0x[a-f0-9]{40}$/.test(walletB)) {
    return NextResponse.json({ error: 'walletA, walletB, conditionId required' }, { status: 400 });
  }

  async function ledger(wallet: string) {
    const rows: any[] = [];
    for (let page = 0; page < 6; page++) {
      try {
        const res = await fetch(`https://data-api.polymarket.com/activity?user=${wallet}&limit=500&offset=${page * 500}`);
        if (!res.ok) break;
        const chunk: any[] = await res.json();
        if (!Array.isArray(chunk) || chunk.length === 0) break;
        rows.push(...chunk);
        if (chunk.length < 500) break;
      } catch { break; }
    }
    return rows
      .filter(r => r.conditionId === conditionId && (r.type === 'TRADE' || r.type === 'REDEEM'))
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .map(r => ({
        type: r.type,
        side: r.side || '',
        outcome: r.outcome || '',
        size: Number(r.size) || 0,
        price: Number(r.price) || 0,
        usdcSize: Number(r.usdcSize) || 0,
        timestamp: Number(r.timestamp) || 0,
        title: r.title || '',
      }));
  }

  const [aRows, bRows] = await Promise.all([ledger(walletA), ledger(walletB)]);
  return NextResponse.json({ conditionId, a: aRows, b: bRows });
}
