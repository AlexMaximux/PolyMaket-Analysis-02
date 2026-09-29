import { it, expect, vi, beforeEach } from 'vitest';
import { POST } from '../src/app/api/bot/trade/route';
import { executeSignal } from '../src/lib/bot/executor';
vi.mock('../src/lib/bot/executor', () => ({ executeSignal: vi.fn(), getBotStatus: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
const post = (body: unknown, key = 'signal-1') => POST(new Request('http://localhost/api/bot/trade', { method: 'POST', headers: key ? { 'Idempotency-Key': key } : {}, body: JSON.stringify(body) }));
it('requires a stable request ID and validates BTC 1H before executing', async () => {
  expect((await post({ symbol: 'BTC', outcome: 'UP' }, '')).status).toBe(400);
  for (const body of [{ symbol: 'ETH', outcome: 'UP' }, { signal: 'buy: BTC/5M/UP' }, { symbol: 'BTC', outcome: {} }, null, []]) expect((await post(body)).status).toBe(400);
  expect(executeSignal).not.toHaveBeenCalled();
});
it('passes the stable ID and never passes a caller amount or spoofed source', async () => {
  vi.mocked(executeSignal).mockResolvedValue({ success: true } as never);
  expect((await post({ signal: 'buy: BTC/1H/DOWN', amountUsd: 99999, source: 'telegram' })).status).toBe(200);
  expect(executeSignal).toHaveBeenCalledWith({ symbol: 'BTC', timeframe: '1H', outcome: 'DOWN', requestId: 'api:signal-1', source: 'api' });
});
it('returns conflict for an unknown outcome, never success', async () => {
  vi.mocked(executeSignal).mockResolvedValue({ success: false, status: 'UNKNOWN' } as never);
  expect((await post({ symbol: 'BTC', outcome: 'UP' })).status).toBe(409);
});
