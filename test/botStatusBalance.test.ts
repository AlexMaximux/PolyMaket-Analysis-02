import { describe, it, expect } from 'vitest';
import { statusBalanceLine } from '../src/lib/bot/telegramBot';

const base = { walletType: 'DEPOSIT_WALLET' as const, walletConnection: 'CONNECTED' as const, walletBalanceUsd: 123.456 };

describe('statusBalanceLine (/status wallet balance)', () => {
  it('shows the USDC balance for a connected Deposit Wallet', () => {
    expect(statusBalanceLine(base)).toContain('$123.46');
  });
  it('shows zero, not unknown, for an empty wallet', () => {
    expect(statusBalanceLine({ ...base, walletBalanceUsd: 0 })).toContain('$0.00');
  });
  it('says unknown when the read failed', () => {
    expect(statusBalanceLine({ ...base, walletConnection: 'ERROR', walletBalanceUsd: null })).toContain('نامشخص');
  });
  it('says unknown when connected but no number came back', () => {
    expect(statusBalanceLine({ ...base, walletBalanceUsd: null })).toContain('نامشخص');
  });
  it('has no number when the wallet is not set up', () => {
    expect(statusBalanceLine({ ...base, walletConnection: 'NOT_CONFIGURED', walletBalanceUsd: null })).not.toMatch(/\$\d/);
  });
  it('says the balance is not read for other wallet types', () => {
    expect(statusBalanceLine({ ...base, walletType: 'EOA', walletBalanceUsd: null })).toContain('خوانده نمی‌شود');
  });
});
