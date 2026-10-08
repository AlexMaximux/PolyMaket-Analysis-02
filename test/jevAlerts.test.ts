import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as dbModule from '../src/lib/db';
import { evaluateJevRecordSignal, alertStrategy, alertStrategyLabel, formatTelegramSignalMessage } from '../src/lib/jevAlerts';
import { applySettingChanges } from '../src/lib/settings';
import { FROZEN_STRATEGY, FROZEN_STRATEGY_5 } from '../src/lib/signalAnalysis';

describe('evaluateJevRecordSignal (Frozen Strategy v2 Alert Rule)', () => {
  const baseRecord = {
    coin: 'BTC',
    et_time: '2026-09-27 15:35:00 ET',
    timestamp: '2026-09-27T19:35:00.000Z',
    cards: {
      '1h': {
        slug: 'bitcoin-up-or-down-september-27-2026-3pm-et',
        up: 0.85,
        down: 0.15,
      },
    },
    predictions: {
      jev: {
        score: 3.8,
        score_confidence: 0.95,
        direction: 'UP',
      },
      kev: {
        score: 3.6,
        score_confidence: 0.92,
        direction: 'UP',
      },
      span: {
        score: 3.2,
        direction: 'UP',
      },
      consensus: {
        summary: '3/3 UP',
      },
    },
  };

  it('qualifies valid BTC signal at minute >= 32 with 3/3 consensus (UP)', () => {
    const res = evaluateJevRecordSignal(baseRecord);
    expect(res.isSignal).toBe(true);
    expect(res.type).toBe('BULLISH');
    expect(res.direction).toBe('UP');
    expect(res.minute).toBe(35);
    expect(res.confidence).toBe(95);
    expect(res.hourKey).toBe('btc_hour_bitcoin-up-or-down-september-27-2026-3pm-et');
  });

  it('qualifies valid BTC signal at minute >= 32 with 3/3 consensus (DOWN)', () => {
    const downRecord = {
      ...baseRecord,
      et_time: '2026-09-27 15:42:00 ET',
      predictions: {
        jev: {
          score: 0.2,
          score_confidence: 0.94,
          direction: 'DOWN',
        },
        kev: {
          score: 0.3,
          direction: 'DOWN',
        },
        span: {
          direction: 'DOWN',
        },
        consensus: {
          summary: '0/3 UP (3 DOWN)',
        },
      },
    };
    const res = evaluateJevRecordSignal(downRecord);
    expect(res.isSignal).toBe(true);
    expect(res.type).toBe('BEARISH');
    expect(res.direction).toBe('DOWN');
    expect(res.minute).toBe(42);
  });

  it('rejects non-BTC coins even if all other conditions match', () => {
    const ethRecord = { ...baseRecord, coin: 'ETH' };
    const res = evaluateJevRecordSignal(ethRecord);
    expect(res.isSignal).toBe(false);
  });

  it('rejects signals occurring at minute <= 31 (e.g. minute 15, 30, 31)', () => {
    const earlyRecord = {
      ...baseRecord,
      et_time: '2026-09-27 15:31:00 ET',
    };
    const res = evaluateJevRecordSignal(earlyRecord);
    expect(res.isSignal).toBe(false);

    const min10Record = {
      ...baseRecord,
      et_time: '2026-09-27 15:10:00 ET',
    };
    expect(evaluateJevRecordSignal(min10Record).isSignal).toBe(false);
  });

  it('accepts signals occurring strictly at minute 32 or later', () => {
    const min32Record = {
      ...baseRecord,
      et_time: '2026-09-27 15:32:00 ET',
    };
    expect(evaluateJevRecordSignal(min32Record).isSignal).toBe(true);
  });

  it('rejects if Kev-4b does not agree with Jev direction (not 3/3)', () => {
    const disagreeKev = {
      ...baseRecord,
      predictions: {
        ...baseRecord.predictions,
        kev: {
          direction: 'DOWN',
        },
      },
    };
    expect(evaluateJevRecordSignal(disagreeKev).isSignal).toBe(false);
  });

  it('rejects if Span-01 does not agree with Jev direction (not 3/3)', () => {
    const disagreeSpan = {
      ...baseRecord,
      predictions: {
        ...baseRecord.predictions,
        span: {
          direction: 'DOWN',
        },
      },
    };
    expect(evaluateJevRecordSignal(disagreeSpan).isSignal).toBe(false);
  });

  it('rejects if Jev score is not decisive (e.g. score between 0.5 and 3.5)', () => {
    const weakJev = {
      ...baseRecord,
      predictions: {
        ...baseRecord.predictions,
        jev: {
          score: 2.5,
          score_confidence: 0.95,
          direction: 'UP',
        },
      },
    };
    expect(evaluateJevRecordSignal(weakJev).isSignal).toBe(false);
  });

  it('rejects if Jev confidence is below 90%', () => {
    const lowConf = {
      ...baseRecord,
      predictions: {
        ...baseRecord.predictions,
        jev: {
          score: 3.9,
          score_confidence: 0.85,
          direction: 'UP',
        },
      },
    };
    expect(evaluateJevRecordSignal(lowConf).isSignal).toBe(false);
  });
});

describe('alert rule choice (v2, s5 or the bot strategy)', () => {
  const record = (hm: string, jev: { score: number; conf: number; dir: 'UP' | 'DOWN' }) => ({
    coin: 'BTC',
    et_time: `2026-09-27 15:${hm}:00 ET`,
    timestamp: '2026-09-27T19:35:00.000Z',
    cards: { '1h': { slug: 'bitcoin-up-or-down-september-27-2026-3pm-et' } },
    predictions: {
      jev: { score: jev.score, score_confidence: jev.conf / 100, direction: jev.dir },
      kev: { direction: jev.dir, score: 3.6 },
      span: { direction: jev.dir, score: 3.2 },
    },
  });
  const v2 = (r: object) => evaluateJevRecordSignal(r, FROZEN_STRATEGY).isSignal;
  const s5 = (r: object) => evaluateJevRecordSignal(r, FROZEN_STRATEGY_5).isSignal;

  it('defaults to v2, so evaluating without a strategy is exactly the old rule', () => {
    const r = record('31', { score: 3.8, conf: 95, dir: 'UP' });
    expect(evaluateJevRecordSignal(r).isSignal).toBe(v2(r));
    expect(v2(r)).toBe(false);
  });
  it('s5 accepts minutes 30-55 where v2 accepts 32-59', () => {
    const up = { score: 3.8, conf: 95, dir: 'UP' as const };
    expect([v2(record('31', up)), s5(record('31', up))]).toEqual([false, true]);
    expect([v2(record('56', up)), s5(record('56', up))]).toEqual([true, false]);
    expect([v2(record('55', up)), s5(record('55', up))]).toEqual([true, true]);
  });
  it('s5 uses its own thresholds: UP above 3.25, DOWN below 0.75 with confidence up to 98%', () => {
    const both = (r: object) => [v2(r), s5(r)];
    expect(both(record('40', { score: 3.4, conf: 95, dir: 'UP' }))).toEqual([false, true]);
    expect(both(record('40', { score: 0.6, conf: 95, dir: 'DOWN' }))).toEqual([false, true]);
    expect(both(record('40', { score: 0.2, conf: 40, dir: 'DOWN' }))).toEqual([false, true]);
    expect(both(record('40', { score: 0.2, conf: 99, dir: 'DOWN' }))).toEqual([true, false]);
  });
  it('s5 still needs Kev and Span to agree', () => {
    const r = record('40', { score: 3.8, conf: 95, dir: 'UP' });
    expect(s5({ ...r, predictions: { ...r.predictions, kev: { direction: 'DOWN' } } })).toBe(false);
  });

  describe('the jev.alertStrategy setting', () => {
    let db: Database.Database;
    beforeEach(() => { db = new Database(':memory:'); dbModule.initializeDb(db); vi.spyOn(dbModule, 'getDb').mockReturnValue(db); });
    afterEach(() => { vi.restoreAllMocks(); db.close(); });

    it('is v2 until changed, accepts only v2, s5 and bot, and needs no restart', () => {
      expect(alertStrategy()).toBe(FROZEN_STRATEGY);
      expect(applySettingChanges({ 'jev.alertStrategy': 's5' }).ok).toBe(true);
      expect(alertStrategy()).toBe(FROZEN_STRATEGY_5);
      expect(applySettingChanges({ 'jev.alertStrategy': 'v3' }).ok).toBe(false);
      expect(alertStrategy()).toBe(FROZEN_STRATEGY_5);
    });
    it('bot follows the strategy the trading bot trades', () => {
      applySettingChanges({ 'jev.alertStrategy': 'bot', 'bot.forwardStrategy': 'v2' });
      expect(alertStrategy()).toBe(FROZEN_STRATEGY);
      applySettingChanges({ 'bot.forwardStrategy': 's5' });
      expect(alertStrategy()).toBe(FROZEN_STRATEGY_5);
    });
  });

  it('names the rule in the message: the old line for v2, the minutes and thresholds for s5', () => {
    const r = record('40', { score: 3.8, conf: 95, dir: 'UP' });
    const sig = { type: 'BULLISH' as const, score: 3.8, confidence: 95, direction: 'UP', minute: 40, hour: 15 };
    expect(alertStrategyLabel(FROZEN_STRATEGY)).toBe('BTC · اجماع ۳ مدل (Jev+Kev+Span) · اولین سیگنال بعد از ۳۱');
    expect(formatTelegramSignalMessage(r, 'f.json', sig, FROZEN_STRATEGY, 100, 99)).toContain('اولین سیگنال بعد از ۳۱');
    const m = formatTelegramSignalMessage(r, 'f.json', sig, FROZEN_STRATEGY_5, 100, 99);
    expect(m).toContain('Frozen strategy 1 + Optimised');
    expect(m).toContain('دقیقه 30 تا 55');
    expect(m).not.toContain('اولین سیگنال بعد از ۳۱');
  });
});
