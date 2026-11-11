import { JEV_COINS } from './coins';
import { sanitizeFilterGroups, type FilterGroup } from './fieldFilters';
import { tradeFilterFields } from './snapshotFilterFields';
import {
  DEFAULT_ANALYSIS_CONFIG,
  buildTrades,
  computeMetrics,
  filterBaseRows,
  marketKey,
  parseEtTime,
  tradePnl,
  type AnalysisConfig,
  type Metrics,
  type SnapshotRow,
  type Trade,
} from './signalAnalysis';

const MAX_COMBINATIONS = 400;
const COINS = JEV_COINS.map((coin) => coin.toUpperCase());
const RULE_FIELDS = new Map(tradeFilterFields(COINS)
  .filter((field) => !['market_outcome', 'trade_result'].includes(field.id))
  .map((field) => [field.id, field]));

function object(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function bounded(value: unknown, fallback: number, min: number, max: number, integer = false): number {
  const valid = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  const result = Math.max(min, Math.min(max, valid));
  return integer ? Math.round(result) : result;
}

function choice<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return values.includes(value as T) ? value as T : fallback;
}

function validDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

/** Import/browser storage is untrusted. Outcome fields are never executable strategy rules. */
export function sanitizeLabConfig(input: unknown): AnalysisConfig {
  const raw = object(input);
  const defaults = DEFAULT_ANALYSIS_CONFIG;
  const number = (key: keyof AnalysisConfig, min: number, max: number, integer = false) =>
    bounded(raw[key], defaults[key] as number, min, max, integer);
  const flag = (key: keyof AnalysisConfig) => typeof raw[key] === 'boolean' ? raw[key] as boolean : defaults[key] as boolean;
  const ordered = (a: number, b: number): [number, number] => [Math.min(a, b), Math.max(a, b)];
  const [minMinute, maxMinute] = ordered(number('minMinute', 0, 59, true), number('maxMinute', 0, 59, true));
  const [minEntry, maxEntry] = ordered(number('minEntry', 0, 100), number('maxEntry', 0, 100));
  const [bullishMinConf, bullishMaxConf] = ordered(number('bullishMinConf', 0, 100), number('bullishMaxConf', 0, 100));
  const [bearishMinConf, bearishMaxConf] = ordered(number('bearishMinConf', 0, 100), number('bearishMaxConf', 0, 100));
  let dateFrom = validDate(raw.dateFrom), dateTo = validDate(raw.dateTo);
  if (dateFrom && dateTo && dateFrom > dateTo) [dateFrom, dateTo] = [dateTo, dateFrom];
  const fieldFilters: FilterGroup[] = sanitizeFilterGroups(raw.fieldFilters)
    .map((group) => ({ ...group, conditions: group.conditions.filter((condition) => {
      const field = RULE_FIELDS.get(condition.field);
      return field && (field.kind === 'choice' ? ['in', 'notIn'].includes(condition.op) : !['in', 'notIn'].includes(condition.op));
    }).map((condition) => {
      const field = RULE_FIELDS.get(condition.field)!;
      return field.kind === 'choice'
        ? { ...condition, values: condition.values.filter((value) => field.choices?.some((item) => item.value === value)) }
        : condition;
    }) }))
    .filter((group) => group.conditions.length > 0);
  return {
    coins: Array.isArray(raw.coins) ? [...new Set(raw.coins.filter((coin): coin is string => typeof coin === 'string').map((coin) => coin.toUpperCase()).filter((coin) => COINS.includes(coin)))] : [],
    dateFrom, dateTo,
    hoursOfDay: Array.isArray(raw.hoursOfDay) ? [...new Set(raw.hoursOfDay.filter((hour): hour is number => typeof hour === 'number' && Number.isInteger(hour) && hour >= 0 && hour <= 23))] : [],
    model: choice(raw.model, ['jev', 'kev', 'span', 'solar', 'tev', 'mercury', 'liquid', 'tfm', 'avg'], defaults.model),
    confidenceType: choice(raw.confidenceType, ['score', 'direction'], defaults.confidenceType),
    bullishScore: number('bullishScore', 0, 4),
    bearishScore: number('bearishScore', 0, 4),
    bullishMinConf, bullishMaxConf, bearishMinConf, bearishMaxConf,
    directions: choice(raw.directions, ['both', 'UP', 'DOWN'], defaults.directions),
    consensus: choice(raw.consensus, ['none', '2of3', '3of3'], defaults.consensus),
    solarAgrees: flag('solarAgrees'),
    solarMinConf: number('solarMinConf', 0, 100),
    tfmMinProb: number('tfmMinProb', 0, 100),
    tfmMinEdge: number('tfmMinEdge', -100, 100),
    noPriorOpposite: flag('noPriorOpposite'),
    minMinute, maxMinute, minEntry, maxEntry, fieldFilters,
    dedupe: choice(raw.dedupe, ['all', 'firstPerHour', 'firstPerHourDir'], defaults.dedupe),
    pickOrder: choice(raw.pickOrder, ['afterFilters', 'beforeFilters'], defaults.pickOrder),
    stake: number('stake', 0.01, 1_000_000),
    slippageCents: number('slippageCents', 0, 100),
  };
}

export interface LabRun {
  rows: SnapshotRow[];
  trades: Trade[];
  metrics: Metrics;
  missingPriceCount: number;
}

/** Keep unknown/zero/impossible entry prices out of both P&L and the win-rate denominator. */
export function runLab(rows: SnapshotRow[], config: AnalysisConfig): LabRun {
  const cfg = sanitizeLabConfig(config);
  const baseRows = filterBaseRows(rows, cfg);
  const candidates = buildTrades(baseRows, cfg);
  const trades: Trade[] = [];
  for (const trade of candidates) {
    if (trade.quote == null || !Number.isFinite(trade.quote) || trade.quote <= 0 || trade.quote >= 1) continue;
    const entry = trade.quote + cfg.slippageCents / 100;
    if (!Number.isFinite(entry) || entry <= 0 || entry >= 1) continue;
    // buildTrades has a legacy .999 cap. Lab results use the exact payable price, even near $1.
    trades.push({ ...trade, entry, pnl: tradePnl(trade.status, entry, cfg.stake) });
  }
  return { rows: baseRows, trades, metrics: computeMetrics(trades, cfg.stake), missingPriceCount: candidates.length - trades.length };
}

export interface LabSplit {
  trainMarketKeys: string[];
  holdoutMarketKeys: string[];
  trainHours: number;
  holdoutHours: number;
  trainFraction: number;
  /** First holdout hour in YYYY-MM-DD HH form, ET. */
  cutoff: string | null;
}

/** Split entire ET hours across all coins; a market spanning the boundary stays wholly in holdout. */
export function createLabSplit(rows: SnapshotRow[], trainFraction = 0.7): LabSplit {
  if (!Number.isFinite(trainFraction) || trainFraction <= 0 || trainFraction >= 1) {
    throw new RangeError('Training fraction must be between 0 and 1.');
  }
  const markets = new Map<string, Set<string>>();
  const allHours = new Set<string>();
  for (const row of rows) {
    const parsed = parseEtTime(row.et_time);
    if (!parsed) continue;
    const hour = `${parsed.date} ${String(parsed.hour).padStart(2, '0')}`;
    const key = marketKey(row);
    const hours = markets.get(key) ?? new Set<string>();
    hours.add(hour);
    markets.set(key, hours);
    allHours.add(hour);
  }
  const hours = [...allHours].sort();
  let cut = hours.length > 1 ? Math.max(1, Math.min(hours.length - 1, Math.floor(hours.length * trainFraction))) : hours.length;
  const positions = new Map(hours.map((hour, index) => [hour, index]));
  // Moving the boundary backward, rather than splitting a market, also preserves strict chronology.
  let moved = true;
  while (moved) {
    moved = false;
    for (const marketHours of markets.values()) {
      const indexes = [...marketHours].map((hour) => positions.get(hour)!);
      const min = Math.min(...indexes), max = Math.max(...indexes);
      if (min < cut && max >= cut) { cut = min; moved = true; }
    }
  }
  const trainMarketKeys: string[] = [], holdoutMarketKeys: string[] = [];
  for (const [key, marketHours] of markets) {
    const first = Math.min(...[...marketHours].map((hour) => positions.get(hour)!));
    (first < cut ? trainMarketKeys : holdoutMarketKeys).push(key);
  }
  return { trainMarketKeys, holdoutMarketKeys, trainHours: cut, holdoutHours: hours.length - cut, trainFraction, cutoff: hours[cut] ?? null };
}

export interface LabRange { min: number; max: number; step: number }
export type LabObjective = 'pnl' | 'roi' | 'winRate';
export interface LabOptimizationOptions {
  confidence: LabRange;
  minMinute: LabRange;
  maxEntry: LabRange;
  /** Optional TimesFM confirmer thresholds (0..100 %, -100..100 cents). Absent = the config's value is the only value. */
  tfmMinProb?: LabRange;
  tfmMinEdge?: LabRange;
  minimumTrainResolved: number;
  objective: LabObjective;
  trainFraction?: number;
  maxCombinations?: number;
  signal?: AbortSignal;
  onProgress?: (evaluated: number, total: number) => void;
}
export interface LabCandidate {
  id: string;
  config: AnalysisConfig;
  train: Metrics;
  holdout: Metrics;
}
export interface LabOptimizationResult {
  candidates: LabCandidate[];
  split: LabSplit;
  evaluated: number;
  totalCombinations: number;
  cancelled: boolean;
}

function rangeValues(range: LabRange, min: number, max: number, integer = false): number[] {
  if (![range.min, range.max, range.step].every(Number.isFinite)
    || range.min < min || range.max > max || range.min > range.max || range.step <= 0
    || (integer && ![range.min, range.max, range.step].every(Number.isInteger))) {
    throw new RangeError(`Invalid search range; expected ${min}–${max} and a positive step.`);
  }
  const count = Math.floor((range.max - range.min) / range.step + 1e-8) + 1;
  if (!Number.isSafeInteger(count) || count > MAX_COMBINATIONS) throw new RangeError(`Search exceeds ${MAX_COMBINATIONS} combinations.`);
  return Array.from({ length: count }, (_, index) => Number((range.min + range.step * index).toFixed(8)));
}

/** The holdout is measured only after candidate selection; its outcomes never affect ranking. */
export async function optimizeLab(rows: SnapshotRow[], config: AnalysisConfig, options: LabOptimizationOptions): Promise<LabOptimizationResult> {
  const cfg = sanitizeLabConfig(config);
  const confidence = rangeValues(options.confidence, 0, 100);
  const minutes = rangeValues(options.minMinute, 0, 59, true);
  const prices = rangeValues(options.maxEntry, 0, 100);
  const tfmProbs = options.tfmMinProb ? rangeValues(options.tfmMinProb, 0, 100) : [cfg.tfmMinProb];
  const tfmEdges = options.tfmMinEdge ? rangeValues(options.tfmMinEdge, -100, 100) : [cfg.tfmMinEdge];
  const tfmSearched = !!(options.tfmMinProb || options.tfmMinEdge);
  const totalCombinations = confidence.length * minutes.length * prices.length * tfmProbs.length * tfmEdges.length;
  const cap = options.maxCombinations ?? MAX_COMBINATIONS;
  if (!Number.isInteger(cap) || cap < 1 || cap > MAX_COMBINATIONS || totalCombinations > cap) {
    throw new RangeError(`Search has ${totalCombinations} combinations; the limit is ${Math.min(MAX_COMBINATIONS, cap)}.`);
  }
  if (!Number.isInteger(options.minimumTrainResolved) || options.minimumTrainResolved < 1) throw new RangeError('Minimum training trades must be a positive integer.');
  if (!['pnl', 'roi', 'winRate'].includes(options.objective)) throw new RangeError('Unknown optimization objective.');
  const baseRows = filterBaseRows(rows, cfg);
  const split = createLabSplit(baseRows, options.trainFraction ?? 0.7);
  const trainKeys = new Set(split.trainMarketKeys);
  const holdoutKeys = new Set(split.holdoutMarketKeys);
  const candidates: LabCandidate[] = [];
  let evaluated = 0;
  options.onProgress?.(0, totalCombinations);
  for (const conf of confidence) for (const minute of minutes) for (const maxEntry of prices) for (const tfmMinProb of tfmProbs) for (const tfmMinEdge of tfmEdges) {
    if (options.signal?.aborted) return { candidates: rank(candidates, options.objective), split, evaluated, totalCombinations, cancelled: true };
    const candidateConfig = { ...cfg, bullishMinConf: conf, bearishMinConf: conf, minMinute: minute, maxEntry, tfmMinProb, tfmMinEdge };
    // A range may be valid in isolation but contradict the fixed opposite bound. Do not silently swap it.
    if (conf <= cfg.bullishMaxConf && conf <= cfg.bearishMaxConf && minute <= cfg.maxMinute && maxEntry >= cfg.minEntry) {
      // Build once on the complete history, then partition trades. Earlier weak/opposite signals survive.
      const run = runLab(baseRows, candidateConfig);
      const train = computeMetrics(run.trades.filter((trade) => trainKeys.has(trade.marketKey)), cfg.stake);
      if (train.resolved >= options.minimumTrainResolved) {
        candidates.push({
          id: `${conf}-${minute}-${maxEntry}${tfmSearched ? `-p${tfmMinProb}-e${tfmMinEdge}` : ''}`,
          config: candidateConfig,
          train,
          holdout: computeMetrics(run.trades.filter((trade) => holdoutKeys.has(trade.marketKey)), cfg.stake),
        });
      }
    }
    evaluated++;
    options.onProgress?.(evaluated, totalCombinations);
    if (evaluated % 4 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return { candidates: rank(candidates, options.objective), split, evaluated, totalCombinations, cancelled: false };
}

function rank(candidates: LabCandidate[], objective: LabObjective): LabCandidate[] {
  return candidates.sort((a, b) => (b.train[objective] ?? -Infinity) - (a.train[objective] ?? -Infinity)
    || b.train.resolved - a.train.resolved || a.id.localeCompare(b.id));
}
