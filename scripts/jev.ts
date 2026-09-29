import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());

import {
  generateJevSnapshot,
  callJevDecision,
  callMultiModelDecisions,
  saveHistoricalJevRecord,
  getLatestHistoricalFile,
} from '../src/lib/jevSnapshot';
import { initializeAlertTracker } from '../src/lib/jevAlerts';
import { updateMarketResolutions } from '../src/lib/marketResolver';
import { getSetting } from '../src/lib/settings';
import { beat } from '../src/lib/heartbeat';

const SNAPSHOT_INTERVAL_MS = getSetting('jev.snapshotIntervalSec') * 1000; // live cache refresh (default 30s)
const JEV_RECORD_INTERVAL_MS = getSetting('jev.recordIntervalSec') * 1000; // multi-model record (default 5 min)
const RESOLUTION_CHECK_INTERVAL_MS = 90000; // 90s market resolution checker (handles 10-30m UMA lag)

let lastResolutionCheckTime = 0;

const SUPPORTED_COINS: string[] = getSetting('jev.coins');

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function startLoop() {
  console.log(
    `[${new Date().toISOString()}] Starting Multi-Coin Multi-Model (Jev, Kev-4b, Span-01) 5-Minute Historical Collector & 30s Worker for: ${SUPPORTED_COINS.map(c => c.toUpperCase()).join(', ')}...`
  );

  // Initialize Telegram alert tracker with existing files so no duplicate spam occurs
  initializeAlertTracker();

  const runCoinRecord = async (coin: string) => {
    try {
      const latest = getLatestHistoricalFile(coin);
      if (latest) {
        const elapsed = Date.now() - latest.timestamp;
        if (elapsed < JEV_RECORD_INTERVAL_MS * 0.8) {
          // Less than 80% of the record interval since last file for this coin
          return;
        }
      }

      console.log(`[${new Date().toISOString()}] [${coin.toUpperCase()}] Fetching fresh snapshot...`);
      const snapshot = await generateJevSnapshot(coin);
      console.log(`[${new Date().toISOString()}] [${coin.toUpperCase()}] Querying OpenRouter models (Jev, Kev-4b, Span-01)...`);
      const multi = await callMultiModelDecisions(snapshot);
      const { filename, skippedDuplicate } = saveHistoricalJevRecord(snapshot, multi);
      if (!skippedDuplicate) {
        const jevDir = multi.jev ? `${multi.jev.direction} (${multi.jev.score})` : 'N/A';
        const kevDir = multi.kev ? `${multi.kev.direction} (${multi.kev.score})` : 'N/A';
        const spanDir = multi.span ? `${multi.span.direction} (${multi.span.score != null ? multi.span.score.toFixed(2) : 'N/A'})` : 'N/A';
        console.log(
          `[${new Date().toISOString()}] 💾 SAVED 5-MIN MULTI-MODEL RECORD -> ${filename} | Consensus: ${multi.consensus?.summary || 'N/A'} | Jev: ${jevDir} | Kev: ${kevDir} | Span: ${spanDir}`
        );
      }
    } catch (err: any) {
      console.error(`[${new Date().toISOString()}] [${coin.toUpperCase()}] Error in 5-min multi-model record:`, err.message || err);
    }
  };

  const runAllDueCoins = async () => {
    for (const coin of SUPPORTED_COINS) {
      const latest = getLatestHistoricalFile(coin);
      const elapsed = latest ? Date.now() - latest.timestamp : Infinity;
      if (elapsed >= JEV_RECORD_INTERVAL_MS) {
        await runCoinRecord(coin);
        await sleep(1500); // Gentle pause between OpenRouter calls
      }
    }
  };

  const run30sUpdate = async () => {
    try {
      // 1. Refresh live snapshot cache for all coins
      for (const coin of SUPPORTED_COINS) {
        try {
          await generateJevSnapshot(coin);
        } catch {}
      }

      // 2. Check and collect for any coin that is due for 5-minute file
      await runAllDueCoins();

      // 3. Automatically check and update market outcomes (Polymarket 10-30m UMA resolution)
      const timeSinceLastResCheck = Date.now() - lastResolutionCheckTime;
      if (timeSinceLastResCheck >= RESOLUTION_CHECK_INTERVAL_MS) {
        lastResolutionCheckTime = Date.now();
        await updateMarketResolutions();
      }

      const latestBtc = getLatestHistoricalFile('btc');
      const btcElapsed = latestBtc ? Date.now() - latestBtc.timestamp : 0;
      const nextSec = Math.max(0, Math.round((JEV_RECORD_INTERVAL_MS - btcElapsed) / 1000));
      console.log(
        `[${new Date().toISOString()}] Multi-coin JEV live cache refreshed (all ${SUPPORTED_COINS.length} coins) -> next check cycle in ${nextSec}s`
      );
      beat('jev', true);
    } catch (err: any) {
      console.error(`[${new Date().toISOString()}] 30s update error:`, err.message || err);
      beat('jev', false, err.message || String(err));
    }
  };

  // On start: run for any coin that has no record within the last 5 minutes
  console.log(`[${new Date().toISOString()}] Initializing startup check for all coins...`);
  await runAllDueCoins();

  // Run initial market resolution check immediately on startup
  console.log(`[${new Date().toISOString()}] Initializing market resolutions check...`);
  lastResolutionCheckTime = Date.now();
  await updateMarketResolutions(true);

  // Run the 30s cycle
  setInterval(run30sUpdate, SNAPSHOT_INTERVAL_MS);
}

if (require.main === module) {
  startLoop().catch(console.error);
}
