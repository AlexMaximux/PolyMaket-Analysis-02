import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());

import { startTelegramBotListener } from '../src/lib/bot/telegramBot';
import { startRedemptionWorker } from '../src/lib/bot/redeem';
import { startForwardWorker } from '../src/lib/bot/forward';
import { initializeBotTables } from '../src/lib/bot/db';

async function main() {
  console.log(`[${new Date().toISOString()}] Initializing Polymarket Up/Down Trading Bot...`);
  initializeBotTables();

  console.log('[BOT] Starting Telegram listener and redemption worker...');
  // Redemption continues even when no Telegram token/chat is configured.
  await Promise.all([
    startTelegramBotListener().catch(() => console.error('[BOT] Telegram unavailable; redemption worker continues.')),
    startRedemptionWorker(),
    startForwardWorker(),
  ]);
}

main().catch((err) => {
  console.error('[BOT FATAL ERROR]:', err);
  process.exit(1);
});
