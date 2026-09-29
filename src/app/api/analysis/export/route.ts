import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * POST { walletA, walletB, markets: EdgeMarket[] , format: 'csv' | 'pdf' }
 * Returns a downloadable file with the FULL shared-market trade ledger between the two wallets.
 * CSV: one row per trade/redeem. PDF: minimal print-ready report (hand-rolled, no deps).
 */

interface Row {
  type: string; side: string; outcome: string; size: number; price: number;
  usdcSize: number; timestamp: number; title: string; conditionId?: string;
}

const short = (w: string) => w.slice(0, 6) + '\u2026' + w.slice(-4);

async function ledgerForMarket(wallet: string, conditionId: string): Promise<Row[]> {
  const rows: Row[] = [];
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
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
    .map(r => ({
      type: r.type, side: r.side || '', outcome: r.outcome || '',
      size: Number(r.size) || 0, price: Number(r.price) || 0,
      usdcSize: Number(r.usdcSize) || 0, timestamp: Number(r.timestamp) || 0,
      title: r.title || '',
    }));
}

function csvEscape(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function esc(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function buildPdf(title: string, sections: { header: string; rows: Row[] }[], meta: string[]): Uint8Array {
  const pages: string[][] = [];
  // Simple flowing layout: landscape-ish A4 (842x595)
  const PAGE_W = 842, PAGE_H = 595, M = 36;
  let y = PAGE_H - M;
  let pageOps: string[] = [];
  const objects: string[] = [];

  const money = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

  function ensure(h: number) {
    if (y - h < M) { pages.push(pageOps); pageOps = []; y = PAGE_H - M; }
  }
  function text(x: number, yy: number, size: number, font: 'F1' | 'F2' | 'F3', s: string, gray = 0) {
    const g = gray.toFixed(2);
    pageOps.push(`BT /${font} ${size} Tf ${g} ${g} ${g} rg ${x} ${yy} Td (${s.replace(/([()\\])/g, '\\$1')}) Tj ET`);
  }

  // header block
  text(M, y, 16, 'F2', esc(title.slice(0, 80)), 0); y -= 20;
  meta.forEach(m => { text(M, y, 9, 'F1', esc(m), 0.35); y -= 12; });
  y -= 8;

  for (const sec of sections) {
    ensure(40);
    text(M, y, 11, 'F2', esc(sec.header.slice(0, 90)), 0.1); y -= 14;
    text(M, y, 8, 'F1', 'Date (UTC)        Action   Outcome            Shares       Price   Amount (USDC)', 0.45); y -= 12;
    for (const r of sec.rows) {
      ensure(12);
      const date = new Date(r.timestamp * 1000).toISOString().slice(0, 16).replace('T', ' ');
      const act = r.type === 'REDEEM' ? 'REDEEM ' : (r.side || '').padEnd(6);
      const line = `${date}  ${act} ${(r.outcome || '').slice(0, 18).padEnd(18)} ${Math.round(r.size).toLocaleString('en-US').padStart(10)}  ${(r.price * 100).toFixed(1).padStart(5)}%  ${money(r.usdcSize).padStart(12)}`;
      const isRedeem = r.type === 'REDEEM';
      text(M, y, 8, 'F1', esc(line), isRedeem ? 0.25 : 0);
      y -= 11;
    }
    y -= 10;
  }
  pages.push(pageOps);

  // build PDF objects
  const n = pages.length;
  // 1 catalog, 2 pages tree, 3 font F1, 4 font F2, then per page: page obj + content obj
  const kids = pages.map((_, i) => `${5 + i * 2} 0 R`).join(' ');
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`;
  objects[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>`;
  objects[4] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>`;
  pages.forEach((ops, i) => {
    const pageObj = 5 + i * 2, contObj = pageObj + 1;
    const content = ops.join('\n');
    objects[pageObj] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contObj} 0 R >>`;
    objects[contObj] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = pdf.length;
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++) {
    pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const walletA = String(body?.walletA || '').trim().toLowerCase();
  const walletB = String(body?.walletB || '').trim().toLowerCase();
  const markets: any[] = Array.isArray(body?.markets) ? body.markets : [];
  const format = body?.format === 'pdf' ? 'pdf' : 'csv';
  if (!markets.length || !/^0x[a-f0-9]{40}$/.test(walletA) || !/^0x[a-f0-9]{40}$/.test(walletB)) {
    return NextResponse.json({ error: 'walletA, walletB and markets required' }, { status: 400 });
  }

  // fetch full ledgers once per wallet, filter per market (avoids duplicate pagination per market)
  const [ledgerA, ledgerB] = await Promise.all([
    (async () => {
      const rows: any[] = [];
      for (let page = 0; page < 6; page++) {
        const res = await fetch(`https://data-api.polymarket.com/activity?user=${walletA}&limit=500&offset=${page * 500}`);
        if (!res.ok) break;
        const chunk: any[] = await res.json();
        if (!Array.isArray(chunk) || chunk.length === 0) break;
        rows.push(...chunk);
        if (chunk.length < 500) break;
      }
      return rows.filter(r => r.type === 'TRADE' || r.type === 'REDEEM');
    })(),
    (async () => {
      const rows: any[] = [];
      for (let page = 0; page < 6; page++) {
        const res = await fetch(`https://data-api.polymarket.com/activity?user=${walletB}&limit=500&offset=${page * 500}`);
        if (!res.ok) break;
        const chunk: any[] = await res.json();
        if (!Array.isArray(chunk) || chunk.length === 0) break;
        rows.push(...chunk);
        if (chunk.length < 500) break;
      }
      return rows.filter(r => r.type === 'TRADE' || r.type === 'REDEEM');
    })(),
  ]);

  const want = new Set(markets.map(m => m.conditionId));
  const sections: { header: string; rows: Row[] }[] = [];
  const csvRows: string[] = [];

  const csvHeader = 'wallet,market,date_utc,action,outcome,shares,price_pct,amount_usdc,condition_id';
  csvRows.push(csvHeader);

  for (const m of markets) {
    if (!want.has(m.conditionId)) continue;
    const pick = (rows: any[], wallet: string): Row[] =>
      rows.filter(r => r.conditionId === m.conditionId)
        .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
        .map(r => ({
          type: r.type, side: r.side || '', outcome: r.outcome || '',
          size: Number(r.size) || 0, price: Number(r.price) || 0,
          usdcSize: Number(r.usdcSize) || 0, timestamp: Number(r.timestamp) || 0,
          title: r.title || '',
        }));
    const aRows = pick(ledgerA, walletA);
    const bRows = pick(ledgerB, walletB);
    const title = m.title || m.conditionId.slice(0, 20);

    sections.push({ header: `${short(walletA)} — ${title}`, rows: aRows });
    sections.push({ header: `${short(walletB)} — ${title}`, rows: bRows });

    for (const [w, rows] of [[short(walletA), aRows], [short(walletB), bRows]] as const) {
      for (const r of rows) {
        csvRows.push([
          w, csvEscape(title),
          new Date(r.timestamp * 1000).toISOString().replace('T', ' ').slice(0, 16),
          r.type === 'REDEEM' ? 'REDEEM' : r.side,
          r.outcome, r.size.toFixed(2), (r.price * 100).toFixed(1), r.usdcSize.toFixed(2), m.conditionId,
        ].map(csvEscape).join(','));
      }
    }
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const fname = `flow-${short(walletA).replace('…', '-')}-${short(walletB).replace('…', '-')}-${stamp}`;

  if (format === 'csv') {
    return new NextResponse(csvRows.join('\n'), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${fname}.csv"`,
      },
    });
  }

  const meta = [
    `Wallet A: ${walletA}`,
    `Wallet B: ${walletB}`,
    `Shared markets: ${markets.length} · generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    `Source: Polymarket on-chain activity ledger (buys / sells / redeems)`,
  ];
  const pdfBytes = buildPdf(`Polymarket shared-market report`, sections, meta);
  return new NextResponse(pdfBytes as any, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${fname}.pdf"`,
    },
  });
}
