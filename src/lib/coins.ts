/** Coins the Jev collector and /api/jev/predict support. */
export const JEV_COINS = ['btc', 'eth', 'sol', 'xrp', 'doge', 'hype', 'bnb'] as const;
export type JevCoin = (typeof JEV_COINS)[number];

export function isJevCoin(c: string): c is JevCoin {
  return (JEV_COINS as readonly string[]).includes(c);
}
