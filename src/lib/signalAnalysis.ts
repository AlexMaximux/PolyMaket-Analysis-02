// Honest backtest of Jev/Kev/Span signals against resolved Polymarket 1h markets.
// Pure functions only, so the page and the tests share one implementation.

export type Dir = "UP" | "DOWN";
export type ModelSource = "jev" | "kev" | "span" | "solar" | "avg";
export type ConsensusRule = "none" | "2of3" | "3of3";
export type DedupeMode = "all" | "firstPerHour" | "firstPerHourDir";
// afterFilters: first snapshot of the hour that passes every filter becomes the trade.
// beforeFilters: the hour's first raw signal is the trade; if it fails a filter the hour is skipped.
export type PickOrder = "afterFilters" | "beforeFilters";
export type TradeStatus = "WIN" | "LOSS" | "PENDING";

export interface SnapshotRow {
  filename: string;
  coin?: string;
  et_time: string;
  timestamp?: string | null;
  score?: number | null;
  direction?: Dir | null;
  score_confidence?: number | null;
  direction_confidence?: number | null;
  kev_direction?: Dir | null;
  kev_score?: number | null;
  kev_confidence?: number | null;
  kev_score_confidence?: number | null;
  kev_direction_confidence?: number | null;
  span_direction?: Dir | null;
  span_score?: number | null;
  span_confidence?: number | null;
  solar_direction?: Dir | null;
  solar_score?: number | null;
  solar_confidence?: number | null;
  solar_score_confidence?: number | null;
  solar_direction_confidence?: number | null;
  consensus_agreement?: number | null;
  up_1h_num?: number | null;
  market_slug?: string | null;
  market_outcome?: "UP" | "DOWN" | "PENDING" | null;
}

export interface AnalysisConfig {
  coins: string[]; // empty = all coins
  dateFrom: string | null; // "YYYY-MM-DD" (ET), inclusive
  dateTo: string | null;
  hoursOfDay: number[]; // ET hours 0-23, empty = all

  model: ModelSource;
  confidenceType: "score" | "direction";
  bullishScore: number;
  bearishScore: number;
  bullishMinConf: number;
  bearishMinConf: number;
  directions: "both" | Dir;

  consensus: ConsensusRule;
  // Extra filter, separate from `consensus` (which counts Jev/Kev/Span only): Solar-Decide must
  // point the same way as the signal. Rows recorded before Solar existed have no direction and fail it.
  solarAgrees: boolean;
  solarMinConf: number; // Solar score confidence, %; 0 = off. Rows without a Solar prediction fail when > 0.
  minMinute: number; // minute of the hour the signal appeared, inclusive
  maxMinute: number; // inclusive
  minEntry: number; // price paid for the chosen side, in cents, inclusive
  maxEntry: number;

  dedupe: DedupeMode;
  pickOrder: PickOrder;

  stake: number; // dollars per trade
  slippageCents: number; // added to the quoted price
}

export const DEFAULT_ANALYSIS_CONFIG: AnalysisConfig = {
  coins: [],
  dateFrom: null,
  dateTo: null,
  hoursOfDay: [],
  model: "jev",
  confidenceType: "score",
  bullishScore: 3.5,
  bearishScore: 0.5,
  bullishMinConf: 90,
  bearishMinConf: 90,
  directions: "both",
  consensus: "none",
  solarAgrees: false,
  solarMinConf: 0,
  minMinute: 0,
  maxMinute: 59,
  minEntry: 0,
  maxEntry: 100,
  dedupe: "firstPerHourDir",
  pickOrder: "afterFilters",
  stake: 10,
  slippageCents: 0,
};

// The strategy under forward test, and its history. Each entry's `rule` is locked once `frozenAt`
// passes: do not edit a past entry's rule, since that would rewrite the forward test after the fact.
// To change the rule, close the current entry with `frozenUntil` and append a new one (see below).
// Stake and slippage stay user settings on the page (they are money, not the rule).
export interface FrozenStrategy {
  id: string;
  name: string;
  note: string; // why this version exists / what changed from the last one
  frozenAt: string; // ISO; only signals from snapshots at or after this count as forward results
  frozenUntil: string | null; // ISO; null = current. Forward window is [frozenAt, frozenUntil).
  rule: AnalysisConfig;
  checkpoints: number[];
}

const baseRule = (over: Partial<AnalysisConfig>): AnalysisConfig => ({
  ...DEFAULT_ANALYSIS_CONFIG,
  coins: ["BTC"],
  model: "jev",
  consensus: "3of3",
  dedupe: "firstPerHour",
  pickOrder: "afterFilters",
  ...over,
});

export const STRATEGY_HISTORY: FrozenStrategy[] = [
  {
    id: "v1",
    name: "BTC · Jev + Kev + Span all agree · first signal per hour",
    note: "First freeze. Backtest was 22W/1L (95.7%). Forward result over 23 trades came in at 19W/3L/1P (86.4%), roughly break-even — the backtest's edge did not fully hold up.",
    frozenAt: "2026-09-26T18:43:16.000Z", // 14:43 ET
    frozenUntil: "2026-09-27T16:53:14.000Z", // 12:53 ET Sep 27 — closed when v2 was adopted
    rule: baseRule({}),
    checkpoints: [10, 20, 30, 50],
  },
  {
    id: "v2",
    name: "BTC · Jev + Kev + Span all agree · first signal after minute 31 of the hour",
    note: "Added a minute filter: a signal in the first half of the hour is ignored, only the first qualifying signal at minute 32+ counts. Chosen because, in v1's own forward data, all 3 losses came from signals before minute 31 — so this is a hindsight-informed change and needs its own clean forward test, not credit for v1's history.",
    frozenAt: "2026-09-27T16:53:14.000Z", // 12:53 ET
    frozenUntil: null,
    rule: baseRule({ minMinute: 32 }),
    checkpoints: [10, 20, 30, 50],
  },
];

export const FROZEN_STRATEGY = STRATEGY_HISTORY[STRATEGY_HISTORY.length - 1];

// A second forward test that runs alongside FROZEN_STRATEGY, not after it: v2 keeps its own window and
// result. It is v2's rule plus one filter, so the two can be compared over the same hours.
// The 80% threshold was picked after looking at BTC history with Solar backfilled (it removed 4 of 9
// losses in-sample), so the backtest before `frozenAt` is optimistic and only the forward window counts.
export const FROZEN_STRATEGY_2: FrozenStrategy = {
  id: "s2",
  name: "BTC · Jev + Kev + Span all agree · minute 32+ · Solar confidence ≥ 80%",
  note: "Strategy 1 (v2) plus a Solar-Decide filter: Solar's score confidence must be at least 80%. Solar pointing the same way was not useful on its own (it agreed on every v2 trade). Runs in parallel with v2 so both are scored on the same hours. Rows without a Solar prediction cannot trade.",
  frozenAt: "2026-09-29T09:50:00.000Z", // 05:50 ET
  frozenUntil: null,
  rule: baseRule({ minMinute: 32, solarMinConf: 80 }),
  checkpoints: [10, 20, 30, 50],
};

export interface Trade {
  row: SnapshotRow;
  coin: string;
  marketKey: string;
  time: number;
  minute: number;
  hour: number;
  date: string;
  dir: Dir;
  modelScore: number;
  modelConf: number;
  agreeCount: number; // how many of Jev/Kev/Span point the same way as the signal
  quote: number | null; // quoted price of the chosen side, 0-1
  entry: number | null; // quote + slippage, 0-1
  status: TradeStatus;
  pnl: number; // 0 while pending
}

export interface Metrics {
  trades: number;
  wins: number;
  losses: number;
  pending: number;
  resolved: number;
  winRate: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  breakEven: number | null; // win rate needed for zero P&L at the prices actually paid
  avgEntry: number | null;
  edge: number | null; // winRate - breakEven
  pnl: number;
  roi: number | null; // pnl / money staked on resolved trades
  evPerTrade: number | null;
  maxDrawdown: number;
  maxLossStreak: number;
  lateCount: number; // signals at minute >= LATE_MINUTE
}

export const LATE_MINUTE = 50;

export function parseEtTime(et: string): { date: string; hour: number; minute: number } | null {
  const m = et?.match(/^(\d{4}-\d{2}-\d{2})[ _T](\d{2})[:-](\d{2})/);
  if (!m) return null;
  return { date: m[1], hour: parseInt(m[2], 10), minute: parseInt(m[3], 10) };
}

export function rowTime(r: SnapshotRow): number {
  const t = r.timestamp ? new Date(r.timestamp).getTime() : NaN;
  return isNaN(t) ? 0 : t;
}

export function sortChrono<T extends SnapshotRow>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const ta = rowTime(a);
    const tb = rowTime(b);
    if (ta && tb) return ta - tb;
    return a.filename.localeCompare(b.filename);
  });
}

// Same rule as the Jev dashboard signal marker.
export function detectSignal(
  r: SnapshotRow,
  cfg: Pick<AnalysisConfig, "model" | "confidenceType" | "bullishScore" | "bearishScore" | "bullishMinConf" | "bearishMinConf">,
): { dir: Dir; score: number; conf: number } | null {
  let score: number | null | undefined;
  let conf: number | null | undefined;
  if (cfg.model === "kev") {
    score = r.kev_score;
    conf = cfg.confidenceType === "direction"
      ? r.kev_direction_confidence ?? r.kev_confidence
      : r.kev_score_confidence ?? r.kev_confidence;
  } else if (cfg.model === "span") {
    score = r.span_score;
    conf = r.span_confidence;
  } else if (cfg.model === "solar") {
    score = r.solar_score;
    conf = cfg.confidenceType === "direction"
      ? r.solar_direction_confidence ?? r.solar_confidence
      : r.solar_score_confidence ?? r.solar_confidence;
  } else if (cfg.model === "avg") {
    const scores = [r.score, r.kev_score, r.span_score].filter((s): s is number => s != null);
    score = scores.length ? Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)) : null;
    conf = r.consensus_agreement ?? r.score_confidence;
  } else {
    score = r.score;
    conf = cfg.confidenceType === "direction" ? r.direction_confidence : r.score_confidence;
  }
  if (score == null || conf == null || isNaN(conf)) return null;
  if (score > cfg.bullishScore && conf >= cfg.bullishMinConf) return { dir: "UP", score, conf };
  if (score < cfg.bearishScore && conf >= cfg.bearishMinConf) return { dir: "DOWN", score, conf };
  return null;
}

export function agreeCount(r: SnapshotRow, dir: Dir): number {
  return [r.direction, r.kev_direction, r.span_direction].filter((d) => d === dir).length;
}

export function marketKey(r: SnapshotRow): string {
  const coin = (r.coin || r.filename.split("_")[0] || "").toUpperCase();
  if (r.market_slug) return `${coin}_${r.market_slug}`;
  const p = parseEtTime(r.et_time);
  return p ? `${coin}_${p.date}_${p.hour}` : r.filename;
}

export function sidePrice(r: SnapshotRow, dir: Dir): number | null {
  if (r.up_1h_num == null || isNaN(r.up_1h_num)) return null;
  const up = r.up_1h_num / 100;
  return dir === "UP" ? up : 1 - up;
}

export function tradeStatus(r: SnapshotRow, dir: Dir): TradeStatus {
  const o = r.market_outcome;
  if (o !== "UP" && o !== "DOWN") return "PENDING";
  return o === dir ? "WIN" : "LOSS";
}

// Buying `stake` dollars of shares at `entry`: a win pays $1 per share, a loss loses the stake.
export function tradePnl(status: TradeStatus, entry: number | null, stake: number): number {
  if (status === "PENDING" || entry == null || entry <= 0) return 0;
  return status === "WIN" ? stake * (1 / entry - 1) : -stake;
}

export function wilson(wins: number, n: number, z = 1.96): { low: number; high: number } | null {
  if (n <= 0) return null;
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

export function filterBaseRows<T extends SnapshotRow>(rows: T[], cfg: AnalysisConfig): T[] {
  const coins = new Set(cfg.coins.map((c) => c.toUpperCase()));
  const hours = new Set(cfg.hoursOfDay);
  return rows.filter((r) => {
    if (coins.size && !coins.has((r.coin || "").toUpperCase())) return false;
    const p = parseEtTime(r.et_time);
    if (!p) return false;
    if (cfg.dateFrom && p.date < cfg.dateFrom) return false;
    if (cfg.dateTo && p.date > cfg.dateTo) return false;
    if (hours.size && !hours.has(p.hour)) return false;
    return true;
  });
}

function buildCandidate(r: SnapshotRow, cfg: AnalysisConfig): Trade | null {
  const sig = detectSignal(r, cfg);
  if (!sig) return null;
  const p = parseEtTime(r.et_time);
  if (!p) return null;
  const quote = sidePrice(r, sig.dir);
  const entry = quote == null ? null : Math.min(0.999, quote + cfg.slippageCents / 100);
  const status = tradeStatus(r, sig.dir);
  return {
    row: r,
    coin: (r.coin || "").toUpperCase(),
    marketKey: marketKey(r),
    time: rowTime(r),
    minute: p.minute,
    hour: p.hour,
    date: p.date,
    dir: sig.dir,
    modelScore: sig.score,
    modelConf: sig.conf,
    agreeCount: agreeCount(r, sig.dir),
    quote,
    entry,
    status,
    pnl: tradePnl(status, entry, cfg.stake),
  };
}

function passesFilters(t: Trade, cfg: AnalysisConfig): boolean {
  if (cfg.directions !== "both" && t.dir !== cfg.directions) return false;
  if (cfg.consensus === "2of3" && t.agreeCount < 2) return false;
  if (cfg.consensus === "3of3" && t.agreeCount < 3) return false;
  if (cfg.solarAgrees && t.row.solar_direction !== t.dir) return false;
  if (cfg.solarMinConf > 0 && !((t.row.solar_score_confidence ?? -1) >= cfg.solarMinConf)) return false;
  if (t.minute < cfg.minMinute || t.minute > cfg.maxMinute) return false;
  const priceFilterOn = cfg.minEntry > 0 || cfg.maxEntry < 100;
  if (priceFilterOn) {
    if (t.quote == null) return false;
    const cents = t.quote * 100;
    if (cents < cfg.minEntry || cents > cfg.maxEntry) return false;
  }
  return true;
}

function dedupeKey(t: Trade, mode: DedupeMode): string {
  if (mode === "firstPerHour") return t.marketKey;
  if (mode === "firstPerHourDir") return `${t.marketKey}_${t.dir}`;
  return t.row.filename;
}

function keepFirst(trades: Trade[], mode: DedupeMode): Trade[] {
  if (mode === "all") return trades;
  const seen = new Set<string>();
  const out: Trade[] = [];
  for (const t of trades) {
    const k = dedupeKey(t, mode);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

// Rows must already be base-filtered (coin/date/hour). Returns trades oldest first.
export function buildTrades(baseRows: SnapshotRow[], cfg: AnalysisConfig): Trade[] {
  const candidates = sortChrono(baseRows)
    .map((r) => buildCandidate(r, cfg))
    .filter((t): t is Trade => t != null);
  if (cfg.pickOrder === "beforeFilters") {
    return keepFirst(candidates, cfg.dedupe).filter((t) => passesFilters(t, cfg));
  }
  return keepFirst(candidates.filter((t) => passesFilters(t, cfg)), cfg.dedupe);
}

export function computeMetrics(trades: Trade[], stake: number): Metrics {
  let wins = 0, losses = 0, pending = 0, pnl = 0, lateCount = 0;
  let invPriceSum = 0, priceSum = 0, priced = 0;
  let equity = 0, peak = 0, maxDrawdown = 0, lossStreak = 0, maxLossStreak = 0;
  for (const t of trades) {
    if (t.minute >= LATE_MINUTE) lateCount++;
    if (t.status === "PENDING") { pending++; continue; }
    if (t.status === "WIN") { wins++; lossStreak = 0; } else { losses++; lossStreak++; }
    maxLossStreak = Math.max(maxLossStreak, lossStreak);
    if (t.entry != null && t.entry > 0) {
      invPriceSum += 1 / t.entry;
      priceSum += t.entry;
      priced++;
    }
    pnl += t.pnl;
    equity += t.pnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  const resolved = wins + losses;
  const winRate = resolved ? wins / resolved : null;
  const ci = wilson(wins, resolved);
  // With a fixed stake, zero P&L needs winRate = 1 / mean(1/entry): the harmonic mean of prices paid.
  const breakEven = priced ? priced / invPriceSum : null;
  return {
    trades: trades.length,
    wins,
    losses,
    pending,
    resolved,
    winRate,
    ciLow: ci?.low ?? null,
    ciHigh: ci?.high ?? null,
    breakEven,
    avgEntry: priced ? priceSum / priced : null,
    edge: winRate != null && breakEven != null ? winRate - breakEven : null,
    pnl,
    roi: priced && stake > 0 ? pnl / (stake * priced) : null,
    evPerTrade: resolved ? pnl / resolved : null,
    maxDrawdown,
    maxLossStreak,
    lateCount,
  };
}

export type Verdict = "NO_DATA" | "TOO_FEW" | "EDGE_LIKELY" | "POSITIVE_UNPROVEN" | "NO_EDGE";

export const MIN_RESOLVED_FOR_VERDICT = 30;

// EDGE_LIKELY, not "proven": the interval assumes independent trades, which correlated coins are not.
export function verdictOf(m: Metrics): Verdict {
  if (!m.resolved || m.winRate == null) return "NO_DATA";
  if (m.breakEven != null && m.ciLow != null && m.ciLow > m.breakEven && m.resolved >= MIN_RESOLVED_FOR_VERDICT) {
    return "EDGE_LIKELY";
  }
  if (m.resolved < MIN_RESOLVED_FOR_VERDICT) return "TOO_FEW";
  if (m.breakEven != null && m.winRate > m.breakEven) return "POSITIVE_UNPROVEN";
  return "NO_EDGE";
}

// Hours where the first signal and a later opposite-direction signal both became trades.
export function conflictingHours(trades: Trade[]): string[] {
  const dirs = new Map<string, Set<Dir>>();
  for (const t of trades) {
    if (!dirs.has(t.marketKey)) dirs.set(t.marketKey, new Set());
    dirs.get(t.marketKey)!.add(t.dir);
  }
  return [...dirs.entries()].filter(([, s]) => s.size > 1).map(([k]) => k);
}

export interface BreakdownRow {
  key: string;
  label: string;
  metrics: Metrics;
}

export function breakdown(
  trades: Trade[],
  stake: number,
  keyOf: (t: Trade) => string,
  labelOf?: (k: string) => string,
  order?: string[],
): BreakdownRow[] {
  const groups = new Map<string, Trade[]>();
  for (const t of trades) {
    const k = keyOf(t);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(t);
  }
  const keys = order ? order.filter((k) => groups.has(k)) : [...groups.keys()].sort();
  return keys.map((k) => ({ key: k, label: labelOf ? labelOf(k) : k, metrics: computeMetrics(groups.get(k)!, stake) }));
}

export const MINUTE_BUCKETS = ["00-14", "15-29", "30-44", "45-49", "50-59"];
export function minuteBucket(m: number): string {
  if (m < 15) return "00-14";
  if (m < 30) return "15-29";
  if (m < 45) return "30-44";
  if (m < 50) return "45-49";
  return "50-59";
}

export const PRICE_BUCKETS = ["<60¢", "60-75¢", "75-85¢", "85-92¢", "92-97¢", "≥97¢", "no price"];
export function priceBucket(q: number | null): string {
  if (q == null) return "no price";
  const c = q * 100;
  if (c < 60) return "<60¢";
  if (c < 75) return "60-75¢";
  if (c < 85) return "75-85¢";
  if (c < 92) return "85-92¢";
  if (c < 97) return "92-97¢";
  return "≥97¢";
}
