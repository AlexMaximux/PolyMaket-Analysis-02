"use client";

import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from "react";
import { curveRowTime, type CurveDefinition, type CurveRow, type CurveUnit } from "@/lib/jevCurves";
import styles from "./CurveChart.module.css";

export interface CurveMarker {
  filename: string;
  time: number;
  direction: "UP" | "DOWN";
  outcome?: string | null;
}

export interface CurveReference { unit: CurveUnit; value: number; label: string }

export interface CurveChartProps {
  rows: CurveRow[];
  series: CurveDefinition[];
  range: [number, number] | null;
  onRangeChange: (range: [number, number] | null) => void;
  hoveredTime: number | null;
  onHover: (time: number | null) => void;
  onSelectRow: (row: CurveRow) => void;
  markers?: CurveMarker[];
  references?: CurveReference[];
}

interface TimedRow { time: number; row: CurveRow }
interface Point { time: number; value: number }
interface LaneSeries { definition: CurveDefinition; path: string; last: number | null }
interface Lane {
  unit: CurveUnit;
  series: LaneSeries[];
  ticks: number[];
  y: (value: number) => number;
  references: CurveReference[];
}

const UNITS: Record<CurveUnit, { name: string; suffix: string }> = {
  score: { name: "امتیاز مدل", suffix: "0–4" },
  percent: { name: "اطمینان و احتمال", suffix: "%" },
  cents: { name: "قیمت بازار و ارزش منصفانه", suffix: "¢" },
  edge: { name: "فاصلهٔ ارزش منصفانه از بازار", suffix: "¢" },
  usd: { name: "قیمت نقدی و قیمت مرجع", suffix: "USD" },
  change: { name: "فاصلهٔ نسبی از قیمت مرجع", suffix: "%" },
};

const UNIT_ORDER: CurveUnit[] = ["score", "percent", "cents", "edge", "usd", "change"];
const dateFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", day: "2-digit", month: "short" });
const timeFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
const fullFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
const numeric = (value: number, digits = 1) => value.toLocaleString("en-US", { maximumFractionDigits: digits });
const timeLabel = (time: number, long = true) => (long ? fullFormat : timeFormat).format(time);

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(760);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.max(240, Math.round(entry.contentRect.width));
      setWidth(current => current === next ? current : next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

function orderedRows(rows: CurveRow[]): TimedRow[] {
  return rows.flatMap(row => {
    const time = curveRowTime(row);
    return time == null ? [] : [{ time, row }];
  }).sort((a, b) => a.time - b.time || a.row.filename.localeCompare(b.row.filename));
}

function nearest(rows: TimedRow[], time: number): TimedRow | undefined {
  if (!rows.length) return undefined;
  let lower = 0, upper = rows.length;
  while (lower < upper) {
    const middle = (lower + upper) >>> 1;
    if (rows[middle].time <= time) lower = middle + 1;
    else upper = middle;
  }
  const before = rows[Math.max(0, lower - 1)];
  const after = rows[Math.min(lower, rows.length - 1)];
  return Math.abs(before.time - time) <= Math.abs(after.time - time) ? before : after;
}

function domain(rows: TimedRow[], selected: [number, number] | null): [number, number] {
  const first = rows[0]?.time ?? 0;
  const last = rows[rows.length - 1]?.time ?? 1;
  if (!selected || !selected.every(Number.isFinite)) return first === last ? [first - 30_000, last + 30_000] : [first, last];
  const from = Math.max(first, Math.min(selected[0], selected[1]));
  const until = Math.min(last, Math.max(selected[0], selected[1]));
  // A view outside this coin's history stays visibly empty; it is not silently reset.
  return until > from ? [from, until] : [Math.min(...selected), Math.max(...selected) + (selected[0] === selected[1] ? 1 : 0)];
}

/** First/minimum/maximum/last within each pixel: spikes survive decimation. */
function decimate(points: Point[], x: (time: number) => number): Point[] {
  if (points.length < 4) return points;
  const result: Point[] = [];
  let start = 0;
  while (start < points.length) {
    const pixel = Math.floor(x(points[start].time));
    let end = start + 1, minimum = start, maximum = start;
    while (end < points.length && Math.floor(x(points[end].time)) === pixel) {
      if (points[end].value < points[minimum].value) minimum = end;
      if (points[end].value > points[maximum].value) maximum = end;
      end++;
    }
    for (const index of [...new Set([start, minimum, maximum, end - 1])].sort((a, b) => a - b)) result.push(points[index]);
    start = end;
  }
  return result;
}

function typicalGap(rows: TimedRow[]): number {
  const times = rows.map(row => row.time);
  const differences = times.slice(1).map((time, i) => time - times[i]).filter(value => value > 0).sort((a, b) => a - b);
  return Math.max(15 * 60_000, (differences[Math.floor(differences.length / 2)] || 5 * 60_000) * 4);
}

function segmentedPoints(rows: TimedRow[], definition: CurveDefinition): Point[][] {
  const coins = new Map<string, TimedRow[]>();
  for (const timed of rows) {
    const key = timed.row.coin || "unknown";
    const coin = coins.get(key);
    if (coin) coin.push(timed);
    else coins.set(key, [timed]);
  }
  const segments: Point[][] = [];
  for (const coinRows of coins.values()) {
    const maxGap = typicalGap(coinRows);
    let segment: Point[] = [];
    let previousTime: number | null = null;
    for (const timed of coinRows) {
      const value = definition.get(timed.row);
      if (value == null || !Number.isFinite(value) || (previousTime != null && timed.time - previousTime > maxGap)) {
        if (segment.length) segments.push(segment);
        segment = [];
      }
      if (value != null && Number.isFinite(value)) segment.push({ time: timed.time, value });
      previousTime = timed.time;
    }
    if (segment.length) segments.push(segment);
  }
  return segments;
}

function niceExtent(minimum: number, maximum: number, unit: CurveUnit): number[] {
  if (unit === "score") return [0, 1, 2, 3, 4];
  if (unit === "percent" || unit === "cents") return [0, 25, 50, 75, 100];
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return [-1, -0.5, 0, 0.5, 1];
  const min = unit === "usd" ? minimum : Math.min(0, minimum);
  const max = unit === "usd" ? maximum : Math.max(0, maximum);
  const span = max - min || Math.max(Math.abs(max) * 0.002, 1);
  const rawStep = span / 3;
  const power = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 2.5, 5, 10].find(value => value * power >= rawStep)! * power;
  const lower = Math.floor(min / step) * step;
  const upper = Math.max(lower + step * 4, Math.ceil(max / step) * step);
  return Array.from({ length: 5 }, (_, index) => lower + (upper - lower) * index / 4);
}

function tickLabel(value: number, unit: CurveUnit): string {
  if (unit === "usd") return `$${numeric(value, value < 10 ? 2 : 0)}`;
  if (unit === "edge" || unit === "change") return `${value > 0 ? "+" : ""}${numeric(value, Math.abs(value) < 1 ? 2 : 1)}`;
  return numeric(value, 1);
}

function pointPath(points: Point[], x: (time: number) => number, y: (value: number) => number): string {
  if (points.length === 1) return `M${(x(points[0].time) - 1).toFixed(2)},${y(points[0].value).toFixed(2)}h2`;
  return points.map((point, index) => `${index ? "L" : "M"}${x(point.time).toFixed(2)},${y(point.value).toFixed(2)}`).join(" ");
}

const EMPTY_MARKERS: CurveMarker[] = [];
const EMPTY_REFERENCES: CurveReference[] = [];

export function CurveChart({ rows, series, range, onRangeChange, hoveredTime, onHover, onSelectRow, markers = EMPTY_MARKERS, references = EMPTY_REFERENCES }: CurveChartProps) {
  const { ref, width } = useWidth();
  const clipId = useId().replaceAll(":", "");
  const timedRows = useMemo(() => orderedRows(rows), [rows]);
  const [drag, setDrag] = useState<{ start: number; end: number } | null>(null);
  const pointerStart = useRef<number | null>(null);
  const hoveredRef = useRef<number | null>(null);
  const left = width < 440 ? 60 : 72, right = 12;
  const height = width < 440 ? 158 : 176, top = 10, bottom = 28;
  const plotWidth = Math.max(1, width - left - right), plotHeight = height - top - bottom;
  const [from, until] = useMemo(() => domain(timedRows, range), [timedRows, range]);
  const visibleRows = useMemo(() => timedRows.filter(point => point.time >= from && point.time <= until), [timedRows, from, until]);
  const x = useMemo(() => (time: number) => left + (time - from) / Math.max(1, until - from) * plotWidth, [left, from, until, plotWidth]);
  const lanes = useMemo(() => {
    const result: Lane[] = [];
    for (const unit of UNIT_ORDER) {
      const definitions = series.filter(definition => definition.unit === unit);
      if (!definitions.length) continue;
      const points = definitions.map(definition => ({ definition, segments: segmentedPoints(visibleRows, definition) }));
      const laneReferences = references.filter(reference => reference.unit === unit && Number.isFinite(reference.value));
      let min = Infinity, max = -Infinity;
      for (const curve of points) for (const segment of curve.segments) for (const point of segment) {
        min = Math.min(min, point.value); max = Math.max(max, point.value);
      }
      for (const reference of laneReferences) { min = Math.min(min, reference.value); max = Math.max(max, reference.value); }
      const ticks = niceExtent(min, max, unit);
      const y = (value: number) => top + (ticks[4] - value) / (ticks[4] - ticks[0]) * plotHeight;
      result.push({ unit, ticks, y, references: laneReferences, series: points.map(({ definition, segments }) => ({ definition, path: segments.map(segment => pointPath(decimate(segment, x), x, y)).join(" "), last: segments[segments.length - 1]?.at(-1)?.value ?? null })) });
    }
    return result;
  }, [series, visibleRows, references, top, plotHeight, x]);
  const timeTicks = useMemo(() => {
    if (!timedRows.length) return [];
    const count = width < 500 ? 3 : 5;
    return Array.from({ length: count }, (_, index) => {
      const time = from + (until - from) * index / (count - 1);
      return { time, label: until - from > 2 * 86400_000 ? dateFormat.format(time) : timeLabel(time, until - from >= 86400_000), anchor: index === 0 ? "start" : index === count - 1 ? "end" : "middle" };
    });
  }, [width, from, until, timedRows.length]);
  const visibleMarkers = useMemo(() => markers.filter(marker => marker.time >= from && marker.time <= until), [markers, from, until]);
  const markerPaths = useMemo(() => {
    const seen = new Set<string>();
    const up: string[] = [], down: string[] = [];
    for (const marker of visibleMarkers) {
      const position = x(marker.time);
      const key = `${marker.direction}-${Math.floor(position / 3)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const path = marker.direction === "UP" ? `M${position - 3},${top + 7}l3,-5l3,5z` : `M${position - 3},${top + 1}l3,5l3,-5z`;
      (marker.direction === "UP" ? up : down).push(path);
    }
    return { up: up.join(" "), down: down.join(" "), displayed: seen.size };
  }, [visibleMarkers, x, top]);
  const hovered = hoveredTime == null || hoveredTime < from || hoveredTime > until ? undefined : nearest(visibleRows, hoveredTime);
  const invalidTime = timedRows.length !== rows.length;

  function pointerTime(event: PointerEvent<SVGSVGElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const position = (event.clientX - bounds.left) / bounds.width * width;
    return from + Math.max(0, Math.min(1, (position - left) / plotWidth)) * (until - from);
  }
  function selectKeyboard(direction: -1 | 1) {
    if (!visibleRows.length) return;
    const selected = hoveredTime == null ? null : nearest(visibleRows, hoveredTime);
    const index = selected ? visibleRows.indexOf(selected) : direction === 1 ? -1 : visibleRows.length;
    const target = visibleRows[Math.max(0, Math.min(visibleRows.length - 1, index + direction))];
    hoveredRef.current = target.time;
    onHover(target.time);
  }

  function handleKeyDown(event: React.KeyboardEvent<SVGSVGElement>) {
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") { event.preventDefault(); selectKeyboard(event.key === "ArrowRight" ? 1 : -1); }
    if (event.key === "Enter" && hovered) { event.preventDefault(); onSelectRow(hovered.row); }
    if (event.key === "Escape") { setDrag(null); onRangeChange(null); }
  }
  function handlePointerDown(event: PointerEvent<SVGSVGElement>) {
    if (event.button !== 0) return;
    const time = pointerTime(event);
    pointerStart.current = time;
    setDrag({ start: time, end: time });
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function handlePointerMove(event: PointerEvent<SVGSVGElement>) {
    const time = pointerTime(event);
    if (pointerStart.current != null) setDrag({ start: pointerStart.current, end: time });
    const nearestRow = nearest(visibleRows, time);
    const nextTime = nearestRow?.time ?? null;
    if (nextTime !== hoveredRef.current) { hoveredRef.current = nextTime; onHover(nextTime); }
  }
  function handlePointerUp(event: PointerEvent<SVGSVGElement>) {
    const start = pointerStart.current;
    if (start == null) return;
    const end = pointerTime(event);
    pointerStart.current = null;
    setDrag(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (Math.abs(x(start) - x(end)) >= 8) onRangeChange([Math.min(start, end), Math.max(start, end)]);
    else { const selected = nearest(visibleRows, end); if (selected) onSelectRow(selected.row); }
  }
  function handlePointerCancel() { pointerStart.current = null; setDrag(null); }
  function handlePointerLeave() {
    if (pointerStart.current == null) { hoveredRef.current = null; onHover(null); }
  }

  return <div ref={ref} className={styles.chart} dir="ltr">
    {!series.length ? <div className={styles.empty} dir="rtl">یک یا چند پارامتر از فهرست منحنی‌ها انتخاب کنید.</div> : lanes.map((lane, laneIndex) => {
      const hasPoints = lane.series.some(curve => curve.path);
      const id = `${clipId}-${lane.unit}`;
      return <section className={styles.lane} key={lane.unit} aria-label={UNITS[lane.unit].name}>
        <div className={styles.laneHeading} dir="rtl"><h3>{UNITS[lane.unit].name} <span dir="ltr">{UNITS[lane.unit].suffix}</span></h3><div className={styles.legend}>{lane.series.map(({ definition }) => <span key={definition.id} dir="ltr"><svg width="15" height="6" aria-hidden="true"><line x1="0" x2="15" y1="3" y2="3" stroke={definition.color} strokeWidth="2" strokeDasharray={definition.dash} /></svg>{definition.label}</span>)}</div></div>
        {lane.references.length > 0 && <div className={styles.referenceLegend} dir="rtl">{lane.references.map((reference, index) => <span key={`${reference.label}-${index}`}><i />{reference.label}: <bdi>{numeric(reference.value, 2)}</bdi></span>)}</div>}
        <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="img" tabIndex={0} aria-label={`${UNITS[lane.unit].name}؛ محور زمان نیویورک. برای حرکت بین نقاط از کلیدهای چپ و راست، برای انتخاب از Enter و برای بازنشانی بزرگ‌نمایی از Escape استفاده کنید.`}
          onKeyDown={handleKeyDown}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onPointerLeave={handlePointerLeave}>
          <defs><clipPath id={id}><rect x={left} y={top - 1} width={plotWidth} height={plotHeight + 2} /></clipPath></defs>
          {lane.ticks.map(value => <g key={value}><line x1={left} x2={width - right} y1={lane.y(value)} y2={lane.y(value)} stroke={value === 0 ? "#45434a" : "#2a292e"} /><text x={left - 9} y={lane.y(value) + 4} textAnchor="end" className={styles.axis}>{tickLabel(value, lane.unit)}</text></g>)}
          <g clipPath={`url(#${id})`}>
            {lane.references.map((reference, index) => <line key={`${reference.label}-${index}`} x1={left} x2={width - right} y1={lane.y(reference.value)} y2={lane.y(reference.value)} stroke="#aaa5af" strokeDasharray="5 5" opacity=".65"><title>{reference.label}: {reference.value}</title></line>)}
            {lane.series.map(({ definition, path }) => <path key={definition.id} d={path} stroke={definition.color} strokeWidth="1.7" strokeDasharray={definition.dash} fill="none" vectorEffect="non-scaling-stroke" />)}
            {(lane.unit === "score" || (!lanes.some(item => item.unit === "score") && laneIndex === 0)) && <g><path d={markerPaths.up} fill="#80b5e5" /><path d={markerPaths.down} fill="#d8a5b3" /></g>}
            {drag && <rect x={Math.min(x(drag.start), x(drag.end))} y={top} width={Math.max(1, Math.abs(x(drag.end) - x(drag.start)))} height={plotHeight} fill="#80b5e5" fillOpacity=".12" stroke="#80b5e5" strokeWidth="1" />}
            {hovered && <g><line x1={x(hovered.time)} x2={x(hovered.time)} y1={top} y2={height - bottom} stroke="#a9a4ae" strokeDasharray="3 4" />{lane.series.map(({ definition }) => { const value = definition.get(hovered.row); return value != null && Number.isFinite(value) ? <circle key={definition.id} cx={x(hovered.time)} cy={lane.y(value)} r="3" fill={definition.color} stroke="#131217" strokeWidth="1" /> : null; })}</g>}
          </g>
          {timeTicks.map(({ time, label, anchor }) => <text key={time} x={x(time)} y={height - 7} textAnchor={anchor as "start" | "middle" | "end"} className={styles.axis}>{label}</text>)}
          {!hasPoints && <text x={left + plotWidth / 2} y={top + plotHeight / 2} textAnchor="middle" className={styles.emptyLabel}>{visibleRows.length ? "این پارامتر در بازهٔ انتخابی مقداری ندارد" : "اسنپ‌شاتی در این بازه وجود ندارد"}</text>}
        </svg>
      </section>;
    })}
    {series.length > 0 && <div className={styles.foot} dir="rtl"><span>{hovered ? <bdi>{timeLabel(hovered.time)} ET</bdi> : "حرکت روی منحنی: مقایسهٔ هم‌زمان · کلیک: جزئیات · کشیدن: بزرگ‌نمایی"}</span><span>{visibleRows.length.toLocaleString("fa-IR")} نقطه در بازه{visibleMarkers.length ? ` · ${visibleMarkers.length.toLocaleString("fa-IR")} سیگنال` : ""}</span></div>}
    {invalidTime && <p className={styles.note} dir="rtl">رکوردهای بدون زمان معتبر روی منحنی رسم نشده‌اند.</p>}
    {markerPaths.displayed < visibleMarkers.length && <p className={styles.note} dir="rtl">نشانگرهای هم‌مکان برای خوانایی فشرده شده‌اند؛ دادهٔ کامل در جزئیات نقطه در دسترس است.</p>}
  </div>;
}

export interface CurveNavigatorProps {
  rows: CurveRow[];
  range: [number, number] | null;
  onRangeChange: (range: [number, number] | null) => void;
  series?: CurveDefinition;
}

/** A full-history overview with separate, labelled and keyboard-operable time handles. */
export function CurveNavigator({ rows, range, onRangeChange, series }: CurveNavigatorProps) {
  const { ref, width } = useWidth();
  const ordered = useMemo(() => orderedRows(rows), [rows]);
  const first = ordered[0]?.time ?? 0, last = ordered.at(-1)?.time ?? 1;
  const total = Math.max(1, last - first);
  const from = range ? Math.max(first, Math.min(last, range[0])) : first;
  const until = range ? Math.max(from, Math.min(last, range[1])) : last;
  const x = useMemo(() => (time: number) => (time - first) / total * width, [first, total, width]);
  const path = useMemo(() => {
    const definition: CurveDefinition = series ?? { id: "navigator-score", label: "JEV score", group: "Models", unit: "score", color: "#80b5e5", get: row => typeof row.score === "number" && Number.isFinite(row.score) ? row.score : null };
    const segments = segmentedPoints(ordered, definition);
    let minimum = Infinity, maximum = -Infinity;
    for (const segment of segments) for (const point of segment) { minimum = Math.min(minimum, point.value); maximum = Math.max(maximum, point.value); }
    const span = maximum - minimum || 1;
    const y = (value: number) => 4 + (maximum - value) / span * 34;
    return segments.map(segment => pointPath(decimate(segment, x), x, y)).join(" ");
  }, [ordered, series, x]);
  const canChange = ordered.length > 1 && first < last;
  const normalized = (time: number) => Math.round((time - first) / total * 10000);
  const toTime = (value: string) => first + Number(value) / 10000 * total;

  return <div ref={ref} className={styles.navigator} dir="rtl">
    <div className={styles.navigatorHeading}><span>ناوبر تاریخچه <small>{series?.label || "JEV score"}</small></span><button type="button" onClick={() => onRangeChange(null)} disabled={!range}>نمایش کل بازه</button></div>
    <svg viewBox={`0 0 ${width} 44`} width="100%" height="44" role="img" aria-label="نمای فشردهٔ کل تاریخچه و بازهٔ زمانی انتخابی" style={{ direction: "ltr" }}><path d={path} fill="none" stroke="#74717c" strokeWidth="1" /><rect x={x(from)} y="1" width={Math.max(1, x(until) - x(from))} height="42" fill="#80b5e5" fillOpacity=".08" stroke="#80b5e5" strokeWidth="1" /></svg>
    <div className={styles.handles}>
      <label><span>شروع <bdi>{ordered.length ? timeLabel(from) : "—"}</bdi></span><input type="range" min="0" max="10000" step="1" value={normalized(from)} aria-label="شروع بازهٔ نمودار" aria-valuetext={ordered.length ? `${timeLabel(from)} ET` : "بدون داده"} disabled={!canChange} onChange={event => onRangeChange([Math.min(toTime(event.target.value), until - 1), until])} /></label>
      <label><span>پایان <bdi>{ordered.length ? timeLabel(until) : "—"}</bdi></span><input type="range" min="0" max="10000" step="1" value={normalized(until)} aria-label="پایان بازهٔ نمودار" aria-valuetext={ordered.length ? `${timeLabel(until)} ET` : "بدون داده"} disabled={!canChange} onChange={event => onRangeChange([from, Math.max(toTime(event.target.value), from + 1)])} /></label>
    </div>
  </div>;
}
