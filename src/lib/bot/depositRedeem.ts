import { fetchTransaction } from '@polymarket/client/actions';
import { createDepositWalletClient, DepositWalletError } from './depositWallet';
import {
  finishGaslessRedemption, saveGaslessRedemption, updateGaslessHash, type Redemption,
} from './redeemDb';

type DepositInspection =
  | { state: 'WAITING' | 'LOSER' | 'EMPTY' }
  | { state: 'WINNER'; conditionId: string };

const list = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string') return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.map(String) : []; }
  catch { return []; }
};

/** Resolve the exact ledger token against Gamma and confirm the wallet still holds only this bot's inventory. */
export async function inspectDepositRedemption(row: Redemption): Promise<DepositInspection> {
  const response = await fetch(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(row.slug)}`, {
    cache: 'no-store', signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new DepositWalletError('دریافت مشخصات بازار برای Redeem ناموفق بود.');
  const events = await response.json();
  const event = Array.isArray(events) ? events.find(e => e?.slug === row.slug) : null;
  const market = event?.markets?.find((m: { clobTokenIds?: unknown }) => list(m.clobTokenIds).includes(row.token_id));
  if (!market || !/^0x[0-9a-fA-F]{62,64}$/.test(String(market.conditionId))) {
    throw new DepositWalletError('توکن خرید با بازار و condition معتبر پلی‌مارکت تطابق ندارد.');
  }
  const tokens = list(market.clobTokenIds);
  const outcomes = list(market.outcomes);
  const prices = list(market.outcomePrices).map(Number);
  const index = tokens.indexOf(row.token_id);
  if (tokens.length !== 2 || outcomes.length !== 2 || index < 0 ||
      outcomes.map((x: string) => x.toLowerCase()).sort().join(',') !== 'down,up') {
    throw new DepositWalletError('بازار Redeem باید همان بازار دودویی BTC Up/Down باشد.');
  }
  if (!market.closed || prices.length !== 2 || !prices.every((p: number) => p === 0 || p === 1)) return { state: 'WAITING' };
  if (prices[index] !== 1) return { state: 'LOSER' };

  const positionsResponse = await fetch(
    `https://data-api.polymarket.com/positions?user=${encodeURIComponent(row.holder)}&asset=${encodeURIComponent(row.token_id)}`,
    { cache: 'no-store', signal: AbortSignal.timeout(10_000) },
  );
  if (!positionsResponse.ok) throw new DepositWalletError('بررسی موجودی برنده در Data API ناموفق بود.');
  const positions = await positionsResponse.json();
  const position = Array.isArray(positions) ? positions.find(p => String(p?.asset) === row.token_id) : null;
  const size = Number(position?.size ?? 0);
  if (!Number.isFinite(size) || size <= 0) return { state: 'EMPTY' };
  if (size > row.shares + 0.00001) {
    throw new DepositWalletError('موجودی این سهم بیشتر از خریدهای ثبت‌شدهٔ بات است؛ Redeem خودکار برای محافظت از دارایی دیگر متوقف شد.');
  }
  if (position?.redeemable !== true) return { state: 'WAITING' };
  return { state: 'WINNER', conditionId: String(market.conditionId) };
}

export async function submitDepositRedemption(row: Redemption, conditionId: string) {
  const { client, builderReady } = await createDepositWalletClient({ provisionBuilder: true });
  if (!builderReady) throw new DepositWalletError('مجوز Gasless آماده نیست.');
  const handle = await client.redeemPositions({ conditionId: conditionId as `0x${string}` });
  const submitted = saveGaslessRedemption(row, conditionId, String(handle.transactionId), handle.transactionHash);
  try {
    const outcome = await handle.wait();
    updateGaslessHash(submitted, outcome.transactionHash);
    finishGaslessRedemption({ ...submitted, tx_hash: outcome.transactionHash }, 'CONFIRMED', String(row.shares), null);
  } catch {
    // The durable transaction ID is polled on the next cycle; never submit a replacement here.
  }
}

export async function reconcileDepositRedemption(row: Redemption) {
  if (!row.tx_id) throw new DepositWalletError('شناسهٔ تراکنش Gasless ذخیره نشده است؛ بررسی دستی لازم است.');
  const { client } = await createDepositWalletClient();
  const tx = await fetchTransaction(client, { transactionId: row.tx_id });
  updateGaslessHash(row, tx.transactionHash);
  if (tx.state === 'STATE_CONFIRMED') {
    finishGaslessRedemption(row, 'CONFIRMED', String(row.shares), null);
  } else if (tx.state === 'STATE_FAILED' || tx.state === 'STATE_INVALID') {
    finishGaslessRedemption(row, 'FAILED', null, tx.errorMsg || 'تراکنش Gasless Redeem ناموفق شد.');
  }
}
