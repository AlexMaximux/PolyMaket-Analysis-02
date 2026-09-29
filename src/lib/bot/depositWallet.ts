import { createSecureClient, WalletType, type SignedOrder } from '@polymarket/client';
import { createBuilderApiKey } from '@polymarket/client/actions';
import { fetchBalanceAllowance } from '@polymarket/client/actions';
import { AssetType } from '@polymarket/bindings/clob';
import { builderApiKey } from '@polymarket/client/node';
import { privateKey } from '@polymarket/client/viem';
import { hashTypedData, http } from 'viem';
import { polygon } from 'viem/chains';
import { applySettingChanges, getSetting } from '../settings';
import { getBotWalletConfig } from './live';

export class DepositWalletError extends Error {}

function savedBuilderCredentials() {
  const key = getSetting('bot.builderApiKey');
  const secret = getSetting('bot.builderSecret');
  const passphrase = getSetting('bot.builderPassphrase');
  return key && secret && passphrase ? { key, secret, passphrase } : null;
}

/** Authenticate A as the owner/signer of the configured Polymarket Deposit Wallet B. */
export async function createDepositWalletClient(options: { provisionBuilder?: boolean } = {}) {
  const cfg = getBotWalletConfig();
  if (cfg.walletType !== 'DEPOSIT_WALLET' || !cfg.isConfigured || !cfg.address || !cfg.signerAddress) {
    throw new DepositWalletError('نوع کیف پول باید DEPOSIT_WALLET و آدرس B تنظیم شده باشد.');
  }
  const signer = privateKey(cfg.privateKey, {
    chain: polygon,
    transport: http(getSetting('bot.rpcUrl') || 'https://polygon-rpc.com', { timeout: 15_000, retryCount: 0 }),
  });
  const existingBuilder = savedBuilderCredentials();
  let client = await createSecureClient({
    signer,
    wallet: cfg.address,
    ...(existingBuilder ? { apiKey: builderApiKey(existingBuilder) } : {}),
  });
  if (client.account.walletType !== WalletType.DEPOSIT_WALLET ||
      client.account.signer.toLowerCase() !== cfg.signerAddress.toLowerCase() ||
      client.account.wallet.toLowerCase() !== cfg.address.toLowerCase()) {
    throw new DepositWalletError('پلی‌مارکت مالکیت A روی Deposit Wallet انتخاب‌شده را تأیید نکرد.');
  }
  if (!existingBuilder && options.provisionBuilder) {
    const created = await createBuilderApiKey(client);
    const saved = applySettingChanges({
      'bot.builderApiKey': created.key,
      'bot.builderSecret': created.secret,
      'bot.builderPassphrase': created.passphrase,
    });
    if (!saved.ok) throw new DepositWalletError('ذخیرهٔ رمزگذاری‌شدهٔ مجوز Gasless ناموفق بود.');
    client = await createSecureClient({
      signer,
      wallet: cfg.address,
      credentials: client.credentials,
      apiKey: builderApiKey(created),
    });
  }
  return { client, builderReady: Boolean(existingBuilder || options.provisionBuilder) };
}

const ORDER_TYPES = {
  Order: [
    { name: 'salt', type: 'uint256' }, { name: 'maker', type: 'address' },
    { name: 'signer', type: 'address' }, { name: 'tokenId', type: 'uint256' },
    { name: 'makerAmount', type: 'uint256' }, { name: 'takerAmount', type: 'uint256' },
    { name: 'side', type: 'uint8' }, { name: 'signatureType', type: 'uint8' },
    { name: 'timestamp', type: 'uint256' }, { name: 'metadata', type: 'bytes32' },
    { name: 'builder', type: 'bytes32' },
  ],
} as const;
const EXCHANGE_V2 = '0xE111180000d2663C0091e4f400237545B87B996B' as const;
const NEG_RISK_EXCHANGE_V2 = '0xe2222d279d744050d28e00520010520000310F59' as const;
const EXCHANGE_V3 = '0xe3333700cA9d93003F00f0F71f8515005F6c00Aa' as const;

/** Deterministic CLOB order ID, persisted before POST for crash-safe reconciliation. */
export function depositOrderHash(order: SignedOrder, negRisk: boolean) {
  const v2 = order.tokenId.startsWith('0x');
  const verifyingContract = v2 ? EXCHANGE_V3 : negRisk ? NEG_RISK_EXCHANGE_V2 : EXCHANGE_V2;
  return hashTypedData({
    domain: { name: 'Polymarket CTF Exchange', version: v2 ? '3' : '2', chainId: 137, verifyingContract },
    primaryType: 'Order',
    types: ORDER_TYPES,
    message: {
      salt: BigInt(order.salt), maker: order.maker, signer: order.signer, tokenId: BigInt(order.tokenId),
      makerAmount: BigInt(order.makerAmount), takerAmount: BigInt(order.takerAmount),
      side: order.side === 'BUY' ? 0 : 1, signatureType: order.signatureType,
      timestamp: BigInt(order.timestamp), metadata: order.metadata, builder: order.builder,
    },
  });
}

export async function ensureDepositTradingApprovals(client: Awaited<ReturnType<typeof createSecureClient>>) {
  const before = await client.fetchTradingApprovalsState();
  if (!before.isFullyApproved) await client.setupTradingApprovals();
  const after = before.isFullyApproved ? before : await client.fetchTradingApprovalsState();
  if (!after.isFullyApproved) throw new DepositWalletError('مجوزهای لازم برای معامله در Deposit Wallet کامل نشد.');
  return { changed: !before.isFullyApproved };
}

/** Read the CLOB collateral balance for the configured Polymarket wallet (6 decimals). */
export async function getDepositCollateralBalanceUsd() {
  const { client } = await createDepositWalletClient();
  const result = await fetchBalanceAllowance(client, { assetType: AssetType.COLLATERAL });
  const raw = BigInt(result.balance);
  return Number(raw) / 1_000_000;
}
