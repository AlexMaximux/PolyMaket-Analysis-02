// Honest backtest of Jev/Kev/Span signals against resolved Polymarket 1h markets.
// Pure functions only, so the page and the tests share one implementation.

import { parseEtTime } from "./etTime";
import { compileFilters, type FilterGroup } from "./fieldFilters";
import { tradeFilterFields } from "./snapshotFilterFields";

export type Dir = "UP" | "DOWN";
export type ModelSource = "jev" | "kev" | "span" | "solar" | "tev" | "mercury" | "liquid" | "tfm" | "avg";
export type ConsensusRule = "none" | "2of3" | "3of3";
export type DedupeMode = "all" | "firstPerHour" | "firstPerHourDir";
// afterFilters: first snapshot of the hour that passes every filter becomes the trade.
// beforeFilters: the hour's first raw signal is the trade; if it fails a filter the hour is skipped.
export type PickOrder = "afterFilters" | "beforeFilters";
export type TradeStatus = "WIN" | "LOSS" | "PENDING";
// Fast-move filter. snapshot: skip a snapshot whose price moved more than the limit within the window.
// restOfHour: after such a move, skip that snapshot and every later one in the same market hour.
export type MoveFilterMode = "off" | "snapshot" | "restOfHour";
export type MoveUnit = "usd" | "pct";
// How the Strategy Lab sizes each trade. flat: `stake` every time (the default, and the only plan outside the Lab).
// The others double the stake after every loss and go back to the base after a win:
//   p1: the base stake never changes.
//   p2: the base doubles each time the balance doubles from the bankroll (200 -> 400 at 2x), and halves again if the balance falls back.
//   p3: like p2, but the base never goes back down.
//   p4: a percentage of the current balance (stakePercent), double that percentage after a loss, never above stakeCap.
export type StakePlan = "flat" | "p1" | "p2" | "p3" | "p4";

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
  tev_direction?: Dir | null;
  tev_score?: number | null;
  tev_confidence?: number | null;
  tev_score_confidence?: number | null;
  tev_direction_confidence?: number | null;
  mercury_direction?: Dir | null;
  mercury_score?: number | null;
  mercury_confidence?: number | null;
  mercury_score_confidence?: number | null;
  mercury_direction_confidence?: number | null;
  liquid_direction?: Dir | null;
  liquid_score?: number | null;
  liquid_confidence?: number | null;
  liquid_score_confidence?: number | null;
  liquid_direction_confidence?: number | null;
  tfm_direction?: Dir | null;
  tfm_score?: number | null;
  tfm_confidence?: number | null;
  tfm_score_confidence?: number | null;
  tfm_direction_confidence?: number | null;
  tfm_prob_up?: number | null;
  consensus_agreement?: number | null;
  up_1h_num?: number | null;
  spot_price?: number | null;
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
  bullishMaxConf: number; // upper bound on confidence, inclusive; 100 = no cap
  bearishMaxConf: number;
  directions: "both" | Dir;

  consensus: ConsensusRule;
  // Extra filter, separate from `consensus` (which counts Jev/Kev/Span only): Solar-Decide must
  // point the same way as the signal. Rows recorded before Solar existed have no direction and fail it.
  solarAgrees: boolean;
  solarMinConf: number; // Solar score confidence, %; 0 = off. Rows without a Solar prediction fail when > 0.
  // TimesFM as a confirmer of any model's signal. Rows without a TimesFM forecast fail whenever either check is on.
  tfmMinProb: number; // TimesFM P(side traded) must be >= this, in %. 0 = off. 50 = "TimesFM agrees".
  tfmMinEdge: number; // TimesFM P(side traded) minus the quoted price of that side, in cents, must be >= this. -100 = off.
  // Skip the hour once a signal pointing the other way already appeared in it. Earlier signals count at any
  // confidence (the min-conf thresholds are ignored for this check): even a weak opposite signal shows the hour flipped.
  noPriorOpposite: boolean;
  minMinute: number; // minute of the hour the signal appeared, inclusive
  maxMinute: number; // inclusive
  minEntry: number; // price paid for the chosen side, in cents, inclusive
  maxEntry: number;
  // Conditions on any trade or snapshot field (lib/fieldFilters, fields in lib/snapshotFilterFields), tested with
  // the filters above. [] = off, as in every frozen rule.
  fieldFilters: FilterGroup[];
  // Fast-move filter: the move of a snapshot is the largest |price change| against the earlier snapshots
  // of the same coin taken within the last moveWindowMin minutes (plus MOVE_WINDOW_GRACE_MS for timer drift).
  // With snapshots every 5 minutes and a 5-minute window, that is the change since the previous snapshot.
  moveFilter: MoveFilterMode;
  moveUnit: MoveUnit;
  moveThreshold: number; // dollars or percent, by moveUnit; a move strictly above it trips the filter
  moveWindowMin: number;

  dedupe: DedupeMode;
  pickOrder: PickOrder;

  stake: number; // dollars per trade (the base stake when stakePlan is not flat)
  stakePlan: StakePlan; // Strategy Lab only; buildTrades ignores it
  bankroll: number; // starting balance in dollars, used by the p1-p4 plans
  stakePercent: number; // p4: percent of the current balance staked on a trade (twice that after a loss)
  stakeCap: number; // p4: no stake above this many dollars
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
  bullishMaxConf: 100,
  bearishMaxConf: 100,
  directions: "both",
  consensus: "none",
  solarAgrees: false,
  solarMinConf: 0,
  tfmMinProb: 0,
  tfmMinEdge: -100,
  noPriorOpposite: false,
  minMinute: 0,
  maxMinute: 59,
  minEntry: 0,
  maxEntry: 100,
  fieldFilters: [],
  moveFilter: "off",
  moveUnit: "usd",
  moveThreshold: 200,
  moveWindowMin: 5,
  dedupe: "firstPerHourDir",
  pickOrder: "afterFilters",
  stake: 10,
  stakePlan: "flat",
  bankroll: 1000,
  stakePercent: 10,
  stakeCap: 800,
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

// A third forward test alongside v2 and s2: v2's rule plus one filter. If a Jev signal pointing the other way (at
// any confidence) already appeared in the hour, the hour is skipped. Picked on 2026-10-01 after looking at the data
// (in the dashboard export, hours where the signal flipped produced 35 of 46 losses), so the backtest before
// `frozenAt` is optimistic and only the forward window counts. Frozen on the hour: forward rows start at `frozenAt`,
// so a freeze in mid-hour would hide that hour's earlier signals from the filter.
export const FROZEN_STRATEGY_3: FrozenStrategy = {
  id: "s3",
  name: "BTC · Jev + Kev + Span all agree · minute 32+ · skip hours that already flipped",
  note: "Strategy 1 (v2) plus one filter: skip the hour if a Jev signal in the opposite direction (any confidence) already appeared in it. On BTC since Sep 26 (in-sample) it cut v2 from 119 trades / 8 losses to 99 / 3, and held in both halves of that data (2 of 49 lost, then 1 of 50). Runs in parallel with v2 and s2 so all three are scored on the same hours.",
  frozenAt: "2026-10-01T23:00:00.000Z", // 19:00 ET
  frozenUntil: null,
  rule: baseRule({ minMinute: 32, noPriorOpposite: true }),
  checkpoints: [10, 20, 30, 50],
};

// A fourth parallel forward test, set by the user on the analysis page on 2026-10-02: Jev alone with looser score
// thresholds, and only hours whose very first signal comes at minute 45 or later (beforeFilters: if the hour's first
// signal is earlier, the hour is skipped). Every coin, one trade per coin per hour. Picked after looking at the data,
// so only the forward window counts. Coins move together, so their trades are not independent.
export const FROZEN_STRATEGY_4: FrozenStrategy = {
  id: "s4",
  name: "All coins · Jev alone · score > 3.25 / < 0.75 at 85% confidence · hour's first signal, only if at minute 45+",
  note: "Jev alone (no Kev/Span/Solar agreement), score above 3.25 or below 0.75 with score confidence ≥ 85%, on every recorded coin. The hour's first such signal is the trade, and the hour is skipped unless that signal comes at minute 45 or later: these are hours that stayed undecided until late. In-sample: 99 resolved trades, 4 losses at an average 86.7¢ (BTC alone: 26 trades, 0 losses). Only coins the Jev collector records can trade (setting jev.coins).",
  frozenAt: "2026-10-02T01:00:00.000Z", // 21:00 ET Oct 1
  frozenUntil: null,
  rule: baseRule({
    coins: [],
    consensus: "none",
    bullishScore: 3.25,
    bearishScore: 0.75,
    bullishMinConf: 85,
    bearishMinConf: 85,
    minMinute: 45,
    pickOrder: "beforeFilters",
  }),
  checkpoints: [10, 20, 30, 50],
};

// A fifth parallel forward test, set by the user on 2026-10-03: strategy 1 (v2) with the thresholds a parameter search
// picked on the same data. It beat v2 in-sample but not in the walk-forward check; only the forward window counts.
// Frozen on the hour, after the search, so no forward row was seen. Since 2026-10-08 the bot trades it by default
// (setting bot.forwardStrategy); v2 keeps its own forward test.
export const FROZEN_STRATEGY_5: FrozenStrategy = {
  id: "s5",
  name: "BTC · Jev + Kev + Span all agree · UP score > 3.25 at 90–100% / DOWN score < 0.75 at 0–98% · minute 30–55",
  note: "Strategy 1 (v2) with the optimizer's best settings: UP if score > 3.25 (3.5 gives the same trades), DOWN if score < 0.75, UP confidence 90–100%, DOWN confidence 0–98%, signal minute 30–55. Everything else as v2: Jev, score confidence, 3 of 3, Solar off, flipped hours kept, price 0–100, first signal per hour after filters. Picked by a search on the same data (in-sample it made more than v2 at cheaper entries, but it did worse than v2 in the walk-forward check), so treat it as a hypothesis.",
  frozenAt: "2026-10-03T21:00:00.000Z", // 17:00 ET
  frozenUntil: null,
  rule: baseRule({
    bullishScore: 3.25,
    bearishScore: 0.75,
    bearishMinConf: 0,
    bearishMaxConf: 98,
    minMinute: 30,
    maxMinute: 55,
  }),
  checkpoints: [10, 20, 30, 50],
};

// A seventh parallel forward test, set by the user on 2026-11-10 (the id s6 is taken by the experiment branch): strategy 1
// (v2) plus a TimesFM 3.0 confirmer. The first snapshot of the hour where v2's signal fires AND TimesFM's probability for
// the side bought is at least that side's quoted price (TFM edge >= 0). Picked after trying about 30 TimesFM conditions on
// the same 47 days of BTC data (in-sample, before slippage: 776 trades, +2.4c per share, 94.8% won at 91.9c; +1.3c with
// 1.5c slippage), so only the forward window counts. Paper only: the bot does not trade it, and it is not an alert option
// (alert rows carry no TimesFM fields). Rows without a TimesFM forecast cannot trade, so the collector needs the local
// TimesFM service (or `npm run backfill:tfm` afterwards: forecasts use only prices from before each snapshot).
// Frozen on the top of an hour, so no forward row was seen.
export const FROZEN_STRATEGY_7: FrozenStrategy = {
  id: "s7",
  name: "BTC · Jev + Kev + Span all agree · minute 32+ · TimesFM probability of the side ≥ its price",
  note: "Strategy 1 (v2) plus one filter: TimesFM 3.0's probability for the side bought (tfm_prob_up for UP, 100 minus it for DOWN) must be at least the quoted price of that side (edge ≥ 0 cents). After filters: the first snapshot of the hour that passes both v2 and the TimesFM condition is the trade, so a later snapshot can still qualify. In-sample on Sep 24 - Nov 10: v2 1,012 trades +0.7c per share; with the filter 776 trades +2.4c (t 3.1), positive in both halves, before slippage. Only the forward window counts. Rows without a TimesFM forecast cannot trade.",
  frozenAt: "2026-11-11T04:00:00.000Z", // 23:00 ET Nov 10
  frozenUntil: null,
  rule: baseRule({ minMinute: 32, tfmMinEdge: 0 }),
  checkpoints: [10, 20, 30, 50],
};

// An eighth parallel forward test, set by the user on 2026-11-12: strategy 1 (v2) with a later minute window, an entry
// price cap, and TimesFM as a confirmer. The bot can trade it (setting bot.forwardStrategy): the forward bridge reads the
// TimesFM forecast of each snapshot from jev/tfm, so it trades only where the TimesFM service writes forecasts (the
// server has none as of 2026-11-12). Not an alert option: alert rows carry no TimesFM fields. Rows without a TimesFM
// forecast cannot trade. Frozen on the top of an hour, so no forward row was seen.
export const FROZEN_STRATEGY_8: FrozenStrategy = {
  id: "s8",
  name: "BTC · Jev + Kev + Span all agree · minute 34–59 · price ≤ 92¢ · TimesFM probability ≥ 50% and edge ≥ 0.001¢",
  note: "Strategy 1 (v2) with: signal minute 34–59, quoted price of the side 0–92¢, TimesFM probability for the side bought at least 50%, and TimesFM probability minus that side's quoted price at least 0.001 cents (edges are rounded to 0.01, so in practice above zero). Everything else as v2: Jev score > 3.5 / < 0.5 at 90%+ score confidence, 3 of 3, first signal of the hour after filters. Set by the user, not by a search here; only the forward window counts.",
  frozenAt: "2026-11-12T20:00:00.000Z", // 15:00 ET
  frozenUntil: null,
  rule: baseRule({ minMinute: 34, maxMinute: 59, minEntry: 0, maxEntry: 92, tfmMinProb: 50, tfmMinEdge: 0.001 }),
  checkpoints: [10, 20, 30, 50],
};

// A ninth parallel forward test, set by the user on 2026-11-13: strategy 1 (v2) with TimesFM as a confirmer (probability of the
// side at least 50% and its edge over the quoted price above zero), a price cap of 90c and a fast-move filter (a snapshot whose
// price moved more than $50 in the last 5 minutes is skipped). Taken from the Strategy Lab file the user tuned on the same
// 2026-09-24 .. 2026-11-12 data (241 trades, 92% won at 84c in-sample), so only the forward window counts. How much to stake is
// not part of the rule: the Lab simulated a percentage-of-balance plan (P4, 20.1% of the balance, 2x after a loss, cap $800),
// but the forward card uses the page stake and the bot uses its own stake settings.
// The bot can trade it (setting bot.forwardStrategy); like s8 it needs TimesFM forecasts in jev/tfm and spot prices in the
// snapshots, so it trades only where the TimesFM service runs (the server has none as of 2026-11-13). Not an alert option:
// alert rows carry no TimesFM fields. Rows without a TimesFM forecast cannot trade. Frozen on the top of an hour.
export const FROZEN_STRATEGY_9: FrozenStrategy = {
  id: "s9",
  name: "BTC · Jev + Kev + Span all agree · minute 32–59 · price ≤ 90¢ · TimesFM probability ≥ 50% and edge > 0 · skip snapshots after a $50 move in 5 min",
  note: "Strategy 1 (v2) with: signal minute 32–59, quoted price of the side 0–90¢, TimesFM probability for the side bought at least 50%, TimesFM probability minus the quoted price of that side at least 0.001 cents (in practice above zero), and a fast-move filter: a snapshot is skipped when BTC moved more than $50 against any snapshot of the last 5 minutes (one minute of timer drift allowed). Everything else as v2: Jev score > 3.5 / < 0.5 at 90%+ score confidence, 3 of 3, first signal of the hour after filters. Set by the user from a Strategy Lab file tuned on the same history, so it is in-sample until forward rows show otherwise. Stake size is not part of the rule.",
  frozenAt: "2026-11-13T05:00:00.000Z", // 00:00 ET
  frozenUntil: null,
  rule: baseRule({ minMinute: 32, maxMinute: 59, minEntry: 0, maxEntry: 90, tfmMinProb: 50, tfmMinEdge: 0.001, moveFilter: "snapshot", moveUnit: "usd", moveThreshold: 50, moveWindowMin: 5 }),
  checkpoints: [10, 20, 30, 50],
};

// Every frozen strategy by id. The Jev alert (setting jev.alertStrategy) can follow any of them; the bot trades v2 or s5.
// s7 is not listed: its rule needs TimesFM fields that alert rows do not carry, so an alert on it would never fire.
export const STRATEGIES_BY_ID: Record<string, FrozenStrategy> = {
  v1: STRATEGY_HISTORY[0], v2: FROZEN_STRATEGY, s2: FROZEN_STRATEGY_2, s3: FROZEN_STRATEGY_3, s4: FROZEN_STRATEGY_4, s5: FROZEN_STRATEGY_5,
};

// The ready-made rules the Strategy Lab offers as a start: every frozen strategy, including those that cannot drive an alert.
export const LAB_PRESETS: Record<string, FrozenStrategy> = { ...STRATEGIES_BY_ID, s7: FROZEN_STRATEGY_7, s8: FROZEN_STRATEGY_8, s9: FROZEN_STRATEGY_9 };

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
  priorOpposite: boolean; // an opposite-direction signal (any confidence) appeared earlier in this market hour
  priceMove: number | null; // largest price change within moveWindowMin, in moveUnit; null without an earlier snapshot
  fastMoveBlocked: boolean; // the fast-move filter (moveFilter) blocks this snapshot
  stake?: number; // dollars staked on this trade; set only by a Lab stake plan (otherwise every trade uses the config stake)
  quote: number | null; // quoted price of the chosen side, 0-1
  entry: number | null; // quote + slippage, 0-1
  tfmProb: number | null; // TimesFM P(side traded), 0-100, one decimal; null without a forecast
  tfmEdge: number | null; // tfmProb - quote * 100, two decimals; null when either is missing
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

export { parseEtTime };

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
  cfg: Pick<AnalysisConfig, "model" | "confidenceType" | "bullishScore" | "bearishScore" | "bullishMinConf" | "bearishMinConf" | "bullishMaxConf" | "bearishMaxConf">,
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
  } else if (cfg.model === "tev") {
    score = r.tev_score;
    conf = cfg.confidenceType === "direction"
      ? r.tev_direction_confidence ?? r.tev_confidence
      : r.tev_score_confidence ?? r.tev_confidence;
  } else if (cfg.model === "mercury") {
    score = r.mercury_score;
    conf = cfg.confidenceType === "direction"
      ? r.mercury_direction_confidence ?? r.mercury_confidence
      : r.mercury_score_confidence ?? r.mercury_confidence;
  } else if (cfg.model === "liquid") {
    score = r.liquid_score;
    conf = cfg.confidenceType === "direction"
      ? r.liquid_direction_confidence ?? r.liquid_confidence
      : r.liquid_score_confidence ?? r.liquid_confidence;
  } else if (cfg.model === "tfm") {
    score = r.tfm_score;
    conf = cfg.confidenceType === "direction"
      ? r.tfm_direction_confidence ?? r.tfm_confidence
      : r.tfm_score_confidence ?? r.tfm_confidence;
  } else if (cfg.model === "avg") {
    const scores = [r.score, r.kev_score, r.span_score].filter((s): s is number => s != null);
    score = scores.length ? Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)) : null;
    conf = r.consensus_agreement ?? r.score_confidence;
  } else {
    score = r.score;
    conf = cfg.confidenceType === "direction" ? r.direction_confidence : r.score_confidence;
  }
  if (score == null || conf == null || isNaN(conf)) return null;
  if (score > cfg.bullishScore && conf >= cfg.bullishMinConf && conf <= cfg.bullishMaxConf) return { dir: "UP", score, conf };
  if (score < cfg.bearishScore && conf >= cfg.bearishMinConf && conf <= cfg.bearishMaxConf) return { dir: "DOWN", score, conf };
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

// Snapshot timers drift by a few seconds and sometimes skip; this lets a snapshot 5:30 after the last one still
// count for a 5-minute window.
export const MOVE_WINDOW_GRACE_MS = 60_000;

// Largest |price change| between `r` and the earlier rows of `history` (same coin, oldest first) inside the window.
// Returns dollars or percent of the earlier price, by cfg.moveUnit; null when no earlier price is in the window.
export function priceMoveOf(
  r: SnapshotRow,
  history: SnapshotRow[],
  cfg: Pick<AnalysisConfig, "moveUnit" | "moveWindowMin">,
): number | null {
  const t = rowTime(r);
  const spot = r.spot_price;
  if (!t || spot == null || !Number.isFinite(spot)) return null;
  const from = t - cfg.moveWindowMin * 60_000 - MOVE_WINDOW_GRACE_MS;
  let best: number | null = null;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    const ht = rowTime(h);
    if (!ht || ht >= t) continue;
    if (ht < from) break;
    const ref = h.spot_price;
    if (ref == null || !Number.isFinite(ref) || ref <= 0) continue;
    const move = cfg.moveUnit === "pct" ? (Math.abs(spot - ref) / ref) * 100 : Math.abs(spot - ref);
    if (best == null || move > best) best = move;
  }
  return best == null ? null : Number(best.toFixed(cfg.moveUnit === "pct" ? 4 : 2));
}

function buildCandidate(
  r: SnapshotRow,
  cfg: AnalysisConfig,
  priorDirs: Set<Dir>,
  move: { priceMove: number | null; blocked: boolean } = { priceMove: null, blocked: false },
): Trade | null {
  const sig = detectSignal(r, cfg);
  if (!sig) return null;
  const p = parseEtTime(r.et_time);
  if (!p) return null;
  const quote = sidePrice(r, sig.dir);
  const entry = quote == null ? null : Math.min(0.999, quote + cfg.slippageCents / 100);
  const status = tradeStatus(r, sig.dir);
  const tfmUp = r.tfm_prob_up != null && Number.isFinite(r.tfm_prob_up) ? r.tfm_prob_up : null;
  const tfmSide = tfmUp == null ? null : sig.dir === "UP" ? tfmUp : 100 - tfmUp;
  const tfmProb = tfmSide == null ? null : Number(tfmSide.toFixed(1));
  // The edge uses the rounded tfmProb, so the two numbers on a trade always agree with each other.
  const tfmEdge = tfmProb == null || quote == null ? null : Number((tfmProb - quote * 100).toFixed(2));
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
    priorOpposite: priorDirs.has(sig.dir === "UP" ? "DOWN" : "UP"),
    priceMove: move.priceMove,
    fastMoveBlocked: move.blocked,
    quote,
    entry,
    tfmProb,
    tfmEdge,
    status,
    pnl: tradePnl(status, entry, cfg.stake),
  };
}

// For evaluating cfg.fieldFilters only; the page builds its own list with the coins it has, for the picker.
const TRADE_FIELDS = new Map(tradeFilterFields().map((f) => [f.id, f]));

function passesFilters(t: Trade, cfg: AnalysisConfig, fieldTest: ((t: Trade) => boolean) | null): boolean {
  if (cfg.directions !== "both" && t.dir !== cfg.directions) return false;
  if (cfg.consensus === "2of3" && t.agreeCount < 2) return false;
  if (cfg.consensus === "3of3" && t.agreeCount < 3) return false;
  if (cfg.solarAgrees && t.row.solar_direction !== t.dir) return false;
  if (cfg.solarMinConf > 0 && !((t.row.solar_score_confidence ?? -1) >= cfg.solarMinConf)) return false;
  if (cfg.tfmMinProb > 0 && !(t.tfmProb != null && t.tfmProb >= cfg.tfmMinProb)) return false;
  if (cfg.tfmMinEdge > -100 && !(t.tfmEdge != null && t.tfmEdge >= cfg.tfmMinEdge)) return false;
  if (cfg.noPriorOpposite && t.priorOpposite) return false;
  if (cfg.moveFilter !== "off" && t.fastMoveBlocked) return false;
  if (t.minute < cfg.minMinute || t.minute > cfg.maxMinute) return false;
  const priceFilterOn = cfg.minEntry > 0 || cfg.maxEntry < 100;
  if (priceFilterOn) {
    if (t.quote == null) return false;
    const cents = t.quote * 100;
    if (cents < cfg.minEntry || cents > cfg.maxEntry) return false;
  }
  if (fieldTest && !fieldTest(t)) return false;
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
  // Signal directions seen so far in each market hour, at any confidence (feeds noPriorOpposite).
  const anyConf = { ...cfg, bullishMinConf: 0, bearishMinConf: 0, bullishMaxConf: 100, bearishMaxConf: 100 };
  const seen = new Map<string, Set<Dir>>();
  // Fast-move filter state: earlier rows per coin, and market hours that already had a fast move.
  const moveOn = cfg.moveFilter !== "off";
  const byCoin = new Map<string, SnapshotRow[]>();
  const trippedHours = new Set<string>();
  const candidates: Trade[] = [];
  for (const r of sortChrono(baseRows)) {
    const key = marketKey(r);
    const dirs = seen.get(key) ?? new Set<Dir>();
    let move = { priceMove: null as number | null, blocked: false };
    if (moveOn) {
      const coin = (r.coin || r.filename.split("_")[0] || "").toUpperCase();
      const history = byCoin.get(coin) ?? [];
      const priceMove = priceMoveOf(r, history, cfg);
      const fast = priceMove != null && priceMove > cfg.moveThreshold;
      if (fast && cfg.moveFilter === "restOfHour") trippedHours.add(key);
      move = { priceMove, blocked: fast || (cfg.moveFilter === "restOfHour" && trippedHours.has(key)) };
      history.push(r);
      byCoin.set(coin, history);
    }
    const t = buildCandidate(r, cfg, dirs, move);
    if (t) candidates.push(t);
    const raw = detectSignal(r, anyConf);
    if (raw) seen.set(key, dirs.add(raw.dir));
  }
  const fieldTest = compileFilters(cfg.fieldFilters ?? [], TRADE_FIELDS);
  if (cfg.pickOrder === "beforeFilters") {
    return keepFirst(candidates, cfg.dedupe).filter((t) => passesFilters(t, cfg, fieldTest));
  }
  return keepFirst(candidates.filter((t) => passesFilters(t, cfg, fieldTest)), cfg.dedupe);
}

export function computeMetrics(trades: Trade[], stake: number): Metrics {
  let wins = 0, losses = 0, pending = 0, pnl = 0, lateCount = 0;
  let invPriceSum = 0, priceSum = 0, priced = 0, staked = 0;
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
      staked += t.stake ?? stake;
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
    roi: priced && staked > 0 ? pnl / staked : null,
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
