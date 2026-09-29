import { describe, it, expect } from 'vitest';
import { buildTrades, DEFAULT_ANALYSIS_CONFIG, type AnalysisConfig, type SnapshotRow } from '@/lib/signalAnalysis';
import { buildLadderTrades, computeLadderMetrics, optimizeLadder, randomConfig, DEFAULT_LADDER_CONFIG, type LadderConfig, type LadderTrade } from '@/lib/ladderBacktest';

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
const ladderCfg = (rungs: LadderConfig['rungs']): LadderConfig => ({ rungs });

describe('buildLadderTrades — fill detection', () => {
  it('fills a rung when a later same-market row crosses its threshold', () => {
    // signal at 04:10, up_1h_num=80 -> quote 0.80. Rung at 15c -> threshold 0.65.
    // 04:20 up_1h_num=60 -> price 0.60, crosses it.
    const rows = [row({ hm: '04:10' }), row({ hm: '04:20', up_1h_num: 60 })];
    const base = buildTrades(rows, cfg());
    const [t] = buildLadderTrades(base, rows, ladderCfg([{ distanceCents: 15, sizeMultiplier: 0.5 }]), 10);
    expect(t.rungs[0].filled).toBe(true);
    expect(t.rungs[0].fillPrice).toBeCloseTo(0.65); // the rung's own limit price, not the observed 0.60
  });

  it('leaves a rung unfilled when price never reaches it', () => {
    const rows = [row({ hm: '04:10' }), row({ hm: '04:20', up_1h_num: 78 })];
    const base = buildTrades(rows, cfg());
    const [t] = buildLadderTrades(base, rows, ladderCfg([{ distanceCents: 15, sizeMultiplier: 0.5 }]), 10);
    expect(t.rungs[0].filled).toBe(false);
    expect(t.rungs[0].fillPrice).toBeNull();
  });

  it('ignores rows at or before the signal time, and rows from a different market', () => {
    const rows = [
      row({ hm: '04:05', up_1h_num: 50 }), // before signal, would satisfy threshold but must not count
      row({ hm: '04:10' }), // the signal itself
      row({ hm: '05:05', up_1h_num: 50, slug: 'bitcoin-up-or-down-september-26-2026-5am-et' }), // different hour/market
    ];
    const base = buildTrades(rows, cfg());
    const [t] = buildLadderTrades(base, rows, ladderCfg([{ distanceCents: 15, sizeMultiplier: 0.5 }]), 10);
    expect(t.rungs[0].filled).toBe(false);
  });

  it('checks each rung independently against the full forward series', () => {
    const rows = [row({ hm: '04:10' }), row({ hm: '04:20', up_1h_num: 25 })]; // price crashes straight to 0.25
    const base = buildTrades(rows, cfg());
    const cfgLadder = ladderCfg([
      { distanceCents: 15, sizeMultiplier: 0.5 },
      { distanceCents: 50, sizeMultiplier: 0.2 },
    ]);
    const [t] = buildLadderTrades(base, rows, cfgLadder, 10);
    expect(t.rungs[0].filled).toBe(true);
    expect(t.rungs[1].filled).toBe(true);
    expect(t.rungs[1].fillPrice).toBeCloseTo(0.3); // 0.80 - 50c
  });
});

describe('buildLadderTrades — stake, shares, blended entry, pnl', () => {
  it('computes blended entry and a winning pnl across two filled rungs', () => {
    // base: $10 @ 0.80 -> 12.5 shares. rung1 fills @0.65 with 0.5x=$5 -> 7.6923 shares.
    const rows = [row({ hm: '04:10' }), row({ hm: '04:20', up_1h_num: 60 })];
    const base = buildTrades(rows, cfg());
    const [t] = buildLadderTrades(base, rows, ladderCfg([{ distanceCents: 15, sizeMultiplier: 0.5 }]), 10);
    expect(t.totalStake).toBeCloseTo(15);
    expect(t.totalShares).toBeCloseTo(10 / 0.8 + 5 / 0.65);
    expect(t.blendedEntry).toBeCloseTo(t.totalStake / t.totalShares);
    expect(t.status).toBe('WIN');
    expect(t.pnl).toBeCloseTo(t.totalShares - t.totalStake);
  });

  it('a loss forfeits exactly the filled stake, unfilled rungs risk nothing', () => {
    const rows = [
      row({ hm: '04:10', market_outcome: 'DOWN' }),
      row({ hm: '04:20', up_1h_num: 78, market_outcome: 'DOWN' }), // never reaches the 15c rung
    ];
    const base = buildTrades(rows, cfg());
    const [t] = buildLadderTrades(base, rows, ladderCfg([{ distanceCents: 15, sizeMultiplier: 0.5 }]), 10);
    expect(t.rungs[0].filled).toBe(false);
    expect(t.totalStake).toBeCloseTo(10); // only the base stake was ever at risk
    expect(t.status).toBe('LOSS');
    expect(t.pnl).toBeCloseTo(-10);
  });
});

describe('buildLadderTrades — edge cases', () => {
  it('returns an empty array for no trades', () => {
    expect(buildLadderTrades([], [], DEFAULT_LADDER_CONFIG, 10)).toEqual([]);
  });

  it('skips a trade with no quoted price without throwing, and puts no stake at risk', () => {
    const rows = [row({ hm: '04:10', up_1h_num: null })];
    const base = buildTrades(rows, cfg());
    expect(() => buildLadderTrades(base, rows, DEFAULT_LADDER_CONFIG, 10)).not.toThrow();
    const [t] = buildLadderTrades(base, rows, DEFAULT_LADDER_CONFIG, 10);
    expect(t.totalShares).toBe(0);
    expect(t.blendedEntry).toBeNull();
    expect(t.pnl).toBe(0);
    expect(t.totalStake).toBe(0); // no price was ever quoted, so nothing was actually risked
    expect(t.rungs.every((r) => !r.filled)).toBe(true);
  });

  it('never fills a rung whose limit price would be zero or negative, and stays finite', () => {
    // quote 0.80: an 80c rung has threshold exactly 0, a 90c rung would be negative.
    // Crash the price all the way to 0 (real data does hit 0/100 at the edges) -- naive
    // "price <= threshold" logic treats price 0 <= threshold 0 as a fill at a $0 price,
    // which divides stake by a zero fillPrice into Infinity shares.
    const rows = [row({ hm: '04:10' }), row({ hm: '04:20', up_1h_num: 0 })];
    const base = buildTrades(rows, cfg());
    const cfgLadder = ladderCfg([
      { distanceCents: 80, sizeMultiplier: 0.5 },
      { distanceCents: 90, sizeMultiplier: 0.5 },
    ]);
    const [t] = buildLadderTrades(base, rows, cfgLadder, 10);
    expect(t.rungs[0].filled).toBe(false);
    expect(t.rungs[1].filled).toBe(false);
    expect(Number.isFinite(t.totalShares)).toBe(true);
    expect(Number.isFinite(t.pnl)).toBe(true);
  });
});

function ladderTrade(p: Partial<LadderTrade> & { status: LadderTrade['status']; pnl: number; totalStake: number; blendedEntry: number | null; filled: boolean[] }): LadderTrade {
  return {
    base: {} as any,
    rungs: p.filled.map((filled, i) => ({ distanceCents: (i + 1) * 15, sizeMultiplier: 0.5, filled, fillPrice: filled ? 0.5 : null, fillTime: filled ? 1 : null })),
    totalStake: p.totalStake,
    totalShares: p.blendedEntry ? p.totalStake / p.blendedEntry : 0,
    blendedEntry: p.blendedEntry,
    status: p.status,
    pnl: p.pnl,
  };
}

describe('computeLadderMetrics', () => {
  it('returns neutral zero/null values for an empty trade list', () => {
    const m = computeLadderMetrics([]);
    expect(m).toMatchObject({ trades: 0, wins: 0, losses: 0, pending: 0, resolved: 0, winRate: null, roi: null, fillRateByRung: [], avgRungsFilled: 0 });
  });

  it('computes ROI from total staked across resolved trades, and per-rung fill rate', () => {
    const trades = [
      ladderTrade({ status: 'WIN', pnl: 5, totalStake: 15, blendedEntry: 0.75, filled: [true, false] }),
      ladderTrade({ status: 'LOSS', pnl: -10, totalStake: 10, blendedEntry: 0.8, filled: [false, false] }),
    ];
    const m = computeLadderMetrics(trades);
    expect(m.wins).toBe(1);
    expect(m.losses).toBe(1);
    expect(m.roi).toBeCloseTo(-5 / 25);
    expect(m.fillRateByRung).toEqual([0.5, 0]);
    expect(m.avgRungsFilled).toBeCloseTo(0.5);
  });

  it('counts a pending trade toward fillRateByRung diagnostics but not toward wins/losses/roi', () => {
    const trades = [ladderTrade({ status: 'PENDING', pnl: 0, totalStake: 15, blendedEntry: 0.75, filled: [true, true] })];
    const m = computeLadderMetrics(trades);
    expect(m.pending).toBe(1);
    expect(m.resolved).toBe(0);
    expect(m.roi).toBeNull();
    expect(m.fillRateByRung).toEqual([1, 1]);
  });
});

// A deterministic rng: cycles through two fixed fractions so every random candidate this
// generates is identical (2 rng() calls per rung: distance fraction, then multiplier fraction).
function fixedRng(distanceFraction: number, multiplierFraction: number) {
  let i = 0;
  const seq = [distanceFraction, multiplierFraction];
  return () => seq[i++ % seq.length];
}

function manyRowsForSignal(hm: string, outcome: 'UP' | 'DOWN', crashTo: number | null, slug: string) {
  const rows = [row({ hm, slug })];
  if (crashTo != null) {
    const [h, m] = hm.split(':');
    const laterM = String(Number(m) + 5).padStart(2, '0');
    rows.push(row({ hm: `${h}:${laterM}`, up_1h_num: crashTo, slug }));
  }
  return rows.map((r) => ({ ...r, market_outcome: outcome }));
}

describe('optimizeLadder', () => {
  it('falls back to the starting config when train data has too few resolved trades', async () => {
    // Only 2 trades total, both dated before the split -> train has 2 resolved, well under the default 30 minimum.
    const rows = [
      ...manyRowsForSignal('04:10', 'UP', 60, 'bitcoin-up-or-down-september-26-2026-4am-et'),
      ...manyRowsForSignal('05:10', 'UP', 60, 'bitcoin-up-or-down-september-26-2026-5am-et'),
    ];
    const base = buildTrades(rows, cfg());
    const starting = ladderCfg([{ distanceCents: 15, sizeMultiplier: 0.5 }]);
    const result = await optimizeLadder(base, rows, 10, '2026-09-27', starting, { iterations: 20, rng: fixedRng(0.5, 0.5) });
    expect(result.config).toEqual(starting);
    expect(result.cancelled).toBe(false);
  });

  it('finds a better config and computes holdout strictly from trades on/after the split date', async () => {
    // Every market crashes from 0.80 to 0.50 shortly after the signal and resolves UP (a win).
    // 20 distinct markets/hours on each of two train days (40 total, both before the split),
    // plus 10 distinct markets on one holdout day (on/after the split). Each market gets its own
    // et_time/timestamp/slug passed directly — row()'s ...p spread lets these override its
    // hardcoded-date defaults, so there is no risk of two markets colliding on the same key.
    function winningMarket(date: string, hour: number): SnapshotRow[] {
      const hh = String(hour).padStart(2, '0');
      const utcHour = String((hour + 4) % 24).padStart(2, '0');
      const slug = `bitcoin-up-or-down-${date}-${hh}h-et`;
      return [
        row({ hm: `${hh}:10`, et_time: `${date} ${hh}:10:00 ET`, timestamp: `${date}T${utcHour}:10:00.000Z`, slug, market_outcome: 'UP' }),
        row({ hm: `${hh}:20`, et_time: `${date} ${hh}:20:00 ET`, timestamp: `${date}T${utcHour}:20:00.000Z`, slug, up_1h_num: 50, market_outcome: 'UP' }),
      ];
    }
    const rows = [
      ...Array.from({ length: 20 }, (_, h) => winningMarket('2026-09-01', h)).flat(),
      ...Array.from({ length: 20 }, (_, h) => winningMarket('2026-09-02', h)).flat(),
      ...Array.from({ length: 10 }, (_, h) => winningMarket('2026-09-05', h)).flat(),
    ];
    const base = buildTrades(rows, cfg());
    const starting = ladderCfg([{ distanceCents: 50, sizeMultiplier: 0.01 }]); // its rung needs price <=0.30, the crash only reaches 0.50 -> never fills
    // fixedRng always draws distanceCents=15, sizeMultiplier=0.5 (inverting the implementation's snap() step):
    // 15 = 5 + f*(80-5) -> f = 10/75; 0.5 = 0.05 + f*(1-0.05) -> f = 0.45/0.95.
    const rng = fixedRng(10 / 75, 0.45 / 0.95);
    const result = await optimizeLadder(base, rows, 10, '2026-09-03', starting, { iterations: 50, rng });
    expect(result.config.rungs[0].distanceCents).toBeCloseTo(15);
    expect(result.config.rungs[0].sizeMultiplier).toBeCloseTo(0.5);
    expect(result.trainMetrics.resolved).toBe(40);
    expect(result.holdoutMetrics.trades).toBe(10);
    // starting config never fills its rung, so its train ROI is a fixed ~0.25 (2.5 pnl / 10 stake per trade);
    // the found config fills a profitable rung and should clear that by a comfortable margin.
    expect(result.trainMetrics.roi).toBeGreaterThan(0.3);
  });

  it('stops early and reports cancelled when shouldCancel returns true', async () => {
    const rows = manyRowsForSignal('04:10', 'UP', 60, 'bitcoin-up-or-down-september-26-2026-4am-et');
    const base = buildTrades(rows, cfg());
    const result = await optimizeLadder(base, rows, 10, '2026-09-27', DEFAULT_LADDER_CONFIG, { iterations: 500 }, () => true);
    expect(result.cancelled).toBe(true);
    expect(result.triedCount).toBeLessThan(500);
  });
});

describe('randomConfig', () => {
  it('always returns rungs with strictly increasing, distinct distances (a real ladder, not stacked duplicate price levels)', () => {
    // a constant rng would draw the exact same raw distance for every rung without the fix.
    const config = randomConfig(3, [5, 80], [0.05, 1], fixedRng(0.5, 0.5));
    const distances = config.rungs.map((r) => r.distanceCents);
    expect(new Set(distances).size).toBe(3);
    expect([...distances].sort((a, b) => a - b)).toEqual(distances);
  });
});
