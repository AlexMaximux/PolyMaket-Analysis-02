"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { computeMetrics, type Trade } from "@/lib/signalAnalysis";
import styles from "./LabCharts.module.css";

const money = (value: number) => `${value < 0 ? "−" : value > 0 ? "+" : ""}$${Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const tickMoney = (value: number) => `${value < 0 ? "−" : value > 0 ? "+" : ""}$${Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: Math.abs(value) < 10 ? 1 : 0 })}`;
const dateFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", month: "short", day: "2-digit" });
const dateTimeFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const dateLabel = (time: number, withTime = false) => (withTime ? dateTimeFormat : dateFormat).format(time);

function useChartWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(700);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(260, Math.round(entry.contentRect.width))));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

interface EquityPoint { time: number; value: number; trade?: Trade }

function pointsOf(trades: Trade[]): EquityPoint[] {
  const resolved = trades.filter((t) => t.status !== "PENDING" && t.entry != null && t.entry > 0 && t.entry < 1 && Number.isFinite(t.time) && t.time > 0)
    .sort((a, b) => a.time - b.time || a.row.filename.localeCompare(b.row.filename));
  if (!resolved.length) return [];
  let value = 0;
  return [{ time: resolved[0].time, value: 0 }, ...resolved.map((trade) => ({ time: trade.time, value: value += trade.pnl, trade }))];
}

function nearest(points: EquityPoint[], time: number): EquityPoint | undefined {
  if (!points.length) return undefined;
  let low = 0, high = points.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (points[mid].time <= time) low = mid + 1;
    else high = mid;
  }
  const before = points[Math.max(0, low - 1)], after = points[Math.min(low, points.length - 1)];
  return Math.abs(before.time - time) <= Math.abs(after.time - time) ? before : after;
}

function valueAt(points: EquityPoint[], time: number): EquityPoint | undefined {
  if (!points.length || points[0].time > time) return undefined;
  let low = 0, high = points.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (points[mid].time <= time) low = mid;
    else high = mid - 1;
  }
  return points[low];
}

function equityGeometry(current: EquityPoint[], comparison: EquityPoint[], width: number, stake: number) {
  const all = [...current, ...comparison];
  const height = 234, left = 66, right = 10, top = 12, bottom = 38;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const bounds = all.reduce((result, point) => ({
    from: Math.min(result.from, point.time), until: Math.max(result.until, point.time),
    min: Math.min(result.min, point.value), max: Math.max(result.max, point.value),
  }), { from: Infinity, until: -Infinity, min: 0, max: 0 });
  const from = all.length ? bounds.from : 0;
  const until = all.length ? bounds.until : 1;
  const rawMin = bounds.min;
  const rawMax = bounds.max;
  const span = rawMax - rawMin || Math.max(stake, 1);
  const rawStep = span / 3;
  const power = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 2.5, 5, 10].find((n) => n * power >= rawStep)! * power;
  const yMin = Math.floor(rawMin / step) * step;
  const yMax = Math.max(yMin + step * 4, Math.ceil(rawMax / step) * step);
  const x = (time: number) => left + (until === from ? plotWidth / 2 : (time - from) / (until - from) * plotWidth);
  const y = (value: number) => top + (yMax - value) / (yMax - yMin) * plotHeight;
  const path = (points: EquityPoint[]) => points.map((p, i) => `${i ? "L" : "M"}${x(p.time).toFixed(2)},${y(p.value).toFixed(2)}`).join(" ");
  const ticks = Array.from({ length: 5 }, (_, i) => yMin + (yMax - yMin) * i / 4);
  const xTicks = width < 480 ? 3 : 5;
  const timeTicks = all.length ? Array.from({ length: until === from ? 1 : xTicks }, (_, i) => {
    const time = until === from ? from : from + (until - from) * i / (xTicks - 1);
    return { time, label: dateLabel(time, until - from < 2 * 86400000), anchor: until === from ? "middle" as const : i === 0 ? "start" as const : i === xTicks - 1 ? "end" as const : "middle" as const };
  }) : [];
  return { height, left, right, top, bottom, plotWidth, plotHeight, from, until, x, y, ticks, timeTicks, currentPath: path(current), comparisonPath: path(comparison) };
}

export function EquityChart({ trades, compareTrades, stake }: { trades: Trade[]; compareTrades?: Trade[]; stake: number }) {
  const { ref, width } = useChartWidth();
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const current = useMemo(() => pointsOf(trades), [trades]);
  const comparison = useMemo(() => pointsOf(compareTrades ?? []), [compareTrades]);
  const { height, left, right, top, bottom, plotWidth, plotHeight, from, until, x, y, ticks, timeTicks, currentPath, comparisonPath } = useMemo(() => equityGeometry(current, comparison, width, stake), [current, comparison, width, stake]);
  const hovered = hoverTime == null ? undefined : nearest(current, hoverTime);
  const compareHovered = hovered ? valueAt(comparison, hovered.time) : undefined;
  const missingTime = useMemo(() => trades.filter((t) => t.status !== "PENDING" && (!Number.isFinite(t.time) || t.time <= 0)).length, [trades]);

  return (
    <div ref={ref} className={`jl-equity-chart ${styles.equity}`} dir="ltr">
      {comparison.length > 0 && <div className={styles.legend} dir="rtl"><span><i className={styles.activeSwatch} /> استراتژی فعلی</span><span><i className={styles.compareSwatch} /> مبنای مقایسه</span></div>}
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label="نمودار سود و زیان تجمعی فرضی، به ترتیب زمان ورود معاملات؛ محور افقی زمان نیویورک و محور عمودی دلار" onPointerLeave={() => setHoverTime(null)} onPointerMove={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        const pointX = (event.clientX - bounds.left) / bounds.width * width;
        const point = nearest(current, from + Math.max(0, Math.min(1, (pointX - left) / plotWidth)) * (until - from));
        const selectedTime = point?.time ?? null;
        setHoverTime(previous => previous === selectedTime ? previous : selectedTime);
      }}>
        {ticks.map((value) => <g key={value}><line x1={left} x2={width - right} y1={y(value)} y2={y(value)} stroke={value === 0 ? "#56545a" : "#2a2a2d"} strokeWidth="1" /><text x={left - 10} y={y(value) + 4} textAnchor="end" className={styles.axis}>{tickMoney(value)}</text></g>)}
        {timeTicks.map(({ time, label, anchor }) => <text key={time} x={x(time)} y={height - 12} textAnchor={anchor} className={styles.axis}>{label}</text>)}
        {comparison.length > 0 && <path d={comparisonPath} fill="none" stroke="#77777d" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />}
        {current.length > 0 && <path d={currentPath} fill="none" stroke="#80b5e5" strokeWidth="2" vectorEffect="non-scaling-stroke" />}
        {hovered && <g><line x1={x(hovered.time)} x2={x(hovered.time)} y1={top} y2={height - bottom} stroke="#55545a" strokeDasharray="3 4" /><circle cx={x(hovered.time)} cy={y(hovered.value)} r="3.5" fill="#80b5e5" /></g>}
        {!current.length && <text x={left + plotWidth / 2} y={top + plotHeight / 2} textAnchor="middle" className={styles.emptyText}>معاملهٔ تسویه‌شده‌ای برای رسم وجود ندارد</text>}
      </svg>
      <div className={styles.caption} dir="rtl" aria-live="polite">
        {hovered ? <><span dir="ltr">{dateLabel(hovered.time, true)} ET</span><strong dir="ltr">{money(hovered.value)}</strong>{compareHovered && <span dir="ltr">مبنا: {money(compareHovered.value)}</span>}</> : <span>سود تجمعی فرضی بر اساس ترتیب ورود · سرمایهٔ ثابت <bdi>${stake.toLocaleString("en-US")}</bdi> برای هر معامله</span>}
      </div>
      {missingTime > 0 && <p className={styles.note} dir="rtl">{missingTime.toLocaleString("fa-IR")} معامله بدون زمان معتبر در نمودار رسم نشده است.</p>}
    </div>
  );
}

export function BreakdownChart({ trades, stake, groupBy }: { trades: Trade[]; stake: number; groupBy: "coin" | "hour" | "direction" }) {
  const [expanded, setExpanded] = useState(false);
  const groups = useMemo(() => {
    const map = new Map<string, Trade[]>();
    for (const trade of trades) {
      const key = groupBy === "coin" ? trade.coin : groupBy === "hour" ? `${String(trade.hour).padStart(2, "0")}:00` : trade.dir;
      const rows = map.get(key);
      if (rows) rows.push(trade);
      else map.set(key, [trade]);
    }
    return [...map].map(([label, rows]) => ({ label, metrics: computeMetrics(rows, stake) })).sort((a, b) => b.metrics.pnl - a.metrics.pnl || a.label.localeCompare(b.label));
  }, [trades, stake, groupBy]);
  const visible = expanded ? groups : groups.slice(0, 8);
  const min = Math.min(0, ...groups.map((g) => g.metrics.pnl));
  const max = Math.max(0, ...groups.map((g) => g.metrics.pnl));
  const range = max - min || 1;
  const zero = -min / range * 100;
  return (
    <div className={`jl-breakdown-chart ${styles.breakdown}`} dir="rtl">
      {!groups.length ? <p className={styles.empty}>با قوانین فعلی معامله‌ای انتخاب نشده است.</p> : <>
        <div className={styles.breakdownHeader}><span>{groupBy === "coin" ? "دارایی" : groupBy === "hour" ? "ساعت ورود · ET" : "جهت معامله"}</span><span>سود / زیان · دلار</span></div>
        {visible.map(({ label, metrics }) => {
          const end = (metrics.pnl - min) / range * 100;
          return <div key={label} className={styles.breakdownRow}>
            <div className={styles.rowLabel}><strong dir="ltr">{label}</strong><span>{metrics.resolved.toLocaleString("fa-IR")} تسویه‌شده{metrics.pending ? ` · ${metrics.pending.toLocaleString("fa-IR")} باز` : ""}</span></div>
            <div className={styles.barColumn}><div className={styles.barTrack} dir="ltr"><i className={styles.zero} style={{ left: `${zero}%` }} /><i className={metrics.pnl < 0 ? styles.negativeBar : styles.positiveBar} style={{ left: `${Math.min(zero, end)}%`, width: `${Math.abs(end - zero)}%` }} /></div><span className={styles.barValue} dir="ltr">{money(metrics.pnl)}</span></div>
          </div>;
        })}
        <div className={styles.breakdownScale}><span /><div dir="ltr"><span>{tickMoney(min)}</span><span>{tickMoney(max)}</span></div></div>
        {groups.length > 8 && <button type="button" className={styles.expand} onClick={() => setExpanded(!expanded)}>{expanded ? "نمایش کمتر" : `نمایش هر ${groups.length.toLocaleString("fa-IR")} گروه`}</button>}
      </>}
    </div>
  );
}
