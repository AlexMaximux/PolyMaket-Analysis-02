import { ClobClient, ExchangeOrderBuilder, SignatureType, getContractConfig, type SignedOrder } from '@polymarket/clob-client';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { getSetting } from '../settings';

export const CLOB_HOST = 'https://clob.polymarket.com';
export function getBotWalletConfig() {
  const privateKey = getSetting('bot.privateKey');
  const walletType = getSetting('bot.walletType');
  const proxyAddress = getSetting('bot.proxyAddress');
  let address: string | null = null;
  let signerAddress: string | null = null;
  try {
    if (privateKey) {
      signerAddress = privateKeyToAccount((privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as `0x${string}`).address;
      address = walletType === 'EOA' ? signerAddress : proxyAddress || null;
    }
  } catch { /* invalid keys must fail closed */ }
  return { privateKey, walletType, proxyAddress, address, signerAddress, isConfigured: !!address };
}
export function walletIdentity(): string {
  const w = getBotWalletConfig();
  return `${w.walletType}:${w.signerAddress}:${w.address}`;
}
export async function createLiveClient() {
  const w = getBotWalletConfig();
  if (!w.isConfigured) throw new Error('کیف پول معتبر تنظیم نشده است.');
  const account = privateKeyToAccount((w.privateKey.startsWith('0x') ? w.privateKey : `0x${w.privateKey}`) as `0x${string}`);
  const wallet = createWalletClient({ account, chain: polygon, transport: http(getSetting('bot.rpcUrl') || 'https://polygon-rpc.com') });
  const sig = w.walletType === 'EOA' ? SignatureType.EOA : w.walletType === 'POLY_PROXY' ? SignatureType.POLY_PROXY : SignatureType.POLY_GNOSIS_SAFE;
  const funder = w.walletType === 'EOA' ? undefined : w.proxyAddress;
  const base = new ClobClient(CLOB_HOST, 137, wallet, undefined, sig, funder);
  const key = process.env.POLYMARKET_API_KEY?.trim();
  const secret = process.env.POLYMARKET_API_SECRET?.trim();
  const passphrase = process.env.POLYMARKET_PASSPHRASE?.trim();
  const creds = key && secret && passphrase ? { key, secret, passphrase } : await base.createOrDeriveApiKey();
  if (!creds?.key || !creds.secret || !creds.passphrase) throw new Error('ساخت اعتبارنامهٔ CLOB ناموفق بود.');
  // SDK automatic POST retry remains disabled; our ledger controls all retries.
  const client = new ClobClient(CLOB_HOST, 137, wallet, creds, sig, funder);
  return {
    client,
    orderHash(order: SignedOrder, negRisk: boolean) {
      const config = getContractConfig(137);
      const builder = new ExchangeOrderBuilder(negRisk ? config.negRiskExchange : config.exchange, 137, wallet);
      return builder.buildOrderHash(builder.buildOrderTypedData(order));
    },
  };
}
