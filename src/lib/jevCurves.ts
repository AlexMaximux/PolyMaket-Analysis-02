import type { AnalysisConfig, SnapshotRow } from "./signalAnalysis";
import { isConditionReady, type FilterCondition, type FilterGroup } from "./fieldFilters";
import { tradeFilterFields } from "./snapshotFilterFields";

/** All values here are the flattened history API's units: percent and cents are already 0–100. */
export interface CurveRow extends SnapshotRow {
  [field: string]: unknown;
  confidence?: number | null;
  prob_up?: number | null;
  prob_down?: number | null;
  kev_prob_up?: number | null;
  span_prob_up?: number | null;
  span_prob_down?: number | null;
  solar_prob_up?: number | null;
  tev_prob_up?: number | null;
  mercury_prob_up?: number | null;
  liquid_prob_up?: number | null;
  tfm_prob_up?: number | null;
  up_15m_num?: number | null;
  up_5m_num?: number | null;
  fair_15m?: number | null;
  fair_5m?: number | null;
  fair_joint?: number | null;
  fair_base?: number | null;
  fair_claude?: number | null;
  fair_tfm?: number | null;
  spot_price?: number | null;
  open_price?: number | null;
  price_to_beat?: number | null;
  tokens?: number | null;
  cost?: number | null;
}

export type CurveUnit = "score" | "percent" | "cents" | "edge" | "usd" | "change";
export interface CurveDefinition {
  id: string;
  label: string;
  group: string;
  unit: CurveUnit;
  color: string;
  dash?: string;
  get: (row: CurveRow) => number | null;
}

// A stable four-hue vocabulary. Dash patterns carry model identity when hues repeat.
const BLUE = "#80b5e5", GOLD = "#d5b775", MINT = "#87c2af", ROSE = "#d99caa";
const MODEL_STYLES = [
  { id: "jev", name: "Jev", prefix: "", color: BLUE, dash: undefined },
  { id: "kev", name: "Kev-4b", prefix: "kev_", color: GOLD, dash: undefined },
  { id: "span", name: "Span-01", prefix: "span_", color: MINT, dash: undefined },
  { id: "solar", name: "Solar-Decide", prefix: "solar_", color: ROSE, dash: undefined },
  { id: "tev", name: "Tev-4b", prefix: "tev_", color: BLUE, dash: "7 4" },
  { id: "mercury", name: "Mercury-Decide", prefix: "mercury_", color: GOLD, dash: "7 4" },
  { id: "liquid", name: "Liquid-D1", prefix: "liquid_", color: MINT, dash: "3 4" },
  { id: "tfm", name: "TimesFM", prefix: "tfm_", color: ROSE, dash: "7 4" },
] as const;

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function bounded(value: unknown, min: number, max: number): number | null {
  const n = finite(value);
  return n != null && n >= min && n <= max ? n : null;
}
function numberField(id: string, label: string, group: string, unit: CurveUnit, color: string, dash?: string): CurveDefinition {
  return { id, label, group, unit, color, dash, get: row => {
    if (unit === "score") return bounded(row[id], 0, 4);
    if (unit === "percent" || unit === "cents") return bounded(row[id], 0, 100);
    return finite(row[id]);
  } };
}
function derived(id: string, label: string, group: string, unit: CurveUnit, color: string, get: CurveDefinition["get"], dash?: string): CurveDefinition {
  return { id, label, group, unit, color, dash, get };
}
function difference(row: CurveRow, a: string, b: string): number | null {
  const first = bounded(row[a], 0, 100), second = bounded(row[b], 0, 100);
  return first == null || second == null ? null : first - second;
}
function ratioChange(row: CurveRow, base: string): number | null {
  const spot = finite(row.spot_price), reference = finite(row[base]);
  return spot == null || reference == null || reference <= 0 ? null : (spot / reference - 1) * 100;
}

const modelCurves: CurveDefinition[] = MODEL_STYLES.flatMap(model => {
  const { prefix, name, color, dash } = model;
  const curves = [
    numberField(`${prefix}score`, `${name} · امتیاز`, name, "score", color, dash),
    numberField(`${prefix}prob_up`, `${name} · احتمال UP`, name, "percent", color, dash),
  ];
  if (model.id === "span") {
    curves.push(numberField("span_confidence", `${name} · اطمینان`, name, "percent", color, "3 3"));
  } else {
    curves.push(
      numberField(`${prefix}score_confidence`, `${name} · اطمینان امتیاز`, name, "percent", color, "3 3"),
      numberField(`${prefix}direction_confidence`, `${name} · اطمینان جهت`, name, "percent", color, "8 3 2 3"),
      numberField(`${prefix}confidence`, `${name} · اطمینان کلی`, name, "percent", color, "1 3"),
    );
  }
  // A probability of DOWN is the complement only in this binary model. No UP value means no DOWN value.
  curves.push(derived(`${prefix}prob_down`, `${name} · احتمال DOWN`, name, "percent", color, row => {
    const explicit = bounded(row[`${prefix}prob_down`], 0, 100);
    const up = bounded(row[`${prefix}prob_up`], 0, 100);
    return explicit ?? (up == null ? null : 100 - up);
  }, "2 4"));
  return curves;
});

const fairFields = [
  { id: "fair_15m", label: "Fair · مدل 15m", color: GOLD, dash: undefined },
  { id: "fair_5m", label: "Fair · مدل 5m", color: MINT, dash: undefined },
  { id: "fair_base", label: "Fair · بدون رانش", color: BLUE, dash: "7 4" },
  { id: "fair_joint", label: "Fair · Joint solve", color: ROSE, dash: undefined },
  { id: "fair_claude", label: "Fair · Claude", color: GOLD, dash: "3 4" },
  { id: "fair_tfm", label: "Fair · TimesFM", color: ROSE, dash: "3 4" },
] as const;

/** Each id is stable so saved workspaces, table columns and presets refer to the same value. */
export const CURVE_DEFINITIONS: CurveDefinition[] = [
  ...modelCurves,
  derived("avg_score", "میانگین امتیاز Jev / Kev / Span", "اجماع", "score", BLUE, row => {
    const values = [row.score, row.kev_score, row.span_score].map(value => bounded(value, 0, 4)).filter((value): value is number => value != null);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  }, "7 4"),
  derived("score_spread", "اختلاف بیشترین و کمترین امتیاز سه مدل", "اجماع", "score", ROSE, row => {
    const values = [row.score, row.kev_score, row.span_score].map(value => bounded(value, 0, 4)).filter((value): value is number => value != null);
    return values.length >= 2 ? Math.max(...values) - Math.min(...values) : null;
  }),
  numberField("consensus_agreement", "توافق Jev / Kev / Span", "اجماع", "percent", BLUE),
  numberField("up_1h_num", "بازار 1h · UP", "بازار", "cents", BLUE),
  derived("down_1h_num", "بازار 1h · DOWN (مکمل UP)", "بازار", "cents", ROSE, row => {
    const up = bounded(row.up_1h_num, 0, 100);
    return up == null ? null : 100 - up;
  }, "7 4"),
  numberField("up_15m_num", "بازار 15m · UP", "بازار", "cents", GOLD),
  numberField("up_5m_num", "بازار 5m · UP", "بازار", "cents", MINT),
  ...fairFields.map(field => numberField(field.id, field.label, "ارزش منصفانه", "cents", field.color, field.dash)),
  ...fairFields.map(field => derived(`${field.id}_edge`, `${field.label} − بازار 1h`, "اختلاف با بازار", "edge", field.color, row => difference(row, field.id, "up_1h_num"), field.dash)),
  numberField("spot_price", "قیمت نقدی", "قیمت دارایی", "usd", BLUE),
  numberField("price_to_beat", "قیمت مرجع بازار · Price to beat", "قیمت دارایی", "usd", GOLD, "7 4"),
  numberField("open_price", "قیمت بازشدن ساعت", "قیمت دارایی", "usd", MINT, "3 4"),
  derived("spot_vs_ptb", "تغییر نقدی نسبت به قیمت مرجع", "تغییر قیمت", "change", BLUE, row => ratioChange(row, "price_to_beat")),
  derived("spot_vs_open", "تغییر نقدی نسبت به قیمت بازشدن", "تغییر قیمت", "change", GOLD, row => ratioChange(row, "open_price"), "7 4"),
];

export const CURVE_BY_ID = new Map(CURVE_DEFINITIONS.map(definition => [definition.id, definition]));
export const CURVE_PRESETS: Record<string, string[]> = {
  core: ["score", "up_1h_num", "fair_15m"],
  models: MODEL_STYLES.map(model => `${model.prefix}score`),
  confidence: MODEL_STYLES.map(model => model.id === "span" ? "span_confidence" : `${model.prefix}score_confidence`),
  probabilities: MODEL_STYLES.map(model => `${model.prefix}prob_up`),
  fair: ["up_1h_num", ...fairFields.map(field => field.id)],
  edge: fairFields.map(field => `${field.id}_edge`),
  spot: ["spot_price", "price_to_beat", "open_price", "spot_vs_ptb"],
};

/** An explicitly empty array means hide every curve; an absent/broken setting uses the fallback. */
export function sanitizeCurveIds(input: unknown, fallback: readonly string[] = CURVE_PRESETS.core): string[] {
  const ids = Array.isArray(input) ? input : fallback;
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && CURVE_BY_ID.has(id)))];
}

export interface CurveEtParts { date: string; hour: number; minute: number; second: number }
export type CurveTimeRow = Pick<SnapshotRow, "timestamp" | "et_time" | "filename">;
const etFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
function timeParts(time: number): CurveEtParts {
  const parts = Object.fromEntries(etFormatter.formatToParts(time).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second) };
}
function parseEtParts(text: string): CurveEtParts | null {
  const match = text.match(/(\d{4}-\d{2}-\d{2})[ _T](\d{2})[:-](\d{2})(?:[:-](\d{2}))?/);
  if (!match) return null;
  const parts = { date: match[1], hour: Number(match[2]), minute: Number(match[3]), second: Number(match[4] || 0) };
  const date = new Date(`${parts.date}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === parts.date
    && parts.hour <= 23 && parts.minute <= 59 && parts.second <= 59 ? parts : null;
}

/**
 * Prefer recorded absolute timestamps. The ET fallback validates both NY offsets against Intl,
 * rejects the nonexistent spring hour, and chooses the earlier occurrence of an ambiguous fall
 * hour unless an explicit EST/EDT suffix disambiguates it. It never uses the host's timezone.
 */
export function curveRowTime(row: CurveTimeRow): number | null {
  if (typeof row.timestamp === "string" && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(row.timestamp)) {
    const time = Date.parse(row.timestamp);
    if (Number.isFinite(time)) return time;
  }
  const text = row.et_time || row.filename;
  const parts = parseEtParts(text);
  if (!parts) return null;
  const wall = Date.parse(`${parts.date}T${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}:${String(parts.second).padStart(2, "0")}Z`);
  const offsets = /\bEST\b/.test(text) ? [5] : /\bEDT\b/.test(text) ? [4] : [4, 5];
  for (const offset of offsets) {
    const candidate = wall + offset * 3_600_000;
    const actual = timeParts(candidate);
    if (actual.date === parts.date && actual.hour === parts.hour && actual.minute === parts.minute && actual.second === parts.second) return candidate;
  }
  return null;
}

/** Filter labels use the ET text when available; absolute time provides a fallback for old rows. */
export function curveEtParts(row: CurveTimeRow): CurveEtParts | null {
  const parsed = parseEtParts(row.et_time || row.filename);
  if (parsed) return parsed;
  const time = curveRowTime(row);
  return time == null ? null : timeParts(time);
}

export function sortCurveRows<T extends CurveRow>(rows: readonly T[]): T[] {
  return rows.map(row => ({ row, time: curveRowTime(row) }))
    .sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity) || a.row.filename.localeCompare(b.row.filename))
    .map(item => item.row);
}

export interface CurveRowFilter {
  coin?: string;
  dateFrom?: string | null;
  dateTo?: string | null;
  /** Minute of each ET hour, inclusive. Empty or undefined means no limit. */
  startMinute?: number | null;
  endMinute?: number | null;
  hours?: readonly number[];
}
export function filterCurveRows<T extends CurveRow>(rows: readonly T[], filter: CurveRowFilter): T[] {
  const coin = filter.coin?.toUpperCase();
  const hours = new Set(filter.hours || []);
  return sortCurveRows(rows.filter(row => {
    if (coin && coin !== "ALL" && (row.coin || "BTC").toUpperCase() !== coin) return false;
    const parts = curveEtParts(row);
    if (!parts) return false;
    return (!filter.dateFrom || parts.date >= filter.dateFrom)
      && (!filter.dateTo || parts.date <= filter.dateTo)
      && (filter.startMinute == null || parts.minute >= filter.startMinute)
      && (filter.endMinute == null || parts.minute <= filter.endMinute)
      && (!hours.size || hours.has(parts.hour));
  }));
}

export type CurveTransform = "raw" | "mean" | "delta";
export interface CurvePoint { time: number; value: number | null; row: CurveRow; index: number }
export interface CurvePointOptions {
  transform?: CurveTransform;
  /** Number of consecutive available snapshots in a trailing mean; partial windows stay missing. */
  window?: number;
  /** Insert a missing point before long gaps; this stops a chart from drawing through absent history. */
  maxGapMs?: number;
}

/** Keep null observations and explicit time breaks; never interpolate missing model responses. */
export function buildCurvePoints(rows: readonly CurveRow[], curve: CurveDefinition | string, options: CurvePointOptions = {}): CurvePoint[] {
  const definition = typeof curve === "string" ? CURVE_BY_ID.get(curve) : curve;
  if (!definition) return [];
  const transform = options.transform || "raw";
  const window = Math.max(1, Math.min(1000, Math.round(options.window || 3)));
  const maxGap = options.maxGapMs != null && Number.isFinite(options.maxGapMs) && options.maxGapMs > 0 ? options.maxGapMs : Infinity;
  const sorted = sortCurveRows(rows);
  const points: CurvePoint[] = [];
  let previousTime: number | null = null, previousValue: number | null = null, previousCoin: string | null = null;
  let values: number[] = [], sum = 0;
  sorted.forEach((row, index) => {
    const time = curveRowTime(row);
    if (time == null) return;
    const coin = (row.coin || "BTC").toUpperCase();
    const hasBreak = previousTime != null && (time - previousTime > maxGap || coin !== previousCoin);
    if (hasBreak) {
      points.push({ time, value: null, row, index });
      previousValue = null;
      values = []; sum = 0;
    }
    const value = finite(definition.get(row));
    let transformed = value;
    if (value == null) { previousValue = null; values = []; sum = 0; }
    else if (transform === "mean") {
      values.push(value); sum += value;
      if (values.length > window) sum -= values.shift()!;
      transformed = values.length === window ? sum / window : null;
    } else if (transform === "delta") {
      transformed = previousValue == null ? null : value - previousValue;
    }
    points.push({ time, value: transformed, row, index });
    previousTime = time; previousValue = value; previousCoin = coin;
  });
  return points;
}

export function curveExtent(points: readonly Pick<CurvePoint, "value">[]): [number, number] | null {
  let min = Infinity, max = -Infinity;
  for (const point of points) {
    const value = finite(point.value);
    if (value != null) { min = Math.min(min, value); max = Math.max(max, value); }
  }
  return min === Infinity ? null : [min, max];
}

const BOUND_ID = "__jev_curve_score_bound_";
const BOUND_FIELDS = new Map(tradeFilterFields().map(field => [field.id, field]));

/**
 * The legacy curve marker has two additional inclusive score caps that AnalysisConfig does
 * not carry: UP score <= upMax, DOWN score >= downMin. Distribute those bounds over every
 * existing OR group, keeping its conditions ANDed with the appropriate direction. Strip our
 * own generated conditions first, so loading and re-applying a searched rule is idempotent.
 */
export function withCurveScoreBounds(config: AnalysisConfig, upMax: number, downMin: number): AnalysisConfig {
  const upper = Number.isFinite(upMax) ? Math.min(4, Math.max(0, upMax)) : 4;
  const lower = Number.isFinite(downMin) ? Math.min(4, Math.max(0, downMin)) : 0;
  const groups = new Map<string, FilterGroup>();
  for (const group of config.fieldFilters || []) {
    const id = group.id.replace(/::curve-bound-(UP|DOWN)$/, "");
    const conditions = group.conditions.filter(condition => !condition.id.startsWith(BOUND_ID))
      .map(condition => ({ ...condition, values: [...condition.values] }));
    // Empty/incomplete OR groups were ignored by the original engine. Adding a bound
    // must not turn one of them into a new branch that bypasses the usable groups.
    if (conditions.some(condition => isConditionReady(condition, BOUND_FIELDS.get(condition.field)))) {
      groups.set(`${id}:${JSON.stringify(conditions)}`, { id, conditions });
    }
  }
  const baseGroups = groups.size ? [...groups.values()] : [{ id: "__jev_curve_unfiltered", conditions: [] }];
  const fieldFilters = baseGroups.flatMap(group => (["UP", "DOWN"] as const).map(direction => {
    const directionCondition: FilterCondition = {
      id: `${BOUND_ID}dir_${direction}`, field: "trade_dir", op: "in", a: null, b: null,
      values: [direction], enabled: true,
    };
    const scoreCondition: FilterCondition = {
      id: `${BOUND_ID}value_${direction}`, field: "trade_score", op: direction === "UP" ? "lte" : "gte",
      a: direction === "UP" ? upper : lower, b: null, values: [], enabled: true,
    };
    return {
      id: `${group.id}::curve-bound-${direction}`,
      conditions: [...group.conditions.map(condition => ({ ...condition, values: [...condition.values] })), directionCondition, scoreCondition],
    };
  }));
  return { ...config, fieldFilters };
}
