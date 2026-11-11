import { describe, expect, it } from 'vitest';
import { DEFAULT_ANALYSIS_CONFIG, type AnalysisConfig, type SnapshotRow } from '@/lib/signalAnalysis';
import { createLabSplit, optimizeLab, runLab, sanitizeLabConfig, type LabOptimizationOptions } from '@/lib/jevLab';

const cfg = (over: Partial<AnalysisConfig> = {}): AnalysisConfig => ({ ...DEFAULT_ANALYSIS_CONFIG, dedupe: 'firstPerHour', ...over });
function row(hour: number, minute = 35, over: Partial<SnapshotRow> = {}): SnapshotRow {
  const hh = String(hour).padStart(2, '0'), mm = String(minute).padStart(2, '0');
  return {
    filename: `btc_2026-10-01_${hh}-${mm}.json`, coin: 'BTC',
    et_time: `2026-10-01 ${hh}:${mm}:00 ET`, timestamp: `2026-10-01T${hh}:${mm}:00Z`,
    market_slug: `market-${hour}`, score: 3.8, score_confidence: 95,
    direction: 'UP', kev_direction: 'UP', span_direction: 'UP',
    up_1h_num: 80, market_outcome: 'UP', ...over,
  };
}
const options = (over: Partial<LabOptimizationOptions> = {}): LabOptimizationOptions => ({
  confidence: { min: 90, max: 90, step: 5 },
  minMinute: { min: 0, max: 0, step: 5 },
  maxEntry: { min: 100, max: 100, step: 5 },
  minimumTrainResolved: 1, objective: 'pnl', trainFraction: 0.5, ...over,
});

describe('lab config import', () => {
  it('bounds money and enums, validates dates, removes hindsight rules, and never mutates input', () => {
    const input = { ...cfg(), model: 'unknown', stake: -50, slippageCents: -10,
      coins: ['btc', 'BTC', 'ETH', 'FAKE'], hoursOfDay: [0, 23, 24, 0.5, '3'],
      dateFrom: '2026-02-31', minMinute: 55, maxMinute: 20,
      fieldFilters: [{ id: 'g', conditions: [
        { id: 'win', field: 'trade_result', op: 'in', values: ['WIN'], enabled: true },
        { id: 'outcome', field: 'market_outcome', op: 'in', values: ['UP'], enabled: true },
        { id: 'conf', field: 'trade_conf', op: 'gte', a: 90, values: [], enabled: true },
      ] }],
    };
    const result = sanitizeLabConfig(input);
    expect(result.model).toBe('jev');
    expect(result.stake).toBe(0.01);
    expect(result.slippageCents).toBe(0);
    expect(result.coins).toEqual(['BTC', 'ETH']);
    expect(result.hoursOfDay).toEqual([0, 23]);
    expect(result.dateFrom).toBeNull();
    expect([result.minMinute, result.maxMinute]).toEqual([20, 55]);
    expect(result.fieldFilters[0].conditions.map((condition) => condition.field)).toEqual(['trade_conf']);
    expect(input.fieldFilters[0].conditions).toHaveLength(3);
  });
  it('clamps the TimesFM confirmation fields and fills defaults for old configs', () => {
    expect(sanitizeLabConfig({ ...cfg(), tfmMinProb: 150 }).tfmMinProb).toBe(100);
    expect(sanitizeLabConfig({ ...cfg(), tfmMinProb: -5 }).tfmMinProb).toBe(0);
    expect(sanitizeLabConfig({ ...cfg(), tfmMinEdge: -500 }).tfmMinEdge).toBe(-100);
    expect(sanitizeLabConfig({ ...cfg(), tfmMinEdge: 500 }).tfmMinEdge).toBe(100);
    const old: Record<string, unknown> = { ...cfg() };
    delete old.tfmMinProb; delete old.tfmMinEdge;
    const result = sanitizeLabConfig(old);
    expect(result.tfmMinProb).toBe(0);
    expect(result.tfmMinEdge).toBe(-100);
    expect(sanitizeLabConfig({ ...cfg(), tfmMinProb: 'x', tfmMinEdge: NaN })).toMatchObject({ tfmMinProb: 0, tfmMinEdge: -100 });
  });
  it('keeps the TimesFM model', () => {
    expect(sanitizeLabConfig({ ...cfg(), model: 'tfm' }).model).toBe('tfm');
  });
});

describe('executable lab trades', () => {
  it('excludes missing, zero and impossible quotes from all metrics, including win rate', () => {
    const run = runLab([
      row(1), row(2, 35, { up_1h_num: null }), row(3, 35, { up_1h_num: 0 }),
      row(4, 35, { up_1h_num: 100 }), row(5, 35, { up_1h_num: NaN }),
      row(6, 35, { market_outcome: 'DOWN' }), row(7, 35, { market_outcome: 'PENDING' }),
    ], cfg());
    expect(run.missingPriceCount).toBe(4);
    expect(run.metrics).toMatchObject({ trades: 3, resolved: 2, wins: 1, losses: 1, pending: 1, winRate: 0.5 });
    expect(run.metrics.pnl).toBeCloseTo(-7.5);
    expect(run.metrics.roi).toBeCloseTo(-0.375);
  });
  it('preserves the first signal rule when its quote is missing instead of replacing it later', () => {
    const run = runLab([row(1, 10, { up_1h_num: null }), row(1, 40)], cfg());
    expect(run.trades).toHaveLength(0);
    expect(run.missingPriceCount).toBe(1);
  });
  it('rejects a fill at or above $1 after slippage instead of using the legacy price clamp', () => {
    const run = runLab([row(1), row(2, 35, { up_1h_num: 70 })], cfg({ slippageCents: 20 }));
    expect(run.missingPriceCount).toBe(1);
    expect(run.metrics.resolved).toBe(1);
    expect(run.trades[0].entry).toBeCloseTo(0.9);
  });
  it('uses the exact near-$1 entry for shares, profit, ROI and break-even', () => {
    const run = runLab([row(1, 35, { up_1h_num: 99.9 })], cfg({ slippageCents: 0.05, stake: 100 }));
    const exactEntry = 0.9995;
    expect(run.trades[0].entry).toBeCloseTo(exactEntry, 12);
    expect(run.trades[0].pnl).toBeCloseTo(100 * (1 / exactEntry - 1), 12);
    expect(run.metrics.pnl).toBeCloseTo(100 * (1 / exactEntry - 1), 12);
    expect(run.metrics.roi).toBeCloseTo(1 / exactEntry - 1, 12);
    expect(run.metrics.breakEven).toBeCloseTo(exactEntry, 12);
  });
});

describe('chronological split', () => {
  it('keeps snapshots, coins in the same ET hour, and each market together', () => {
    const rows = [row(1), row(1, 50), row(2), row(2, 40, { coin: 'ETH', market_slug: 'eth-2' }), row(3), row(4)];
    const split = createLabSplit(rows, 0.5);
    expect(split).toMatchObject({ trainHours: 2, holdoutHours: 2, cutoff: '2026-10-01 03' });
    expect(split.trainMarketKeys).toContain('BTC_market-2');
    expect(split.trainMarketKeys).toContain('ETH_eth-2');
    expect(split.holdoutMarketKeys.every((key) => !split.trainMarketKeys.includes(key))).toBe(true);
  });
  it('moves a boundary backward if one market spans it, preserving strict chronology', () => {
    const split = createLabSplit([row(1), row(2), row(3, 35, { market_slug: 'market-2' }), row(4)], 0.5);
    expect(split).toMatchObject({ trainHours: 1, holdoutHours: 3, cutoff: '2026-10-01 02' });
    expect(split.holdoutMarketKeys).toContain('BTC_market-2');
  });
});

describe('bounded optimizer', () => {
  it('ranks only on training results even when the holdout prefers another candidate', async () => {
    const rows = [
      row(1, 35, { score_confidence: 90, up_1h_num: 50 }),
      row(2, 35, { score_confidence: 95, up_1h_num: 80 }),
      row(3, 35, { score_confidence: 90, market_outcome: 'DOWN' }),
      row(4, 35, { score_confidence: 95, up_1h_num: 80 }),
    ];
    const result = await optimizeLab(rows, cfg(), options({ confidence: { min: 90, max: 95, step: 5 } }));
    expect(result.evaluated).toBe(2);
    expect(result.candidates[0].config.bullishMinConf).toBe(90);
    expect(result.candidates[0].train.pnl).toBeGreaterThan(result.candidates[1].train.pnl);
    expect(result.candidates[0].holdout.pnl).toBeLessThan(result.candidates[1].holdout.pnl);
    const changedHoldout = rows.map((item, index) => index >= 2 ? { ...item, market_outcome: 'UP' as const } : item);
    const changed = await optimizeLab(changedHoldout, cfg(), options({ confidence: { min: 90, max: 95, step: 5 } }));
    expect(changed.candidates.map((candidate) => candidate.id)).toEqual(result.candidates.map((candidate) => candidate.id));
  });
  it('keeps early weak opposite signals when applying the minute window and splitting', async () => {
    const rows = [row(1), row(2),
      row(3, 5, { score: 0.2, score_confidence: 20, direction: 'DOWN' }), row(3, 40), row(4, 40)];
    const result = await optimizeLab(rows, cfg({ noPriorOpposite: true }), options({ minMinute: { min: 30, max: 30, step: 5 } }));
    expect(result.candidates[0].train.resolved).toBe(2);
    expect(result.candidates[0].holdout.resolved).toBe(1);
  });
  it('preserves beforeFilters selection and minimum training sample requirements', async () => {
    const rows = [row(1, 5), row(1, 40), row(2, 40), row(3, 40), row(4, 40)];
    const result = await optimizeLab(rows, cfg({ pickOrder: 'beforeFilters' }), options({ minMinute: { min: 30, max: 30, step: 1 } }));
    expect(result.candidates[0].train.resolved).toBe(1);
    const tooFew = await optimizeLab(rows, cfg({ pickOrder: 'beforeFilters' }), options({ minimumTrainResolved: 2, minMinute: { min: 30, max: 30, step: 1 } }));
    expect(tooFew.candidates).toHaveLength(0);
  });
  it('rejects a grid above the hard cap or with invalid steps instead of silently truncating', async () => {
    await expect(optimizeLab([], cfg(), options({ confidence: { min: 0, max: 100, step: 1 }, minMinute: { min: 0, max: 10, step: 1 } }))).rejects.toThrow(RangeError);
    await expect(optimizeLab([], cfg(), options({ maxEntry: { min: 0, max: 100, step: 0 } }))).rejects.toThrow(RangeError);
    await expect(optimizeLab([], cfg(), options({ maxCombinations: 401 }))).rejects.toThrow(RangeError);
  });
  it('searches the TimesFM thresholds as extra dimensions and tags the candidates', async () => {
    const rows = [row(1, 35, { tfm_prob_up: 70 }), row(2, 35, { tfm_prob_up: 30 }), row(3, 35, { tfm_prob_up: 70 }), row(4, 35, { tfm_prob_up: 30 })];
    const plain = await optimizeLab(rows, cfg(), options());
    const withProb = await optimizeLab(rows, cfg(), options({ tfmMinProb: { min: 0, max: 50, step: 50 } }));
    expect(withProb.totalCombinations).toBe(plain.totalCombinations * 2);
    expect(withProb.evaluated).toBe(plain.evaluated * 2);
    expect(plain.candidates[0].id).toBe('90-0-100');
    expect(withProb.candidates.map((c) => c.id).sort()).toEqual(['90-0-100-p0-e-100', '90-0-100-p50-e-100']);
    const strict = withProb.candidates.find((c) => c.config.tfmMinProb === 50)!;
    const loose = withProb.candidates.find((c) => c.config.tfmMinProb === 0)!;
    expect(strict.config.tfmMinEdge).toBe(-100);
    expect(strict.train.trades + strict.holdout.trades).toBe(2);
    expect(loose.train.trades + loose.holdout.trades).toBe(4);
    const both = await optimizeLab(rows, cfg(), options({ tfmMinProb: { min: 0, max: 50, step: 50 }, tfmMinEdge: { min: -100, max: 0, step: 100 } }));
    expect(both.totalCombinations).toBe(plain.totalCombinations * 4);
  });
  it('uses the config TimesFM values as the only value when no range is given', async () => {
    const rows = [row(1, 35, { tfm_prob_up: 70 }), row(2, 35, { tfm_prob_up: 30 }), row(3, 35, { tfm_prob_up: 70 }), row(4, 35, { tfm_prob_up: 30 })];
    const result = await optimizeLab(rows, cfg({ tfmMinProb: 50 }), options());
    expect(result.totalCombinations).toBe(1);
    expect(result.candidates[0].config.tfmMinProb).toBe(50);
    expect(result.candidates[0].id).toBe('90-0-100');
    expect(result.candidates[0].train.trades + result.candidates[0].holdout.trades).toBe(2);
  });
  it('rejects an invalid TimesFM range', async () => {
    await expect(optimizeLab([], cfg(), options({ tfmMinProb: { min: 0, max: 150, step: 10 } }))).rejects.toThrow(RangeError);
    await expect(optimizeLab([], cfg(), options({ tfmMinEdge: { min: -200, max: 0, step: 10 } }))).rejects.toThrow(RangeError);
  });
  it('reports progress and responds to cancellation without completing the remaining grid', async () => {
    const controller = new AbortController();
    const progress: number[] = [];
    const result = await optimizeLab([row(1), row(2)], cfg(), options({
      confidence: { min: 80, max: 100, step: 5 }, signal: controller.signal,
      onProgress: (evaluated) => { progress.push(evaluated); if (evaluated === 2) controller.abort(); },
    }));
    expect(progress).toEqual([0, 1, 2]);
    expect(result).toMatchObject({ evaluated: 2, totalCombinations: 5, cancelled: true });
  });
});
