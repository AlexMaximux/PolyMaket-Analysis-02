import { getBotWalletConfig } from './live';
import { getDepositCollateralBalanceUsd } from './depositWallet';

// The read must never hold an order back for long: past this the line says the balance is unknown and the order goes on.
export const BALANCE_READ_TIMEOUT_MS = 3_000;

/**
 * First line of the Telegram message sent when an order is about to be made: the wallet's USDC balance on Polymarket,
 * read just before the order. Empty when no balance can be read for this wallet (not set up, or not a Deposit Wallet,
 * the only type the bot reads a balance for), so those messages stay as they were. A failed or slow read gives a line
 * that says so instead of a number, and never throws.
 */
export async function walletBalanceLine(
  read: () => Promise<number> = getDepositCollateralBalanceUsd,
  timeoutMs = BALANCE_READ_TIMEOUT_MS,
): Promise<string> {
  try {
    const wallet = getBotWalletConfig();
    if (!wallet.isConfigured || wallet.walletType !== 'DEPOSIT_WALLET') return '';
  } catch {
    return '';
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const usd = await Promise.race([
      read(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('balance read timed out')), timeoutMs); }),
    ]);
    if (!Number.isFinite(usd)) throw new Error('balance is not a number');
    return `💼 موجودی کیف پول قبل از سفارش: $${usd.toFixed(2)}`;
  } catch {
    return '💼 موجودی کیف پول قبل از سفارش: نامشخص (خواندن ممکن نشد)';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The line, then a blank line, then the message; the message alone when there is no line. */
export const withBalanceLine = (line: string, message: string) => (line ? `${line}\n\n${message}` : message);
