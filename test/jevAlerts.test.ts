import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as dbModule from '../src/lib/db';
import { evaluateJevRecordSignal } from '../src/lib/jevAlerts';

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
