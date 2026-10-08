import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as dbModule from '../src/lib/db';
import { applySettingChanges } from '../src/lib/settings';
import { selectForwardSignal, runForwardCycle } from '../src/lib/bot/forward';
import { forwardSnapshotRow } from '../src/lib/forwardSnapshot';
import { buildHourlyEtSlug } from '../src/lib/bot/executor';
import { enqueueNotification, deliverNotifications, notificationStatus, collectNotifications } from '../src/lib/bot/notifications';
import { runOutcomeCycle } from '../src/lib/bot/outcomes';
import { initRedemptions } from '../src/lib/bot/redeemDb';
import { walletIdentity } from '../src/lib/bot/live';
import { FROZEN_STRATEGY, FROZEN_STRATEGY_5, type SnapshotRow } from '../src/lib/signalAnalysis';
import { BOT_STRATEGIES, botStrategy } from '../src/lib/bot/forward';
import { setBotSetting } from '../src/lib/bot/db';
import type { TradeResult } from '../src/lib/bot/types';
import type { RedemptionChain } from '../src/lib/bot/redeemChain';
const NOW = Date.parse('2026-09-28T18:40:00Z');
const KEY = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
let db: Database.Database;
function row(minute = 39, extra: Partial<SnapshotRow> = {}): SnapshotRow {
  return { filename: `btc_${minute}.json`, coin: 'BTC', timestamp: `2026-09-28T18:${minute}:00Z`, et_time: `2026-09-28 14:${minute}:00 ET`, market_slug: buildHourlyEtSlug('btc'), score: 4, score_confidence: 95, direction: 'UP', kev_direction: 'UP', span_direction: 'UP', up_1h_num: 50, ...extra };
}
beforeEach(() => {
  db = new Database(':memory:'); dbModule.initializeDb(db); vi.spyOn(dbModule, 'getDb').mockReturnValue(db);
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });
describe('forward bridge', () => {
  const select = (rows: SnapshotRow[], armed = NOW - 120_000) => selectForwardSignal(rows, NOW, armed, buildHourlyEtSlug('btc'), FROZEN_STRATEGY);
  it('uses the frozen rule and a stable ID, independent of result labels', () => {
    const a = select([row()]); expect(a).toMatchObject({ outcome: 'UP', expectedMarketSlug: buildHourlyEtSlug('btc') });
    expect(select([row(39, { market_outcome: 'DOWN' })])).toEqual(a);
    expect(select([row(39, { span_direction: 'DOWN' })])).toBeNull();
  });
  it('never substitutes a later signal for an earlier stale or pre-activation first signal', () => {
    expect(select([row(32), row(39)])).toBeNull();
    expect(select([row()], NOW)).toBeNull();
    expect(select([row(41)])).toBeNull();
    expect(select([row(39, { market_slug: 'old-hour' })])).toBeNull();
  });
  it('ignores pre-minute-32 candidates exactly as the frozen strategy does', () => {
    expect(select([row(30), row(39)])?.outcome).toBe('UP');
  });
  it('normalizes raw model confidences exactly as the analysis API', () => {
    expect(forwardSnapshotRow('btc_x.json', { predictions: { jev: { score: 4, raw_decision: { answers: { one_hour_score: { confidence: .954 } } } }, kev: { direction: 'UP' }, span: { direction: 'UP' } }, cards: { '1h': { up: .5014, slug: 'test' } } })).toMatchObject({ score_confidence: 95, up_1h_num: 50.1, market_slug: 'test', coin: 'BTC' });
  });
  it('claims each event once across cycles and rearms on live-mode changes', async () => {
    applySettingChanges({ 'bot.enabled': true, 'bot.forwardEnabled': true, 'bot.forwardStrategy': 'v2' });
    setBotSetting('forward.strategy', 'v2');
    db.prepare('UPDATE bot_forward_gate SET armed_at=?').run(NOW - 120_000);
    const execute = vi.fn().mockResolvedValue({ success: false } as TradeResult);
    await runForwardCycle([row()], execute); await runForwardCycle([row()], execute);
    expect(execute).toHaveBeenCalledTimes(1);
    applySettingChanges({ 'bot.privateKey': KEY, 'bot.simulationMode': false });
    expect(db.prepare('SELECT armed_at FROM bot_forward_gate').get()).toEqual({ armed_at: NOW });
  });
  it('does nothing with the bridge or bot disabled', async () => {
    const execute = vi.fn(); await runForwardCycle([row()], execute); expect(execute).not.toHaveBeenCalled();
  });
});
describe('forward strategy choice', () => {
  // Oct 5, after the s5 freeze: 14:xx ET = 18:xx UTC
  const T = (m: number, s = 0) => Date.parse(`2026-10-05T18:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}Z`);
  const at = (t: number) => vi.mocked(Date.now).mockReturnValue(t);
  function row5(minute: number, extra: Partial<SnapshotRow> = {}): SnapshotRow {
    const mm = String(minute).padStart(2, '0');
    return { filename: `btc_5_${mm}.json`, coin: 'BTC', timestamp: `2026-10-05T18:${mm}:00Z`, et_time: `2026-10-05 14:${mm}:00 ET`, market_slug: buildHourlyEtSlug('btc'), score: 4, score_confidence: 95, direction: 'UP', kev_direction: 'UP', span_direction: 'UP', up_1h_num: 50, ...extra };
  }
  const down = { score: 0.2, direction: 'DOWN', kev_direction: 'DOWN', span_direction: 'DOWN' } as const;

  it('defaults to Frozen strategy 1 + Optimised and accepts only the strategies the bot can trade', () => {
    expect(botStrategy()).toBe(FROZEN_STRATEGY_5);
    expect(BOT_STRATEGIES.map(s => s.id)).toEqual(['v2', 's5']);
    expect(applySettingChanges({ 'bot.forwardStrategy': 'v2' }).ok).toBe(true);
    expect(botStrategy()).toBe(FROZEN_STRATEGY);
    expect(applySettingChanges({ 'bot.forwardStrategy': 's3' }).ok).toBe(false);
  });
  it('s5 trades its own rule: minute 30-31 and a low-confidence DOWN that v2 skips', () => {
    at(T(31, 30));
    const slug = buildHourlyEtSlug('btc');
    const sel = (rows: SnapshotRow[], s = FROZEN_STRATEGY_5) => selectForwardSignal(rows, T(31, 30), T(20), slug, s);
    expect(sel([row5(31)])?.outcome).toBe('UP');
    expect(sel([row5(31)], FROZEN_STRATEGY)).toBeNull();
    expect(sel([row5(31, { ...down, score: 0.7, score_confidence: 40 })])?.outcome).toBe('DOWN');
    expect(sel([row5(31, { ...down, score_confidence: 99 })])).toBeNull();
  });
  it('re-arms when the strategy changes, and never buys an hour a second time after a switch', async () => {
    const execute = vi.fn().mockResolvedValue({ success: false } as TradeResult);
    at(T(33, 30));
    applySettingChanges({ 'bot.enabled': true, 'bot.forwardEnabled': true, 'bot.forwardStrategy': 'v2' });
    setBotSetting('forward.strategy', 'v2');
    db.prepare('UPDATE bot_forward_gate SET armed_at=?').run(T(20));
    // v2 buys the hour on a 99% DOWN signal (s5 caps DOWN confidence at 98%)
    const rows = [row5(33, { ...down, score_confidence: 99 })];
    await runForwardCycle(rows, execute);
    expect(execute).toHaveBeenCalledTimes(1);
    // Switch to s5: the next cycle re-arms and trades nothing
    at(T(46));
    applySettingChanges({ 'bot.forwardStrategy': 's5' });
    at(T(47));
    await runForwardCycle(rows, execute);
    expect(db.prepare('SELECT armed_at FROM bot_forward_gate').get()).toEqual({ armed_at: T(47) });
    // s5's first signal of the hour comes later and is fresh, but the hour was already bought under v2
    rows.push(row5(48, { ...down, score_confidence: 95 }));
    at(T(48, 30));
    await runForwardCycle(rows, execute);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('durable Telegram reports', () => {
  function telegram() { applySettingChanges({ 'bot.telegramToken': '123456789:abcdefghijklmnopqrstuvwxyz123456789', 'bot.telegramChatId': '12345' }); }
  it('deduplicates reports, verifies Telegram acceptance, and retries after failure', async () => {
    telegram(); enqueueNotification('a', 'test'); enqueueNotification('a', 'duplicate');
    const send = vi.fn().mockRejectedValueOnce(new Error('network'));
    await deliverNotifications(send); expect(notificationStatus()).toEqual({ pending: 1, failed: 1 });
    db.prepare('UPDATE bot_notifications SET next_at=0').run();
    send.mockResolvedValue(new Response(JSON.stringify({ ok: true, result: { message_id: 7 } })));
    await Promise.all([deliverNotifications(send), deliverNotifications(send)]);
    expect(send).toHaveBeenCalledTimes(2); expect(notificationStatus()).toEqual({ pending: 0, failed: 0 });
  });
  it('does not mark an HTTP 200 Telegram error as delivered', async () => {
    telegram(); enqueueNotification('a', 'test');
    await deliverNotifications(vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false }))));
    expect(notificationStatus().pending).toBe(1);
  });
  it.each(['WINNER', 'LOSER'] as const)('announces finalized %s once, while trading is disabled', async state => {
    applySettingChanges({ 'bot.privateKey': KEY }); initRedemptions();
    db.prepare(`INSERT INTO bot_requests(request_id,fingerprint,state,simulated,amount,created_at,updated_at,token_id,slug,wallet,result) VALUES('forward:test','{}','FILLED',0,10,0,0,'1234','bitcoin-up-or-down-test-et',?,?)`).run(walletIdentity(), JSON.stringify({ shares: 20, amountUsd: 10, outcome: 'UP', success: true }));
    const inspect = vi.fn().mockResolvedValue({ state });
    const factory = () => ({ inspect } as unknown as RedemptionChain);
    await runOutcomeCycle(factory); await runOutcomeCycle(factory); collectNotifications(); collectNotifications();
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM bot_notifications WHERE event LIKE 'outcome:%'").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM bot_notifications WHERE event LIKE 'purchase:%'").get()).toEqual({ n: 1 });
  });
  it('does not announce uncertain RPC responses as losses', async () => {
    applySettingChanges({ 'bot.privateKey': KEY }); initRedemptions();
    db.prepare(`INSERT INTO bot_requests(request_id,fingerprint,state,simulated,amount,created_at,updated_at,token_id,slug,wallet,result) VALUES('forward:test','{}','FILLED',0,10,0,0,'1234','bitcoin-up-or-down-test-et',?,?)`).run(walletIdentity(), JSON.stringify({ shares: 20, amountUsd: 10 }));
    await runOutcomeCycle(() => ({ inspect: vi.fn().mockRejectedValue(new Error('unavailable')) } as unknown as RedemptionChain));
    expect(db.prepare('SELECT outcome FROM bot_outcomes').get()).toEqual({ outcome: null });
  });
});
