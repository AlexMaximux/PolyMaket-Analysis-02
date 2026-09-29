import type { getRedemptionStatus } from './redeem';
export type TradeOutcome = 'UP' | 'DOWN';

export interface SignalRequest {
  symbol: string;        // e.g. "BTCUPDOW" or "BTC"
  timeframe: string;     // only "1H"
  outcome: TradeOutcome; // "UP" | "DOWN"
  forwardArmedAt?: number;
  expiresAt?: number;
  expectedMarketSlug?: string; // pins automated signals to their original market
  amountUsd?: number;    // legacy input ignored; always uses configured fixed amount
  requestId?: string;    // required stable ID, reused when retrying the same signal
  source?: 'telegram' | 'api' | 'signal' | 'manual';
}

export interface ActiveMarketInfo {
  slug: string;
  title: string;
  coin: string;
  timeframe: string;
  endDate: string;
  acceptingOrders: boolean;
  closed: boolean;
  tokenUp: string;
  tokenDown: string;
  bestAskUp: number | null;
  bestBidUp: number | null;
  bestAskDown: number | null;
  bestBidDown: number | null;
  selectedTokenId: string;
  selectedBestAsk: number | null;
  minimumOrderSize: number | null;
}

export interface TradeResult {
  success: boolean;
  requestId?: string;
  status?: 'PENDING' | 'UNKNOWN' | 'FILLED' | 'SIMULATED' | 'FAILED';
  attempts?: number;
  simulated: boolean;
  orderId?: string;
  txHash?: string;
  symbol: string;
  timeframe: string;
  outcome: TradeOutcome;
  slug?: string;
  tokenId?: string;
  amountUsd: number;
  shares?: number;
  price?: number;
  totalSpentAfter: number;
  maxBudget: number;
  remainingBudget: number;
  error?: string;
  timestamp: number;
}

export interface BotStatus {
  forward?: { enabled: boolean; strategy: string; lastScan: number | null; lastError: string | null };
  notifications?: { pending: number; failed: number };
  redemption: ReturnType<typeof getRedemptionStatus>;
  enabled: boolean;
  walletAddress: string | null;
  walletType: 'EOA' | 'POLY_PROXY' | 'POLY_GNOSIS_SAFE' | 'DEPOSIT_WALLET';
  isConfigured: boolean;
  walletBalanceUsd: number | null;
  walletConnection: 'CONNECTED' | 'ERROR' | 'NOT_CONFIGURED';
  geo: import('./geo').PolymarketGeoStatus;
  simulationMode: boolean;
  maxTotalBudget: number;
  totalSpent: number;
  reservedBudget: number;
  pendingRequests: { requestId: string; state: string; orderId: string | null }[];
  remainingBudget: number;
  perTradeAmount: number;
  totalTradesCount: number;
  recentTrades: TradeRecord[];
  activeMarket?: {
    slug: string;
    title: string;
    bestAskUp: number | null;
    bestAskDown: number | null;
    minimumOrderSize: number | null;
  } | null;
}

export interface TradeRecord {
  id: number;
  timestamp: number;
  symbol: string;
  timeframe: string;
  outcome: TradeOutcome;
  slug: string;
  token_id: string;
  amount_usd: number;
  shares: number | null;
  price: number | null;
  status: 'FILLED' | 'SIMULATED' | 'FAILED';
  order_id: string | null;
  tx_hash: string | null;
  source: string;
  error_message: string | null;
}
