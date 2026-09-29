import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());

import fs from 'fs';
import path from 'path';
import { callKevDecision, callSpanDecision, callSolarDecision } from '../src/lib/jevSnapshot';

const CONCURRENCY = 6; // 6 concurrent calls to OpenRouter
const SLEEP_BETWEEN_BATCHES_MS = 250;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function processFile(filename: string): Promise<boolean> {
  const jevHistoryDir = path.join(process.cwd(), 'jev', 'history');
  const jevDir = path.join(process.cwd(), 'jev');
  const publicHistoryDir = path.join(process.cwd(), 'public', 'jev', 'history');
  const publicJevDir = path.join(process.cwd(), 'public', 'jev');

  const filePath = path.join(jevHistoryDir, filename);
  let data: any;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err: any) {
    console.error(`Error reading ${filename}:`, err.message);
    return false;
  }

  // Check if already has kev, span and solar
  if (data.predictions?.kev && data.predictions?.span && data.predictions?.solar) {
    return true;
  }

  // Ensure snapshot has minimum required fields
  if (!data.cards) {
    // Very old legacy snapshot format without cards
    return false;
  }

  try {
    const [kevRes, spanRes, solarRes] = await Promise.allSettled([
      data.predictions?.kev ? Promise.resolve(data.predictions.kev) : callKevDecision(data),
      data.predictions?.span ? Promise.resolve(data.predictions.span) : callSpanDecision(data),
      data.predictions?.solar ? Promise.resolve(data.predictions.solar) : callSolarDecision(data),
    ]);

    const kev = kevRes.status === 'fulfilled' ? kevRes.value : null;
    const span = spanRes.status === 'fulfilled' ? spanRes.value : null;
    const solar = solarRes.status === 'fulfilled' ? solarRes.value : null;

    const jev = data.predictions?.jev || data.prediction || null;

    const votes = [jev?.direction, kev?.direction, span?.direction].filter(Boolean) as ('UP' | 'DOWN')[];
    const upVotes = votes.filter(v => v === 'UP').length;
    const downVotes = votes.filter(v => v === 'DOWN').length;
    const totalVotes = votes.length;

    let consensusDirection: 'UP' | 'DOWN' | 'SPLIT' | null = null;
    if (upVotes > downVotes) consensusDirection = 'UP';
    else if (downVotes > upVotes) consensusDirection = 'DOWN';
    else if (totalVotes > 0) consensusDirection = 'SPLIT';

    const consensus = {
      direction: consensusDirection,
      up_votes: upVotes,
      down_votes: downVotes,
      total_models: totalVotes,
      summary: totalVotes > 0 ? `${upVotes}/${totalVotes} UP (${downVotes} DOWN)` : null,
      agreement: totalVotes > 0 ? Number(((Math.max(upVotes, downVotes) / totalVotes) * 100).toFixed(0)) : null,
    };

    // Solar is stored beside the others but is not a consensus vote (see callMultiModelDecisions).
    data.predictions = {
      ...data.predictions,
      jev: jev,
      kev: kev,
      span: span,
      ...(solar ? { solar } : {}),
      consensus: consensus,
    };

    const jsonStr = JSON.stringify(data, null, 2);

    // Save back to all locations
    fs.writeFileSync(filePath, jsonStr, 'utf8');

    const inJev = path.join(jevDir, filename);
    if (fs.existsSync(inJev)) {
      try { fs.writeFileSync(inJev, jsonStr, 'utf8'); } catch {}
    }

    const inPublicHist = path.join(publicHistoryDir, filename);
    if (fs.existsSync(inPublicHist)) {
      try { fs.writeFileSync(inPublicHist, jsonStr, 'utf8'); } catch {}
    }

    const inPublicJev = path.join(publicJevDir, filename);
    if (fs.existsSync(inPublicJev)) {
      try { fs.writeFileSync(inPublicJev, jsonStr, 'utf8'); } catch {}
    }

    const kevSummary = kev ? `${kev.direction} (${kev.score})` : 'failed';
    const solarSummary = solar ? `${solar.direction} (${solar.score})` : 'failed';
    const spanSummary = span ? `${span.direction} (${span.prob_up}% UP)` : 'failed';
    console.log(`[DONE] ${filename} -> Kev: ${kevSummary} | Span: ${spanSummary} | Solar: ${solarSummary} | Consensus: ${consensus.summary}`);
    return true;
  } catch (err: any) {
    console.error(`[ERROR] Failed to enrich ${filename}:`, err.message || err);
    return false;
  }
}

async function run() {
  const args = process.argv.slice(2);
  const coinArg = args.find(a => a.startsWith('--coin='))?.split('=')[1]?.toLowerCase();
  const limitArg = args.find(a => a.startsWith('--limit='))?.split('=')[1];
  const limit = limitArg ? parseInt(limitArg, 10) : Infinity;

  const historyDir = path.join(process.cwd(), 'jev', 'history');
  if (!fs.existsSync(historyDir)) {
    console.error('jev/history does not exist');
    return;
  }

  let files = fs.readdirSync(historyDir).filter(f => f.endsWith('.json'));
  if (coinArg && coinArg !== 'all') {
    files = files.filter(f => f.toLowerCase().startsWith(coinArg + '_'));
  }

  // Sort newest first by date and time in filename
  files.sort((a, b) => {
    const getSortKey = (name: string) => {
      const match = name.match(/(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})/);
      return match ? `${match[1]}_${match[2]}` : name;
    };
    return getSortKey(b).localeCompare(getSortKey(a));
  });

  // Find candidate files needing enrichment
  const candidates: string[] = [];
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(historyDir, f), 'utf8'));
      if (!data.predictions?.kev || !data.predictions?.span || !data.predictions?.solar) {
        if (data.cards) { // only process files with market cards
          candidates.push(f);
        }
      }
    } catch {}
  }

  const toProcess = candidates.slice(0, limit);
  console.log(`\n======================================================`);
  console.log(`Found ${candidates.length} historical files needing Kev-4b, Span-01 & Solar enrichment.`);
  console.log(`Processing ${toProcess.length} files (Concurrency: ${CONCURRENCY})...`);
  console.log(`======================================================\n`);

  let completed = 0;
  let successCount = 0;

  for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
    const chunk = toProcess.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map(f => processFile(f)));
    completed += chunk.length;
    successCount += results.filter(Boolean).length;

    console.log(`Progress: ${completed}/${toProcess.length} (${((completed / toProcess.length) * 100).toFixed(1)}%) - Success: ${successCount}`);
    await sleep(SLEEP_BETWEEN_BATCHES_MS);
  }

  console.log(`\n======================================================`);
  console.log(`Enrichment complete! Successfully updated ${successCount} files.`);
  console.log(`======================================================\n`);
}

if (require.main === module) {
  run().catch(console.error);
}
