import {
  createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData, decodeFunctionResult,
  decodeEventLog, keccak256, getCreate2Address, encodePacked, concat, pad, zeroAddress, zeroHash,
  formatEther, formatUnits, parseEther, type Address, type Hex, type TransactionReceipt,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { getBotWalletConfig } from './live';
import { getSetting } from '../settings';
import type { Redemption } from './redeemDb';

// This project's CLOB v5 stack uses USDC.e-backed standard CTF positions. Never use a
// neg-risk/deposit-wallet fallback. See docs/trading-bot.md for contract sources and scope.
export const CTF = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045' as const;
export const USDCE = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' as const;
export const PROXY_FACTORY = '0xaB45c5A4B0c941a2F231C04C3f49182e1A254052' as const;
const PROXY_INIT_HASH = '0xd21df8dc65880a8606f09fe0ce3df9b8869287ab0b058be05aa9e8af6330a00b' as const;
export const CTF_ABI = parseAbi([
  'function payoutDenominator(bytes32) view returns (uint256)',
  'function payoutNumerators(bytes32,uint256) view returns (uint256)',
  'function getOutcomeSlotCount(bytes32) view returns (uint256)',
  'function getCollectionId(bytes32,bytes32,uint256) view returns (bytes32)',
  'function getPositionId(address,bytes32) pure returns (uint256)',
  'function balanceOf(address,uint256) view returns (uint256)',
  'function redeemPositions(address,bytes32,bytes32,uint256[])',
  'event PayoutRedemption(address indexed redeemer,address indexed collateralToken,bytes32 indexed parentCollectionId,bytes32 conditionId,uint256[] indexSets,uint256 payout)',
]);
const SAFE_ABI = parseAbi([
  'function getThreshold() view returns (uint256)',
  'function isOwner(address) view returns (bool)',
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool success)',
]);
const PROXY_ABI = parseAbi(['function proxy((uint8 typeCode,address to,uint256 value,bytes data)[] calls) payable returns (bytes[])']);
export interface WinningPosition { condition: Hex; indexSet: number; balance: bigint }
export type Inspection = { state: 'WAITING' | 'LOSER' | 'EMPTY' } | { state: 'WINNER'; position: WinningPosition };
export type RedemptionReceipt = { state: 'PENDING' } | { state: 'CONFIRMED' | 'FAILED'; payout: string | null; gas: string; error: string | null };
export class RedemptionError extends Error {}

export function proxyFor(signer: Address) {
  return getCreate2Address({ from: PROXY_FACTORY, bytecodeHash: PROXY_INIT_HASH, salt: keccak256(encodePacked(['address'], [signer])) });
}
export function parseRedemptionReceipt(receipt: TransactionReceipt, row: Redemption): RedemptionReceipt {
  const gas = formatEther(receipt.gasUsed * receipt.effectiveGasPrice);
  if (receipt.status !== 'success') return { state: 'FAILED', payout: null, gas, error: 'تراکنش Redeem برگشت خورد؛ پس از پنج دقیقه دوباره بررسی می‌شود.' };
  let payout = BigInt(0);
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== CTF.toLowerCase()) continue;
    try {
      const event = decodeEventLog({ abi: CTF_ABI, eventName: 'PayoutRedemption', data: log.data, topics: log.topics });
      const a = event.args;
      if (a.redeemer.toLowerCase() === row.holder.toLowerCase() && a.collateralToken.toLowerCase() === USDCE.toLowerCase() &&
          a.parentCollectionId === zeroHash && a.conditionId === row.condition_id && a.indexSets.length === 1 && Number(a.indexSets[0]) === row.index_set) payout += a.payout;
    } catch { /* unrelated log */ }
  }
  return payout > BigInt(0) ? { state: 'CONFIRMED', payout: formatUnits(payout, 6), gas, error: null } :
    { state: 'FAILED', payout: null, gas, error: 'رسید شبکه پرداختی برای این سهم تأیید نکرد؛ موفق ثبت نشد.' };
}
export function createRedemptionChain() {
  const cfg = getBotWalletConfig();
  if (!cfg.isConfigured || !cfg.address) throw new RedemptionError('کیف پول Redeem تنظیم نشده است.');
  const account = privateKeyToAccount((cfg.privateKey.startsWith('0x') ? cfg.privateKey : `0x${cfg.privateKey}`) as Hex);
  const transport = http(getSetting('bot.rpcUrl') || 'https://polygon-rpc.com', { timeout: 15_000, retryCount: 0 });
  const publicClient = createPublicClient({ chain: polygon, transport });
  const walletClient = createWalletClient({ account, chain: polygon, transport });
  const holder = cfg.address as Address;
  async function checkChain() {
    if (await publicClient.getChainId() !== 137) throw new RedemptionError('RPC باید روی شبکه Polygon با شناسهٔ 137 باشد.');
  }
  return {
    async inspect(row: Redemption): Promise<Inspection> {
      await checkChain();
      const response = await fetch(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(row.slug)}`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new RedemptionError('دریافت مشخصات بازار برای Redeem ناموفق بود.');
      const events = await response.json();
      if (!Array.isArray(events)) throw new RedemptionError('پاسخ بازار معتبر نیست.');
      const event = events.find(e => e.slug === row.slug);
      const list = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : typeof value === 'string' ? JSON.parse(value) : [];
      const market = event?.markets?.find((m: { clobTokenIds: unknown }) => list(m.clobTokenIds).includes(row.token_id));
      if (!market || !/^0x[0-9a-fA-F]{64}$/.test(market.conditionId) || market.negRisk !== false) {
        throw new RedemptionError('فقط بازار استاندارد BTC با condition معتبر و بدون NegRisk پشتیبانی می‌شود.');
      }
      const tokens = list(market.clobTokenIds);
      const outcomes = list(market.outcomes).map(x => x.toLowerCase()).sort();
      if (tokens.length !== 2 || outcomes.join(',') !== 'down,up') throw new RedemptionError('بازار باید دو نتیجهٔ Up/Down داشته باشد.');
      const index = tokens.indexOf(row.token_id), condition = market.conditionId as Hex;
      const slots = await publicClient.readContract({ address: CTF, abi: CTF_ABI, functionName: 'getOutcomeSlotCount', args: [condition] });
      if (slots !== BigInt(2)) throw new RedemptionError('بازار دودویی نیست.');
      const den = await publicClient.readContract({ address: CTF, abi: CTF_ABI, functionName: 'payoutDenominator', args: [condition] });
      if (den === BigInt(0)) return { state: 'WAITING' };
      const num = await publicClient.readContract({ address: CTF, abi: CTF_ABI, functionName: 'payoutNumerators', args: [condition, BigInt(index)] });
      if (num > BigInt(0) && num !== den) return { state: 'WAITING' }; // split/invalid is not a binary loss
      const indexSet = 1 << index;
      const collection = await publicClient.readContract({ address: CTF, abi: CTF_ABI, functionName: 'getCollectionId', args: [zeroHash, condition, BigInt(indexSet)] });
      const token = await publicClient.readContract({ address: CTF, abi: CTF_ABI, functionName: 'getPositionId', args: [USDCE, collection] });
      if (token.toString() !== row.token_id) throw new RedemptionError('توکن با وثیقه USDC.e این بات تطابق ندارد.');
      if (num === BigInt(0)) return { state: 'LOSER' };
      const balance = await publicClient.readContract({ address: CTF, abi: CTF_ABI, functionName: 'balanceOf', args: [holder, token] });
      if (balance === BigInt(0)) return { state: 'EMPTY' };
      // CTF redeems the entire token balance. Refuse extra inventory that is not in this bot's ledger.
      if (balance > BigInt(Math.floor(row.shares * 1e6 + 1))) throw new RedemptionError('موجودی این سهم بیشتر از خریدهای ثبت‌شدهٔ بات است؛ برای جلوگیری از تسویهٔ دارایی دیگر، بررسی دستی لازم است.');
      return { state: 'WINNER', position: { condition, indexSet, balance } };
    },
    async prepare(position: WinningPosition): Promise<{ raw: Hex; hash: Hex }> {
      await checkChain();
      const redeemData = encodeFunctionData({ abi: CTF_ABI, functionName: 'redeemPositions', args: [USDCE, zeroHash, position.condition, [BigInt(position.indexSet)]] });
      let to: Address = CTF, data: Hex = redeemData;
      if (cfg.walletType === 'POLY_PROXY') {
        if (proxyFor(account.address).toLowerCase() !== holder.toLowerCase()) throw new RedemptionError('آدرس Proxy با کیف پول امضاکننده تطابق ندارد.');
        to = PROXY_FACTORY;
        data = encodeFunctionData({ abi: PROXY_ABI, functionName: 'proxy', args: [[{ typeCode: 1, to: CTF, value: BigInt(0), data: redeemData }]] });
      } else if (cfg.walletType === 'POLY_GNOSIS_SAFE') {
        const threshold = await publicClient.readContract({ address: holder, abi: SAFE_ABI, functionName: 'getThreshold' });
        const owner = await publicClient.readContract({ address: holder, abi: SAFE_ABI, functionName: 'isOwner', args: [account.address] });
        if (threshold !== BigInt(1) || !owner) throw new RedemptionError('Redeem خودکار Safe فقط با امضاکنندهٔ مالک و threshold=1 پشتیبانی می‌شود.');
        // Safe's prevalidated signature is valid only when the outer msg.sender is this owner.
        const signature = concat([pad(account.address, { size: 32 }), zeroHash, '0x01']);
        to = holder;
        data = encodeFunctionData({ abi: SAFE_ABI, functionName: 'execTransaction', args: [CTF, BigInt(0), redeemData, 0, BigInt(0), BigInt(0), BigInt(0), zeroAddress, zeroAddress, signature] });
      }
      const simulation = await publicClient.call({ account, to, data, value: BigInt(0) });
      if (cfg.walletType === 'POLY_GNOSIS_SAFE' && (!simulation.data || !decodeFunctionResult({ abi: SAFE_ABI, functionName: 'execTransaction', data: simulation.data }))) throw new RedemptionError('شبیه‌سازی Redeem در Safe ناموفق بود.');
      const request = await walletClient.prepareTransactionRequest({ account, chain: polygon, to, data, value: BigInt(0) });
      const maximumFee = request.gas * (request.maxFeePerGas ?? request.gasPrice ?? BigInt(0));
      if (maximumFee <= BigInt(0) || maximumFee > parseEther(String(getSetting('bot.redeemMaxGasPol')))) throw new RedemptionError('کارمزد تخمینی از سقف POL تنظیم‌شده بیشتر است؛ تراکنشی ارسال نشد.');
      if (await publicClient.getBalance({ address: account.address }) < maximumFee) throw new RedemptionError('برای کارمزد Redeem، موجودی POL کیف پول امضاکننده کافی نیست.');
      const raw = await walletClient.signTransaction(request);
      return { raw, hash: keccak256(raw) };
    },
    async broadcast(raw: Hex) { await publicClient.sendRawTransaction({ serializedTransaction: raw }); },
    async receipt(row: Redemption): Promise<RedemptionReceipt> {
      await checkChain();
      let receipt: TransactionReceipt;
      try { receipt = await publicClient.getTransactionReceipt({ hash: row.tx_hash as Hex }); }
      catch (e) {
        if (e instanceof Error && e.name === 'TransactionReceiptNotFoundError') return { state: 'PENDING' };
        throw e;
      }
      if (receipt.transactionHash.toLowerCase() !== row.tx_hash?.toLowerCase()) throw new RedemptionError('هش رسید با تراکنش ذخیره‌شده تطابق ندارد.');
      if (await publicClient.getBlockNumber() - receipt.blockNumber < BigInt(11)) return { state: 'PENDING' }; // 12 confirmations
      return parseRedemptionReceipt(receipt, row);
    },
  };
}
export type RedemptionChain = ReturnType<typeof createRedemptionChain>;
