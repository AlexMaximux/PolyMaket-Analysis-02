import { describe, beforeEach, afterEach, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { encodeAbiParameters, encodeEventTopics, decodeFunctionData, zeroHash, type TransactionReceipt } from 'viem';
import * as dbModule from '../src/lib/db';
import { applySettingChanges } from '../src/lib/settings';
import { createRedemptionChain, parseRedemptionReceipt, proxyFor, CTF_ABI, CTF, USDCE, PROXY_FACTORY } from '../src/lib/bot/redeemChain';
import type { Redemption } from '../src/lib/bot/redeemDb';

const rpc = vi.hoisted(() => ({
  getChainId: vi.fn(), readContract: vi.fn(), call: vi.fn(), getBalance: vi.fn(),
  getTransactionReceipt: vi.fn(), getBlockNumber: vi.fn(), sendRawTransaction: vi.fn(),
}));
const signer = vi.hoisted(() => ({ prepareTransactionRequest: vi.fn(), signTransaction: vi.fn() }));
vi.mock('viem', async importOriginal => ({
  ...await importOriginal<typeof import('viem')>(), createPublicClient: () => rpc, createWalletClient: () => signer,
}));
const KEY = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const SAFE = '0x1111111111111111111111111111111111111111';
const CONDITION = `0x${'a'.repeat(64)}` as const;
const HASH = `0x${'b'.repeat(64)}` as const;
const position = { condition: CONDITION, indexSet: 1, balance: BigInt(20_000_000) };
const row = { holder: ADDRESS, token_id: '1234', slug: 'bitcoin-up-or-down-test-et', shares: 20, condition_id: CONDITION, index_set: 1, tx_hash: HASH } as Redemption;
function receipt(payout = BigInt(20_000_000), holder = ADDRESS): TransactionReceipt {
  return {
    status: 'success', gasUsed: BigInt(100_000), effectiveGasPrice: BigInt(1_000_000_000), blockNumber: BigInt(100), transactionHash: HASH,
    logs: [{ address: CTF, topics: encodeEventTopics({ abi: CTF_ABI, eventName: 'PayoutRedemption', args: { redeemer: holder as `0x${string}`, collateralToken: USDCE, parentCollectionId: zeroHash } }),
      data: encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256[]' }, { type: 'uint256' }], [CONDITION, [BigInt(1)], payout]) }],
  } as unknown as TransactionReceipt; // fixture omits unused receipt fields
}
describe('redemption on-chain checks and wallet routing', () => {
  let db: Database.Database;
  let values: Record<string, unknown>;
  beforeEach(() => {
    vi.resetAllMocks();
    db = new Database(':memory:'); dbModule.initializeDb(db); vi.spyOn(dbModule, 'getDb').mockReturnValue(db);
    applySettingChanges({ 'bot.privateKey': KEY }, db);
    values = { getOutcomeSlotCount: BigInt(2), payoutDenominator: BigInt(1), payoutNumerators: BigInt(1), getCollectionId: zeroHash,
      getPositionId: BigInt(1234), balanceOf: BigInt(20_000_000), getThreshold: BigInt(1), isOwner: true };
    rpc.getChainId.mockResolvedValue(137);
    rpc.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => values[functionName]);
    rpc.call.mockResolvedValue({ data: `0x${'0'.repeat(63)}1` });
    rpc.getBalance.mockResolvedValue(BigInt('1000000000000000000'));
    signer.prepareTransactionRequest.mockImplementation(async (args: object) => ({ ...args, gas: BigInt(100_000), maxFeePerGas: BigInt(1_000_000_000) }));
    signer.signTransaction.mockResolvedValue('0x1234');
    rpc.getTransactionReceipt.mockResolvedValue(receipt()); rpc.getBlockNumber.mockResolvedValue(BigInt(111));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify([{ slug: row.slug, markets: [{
      conditionId: CONDITION, clobTokenIds: '["1234","5678"]', outcomes: '["Up","Down"]', negRisk: false,
    }] }]))));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); db.close(); });
  it('requires final on-chain resolution and the selected outcome to win', async () => {
    values.payoutDenominator = BigInt(0);
    expect(await createRedemptionChain().inspect(row)).toEqual({ state: 'WAITING' });
    expect(signer.signTransaction).not.toHaveBeenCalled();
  });
  it('skips a losing outcome', async () => {
    values.payoutNumerators = BigInt(0);
    expect(await createRedemptionChain().inspect(row)).toEqual({ state: 'LOSER' });
  });
  it('does not misreport a split payout as a loss', async () => {
    values.payoutDenominator = BigInt(2); values.payoutNumerators = BigInt(1);
    expect(await createRedemptionChain().inspect(row)).toEqual({ state: 'WAITING' });
  });
  it('checks the actual token matches the condition, index set and USDC.e collateral', async () => {
    expect(await createRedemptionChain().inspect(row)).toEqual({ state: 'WINNER', position });
    expect(rpc.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'getPositionId', args: [USDCE, zeroHash] }));
  });
  it('refuses mismatched collateral/token IDs', async () => {
    values.getPositionId = BigInt(9999);
    await expect(createRedemptionChain().inspect(row)).rejects.toThrow(/USDC/);
  });
  it('does not redeem extra inventory outside bot purchases', async () => {
    values.balanceOf = BigInt(25_000_000);
    await expect(createRedemptionChain().inspect(row)).rejects.toThrow(/بیشتر/);
  });
  it('does not infer a payout when the token balance is zero', async () => {
    values.balanceOf = BigInt(0);
    expect(await createRedemptionChain().inspect(row)).toEqual({ state: 'EMPTY' });
  });
  it('signs a standard EOA redeem for only the winning index set without broadcasting', async () => {
    await createRedemptionChain().prepare(position);
    const request = signer.prepareTransactionRequest.mock.calls[0][0];
    expect(request.to).toBe(CTF); expect(request.value).toBe(BigInt(0));
    const decoded = decodeFunctionData({ abi: CTF_ABI, data: request.data });
    expect(decoded).toMatchObject({ functionName: 'redeemPositions', args: [USDCE, zeroHash, CONDITION, [BigInt(1)]] });
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  });
  it('requires POL and enforces the configured maximum gas fee before signing', async () => {
    rpc.getBalance.mockResolvedValue(BigInt(0));
    await expect(createRedemptionChain().prepare(position)).rejects.toThrow(/POL/);
    expect(signer.signTransaction).not.toHaveBeenCalled();
    rpc.getBalance.mockResolvedValue(BigInt('1000000000000000000'));
    signer.prepareTransactionRequest.mockResolvedValue({ gas: BigInt(1_000_000), maxFeePerGas: BigInt('1000000000000') });
    await expect(createRedemptionChain().prepare(position)).rejects.toThrow(/سقف/);
    expect(signer.signTransaction).not.toHaveBeenCalled();
  });
  it('refuses an RPC connected to a different chain', async () => {
    rpc.getChainId.mockResolvedValue(1);
    await expect(createRedemptionChain().prepare(position)).rejects.toThrow(/137/);
  });
  it('routes Proxy redemption through the factory and verifies its derived wallet', async () => {
    applySettingChanges({ 'bot.walletType': 'POLY_PROXY', 'bot.proxyAddress': proxyFor(ADDRESS) }, db);
    await createRedemptionChain().prepare(position);
    expect(signer.prepareTransactionRequest.mock.calls[0][0].to).toBe(PROXY_FACTORY);
    applySettingChanges({ 'bot.proxyAddress': SAFE }, db);
    await expect(createRedemptionChain().prepare(position)).rejects.toThrow(/Proxy/);
  });
  it('supports owner-controlled one-signature Safe and refuses multisig or wrong owner', async () => {
    applySettingChanges({ 'bot.walletType': 'POLY_GNOSIS_SAFE', 'bot.proxyAddress': SAFE }, db);
    await createRedemptionChain().prepare(position);
    expect(signer.prepareTransactionRequest.mock.calls[0][0].to).toBe(SAFE);
    values.getThreshold = BigInt(2);
    await expect(createRedemptionChain().prepare(position)).rejects.toThrow(/threshold/);
    values.getThreshold = BigInt(1); values.isOwner = false;
    await expect(createRedemptionChain().prepare(position)).rejects.toThrow(/threshold/);
  });
  it('does not sign when Safe simulation returns false', async () => {
    applySettingChanges({ 'bot.walletType': 'POLY_GNOSIS_SAFE', 'bot.proxyAddress': SAFE }, db);
    rpc.call.mockResolvedValue({ data: zeroHash });
    await expect(createRedemptionChain().prepare(position)).rejects.toThrow(/Safe/);
    expect(signer.signTransaction).not.toHaveBeenCalled();
  });
  it('requires a matching payout event, not only successful transaction status', () => {
    expect(parseRedemptionReceipt(receipt(), row)).toMatchObject({ state: 'CONFIRMED', payout: '20' });
    expect(parseRedemptionReceipt({ ...receipt(), logs: [] }, row).state).toBe('FAILED');
    expect(parseRedemptionReceipt(receipt(BigInt(0)), row).state).toBe('FAILED');
    expect(parseRedemptionReceipt(receipt(BigInt(20_000_000), SAFE), row).state).toBe('FAILED');
    expect(parseRedemptionReceipt({ ...receipt(), status: 'reverted' }, row).state).toBe('FAILED');
  });
  it('waits for twelve confirmations and preserves ambiguous RPC failures', async () => {
    rpc.getBlockNumber.mockResolvedValue(BigInt(110));
    expect((await createRedemptionChain().receipt(row)).state).toBe('PENDING');
    rpc.getBlockNumber.mockResolvedValue(BigInt(111));
    expect((await createRedemptionChain().receipt(row)).state).toBe('CONFIRMED');
    rpc.getTransactionReceipt.mockRejectedValue(Object.assign(new Error('not found'), { name: 'TransactionReceiptNotFoundError' }));
    expect((await createRedemptionChain().receipt(row)).state).toBe('PENDING');
    rpc.getTransactionReceipt.mockRejectedValue(new Error('RPC failure'));
    await expect(createRedemptionChain().receipt(row)).rejects.toThrow(/RPC/);
  });
});
