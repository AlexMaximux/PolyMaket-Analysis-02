import { initializeDb } from '../src/lib/db';
import { evaluateAllAlerts } from '../src/lib/alerts';
import { recordUpdownTicks } from '../src/lib/updownRecorder';
import { getSetting } from '../src/lib/settings';
import { beat } from '../src/lib/heartbeat';

/**
 * Alert worker: evaluates all enabled alert rules every 60s and pushes
 * Telegram messages for new (never-seen) whale matches.
 * Also records one Up/Down tick per coin at :05 of every minute (see updownRecorder).
 */
async function alertLoop() {
  initializeDb();
  const intervalMs = getSetting('alerts.intervalSec') * 1000;
  console.log(`Starting alert evaluation loop (every ${intervalMs / 1000}s)...`);
  while (true) {
    try {
      const r = await evaluateAllAlerts();
      if (r.sent > 0 || r.failed > 0) {
        console.log(`[${new Date().toISOString()}] alerts: evaluated=${r.evaluated} sent=${r.sent} failed=${r.failed}`);
      }
      beat('alerts', true);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] alert loop error:`, err);
      beat('alerts', false, String((err as Error)?.message ?? err));
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

// Own wall-clock schedule (5 s past each minute, after the rv60 cache refresh at :02) so slow alert
// passes or SQLite waits can't skip minutes. Gaps are permanent (no book history), so report them.
let lastGapWarn = 0;
async function tickLoop() {
  try {
    const missing = await recordUpdownTicks();
    if (missing.length && Date.now() - lastGapWarn > 600_000) {
      lastGapWarn = Date.now();
      console.warn(`[${new Date().toISOString()}] tick recorder: no data for ${missing.join(', ')} (is the :8000 server up?)`);
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] tick recorder error:`, err);
  }
  setTimeout(tickLoop, 60_000 - (Date.now() % 60_000) + 5_000);
}

alertLoop().catch(console.error);
setTimeout(tickLoop, 60_000 - (Date.now() % 60_000) + 5_000);
