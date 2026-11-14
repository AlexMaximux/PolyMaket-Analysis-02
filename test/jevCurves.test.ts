import { describe, expect, it } from "vitest";
import { CURVE_BY_ID, CURVE_DEFINITIONS, CURVE_PRESETS, buildCurvePoints, curveEtParts, curveExtent, curveRowTime, filterCurveRows, sanitizeCurveIds, sortCurveRows, withCurveScoreBounds, withoutCurveScoreBounds, type CurveRow } from "@/lib/jevCurves";
import { DEFAULT_ANALYSIS_CONFIG, buildTrades, type AnalysisConfig } from "@/lib/signalAnalysis";

const row = (minute: number, extra: Partial<CurveRow> = {}): CurveRow => ({
  filename: `btc_2026-10-01_12-${String(minute).padStart(2, "0")}-00_ET.json`,
  coin: "BTC", et_time: `2026-10-01 12:${String(minute).padStart(2, "0")}:00 ET`,
  timestamp: `2026-10-01T16:${String(minute).padStart(2, "0")}:00.000Z`, ...extra,
});
const get = (id: string, data: CurveRow) => CURVE_BY_ID.get(id)!.get(data);

describe("curve value registry", () => {
  it("keeps already-normalized probabilities, true zeroes and absent values distinct", () => {
    const data = row(0, { prob_up: 0.5, kev_prob_up: 90, span_prob_up: 0, solar_score_confidence: 81, consensus_agreement: 100 });
    expect(get("prob_up", data)).toBe(0.5);
    expect(get("kev_prob_up", data)).toBe(90);
    expect(get("span_prob_up", data)).toBe(0);
    expect(get("solar_score_confidence", data)).toBe(81);
    expect(get("consensus_agreement", data)).toBe(100);
    expect(get("mercury_prob_up", data)).toBeNull();
    expect(get("tev_score", row(0, { tev_score: NaN }))).toBeNull();
    expect(get("score", row(0, { score: 4.1 }))).toBeNull();
  });
  it("computes binary complements and fair-market edges without inventing a missing operand", () => {
    const data = row(0, { up_1h_num: 77.2, fair_claude: 81.7, fair_15m: 70, prob_up: 0.5 });
    expect(get("down_1h_num", data)).toBeCloseTo(22.8);
    expect(get("prob_down", data)).toBeCloseTo(99.5);
    expect(get("fair_claude_edge", data)).toBeCloseTo(4.5);
    expect(get("fair_15m_edge", data)).toBeCloseTo(-7.2);
    expect(get("down_1h_num", row(0))).toBeNull();
    expect(get("fair_claude_edge", row(0, { fair_claude: 81 }))).toBeNull();
  });
  it("reads the TimesFM score, probabilities and fair-value edge", () => {
    const data = row(0, { tfm_score: 3.1, tfm_prob_up: 77.5, fair_tfm: 77.5, up_1h_num: 70 });
    expect(get("tfm_score", data)).toBe(3.1);
    expect(get("tfm_prob_up", data)).toBe(77.5);
    expect(get("fair_tfm", data)).toBe(77.5);
    expect(get("tfm_prob_down", data)).toBeCloseTo(22.5);
    expect(get("fair_tfm_edge", data)).toBeCloseTo(7.5);
    expect(get("fair_tfm_edge", row(0, { fair_tfm: 77.5 }))).toBeNull();
  });
  it("requires a nonzero denominator for spot changes and enough scores for disagreement", () => {
    expect(get("spot_vs_ptb", row(0, { spot_price: 101, price_to_beat: 100 }))).toBeCloseTo(1);
    expect(get("spot_vs_ptb", row(0, { spot_price: 101, price_to_beat: 0 }))).toBeNull();
    expect(get("avg_score", row(0, { score: 4, kev_score: 2 }))).toBe(3);
    expect(get("score_spread", row(0, { score: 4 }))).toBeNull();
    expect(get("score_spread", row(0, { score: 4, kev_score: 2 }))).toBe(2);
  });
  it("has stable unique ids, valid presets and at most four hues", () => {
    expect(new Set(CURVE_DEFINITIONS.map(curve => curve.id)).size).toBe(CURVE_DEFINITIONS.length);
    expect(new Set(CURVE_DEFINITIONS.map(curve => curve.color)).size).toBeLessThanOrEqual(4);
    for (const ids of Object.values(CURVE_PRESETS)) expect(ids.every(id => CURVE_BY_ID.has(id))).toBe(true);
    expect(sanitizeCurveIds(["score", "removed_field", "score", 20, "fair_claude"])).toEqual(["score", "fair_claude"]);
    expect(sanitizeCurveIds([])).toEqual([]);
    expect(sanitizeCurveIds(null)).toEqual(CURVE_PRESETS.core);
  });
});

describe("absolute curve time", () => {
  it("prefers absolute timestamps and converts ET-only summer and winter records accurately", () => {
    expect(curveRowTime(row(0))).toBe(Date.parse("2026-10-01T16:00:00Z"));
    expect(curveRowTime(row(0, { timestamp: null, et_time: "2026-07-01 12:34:56 ET" }))).toBe(Date.parse("2026-07-01T16:34:56Z"));
    expect(curveRowTime(row(0, { timestamp: null, et_time: "2026-12-01 12:34:56 ET" }))).toBe(Date.parse("2026-12-01T17:34:56Z"));
    expect(curveRowTime(row(0, { timestamp: null, et_time: "btc_updown_2026-12-01_12-34-56_ET.json" }))).toBe(Date.parse("2026-12-01T17:34:56Z"));
  });
  it("rejects nonexistent spring hours and invalid dates, disambiguates EST/EDT in the fall", () => {
    const et = (et_time: string) => curveRowTime(row(0, { timestamp: null, et_time }));
    expect(et("2026-03-08 02:30:00 ET")).toBeNull();
    expect(et("2026-02-30 12:30:00 ET")).toBeNull();
    expect(et("2026-10-01 25:00:00 ET")).toBeNull();
    expect(et("2026-11-01 01:30:00 EDT")).toBe(Date.parse("2026-11-01T05:30:00Z"));
    expect(et("2026-11-01 01:30:00 EST")).toBe(Date.parse("2026-11-01T06:30:00Z"));
    expect(et("2026-11-01 01:30:00 ET")).toBe(Date.parse("2026-11-01T05:30:00Z"));
    expect(curveEtParts(row(0, { et_time: "unknown", timestamp: "2026-12-01T05:30:00Z" }))).toEqual({ date: "2026-12-01", hour: 0, minute: 30, second: 0 });
  });
  it("sorts actual timestamps rather than filename order and leaves input untouched", () => {
    const early = row(5, { filename: "z.json" }), late = row(20, { filename: "a.json" });
    const source = [late, early];
    expect(sortCurveRows(source)).toEqual([early, late]);
    expect(source).toEqual([late, early]);
  });
});

describe("curve scope and transformations", () => {
  it("applies inclusive coin/date/minute/hour filters in ET", () => {
    const rows = [row(45), row(30), row(40, { coin: "ETH" }), row(50), row(40, { et_time: "2026-10-02 12:40:00 ET" })];
    expect(filterCurveRows(rows, { coin: "btc", dateFrom: "2026-10-01", dateTo: "2026-10-01", startMinute: 30, endMinute: 45, hours: [12] })).toEqual([rows[1], rows[0]]);
    expect(filterCurveRows(rows, { coin: "BTC", hours: [13] })).toEqual([]);
  });
  it("preserves missing responses, large time gaps, and valid zeroes", () => {
    const points = buildCurvePoints([row(40, { score: 4 }), row(5, { score: 0 }), row(10), row(15, { score: 2 })], "score", { maxGapMs: 10 * 60_000 });
    expect(points.map(point => point.value)).toEqual([0, null, 2, null, 4]);
    expect(curveExtent(points)).toEqual([0, 4]);
    expect(curveExtent([{ value: null }, { value: NaN }])).toBeNull();
  });
  it("uses only trailing windows and restarts means/differences after missing data", () => {
    const rows = [row(0, { score: 1 }), row(5, { score: 3 }), row(10), row(15, { score: 2 }), row(20, { score: 4 })];
    expect(buildCurvePoints(rows, "score", { transform: "mean", window: 2 }).map(point => point.value)).toEqual([null, 2, null, null, 3]);
    expect(buildCurvePoints(rows, "score", { transform: "delta" }).map(point => point.value)).toEqual([null, 2, null, null, 2]);
  });
  it("breaks between distinct coins instead of connecting unrelated prices", () => {
    const points = buildCurvePoints([row(0, { score: 1 }), row(5, { coin: "ETH", score: 3 })], "score");
    expect(points.map(point => point.value)).toEqual([1, null, 3]);
  });
});

describe("per-direction curve score caps", () => {
  const cfg: AnalysisConfig = { ...DEFAULT_ANALYSIS_CONFIG, dedupe: "all", bullishScore: 3, bearishScore: 1, bullishMinConf: 0, bearishMinConf: 0 };
  const scored = (minute: number, score: number, confidence = 95) => row(minute, { score, score_confidence: confidence, up_1h_num: 75 });
  it("keeps inclusive upper/lower caps while the signal thresholds stay strict", () => {
    const bounded = withCurveScoreBounds(cfg, 3.8, 0.2);
    const trades = buildTrades([scored(0, 3), scored(5, 3.5), scored(10, 3.8), scored(15, 3.81), scored(20, 1), scored(25, 0.5), scored(30, 0.2), scored(35, 0.19)], bounded);
    expect(trades.map(trade => trade.modelScore)).toEqual([3.5, 3.8, 0.5, 0.2]);
  });
  it("AND-composes each usable existing OR group and never activates an incomplete branch", () => {
    const config: AnalysisConfig = { ...cfg, fieldFilters: [
      { id: "incomplete", conditions: [{ id: "waiting", field: "trade_price", op: "between", a: null, b: null, values: [], enabled: true }] },
      { id: "conf", conditions: [{ id: "strict", field: "trade_conf", op: "gte", a: 90, b: null, values: [], enabled: true }] },
    ] };
    const before = structuredClone(config);
    const composed = withCurveScoreBounds(config, 3.8, 0.2);
    expect(composed.fieldFilters).toHaveLength(3);
    expect(buildTrades([scored(0, 3.5, 80), scored(5, 3.5, 95), scored(10, 0.3, 80), scored(15, 0.3, 95), scored(20, 4, 95)], composed).map(trade => trade.minute)).toEqual([5, 15]);
    expect(config).toEqual(before);
    expect(withCurveScoreBounds(composed, 3.8, 0.2)).toEqual(composed);
  });
  it("restores editable user price filters and incomplete groups without retaining synthetic caps", () => {
    const config: AnalysisConfig = { ...cfg, fieldFilters: [
      { id: "pending", conditions: [{ id: "not-ready", field: "trade_conf", op: "between", a: null, b: null, values: [], enabled: true }] },
      { id: "price", conditions: [{ id: "price-minimum", field: "trade_price", op: "gte", a: 90, b: null, values: [], enabled: true }] },
    ] };
    const original = structuredClone(config);
    const bounded = withCurveScoreBounds(config, 3.8, 0.2);
    const before = structuredClone(bounded);
    const editable = withoutCurveScoreBounds(bounded);
    expect(editable).toEqual(original);
    expect(editable.fieldFilters.flatMap(group => group.conditions).every(condition => !condition.id.startsWith("__jev_curve_score_bound_"))).toBe(true);
    const rows = [
      scored(0, 3.5), scored(5, 3.5), scored(10, 3.9), scored(15, 0.3), scored(20, 0.1),
    ].map((data, index) => ({ ...data, up_1h_num: [95, 80, 95, 5, 5][index] }));
    expect(buildTrades(rows, bounded).map(trade => trade.minute)).toEqual([0, 15]);
    expect(buildTrades(rows, withCurveScoreBounds(editable, 3.8, 0.2))).toEqual(buildTrades(rows, bounded));
    expect(bounded).toEqual(before);
    expect(config).toEqual(original);
    expect(withoutCurveScoreBounds(withCurveScoreBounds(cfg, 4, 0)).fieldFilters).toEqual([]);
  });
});
