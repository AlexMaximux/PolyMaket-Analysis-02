import { parseEtTime } from "./etTime";
import { NONE, type FilterField } from "./fieldFilters";
import type { Trade } from "./signalAnalysis";

/**
 * Fields the analysis pages can filter on (see lib/fieldFilters), for rows of /api/jev/history. The Jev page filters
 * its rows and Cloud Analysis its trade candidates; both offer the same snapshot fields under the same ids. Ids match
 * the Jev table's column ids where a column exists, and saved filters refer to them, so do not rename an id.
 */

/** Row fields read by name below. The rows carry more (every model's score, UP probability and confidences), read by id. */
export interface FilterableRow {
  coin?: string;
  et_time: string;
  direction?: string | null;
  kev_direction?: string | null;
  span_direction?: string | null;
  up_1h_num?: number | null;
  up_15m_num?: number | null;
  up_5m_num?: number | null;
  fair_claude?: number | null;
  spot_price?: number | null;
  price_to_beat?: number | null;
  market_outcome?: string | null;
}

export const DIR_CHOICES = [
  { value: "UP", label: "UP" },
  { value: "DOWN", label: "DOWN" },
  { value: NONE, label: "none" },
];

/** Claude fair value minus the 1H Up price, in cents; positive when Claude prices UP above the market. */
export function claudeEdge(r: FilterableRow): number | null {
  return r.fair_claude != null && r.up_1h_num != null ? Number((r.fair_claude - r.up_1h_num).toFixed(2)) : null;
}

/** The 3-model consensus column's reading: all answering models agree, a majority, or a tie. */
export function consensusClass(r: FilterableRow): string | null {
  const dirs = [r.direction, r.kev_direction, r.span_direction].filter(Boolean);
  if (!dirs.length) return null;
  const ups = dirs.filter((d) => d === "UP").length;
  const downs = dirs.filter((d) => d === "DOWN").length;
  if (ups === dirs.length) return "FULL_UP";
  if (downs === dirs.length) return "FULL_DOWN";
  if (ups > downs) return "LEAN_UP";
  if (downs > ups) return "LEAN_DOWN";
  return "SPLIT";
}

type Value = number | string | null | undefined;

/**
 * Every snapshot field: time, then `lead` (the page's own signal fields), then market, consensus, each model, fair
 * values and cost. `rowOf` maps what the page filters (a row, a trade) to its snapshot row; `coins` fills the coin picker.
 */
export function snapshotFilterFields<T>(rowOf: (item: T) => FilterableRow, coins: string[], lead: FilterField<T>[] = []): FilterField<T>[] {
  const byId = (item: T, id: string) => (rowOf(item) as unknown as Record<string, Value>)[id];
  const num = (id: string, label: string, group: string, unit?: string, get?: (r: FilterableRow) => Value): FilterField<T> =>
    ({ id, label, group, kind: "number", unit, get: get ? (item) => get(rowOf(item)) : (item) => byId(item, id) });
  const choice = (id: string, label: string, group: string, choices: { value: string; label: string }[], get?: (r: FilterableRow) => Value): FilterField<T> =>
    ({ id, label, group, kind: "choice", choices, get: get ? (item) => get(rowOf(item)) : (item) => byId(item, id) });
  // Direction, score, UP probability and confidences of a model, under the column ids `${prefix}score` etc.
  const model = (group: string, name: string, prefix: string, confs: [string, string][]): FilterField<T>[] => [
    choice(`${prefix}direction`, `${name} direction`, group, DIR_CHOICES),
    num(`${prefix}score`, `${name} score`, group),
    num(`${prefix}prob_up`, `${name} prob UP`, group, "%"),
    ...confs.map(([key, label]) => num(`${prefix}${key}`, `${name} ${label}`, group, "%")),
  ];
  const conf3: [string, string][] = [["score_confidence", "score conf."], ["direction_confidence", "direction conf."], ["confidence", "overall conf."]];
  const count = (d: "UP" | "DOWN") => (r: FilterableRow) => [r.direction, r.kev_direction, r.span_direction].filter((x) => x === d).length;

  return [
    num("minute", "Minute of hour", "Time", undefined, (r) => parseEtTime(r.et_time)?.minute),
    num("hour", "Hour of day (ET)", "Time", undefined, (r) => parseEtTime(r.et_time)?.hour),

    ...lead,

    choice("coin", "Coin", "Market", coins.map((c) => ({ value: c, label: c })), (r) => (r.coin || "BTC").toUpperCase()),
    choice("market_outcome", "Market result", "Market", [
      { value: "UP", label: "UP" }, { value: "DOWN", label: "DOWN" },
      { value: "PENDING", label: "awaiting confirmation" }, { value: NONE, label: "live" },
    ]),
    num("up_1h", "1H Up price", "Market", "¢", (r) => r.up_1h_num),
    num("up_15m", "15M Up price", "Market", "¢", (r) => r.up_15m_num),
    num("up_5m", "5M Up price", "Market", "¢", (r) => r.up_5m_num),
    num("spot_vs_ptb", "Spot vs price to beat", "Market", "%", (r) =>
      r.spot_price != null && r.price_to_beat ? Number(((r.spot_price / r.price_to_beat - 1) * 100).toFixed(4)) : null),

    choice("consensus", "3-model consensus", "Consensus", [
      { value: "FULL_UP", label: "full UP" }, { value: "FULL_DOWN", label: "full DOWN" },
      { value: "LEAN_UP", label: "leaning UP" }, { value: "LEAN_DOWN", label: "leaning DOWN" },
      { value: "SPLIT", label: "split" }, { value: NONE, label: "none" },
    ], consensusClass),
    num("models_up", "Jev/Kev/Span saying UP (count)", "Consensus", undefined, count("UP")),
    num("models_down", "Jev/Kev/Span saying DOWN (count)", "Consensus", undefined, count("DOWN")),
    num("consensus_agreement", "Consensus agreement", "Consensus", "%"),

    ...model("Jev", "Jev", "", conf3),
    ...model("Kev-4b", "Kev", "kev_", conf3),
    ...model("Span-01", "Span", "span_", [["confidence", "confidence"]]),
    ...model("Solar-Decide", "Solar", "solar_", conf3),
    ...model("Tev-4b", "Tev", "tev_", conf3),
    ...model("Mercury-Decide", "Mercury", "mercury_", conf3),
    ...model("Liquid-D1", "Liquid", "liquid_", conf3),

    num("fair_15m", "Fair 15m", "Fair value", "¢"),
    num("fair_5m", "Fair 5m", "Fair value", "¢"),
    num("fair_joint", "Fair joint solve", "Fair value", "¢"),
    num("fair_base", "Fair base (no drift)", "Fair value", "¢"),
    num("fair_claude", "Fair Claude", "Fair value", "¢"),
    num("claude_edge", "Claude edge (fair − 1H price)", "Fair value", "¢", claudeEdge),

    num("tokens", "Jev tokens", "Cost"),
  ];
}

/**
 * Fields for Cloud Analysis trade candidates: the trade's own values (the signal of the model in use, the price of
 * the side it buys), then every snapshot field of its row. The trade result is known only afterwards; filtering on
 * it is for reading the trades, not for a rule.
 */
export function tradeFilterFields(coins: string[] = []): FilterField<Trade>[] {
  const g = "Trade";
  return snapshotFilterFields<Trade>((t) => t.row, coins, [
    { id: "trade_dir", label: "Trade direction", group: g, kind: "choice", choices: DIR_CHOICES.filter((c) => c.value !== NONE), get: (t) => t.dir },
    { id: "trade_score", label: "Signal score (model in use)", group: g, kind: "number", get: (t) => t.modelScore },
    { id: "trade_conf", label: "Signal confidence (model in use)", group: g, kind: "number", unit: "%", get: (t) => t.modelConf },
    { id: "trade_price", label: "Price of side bought (quoted)", group: g, kind: "number", unit: "¢", get: (t) => (t.quote == null ? null : Number((t.quote * 100).toFixed(2))) },
    { id: "trade_agree", label: "Jev/Kev/Span agreeing with trade", group: g, kind: "number", get: (t) => t.agreeCount },
    {
      id: "trade_flipped", label: "Opposite signal earlier in hour", group: g, kind: "choice",
      choices: [{ value: "yes", label: "yes" }, { value: "no", label: "no" }],
      get: (t) => (t.priorOpposite ? "yes" : "no"),
    },
    {
      id: "trade_result", label: "Trade result (hindsight)", group: g, kind: "choice",
      choices: [{ value: "WIN", label: "WIN" }, { value: "LOSS", label: "LOSS" }, { value: "PENDING", label: "pending" }],
      get: (t) => t.status,
    },
  ]);
}
