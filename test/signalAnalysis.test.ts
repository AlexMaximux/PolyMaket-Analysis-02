import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ANALYSIS_CONFIG,
  FROZEN_STRATEGY,
  FROZEN_STRATEGY_2,
  FROZEN_STRATEGY_3,
  FROZEN_STRATEGY_4,
  FROZEN_STRATEGY_5,
  STRATEGY_HISTORY,
  buildTrades,
  computeMetrics,
  detectSignal,
  tradePnl,
  wilson,
  verdictOf,
  conflictingHours,
  type AnalysisConfig,
  type SnapshotRow,
} from '@/lib/signalAnalysis';
import type { FilterCondition, FilterGroup } from '@/lib/fieldFilters';

let seq = 0;
function row(p: Partial<SnapshotRow> & { hm: string; slug?: string }): SnapshotRow {
  seq++;
  const [h, m] = p.hm.split(':');
  return {
    filename: `btc_updown_2026-09-26_${h}-${m}-00_ET_${seq}.json`,
    coin: 'BTC',
    et_time: `2026-09-26 ${h}:${m}:00 ET`,
    timestamp: `2026-09-26T${String(Number(h) + 4).padStart(2, '0')}:${m}:00.000Z`,
    market_slug: p.slug ?? `bitcoin-up-or-down-september-26-2026-${Number(h)}am-et`,
    score: 3.8,
    score_confidence: 95,
    direction: 'UP',
    kev_direction: 'UP',
    span_direction: 'UP',
    up_1h_num: 80,
    market_outcome: 'UP',
    ...p,
  };
}

const cfg = (over: Partial<AnalysisConfig> = {}): AnalysisConfig => ({ ...DEFAULT_ANALYSIS_CONFIG, ...over });

describe('detectSignal', () => {
  it('fires bullish above score and confidence thresholds', () => {
    expect(detectSignal(row({ hm: '04:10' }), cfg())?.dir).toBe('UP');
  });
  it('fires bearish below the bearish score', () => {
    expect(detectSignal(row({ hm: '04:10', score: 0.2 }), cfg())?.dir).toBe('DOWN');
  });
  it('needs the minimum confidence', () => {
    expect(detectSignal(row({ hm: '04:10', score_confidence: 89 }), cfg())).toBeNull();
  });
  it('max confidence caps each side separately and defaults to no cap', () => {
    const up = row({ hm: '04:10', score_confidence: 97 });
    const down = row({ hm: '04:10', score: 0.2, score_confidence: 97 });
    expect(detectSignal(up, cfg())?.dir).toBe('UP');
    expect(detectSignal(up, cfg({ bullishMaxConf: 95 }))).toBeNull();
    expect(detectSignal(up, cfg({ bearishMaxConf: 95 }))?.dir).toBe('UP');
    expect(detectSignal(down, cfg({ bearishMaxConf: 95 }))).toBeNull();
    expect(detectSignal(down, cfg({ bullishMaxConf: 95 }))?.dir).toBe('DOWN');
    expect(detectSignal(row({ hm: '04:10', score_confidence: 95 }), cfg({ bullishMaxConf: 95 }))?.dir).toBe('UP');
  });
  it('averages the three scores for the avg model', () => {
    const r = row({ hm: '04:10', score: 3.9, kev_score: 3.6, span_score: 3.3, consensus_agreement: 100 });
    expect(detectSignal(r, cfg({ model: 'avg' }))?.score).toBe(3.6);
  });
});

describe('pnl and stats', () => {
  it('pays stake*(1/p-1) on a win and loses the stake on a loss', () => {
    expect(tradePnl('WIN', 0.8, 10)).toBeCloseTo(2.5);
    expect(tradePnl('LOSS', 0.8, 10)).toBe(-10);
    expect(tradePnl('PENDING', 0.8, 10)).toBe(0);
  });
  it('wilson interval brackets the observed rate', () => {
    const ci = wilson(22, 23)!;
    expect(ci.low).toBeLessThan(22 / 23);
    expect(ci.high).toBeGreaterThan(22 / 23);
    expect(ci.low).toBeGreaterThan(0.75);
  });
  it('break-even equals the price when every entry is the same', () => {
    const trades = buildTrades([row({ hm: '04:10' }), row({ hm: '05:10' })], cfg());
    expect(computeMetrics(trades, 10).breakEven).toBeCloseTo(0.8);
  });
});

describe('buildTrades counting', () => {
  // 04:25 DOWN (loses), 04:36 UP (wins), 04:50 UP again, 05:05 UP
  const rows = [
    row({ hm: '04:25', score: 0.1, direction: 'DOWN', kev_direction: 'DOWN', span_direction: 'DOWN' }),
    row({ hm: '04:36' }),
    row({ hm: '04:50' }),
    row({ hm: '05:05', slug: 'bitcoin-up-or-down-september-26-2026-5am-et' }),
  ];

  it('all mode keeps every signal snapshot', () => {
    expect(buildTrades(rows, cfg({ dedupe: 'all' }))).toHaveLength(4);
  });
  it('first per hour per direction counts both sides of a conflicting hour', () => {
    const t = buildTrades(rows, cfg({ dedupe: 'firstPerHourDir' }));
    expect(t.map((x) => x.row.et_time.slice(11, 16))).toEqual(['04:25', '04:36', '05:05']);
    expect(conflictingHours(t)).toHaveLength(1);
  });
  it('strict first per hour keeps only the first signal', () => {
    const t = buildTrades(rows, cfg({ dedupe: 'firstPerHour' }));
    expect(t.map((x) => x.row.et_time.slice(11, 16))).toEqual(['04:25', '05:05']);
    expect(computeMetrics(t, 10)).toMatchObject({ wins: 1, losses: 1 });
  });
  it('afterFilters picks the first snapshot that passes; beforeFilters skips the hour', () => {
    const r = [row({ hm: '04:05', kev_direction: 'DOWN' }), row({ hm: '04:20' })];
    expect(buildTrades(r, cfg({ consensus: '3of3', pickOrder: 'afterFilters' }))).toHaveLength(1);
    expect(buildTrades(r, cfg({ consensus: '3of3', pickOrder: 'beforeFilters' }))).toHaveLength(0);
  });
  it('minute window and entry price filters drop late or expensive signals', () => {
    const r = [row({ hm: '04:55' }), row({ hm: '05:10', up_1h_num: 96, slug: 'x-5am' })];
    expect(buildTrades(r, cfg({ maxMinute: 49 }))).toHaveLength(1);
    expect(buildTrades(r, cfg({ maxEntry: 90 }))).toHaveLength(1);
  });
});

describe('frozen strategy', () => {
  it('current rule (v2): BTC, 3/3, strict first per hour, only minute 32+', () => {
    const r = FROZEN_STRATEGY.rule;
    expect(r.coins).toEqual(['BTC']);
    expect(r.model).toBe('jev');
    expect(r.consensus).toBe('3of3');
    expect(r.dedupe).toBe('firstPerHour');
    expect(r.pickOrder).toBe('afterFilters');
    expect([r.bullishScore, r.bearishScore, r.bullishMinConf, r.bearishMinConf]).toEqual([3.5, 0.5, 90, 90]);
    expect([r.minMinute, r.maxMinute, r.minEntry, r.maxEntry]).toEqual([32, 59, 0, 100]);
  });

  it('every history entry has a non-decreasing, non-overlapping forward window and only one open entry', () => {
    let prevEnd = -Infinity;
    let openCount = 0;
    for (const s of STRATEGY_HISTORY) {
      const start = new Date(s.frozenAt).getTime();
      expect(start).toBeGreaterThanOrEqual(prevEnd);
      if (s.frozenUntil == null) {
        openCount++;
      } else {
        const end = new Date(s.frozenUntil).getTime();
        expect(end).toBeGreaterThan(start);
        prevEnd = end;
      }
    }
    expect(openCount).toBe(1);
    expect(STRATEGY_HISTORY[STRATEGY_HISTORY.length - 1]).toBe(FROZEN_STRATEGY);
  });

  it('v1 excluded no minute; v2 requires minute 32+ (the only change between versions)', () => {
    const [v1, v2] = STRATEGY_HISTORY;
    expect(v1.rule.minMinute).toBe(0);
    expect(v2.rule.minMinute).toBe(32);
    const { minMinute: _m1, ...v1Rest } = v1.rule;
    const { minMinute: _m2, ...v2Rest } = v2.rule;
    expect(v1Rest).toEqual(v2Rest);
  });
});

describe('solar filter', () => {
  it('is off in every frozen strategy, so adding Solar does not change their history', () => {
    for (const s of STRATEGY_HISTORY) expect(s.rule.solarAgrees).toBe(false);
  });
  it('keeps rows without a Solar prediction when the filter is off', () => {
    expect(buildTrades([row({ hm: '04:40' })], cfg({ dedupe: 'firstPerHour' }))).toHaveLength(1);
  });
  it('drops rows where Solar disagrees or is missing when the filter is on', () => {
    const on = cfg({ solarAgrees: true, dedupe: 'firstPerHour' });
    expect(buildTrades([row({ hm: '04:40', solar_direction: 'DOWN' })], on)).toHaveLength(0);
    expect(buildTrades([row({ hm: '04:40' })], on)).toHaveLength(0);
    expect(buildTrades([row({ hm: '04:40', solar_direction: 'UP' })], on)).toHaveLength(1);
  });
  it('picks the first hour signal that Solar agrees with', () => {
    const on = cfg({ solarAgrees: true, dedupe: 'firstPerHour' });
    const trades = buildTrades([row({ hm: '04:35', solar_direction: 'DOWN' }), row({ hm: '04:40', solar_direction: 'UP' })], on);
    expect(trades).toHaveLength(1);
    expect(trades[0].minute).toBe(40);
  });
  it('solarMinConf drops low-confidence and missing Solar rows, and is off in the frozen rules', () => {
    for (const s of STRATEGY_HISTORY) expect(s.rule.solarMinConf).toBe(0);
    const on = cfg({ solarMinConf: 80, dedupe: 'firstPerHour' });
    expect(buildTrades([row({ hm: '04:40', solar_score_confidence: 79 })], on)).toHaveLength(0);
    expect(buildTrades([row({ hm: '04:40' })], on)).toHaveLength(0);
    expect(buildTrades([row({ hm: '04:40', solar_score_confidence: 80 })], on)).toHaveLength(1);
  });
  it('strategy 2 is strategy 1 plus only the Solar confidence filter, and runs in parallel', () => {
    const { solarMinConf, ...s2 } = FROZEN_STRATEGY_2.rule;
    const { solarMinConf: none, ...v2 } = FROZEN_STRATEGY.rule;
    expect(solarMinConf).toBe(80);
    expect(none).toBe(0);
    expect(s2).toEqual(v2);
    expect(STRATEGY_HISTORY).not.toContain(FROZEN_STRATEGY_2);
    expect(FROZEN_STRATEGY_2.frozenUntil).toBeNull();
  });
  it('uses Solar own score when it is the model', () => {
    const r = row({ hm: '04:10', score: 0.1, solar_score: 3.9, solar_score_confidence: 95 });
    expect(detectSignal(r, cfg({ model: 'solar' }))?.dir).toBe('UP');
  });
});

describe('flipped-hour filter (noPriorOpposite)', () => {
  const down = { score: 0.2, direction: 'DOWN', kev_direction: 'DOWN', span_direction: 'DOWN' } as const;
  // 04:10 DOWN at 60% confidence is not a trade at the 90% floor, but it shows the hour already flipped
  const flipped = () => [row({ hm: '04:10', ...down, score_confidence: 60 }), row({ hm: '04:35' })];
  const on = cfg({ dedupe: 'firstPerHour', noPriorOpposite: true });

  it('is off by default, so a later signal in a flipped hour still trades', () => {
    expect(buildTrades(flipped(), cfg({ dedupe: 'firstPerHour' }))).toHaveLength(1);
  });
  it('skips the hour once an opposite signal of any confidence appeared earlier in it', () => {
    expect(buildTrades(flipped(), on)).toHaveLength(0);
  });
  it('does not block on an earlier signal in the same direction', () => {
    const trades = buildTrades([row({ hm: '04:10' }), row({ hm: '04:35' })], { ...on, minMinute: 32 });
    expect(trades.map((t) => t.minute)).toEqual([35]);
  });
  it('does not block on an opposite signal in a different hour', () => {
    const r = [row({ hm: '04:10', ...down }), row({ hm: '05:35', slug: 'bitcoin-up-or-down-september-26-2026-5am-et' })];
    expect(buildTrades(r, { ...on, minMinute: 32 }).map((t) => t.minute)).toEqual([35]);
  });
  it('keeps an earlier trade when the opposite signal comes after it', () => {
    const trades = buildTrades([row({ hm: '04:35' }), row({ hm: '04:50', ...down })], on);
    expect(trades.map((t) => [t.minute, t.dir])).toEqual([[35, 'UP']]);
  });
});

describe('frozen strategy 3', () => {
  it('is strategy 1 plus only the flipped-hour filter, and runs in parallel', () => {
    const { noPriorOpposite, ...s3 } = FROZEN_STRATEGY_3.rule;
    const { noPriorOpposite: off, ...v2 } = FROZEN_STRATEGY.rule;
    expect(noPriorOpposite).toBe(true);
    expect(off).toBe(false);
    expect(s3).toEqual(v2);
    expect(STRATEGY_HISTORY).not.toContain(FROZEN_STRATEGY_3);
    expect(FROZEN_STRATEGY_3.frozenUntil).toBeNull();
  });
  it('is frozen on the top of an hour, so no market hour is split between backtest and forward rows', () => {
    const t = new Date(FROZEN_STRATEGY_3.frozenAt);
    expect([t.getUTCMinutes(), t.getUTCSeconds(), t.getUTCMilliseconds()]).toEqual([0, 0, 0]);
    expect(t.getTime()).toBeGreaterThan(new Date(FROZEN_STRATEGY_2.frozenAt).getTime());
  });
  it('the flipped-hour filter is off in every other frozen rule, so their history does not change', () => {
    for (const s of [...STRATEGY_HISTORY, FROZEN_STRATEGY_2]) expect(s.rule.noPriorOpposite).toBe(false);
  });
});

describe('frozen strategy 4', () => {
  it('Jev alone at 3.25 / 0.75 and 85% score confidence, minute 45+, the hour first signal must pass, every coin', () => {
    const r = FROZEN_STRATEGY_4.rule;
    expect(r.coins).toEqual([]);
    expect([r.model, r.confidenceType, r.directions]).toEqual(['jev', 'score', 'both']);
    expect([r.bullishScore, r.bearishScore, r.bullishMinConf, r.bearishMinConf]).toEqual([3.25, 0.75, 85, 85]);
    expect([r.consensus, r.solarAgrees, r.solarMinConf, r.noPriorOpposite]).toEqual(['none', false, 0, false]);
    expect([r.minMinute, r.maxMinute, r.minEntry, r.maxEntry]).toEqual([45, 59, 0, 100]);
    expect([r.dedupe, r.pickOrder]).toEqual(['firstPerHour', 'beforeFilters']);
  });
  it('runs in parallel, frozen on the top of an hour after strategy 3', () => {
    const t = new Date(FROZEN_STRATEGY_4.frozenAt);
    expect([t.getUTCMinutes(), t.getUTCSeconds(), t.getUTCMilliseconds()]).toEqual([0, 0, 0]);
    expect(t.getTime()).toBeGreaterThan(new Date(FROZEN_STRATEGY_3.frozenAt).getTime());
    expect(STRATEGY_HISTORY).not.toContain(FROZEN_STRATEGY_4);
    expect(FROZEN_STRATEGY_4.frozenUntil).toBeNull();
  });
});

describe('frozen strategy 5 (strategy 1 + optimised)', () => {
  it('is v2 with only the optimizer thresholds and minute window changed', () => {
    const r = FROZEN_STRATEGY_5.rule;
    expect([r.bullishScore, r.bearishScore]).toEqual([3.25, 0.75]);
    expect([r.bullishMinConf, r.bullishMaxConf, r.bearishMinConf, r.bearishMaxConf]).toEqual([90, 100, 0, 98]);
    expect([r.minMinute, r.maxMinute]).toEqual([30, 55]);
    // Put v2's values back: nothing else may differ
    expect({ ...r, bullishScore: 3.5, bearishScore: 0.5, bearishMinConf: 90, bearishMaxConf: 100, minMinute: 32, maxMinute: 59 }).toEqual(FROZEN_STRATEGY.rule);
  });
  it('runs in parallel, frozen on the top of an hour after strategy 4', () => {
    const t = new Date(FROZEN_STRATEGY_5.frozenAt);
    expect([t.getUTCMinutes(), t.getUTCSeconds(), t.getUTCMilliseconds()]).toEqual([0, 0, 0]);
    expect(t.getTime()).toBeGreaterThan(new Date(FROZEN_STRATEGY_4.frozenAt).getTime());
    expect(STRATEGY_HISTORY).not.toContain(FROZEN_STRATEGY_5);
    expect(FROZEN_STRATEGY_5.frozenUntil).toBeNull();
  });
  it('trades a DOWN signal at low confidence but not one above 98%, and only in minutes 30-55', () => {
    const down = { score: 0.6, direction: 'DOWN', kev_direction: 'DOWN', span_direction: 'DOWN', up_1h_num: 20 } as const;
    const r = FROZEN_STRATEGY_5.rule;
    expect(buildTrades([row({ hm: '04:40', ...down, score_confidence: 40 })], r)).toHaveLength(1);
    expect(buildTrades([row({ hm: '04:40', ...down, score_confidence: 99 })], r)).toHaveLength(0);
    expect(buildTrades([row({ hm: '04:56', ...down, score_confidence: 40 })], r)).toHaveLength(0);
  });
});

describe('field filters', () => {
  const only = (over: Partial<FilterCondition>): FilterGroup[] => [
    { id: 'g', conditions: [{ id: 'c', field: 'minute', op: 'between', a: null, b: null, values: [], enabled: true, ...over }] },
  ];

  it('are off by default and in every frozen rule, so the forward tests and the bot do not change', () => {
    expect(DEFAULT_ANALYSIS_CONFIG.fieldFilters).toEqual([]);
    for (const s of [...STRATEGY_HISTORY, FROZEN_STRATEGY_2, FROZEN_STRATEGY_3, FROZEN_STRATEGY_4, FROZEN_STRATEGY_5]) expect(s.rule.fieldFilters).toEqual([]);
  });
  it('after filters picks the first snapshot that passes; before filters skips the hour', () => {
    const r = [row({ hm: '04:20' }), row({ hm: '04:50' })];
    const late = only({ a: 45, b: 56 });
    expect(buildTrades(r, cfg({ dedupe: 'firstPerHour', fieldFilters: late })).map((t) => t.minute)).toEqual([50]);
    expect(buildTrades(r, cfg({ dedupe: 'firstPerHour', pickOrder: 'beforeFilters', fieldFilters: late }))).toHaveLength(0);
  });
  it('read the trade: price of the side bought and the signal direction', () => {
    const down = row({ hm: '04:40', score: 0.2, direction: 'DOWN', up_1h_num: 15 }); // DOWN buys at 85¢
    expect(buildTrades([down], cfg({ fieldFilters: only({ field: 'trade_price', op: 'gte', a: 85 }) }))).toHaveLength(1);
    expect(buildTrades([down], cfg({ fieldFilters: only({ field: 'trade_price', op: 'gt', a: 85 }) }))).toHaveLength(0);
    expect(buildTrades([down], cfg({ fieldFilters: only({ field: 'trade_dir', op: 'in', values: ['UP'] }) }))).toHaveLength(0);
  });
  it('read any snapshot field of the row, e.g. the Claude fair value', () => {
    const r = [
      { ...row({ hm: '04:40' }), fair_claude: 97 } as SnapshotRow,
      { ...row({ hm: '05:40', slug: 'x-5am' }), fair_claude: 60 } as SnapshotRow,
    ];
    const t = buildTrades(r, cfg({ fieldFilters: only({ field: 'fair_claude', op: 'gte', a: 90 }) }));
    expect(t.map((x) => x.hour)).toEqual([4]);
  });
  it('ignore a condition that is not filled in yet', () => {
    const r = [row({ hm: '04:20' })];
    expect(buildTrades(r, cfg({ fieldFilters: only({ a: 45 }) }))).toHaveLength(1);
  });
});

describe('verdict', () => {
  it('reports too few trades under the minimum sample', () => {
    const t = buildTrades([row({ hm: '04:10' })], cfg());
    expect(verdictOf(computeMetrics(t, 10))).toBe('TOO_FEW');
  });
});
