import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as dbModule from '../src/lib/db';
import { applySettingChanges } from '../src/lib/settings';
import { alertStrategy, checkAndSendJevSignalAlert, evaluateJevRecordSignal } from '../src/lib/jevAlerts';
import { forwardSnapshotRow } from '../src/lib/forwardSnapshot';
import { ALERT_STRATEGIES, FROZEN_STRATEGY, FROZEN_STRATEGY_5, FROZEN_STRATEGY_8, FROZEN_STRATEGY_9, ruleNeedsTfm } from '../src/lib/signalAnalysis';
import type { TfmRecord } from '../src/lib/tfm/types';

// A v2-style 3/3 UP record at hh:mm ET on 2026-11-14 with the 1h UP side quoted at `up` (0-1) and a spot price.
const rec = (mm: string, up = 0.85, spot = 66_000) => {
  const filename = `btc_updown_2026-11-14_10-${mm}-00_ET.json`;
  return {
    filename, coin: 'BTC', et_time: `2026-11-14 10:${mm}:00 ET`, timestamp: `2026-11-14T15:${mm}:00.000Z`,
    cards: { '1h': { slug: 'bitcoin-up-or-down-november-14-2026-10am-et', up } },
    spot_price: spot, open_price: 65_900,
    predictions: { jev: { score: 3.8, score_confidence: 0.95, direction: 'UP' as const }, kev: { score: 3.6, direction: 'UP' as const }, span: { score: 3.2, direction: 'UP' as const } },
  };
};
const forecast = (file: string, probUp: number): TfmRecord => ({
  file, coin: 'BTC', ts: '2026-11-14T15:40:00.000Z', model: 'google/timesfm-3.0-pytorch', context: 1024, last: 66_000,
  h1: { open: 65_900, minutesLeft: 20, probUp, median: 66_100, q10: 65_800, q90: 66_400 }, m15: null, m5: null, source: 'live',
});
const store = (...recs: TfmRecord[]) => new Map(recs.map(r => [r.file, r]));

describe('Jev alerts on s8 and s9', () => {
  it('offers s8 and s9 next to the strategies that need no TimesFM', () => {
    expect(Object.keys(ALERT_STRATEGIES)).toEqual(['v1', 'v2', 's2', 's3', 's4', 's5', 's8', 's9']);
    expect([ruleNeedsTfm(FROZEN_STRATEGY_8.rule), ruleNeedsTfm(FROZEN_STRATEGY_9.rule)]).toEqual([true, true]);
    expect([ruleNeedsTfm(FROZEN_STRATEGY.rule), ruleNeedsTfm(FROZEN_STRATEGY_5.rule)]).toEqual([false, false]);
  });

  it('s8 alerts only with a forecast whose probability of the side beats its price', () => {
    const r = rec('40');
    expect(evaluateJevRecordSignal(r, FROZEN_STRATEGY_8, [], store(forecast(r.filename, 0.9))).isSignal).toBe(true); // 90% vs 85c
    expect(evaluateJevRecordSignal(r, FROZEN_STRATEGY_8, [], store(forecast(r.filename, 0.8))).isSignal).toBe(false); // edge -5
    expect(evaluateJevRecordSignal(r, FROZEN_STRATEGY_8, [], store()).isSignal).toBe(false); // no forecast
    expect(evaluateJevRecordSignal(r, FROZEN_STRATEGY_8).isSignal).toBe(false); // no store at all
  });

  it('s8 keeps its price cap of 92c and its minute window from 34', () => {
    const pricey = rec('40', 0.95);
    expect(evaluateJevRecordSignal(pricey, FROZEN_STRATEGY_8, [], store(forecast(pricey.filename, 0.99))).isSignal).toBe(false);
    const early = rec('33');
    expect(evaluateJevRecordSignal(early, FROZEN_STRATEGY_8, [], store(forecast(early.filename, 0.95))).isSignal).toBe(false);
  });

  it('s9 skips a snapshot after a fast move of more than $50 in 5 minutes, using the spot prices', () => {
    const before = rec('37', 0.6, 65_900);
    const prior = [{ ...forwardSnapshotRow(before.filename, before), spot_price: 65_900 }];
    const calm = rec('40', 0.85, 65_930);
    const fast = rec('40', 0.85, 66_000);
    expect(evaluateJevRecordSignal(calm, FROZEN_STRATEGY_9, prior, store(forecast(calm.filename, 0.9))).isSignal).toBe(true);
    expect(evaluateJevRecordSignal(fast, FROZEN_STRATEGY_9, prior, store(forecast(fast.filename, 0.9))).isSignal).toBe(false);
  });
});

describe('the alert setting and when the check runs', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    dbModule.initializeDb(db);
    vi.spyOn(dbModule, 'getDb').mockReturnValue(db);
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); });

  it('jev.alertStrategy accepts s8 and s9, and "bot" follows a bot on s8 or s9 instead of falling back to v2', () => {
    expect(applySettingChanges({ 'jev.alertStrategy': 's8' }, db).ok).toBe(true);
    expect(alertStrategy()).toBe(FROZEN_STRATEGY_8);
    expect(applySettingChanges({ 'jev.alertStrategy': 's9' }, db).ok).toBe(true);
    expect(alertStrategy()).toBe(FROZEN_STRATEGY_9);
    expect(applySettingChanges({ 'jev.alertStrategy': 'bot', 'bot.forwardStrategy': 's9' }, db).ok).toBe(true);
    expect(alertStrategy()).toBe(FROZEN_STRATEGY_9);
    expect(applySettingChanges({ 'jev.alertStrategy': 's7' as never }, db).ok).toBe(false);
  });

  it('a TimesFM rule waits for the forecast; any other rule is decided when the record is saved', async () => {
    expect(applySettingChanges({ 'jev.alertStrategy': 's8' }, db).ok).toBe(true);
    const r = rec('40');
    expect(await checkAndSendJevSignalAlert(r, r.filename, 'saved')).toEqual({ sent: false, reason: 'Waiting for the TimesFM forecast' });
    expect(applySettingChanges({ 'jev.alertStrategy': 'v2' }, db).ok).toBe(true);
    expect(await checkAndSendJevSignalAlert(r, r.filename, 'tfm')).toEqual({ sent: false, reason: 'Decided when the record was saved' });
  });
});
