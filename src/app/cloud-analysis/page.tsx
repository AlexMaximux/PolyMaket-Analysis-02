"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Download,
  HelpCircle,
  RefreshCw,
  RotateCcw,
  Scale,
  XCircle,
} from "lucide-react";
import {
  DEFAULT_ANALYSIS_CONFIG,
  FROZEN_STRATEGY,
  FROZEN_STRATEGY_2,
  STRATEGY_HISTORY,
  LATE_MINUTE,
  MINUTE_BUCKETS,
  MIN_RESOLVED_FOR_VERDICT,
  PRICE_BUCKETS,
  breakdown,
  buildTrades,
  computeMetrics,
  conflictingHours,
  filterBaseRows,
  minuteBucket,
  parseEtTime,
  priceBucket,
  verdictOf,
  type AnalysisConfig,
  type Metrics,
  type SnapshotRow,
  type Trade,
  type Verdict,
} from "@/lib/signalAnalysis";
import { LadderPanel } from "@/components/cloud-analysis/LadderPanel";

const STORAGE_KEY = "cloud_analysis_config_v1";

const C = {
  text: "#e8e8e4",
  text2: "#9a9ca3",
  muted: "#73757c",
  win: "#5fbf9a",
  loss: "#e5787f",
  pending: "#f5b83d",
  line: "#6aa9d8",
  grid: "rgba(190,190,200,0.10)",
};

// ---------- formatting ----------
const pct = (x: number | null | undefined, d = 1) => (x == null || isNaN(x) ? "—" : `${(x * 100).toFixed(d)}%`);
const money = (x: number | null | undefined) =>
  x == null || isNaN(x) ? "—" : `${x < 0 ? "−" : x > 0 ? "+" : ""}$${Math.abs(x).toFixed(2)}`;
const cents = (x: number | null | undefined) => (x == null ? "—" : `${(x * 100).toFixed(1)}¢`);
const signColor = (x: number | null | undefined) => (x == null ? C.text2 : x > 0 ? C.win : x < 0 ? C.loss : C.text2);

// ---------- scenarios ----------
type ScenarioDef = { id: string; name: string; hint: string; over: Partial<AnalysisConfig> };
// Scenarios keep the current data scope (coins/dates/hours) and money settings; they change only signal logic.
const SIGNAL_KEYS: (keyof AnalysisConfig)[] = [
  "model", "confidenceType", "bullishScore", "bearishScore", "bullishMinConf", "bearishMinConf", "directions",
  "consensus", "solarAgrees", "solarMinConf", "minMinute", "maxMinute", "minEntry", "maxEntry", "dedupe", "pickOrder",
];
const SCENARIOS: ScenarioDef[] = [
  { id: "raw", name: "Every signal snapshot", hint: "Each 5-min snapshot counted as its own trade (inflated).", over: { dedupe: "all" } },
  { id: "dash", name: "Dashboard: first per hour + direction", hint: "What the Jev page counts today.", over: { dedupe: "firstPerHourDir" } },
  { id: "strict", name: "Strict: first signal of the hour", hint: "One trade per market hour, later signals ignored.", over: { dedupe: "firstPerHour" } },
  { id: "c33", name: "3/3 consensus, first per hour", hint: "First signal where Jev, Kev and Span all agree.", over: { consensus: "3of3", dedupe: "firstPerHour" } },
  { id: "c33solar", name: "3/3 + Solar agrees", hint: "3/3 consensus plus Solar-Decide pointing the same way. Only rows recorded after Solar was added or backfilled can pass.", over: { consensus: "3of3", solarAgrees: true, dedupe: "firstPerHour" } },
  { id: "c33solarconf", name: "3/3 + Solar confidence ≥ 80%", hint: "3/3 consensus, and Solar's score confidence at least 80%. Threshold picked after looking at the data, so treat it as a hypothesis for a forward test.", over: { consensus: "3of3", solarMinConf: 80, dedupe: "firstPerHour" } },
  { id: "c33late", name: `3/3 + no late signals (min ≤ ${LATE_MINUTE - 1})`, hint: "Drops signals in the last 10 minutes.", over: { consensus: "3of3", dedupe: "firstPerHour", maxMinute: LATE_MINUTE - 1 } },
  { id: "c33price", name: "3/3 + price ≤ 90¢", hint: "Skips near-certain, low-payout entries.", over: { consensus: "3of3", dedupe: "firstPerHour", maxEntry: 90 } },
  { id: "c33first", name: "3/3 must be the hour's first signal", hint: "If the first signal is not 3/3, skip the hour.", over: { consensus: "3of3", dedupe: "firstPerHour", pickOrder: "beforeFilters" } },
];

function withScenario(base: AnalysisConfig, over: Partial<AnalysisConfig>): AnalysisConfig {
  const next = { ...base };
  for (const k of SIGNAL_KEYS) (next as Record<string, unknown>)[k] = DEFAULT_ANALYSIS_CONFIG[k];
  return { ...next, ...over };
}

// ---------- small UI pieces ----------
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

// Collapse state persists per-card (keyed by title) across reloads, same convention as the
// page's own settings storage. A title is required to collapse: an untitled card (e.g. the
// bare loading placeholder) has no header to click and always renders open.
function Card({ title, subtitle, right, children, className = "", defaultOpen = true }: {
  title?: string; subtitle?: string; right?: React.ReactNode; children: React.ReactNode; className?: string; defaultOpen?: boolean;
}) {
  const storageKey = title ? `cloud_analysis_card_open_${slugify(title)}` : null;
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    if (!storageKey) return;
    // deferred to a microtask, not called synchronously in the effect body, so the server
    // render and first client render still match before this restores the saved state
    Promise.resolve().then(() => {
      try {
        const saved = localStorage.getItem(storageKey);
        if (saved != null) setOpen(saved === "1");
      } catch {}
    });
  }, [storageKey]);

  const collapsible = !!title;
  const toggle = () => {
    if (!storageKey) return;
    setOpen((o) => {
      const next = !o;
      try {
        localStorage.setItem(storageKey, next ? "1" : "0");
      } catch {}
      return next;
    });
  };

  return (
    <section className={`rounded-2xl border border-white/[0.08] bg-[#181a1e]/80 p-4 ${className}`}>
      {(title || right) && (
        <div
          className={`flex items-start justify-between gap-3 ${open ? "mb-3" : ""} ${collapsible ? "cursor-pointer select-none" : ""}`}
          onClick={collapsible ? toggle : undefined}
        >
          <div className="flex items-start gap-1.5 min-w-0">
            {collapsible && (
              <ChevronRight className={`w-3.5 h-3.5 mt-1 shrink-0 text-[#73757c] transition-transform ${open ? "rotate-90" : ""}`} />
            )}
            <div className="min-w-0">
              {title && <h2 className="text-[14px] font-semibold text-[#e8e8e4]">{title}</h2>}
              {subtitle && open && <p className="text-[12px] text-[#9a9ca3] mt-0.5">{subtitle}</p>}
            </div>
          </div>
          {open && right}
        </div>
      )}
      {open && children}
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="flex items-center gap-1 text-[11px] font-medium text-[#9a9ca3] mb-1">
        {label}
        {hint && (
          <span title={hint} className="text-[#73757c] cursor-help">
            <HelpCircle className="w-3 h-3" />
          </span>
        )}
      </span>
      {children}
    </label>
  );
}

const inputCls =
  "w-full bg-[#0f1013] text-[#e8e8e4] border border-white/[0.12] rounded-lg px-2 py-1.5 text-[12px] font-mono focus:outline-none focus:border-[#8ea4e8]";

function NumberInput({ value, onChange, step = 1, min, max }: {
  value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number;
}) {
  return (
    <input
      type="number"
      className={inputCls}
      value={value}
      step={step}
      min={min}
      max={max}
      onChange={(e) => {
        const v = parseFloat(e.target.value);
        if (!isNaN(v)) onChange(v);
      }}
    />
  );
}

function Segmented<T extends string>({ value, options, onChange }: {
  value: T; options: { value: T; label: string; title?: string }[]; onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          onClick={() => onChange(o.value)}
          className={`px-2 py-1 rounded-md text-[11px] font-medium border transition-colors ${
            value === o.value
              ? "bg-[#6b86d6]/30 border-[#8ea4e8]/60 text-white"
              : "bg-transparent border-white/[0.10] text-[#9a9ca3] hover:text-white hover:bg-white/[0.06]"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Chips({ all, selected, onChange, render }: {
  all: string[]; selected: string[]; onChange: (v: string[]) => void; render?: (v: string) => string;
}) {
  const set = new Set(selected);
  return (
    <div className="flex flex-wrap gap-1">
      <button
        type="button"
        onClick={() => onChange([])}
        className={`px-2 py-0.5 rounded-md text-[11px] border ${
          selected.length === 0 ? "bg-[#6b86d6]/30 border-[#8ea4e8]/60 text-white" : "border-white/[0.10] text-[#9a9ca3] hover:text-white"
        }`}
      >
        All
      </button>
      {all.map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(set.has(v) ? selected.filter((x) => x !== v) : [...selected, v])}
          className={`px-2 py-0.5 rounded-md text-[11px] font-mono border ${
            set.has(v) ? "bg-[#6b86d6]/30 border-[#8ea4e8]/60 text-white" : "border-white/[0.10] text-[#9a9ca3] hover:text-white"
          }`}
        >
          {render ? render(v) : v}
        </button>
      ))}
    </div>
  );
}

function StatusTag({ status }: { status: Trade["status"] }) {
  const map = {
    WIN: { c: C.win, icon: <CheckCircle2 className="w-3 h-3" />, t: "Win" },
    LOSS: { c: C.loss, icon: <XCircle className="w-3 h-3" />, t: "Loss" },
    PENDING: { c: C.pending, icon: <RefreshCw className="w-3 h-3" />, t: "Pending" },
  }[status];
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold" style={{ color: map.c }}>
      {map.icon}
      {map.t}
    </span>
  );
}

function Kpi({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="rounded-xl border border-white/[0.07] bg-[#131418] px-3 py-2.5">
      <div className="text-[11px] text-[#9a9ca3]">{label}</div>
      <div className="text-[20px] font-semibold font-mono tracking-tight mt-0.5" style={{ color: color ?? C.text }}>
        {value}
      </div>
      {sub && <div className="text-[11px] text-[#73757c] mt-0.5">{sub}</div>}
    </div>
  );
}

// Win-rate bar with the 95% range and a break-even tick, so "wins more than it needs to" is visible at a glance.
function WinBar({ m }: { m: Metrics }) {
  if (m.winRate == null) return <span className="text-[#73757c] text-[11px]">—</span>;
  const lo = 0.5; // axis starts at 50%: every entry in this data costs well over 50¢
  const x = (v: number) => `${Math.max(0, Math.min(1, (v - lo) / (1 - lo))) * 100}%`;
  return (
    <div
      className="relative h-3 w-full min-w-[90px] rounded-sm bg-white/[0.05]"
      title={`Win rate ${pct(m.winRate)} (95% range ${pct(m.ciLow)}–${pct(m.ciHigh)}), break-even ${pct(m.breakEven)}`}
    >
      {m.ciLow != null && m.ciHigh != null && (
        <div className="absolute top-1 h-1 rounded-sm bg-white/[0.18]" style={{ left: x(m.ciLow), width: `calc(${x(m.ciHigh)} - ${x(m.ciLow)})` }} />
      )}
      <div
        className="absolute top-0 h-3 w-[3px] rounded-sm"
        style={{ left: `calc(${x(m.winRate)} - 1.5px)`, background: m.breakEven != null && m.winRate >= m.breakEven ? C.win : C.loss }}
      />
      {m.breakEven != null && (
        <div className="absolute -top-0.5 h-4 w-px bg-[#e8e8e4]/70" style={{ left: x(m.breakEven) }} />
      )}
    </div>
  );
}

function MetricsTable({ rows, onRowClick, highlight }: {
  rows: { key: string; label: string; hint?: string; metrics: Metrics }[];
  onRowClick?: (key: string) => void;
  highlight?: string;
}) {
  return (
    <div className="overflow-x-auto -mx-1">
      <table className="w-full text-[12px] border-separate border-spacing-0">
        <thead>
          <tr className="text-[#73757c] text-[11px]">
            <th className="text-left font-medium px-2 py-1.5">Group</th>
            <th className="text-right font-medium px-2 py-1.5">Trades</th>
            <th className="text-right font-medium px-2 py-1.5">W / L / P</th>
            <th className="text-right font-medium px-2 py-1.5">Win rate</th>
            <th className="text-right font-medium px-2 py-1.5" title="Win rate needed for zero profit at the prices actually paid">Break-even</th>
            <th className="font-medium px-2 py-1.5 w-[120px]" title="Bar: win rate. Grey: 95% range. White tick: break-even.">vs break-even</th>
            <th className="text-right font-medium px-2 py-1.5">P&L</th>
            <th className="text-right font-medium px-2 py-1.5">ROI</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.key}
              onClick={onRowClick ? () => onRowClick(r.key) : undefined}
              className={`${onRowClick ? "cursor-pointer" : ""} ${highlight === r.key ? "bg-[#6b86d6]/15" : "hover:bg-white/[0.04]"}`}
            >
              <td className="px-2 py-1.5 border-t border-white/[0.05]">
                <div className="text-[#e8e8e4]">{r.label}</div>
                {r.hint && <div className="text-[11px] text-[#73757c]">{r.hint}</div>}
              </td>
              <td className="px-2 py-1.5 border-t border-white/[0.05] text-right font-mono text-[#e8e8e4]">{r.metrics.trades}</td>
              <td className="px-2 py-1.5 border-t border-white/[0.05] text-right font-mono text-[#9a9ca3]">
                {r.metrics.wins} / {r.metrics.losses} / {r.metrics.pending}
              </td>
              <td className="px-2 py-1.5 border-t border-white/[0.05] text-right font-mono text-[#e8e8e4]">{pct(r.metrics.winRate)}</td>
              <td className="px-2 py-1.5 border-t border-white/[0.05] text-right font-mono text-[#9a9ca3]">{pct(r.metrics.breakEven)}</td>
              <td className="px-2 py-1.5 border-t border-white/[0.05]"><WinBar m={r.metrics} /></td>
              <td className="px-2 py-1.5 border-t border-white/[0.05] text-right font-mono" style={{ color: signColor(r.metrics.pnl) }}>
                {money(r.metrics.pnl)}
              </td>
              <td className="px-2 py-1.5 border-t border-white/[0.05] text-right font-mono" style={{ color: signColor(r.metrics.roi) }}>
                {pct(r.metrics.roi)}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={8} className="px-2 py-4 text-center text-[#73757c]">No trades</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---------- equity curve ----------
function EquityCurve({ trades }: { trades: Trade[] }) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setWidth(Math.max(320, entries[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const points = useMemo(() => {
    const out: { t: Trade; eq: number }[] = [];
    for (const t of trades) {
      if (t.status === "PENDING") continue;
      out.push({ t, eq: (out.length ? out[out.length - 1].eq : 0) + t.pnl });
    }
    return out;
  }, [trades]);

  const H = 220, padL = 52, padR = 12, padT = 12, padB = 24;
  if (points.length === 0) {
    return <div ref={wrapRef} className="h-[120px] flex items-center justify-center text-[12px] text-[#73757c]">No resolved trades</div>;
  }
  const minY = Math.min(0, ...points.map((p) => p.eq));
  const maxY = Math.max(0, ...points.map((p) => p.eq));
  const span = maxY - minY || 1;
  const xs = (i: number) => padL + (points.length === 1 ? 0.5 : i / (points.length - 1)) * (width - padL - padR);
  const ys = (v: number) => padT + (1 - (v - minY) / span) * (H - padT - padB);
  const path = points.map((p, k) => `${k ? "L" : "M"}${xs(k).toFixed(1)},${ys(p.eq).toFixed(1)}`).join(" ");
  const ticks = [minY, minY + span / 2, maxY];
  const hp = hover != null ? points[hover] : null;

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const frac = (x - padL) / (width - padL - padR);
    setHover(Math.max(0, Math.min(points.length - 1, Math.round(frac * (points.length - 1)))));
  };

  return (
    <div ref={wrapRef} className="relative">
      <svg width={width} height={H} onPointerMove={onMove} onPointerLeave={() => setHover(null)} className="block touch-none">
        {ticks.map((v, k) => (
          <g key={k}>
            <line x1={padL} x2={width - padR} y1={ys(v)} y2={ys(v)} stroke={C.grid} />
            <text x={padL - 6} y={ys(v) + 4} textAnchor="end" fontSize={10} fill={C.muted} fontFamily="monospace">
              {money(v)}
            </text>
          </g>
        ))}
        <line x1={padL} x2={width - padR} y1={ys(0)} y2={ys(0)} stroke="rgba(232,232,228,0.35)" strokeDasharray="3 3" />
        <path d={path} fill="none" stroke={C.line} strokeWidth={2} strokeLinejoin="round" />
        {points.map((p, k) =>
          p.t.status === "LOSS" ? (
            <circle key={k} cx={xs(k)} cy={ys(p.eq)} r={4} fill={C.loss} stroke="#181a1e" strokeWidth={2} />
          ) : null,
        )}
        <text x={padL} y={H - 6} fontSize={10} fill={C.muted}>trade 1</text>
        <text x={width - padR} y={H - 6} fontSize={10} fill={C.muted} textAnchor="end">trade {points.length}</text>
        {hp && (
          <>
            <line x1={xs(hover!)} x2={xs(hover!)} y1={padT} y2={H - padB} stroke="rgba(232,232,228,0.4)" />
            <circle cx={xs(hover!)} cy={ys(hp.eq)} r={5} fill={C.line} stroke="#181a1e" strokeWidth={2} />
          </>
        )}
      </svg>
      {hp && (
        <div
          className="pointer-events-none absolute top-2 rounded-lg border border-white/[0.12] bg-[#0f1013]/95 px-3 py-2 text-[11px] shadow-xl"
          style={{ left: Math.min(Math.max(0, xs(hover!) + 12), width - 200) }}
        >
          <div className="font-mono text-[14px] font-semibold" style={{ color: signColor(hp.eq) }}>{money(hp.eq)}</div>
          <div className="text-[#9a9ca3]">cumulative after trade {hover! + 1}</div>
          <div className="mt-1 text-[#e8e8e4]">
            {hp.t.coin} {hp.t.dir} @ {cents(hp.t.entry)} · <span style={{ color: signColor(hp.t.pnl) }}>{money(hp.t.pnl)}</span>
          </div>
          <div className="text-[#73757c]">{hp.t.row.et_time}</div>
        </div>
      )}
      <div className="flex items-center gap-4 mt-1 text-[11px] text-[#9a9ca3]">
        <span className="inline-flex items-center gap-1.5"><span className="inline-block w-4 h-[2px]" style={{ background: C.line }} />Cumulative P&L</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block w-2 h-2 rounded-full" style={{ background: C.loss }} />Loss</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block w-4 border-t border-dashed border-[#e8e8e4]/60" />Zero</span>
      </div>
    </div>
  );
}

// ---------- verdict ----------
const VERDICT_TEXT: Record<Verdict, { title: string; color: string }> = {
  NO_DATA: { title: "No resolved trades", color: C.text2 },
  TOO_FEW: { title: "Too few trades to judge", color: C.pending },
  EDGE_LIKELY: { title: "Edge likely", color: C.win },
  POSITIVE_UNPROVEN: { title: "Positive, not proven", color: C.pending },
  NO_EDGE: { title: "No edge at these prices", color: C.loss },
};

function verdictDetail(v: Verdict, m: Metrics): string {
  const range = `95% range for the true win rate: ${pct(m.ciLow)}–${pct(m.ciHigh)}`;
  switch (v) {
    case "NO_DATA":
      return "Nothing resolved with these settings yet.";
    case "TOO_FEW":
      return `${m.resolved} resolved trades; ${MIN_RESOLVED_FOR_VERDICT}+ needed before trusting a result. ${range}, break-even ${pct(m.breakEven)}.`;
    case "EDGE_LIKELY":
      return `Even the low end of the win-rate range (${pct(m.ciLow)}) beats break-even (${pct(m.breakEven)}). Still check the walk-forward test and the notes below.`;
    case "POSITIVE_UNPROVEN":
      return `Win rate ${pct(m.winRate)} beats break-even ${pct(m.breakEven)}, but the ${range} still reaches below break-even.`;
    case "NO_EDGE":
      return `Win rate ${pct(m.winRate)} is below break-even ${pct(m.breakEven)}: the entries are too expensive for how often it wins.`;
  }
}

// ---------- frozen strategy forward test ----------
function FrozenCard({ strategy, title, before, after, afterTrades, history, stake, slippage, budget, onBudget }: {
  strategy: typeof STRATEGY_HISTORY[number]; title: string;
  before: Metrics; after: Metrics; afterTrades: Trade[];
  history: { strategy: typeof STRATEGY_HISTORY[number]; trades: Trade[]; metrics: Metrics }[];
  stake: number; slippage: number; budget: number; onBudget: (v: number) => void;
}) {
  const frozenEt = new Date(strategy.frozenAt).toLocaleString("en-US", {
    timeZone: "America/New_York", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const v = verdictOf(after);
  const nextCp = strategy.checkpoints.find((c) => c > after.resolved);
  const losses = after.losses;
  const lossesCovered = stake > 0 ? Math.floor(budget / stake) : 0;
  // Losses that would erase profit at the win rate the rule needs: about one loss per (1/entry - 1)^-1 wins.
  const avgEntry = before.avgEntry ?? after.avgEntry ?? 0.88;
  const winsPerLoss = avgEntry < 1 ? avgEntry / (1 - avgEntry) : 0;
  const newestFirst = [...afterTrades].reverse();

  return (
    <Card
      title={title}
      subtitle={`${strategy.name}. Rule locked ${frozenEt} ET. Only signals after that time count here.`}
      right={<span className="text-[11px] px-2 py-0.5 rounded-md border border-white/[0.12] text-[#9a9ca3]">locked</span>}
      defaultOpen={false}
    >
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Kpi label="Forward trades" value={String(after.trades)} sub={`${after.wins} W · ${after.losses} L · ${after.pending} P`} />
        <Kpi label="Win rate" value={pct(after.winRate)} sub={after.resolved ? `95%: ${pct(after.ciLow, 0)}–${pct(after.ciHigh, 0)}` : "no resolved trades yet"} />
        <Kpi label={`P&L at $${stake}/trade`} value={money(after.pnl)} color={signColor(after.pnl)} sub={`slippage ${slippage}¢ · no fees`} />
        <Kpi label="Next checkpoint" value={nextCp ? `${after.resolved} / ${nextCp}` : "all reached"} sub={VERDICT_TEXT[v].title} />
      </div>

      <div className="grid md:grid-cols-2 gap-4 mt-4">
        <div>
          <div className="text-[12px] font-medium text-[#e8e8e4] mb-1.5">Before vs after the freeze</div>
          <MetricsTable
            rows={[
              { key: "b", label: "Backtest", hint: "rule found on this data (optimistic)", metrics: before },
              { key: "a", label: "Forward", hint: "new signals only (the real test)", metrics: after },
            ]}
          />
        </div>
        <div className="space-y-2">
          <div className="text-[12px] font-medium text-[#e8e8e4]">Your budget</div>
          <div className="flex items-end gap-3">
            <div className="w-28"><Field label="Total budget $"><NumberInput value={budget} min={1} onChange={(v) => onBudget(Math.max(1, v))} /></Field></div>
            <p className="text-[12px] text-[#9a9ca3] pb-1.5">
              covers <span className="font-mono text-[#e8e8e4]">{lossesCovered}</span> losses in a row at ${stake}/trade
            </p>
          </div>
          <ul className="text-[12px] text-[#bdbdb8] space-y-1 leading-relaxed">
            <li>One loss costs ${stake}. It takes about <span className="font-mono">{winsPerLoss.toFixed(1)}</span> wins at the average price ({cents(avgEntry)}) to earn it back.</li>
            <li>Forward losses so far: <span className="font-mono">{losses}</span> ({money(-losses * stake)}). Worst run allowed by the budget: <span className="font-mono">{lossesCovered}</span>.</li>
            <li>Suggested stop rule, set before trading: pause if forward win rate is below break-even ({pct(before.breakEven, 0)}) after 30 resolved trades.</li>
            <li>Log your real fill price for each bot trade and compare it with the price here. The gap is your true slippage.</li>
          </ul>
        </div>
      </div>

      {history.length > 1 && (
        <div className="mt-4">
          <div className="text-[12px] font-medium text-[#e8e8e4] mb-1.5">Rule history</div>
          <p className="text-[11px] text-[#73757c] mb-1.5">
            Each version is scored only on its own forward window. A closed version&rsquo;s result is final &mdash; it does not get retested under the current rule, and the current rule gets no credit for a closed version&rsquo;s trades.
          </p>
          <div className="space-y-2">
            {history.map((h, i) => {
              const closed = h.strategy.frozenUntil != null;
              const from = new Date(h.strategy.frozenAt).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
              const to = h.strategy.frozenUntil ? new Date(h.strategy.frozenUntil).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "now";
              return (
                <div key={h.strategy.id} className="rounded-lg border border-white/[0.08] p-2.5">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="text-[12px] font-medium text-[#e8e8e4]">{i + 1}. {h.strategy.name}</span>
                    <span className={`text-[11px] px-1.5 py-0.5 rounded border ${closed ? "border-white/[0.10] text-[#73757c]" : "border-[#5fbf9a]/40 text-[#5fbf9a]"}`}>
                      {closed ? "closed" : "current"}
                    </span>
                  </div>
                  <div className="text-[11px] text-[#73757c] mt-0.5">{from} ET → {to} ET</div>
                  <div className="text-[11px] text-[#bdbdb8] mt-1">{h.strategy.note}</div>
                  <div className="text-[12px] font-mono mt-1.5" style={{ color: signColor(h.metrics.pnl) }}>
                    {h.metrics.trades} trades · {h.metrics.wins}W/{h.metrics.losses}L/{h.metrics.pending}P · {pct(h.metrics.winRate)} win rate · {money(h.metrics.pnl)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="mt-4">
        <div className="text-[12px] font-medium text-[#e8e8e4] mb-1.5">Forward signals (newest first)</div>
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-[12px] border-separate border-spacing-0">
            <thead>
              <tr className="text-[11px] text-[#73757c]">
                <th className="text-left font-medium px-2 py-1.5">Time ET</th>
                <th className="text-left font-medium px-2 py-1.5">Min</th>
                <th className="text-left font-medium px-2 py-1.5">Signal</th>
                <th className="text-right font-medium px-2 py-1.5">Quoted price</th>
                <th className="text-left font-medium px-2 py-1.5">Result</th>
                <th className="text-right font-medium px-2 py-1.5">P&L</th>
              </tr>
            </thead>
            <tbody>
              {newestFirst.map((t) => (
                <tr key={t.row.filename} className="hover:bg-white/[0.04]">
                  <td className="px-2 py-1.5 border-t border-white/[0.05] font-mono text-[#e8e8e4] whitespace-nowrap">{t.row.et_time.replace(" ET", "")}</td>
                  <td className="px-2 py-1.5 border-t border-white/[0.05] font-mono" style={{ color: t.minute >= LATE_MINUTE ? C.pending : C.text2 }}>{t.minute}{t.minute >= LATE_MINUTE ? " late" : ""}</td>
                  <td className="px-2 py-1.5 border-t border-white/[0.05] font-semibold text-[#e8e8e4]">{t.dir === "UP" ? "▲ UP" : "▼ DOWN"}</td>
                  <td className="px-2 py-1.5 border-t border-white/[0.05] font-mono text-right text-[#e8e8e4]">{cents(t.quote)}</td>
                  <td className="px-2 py-1.5 border-t border-white/[0.05]"><StatusTag status={t.status} /></td>
                  <td className="px-2 py-1.5 border-t border-white/[0.05] font-mono text-right" style={{ color: signColor(t.pnl) }}>{t.status === "PENDING" ? "—" : money(t.pnl)}</td>
                </tr>
              ))}
              {!newestFirst.length && (
                <tr><td colSpan={6} className="px-2 py-4 text-center text-[#73757c]">No signal yet since the freeze. Waiting for the next 3/3 signal.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}

// ---------- page ----------
async function getRows(refresh: boolean): Promise<SnapshotRow[]> {
  const res = await fetch(`/api/jev/history${refresh ? "?refresh=true" : ""}`, { cache: "no-store" });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return (json.files || []).filter((r: SnapshotRow) => r && r.et_time);
}

type BreakdownTab = "coin" | "direction" | "minute" | "price" | "agree" | "hour" | "day";

export default function CloudAnalysisPage() {
  const [rows, setRows] = useState<SnapshotRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cfg, setCfg] = useState<AnalysisConfig>(DEFAULT_ANALYSIS_CONFIG);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState<BreakdownTab>("price");
  const [splitDate, setSplitDate] = useState<string | null>(null);
  const [showAllTrades, setShowAllTrades] = useState(false);
  const [budget, setBudget] = useState(100);

  const fetchRows = useCallback((refresh: boolean) => {
    getRows(refresh)
      .then((r) => {
        setRows(r);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  const load = (refresh: boolean) => {
    setLoading(true);
    fetchRows(refresh);
  };

  useEffect(() => {
    fetchRows(false);
    // Restore saved settings after mount so the server render and first client render match.
    Promise.resolve().then(() => {
      try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) setCfg({ ...DEFAULT_ANALYSIS_CONFIG, ...JSON.parse(saved) });
      } catch {}
      setLoaded(true);
    });
  }, [fetchRows]);

  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
    } catch {}
  }, [cfg, loaded]);

  const set = <K extends keyof AnalysisConfig>(k: K, v: AnalysisConfig[K]) => setCfg((p) => ({ ...p, [k]: v }));

  const allCoins = useMemo(() => [...new Set(rows.map((r) => (r.coin || "").toUpperCase()).filter(Boolean))].sort(), [rows]);
  const allDates = useMemo(
    () => [...new Set(rows.map((r) => parseEtTime(r.et_time)?.date).filter((d): d is string => !!d))].sort(),
    [rows],
  );

  const baseRows = useMemo(() => filterBaseRows(rows, cfg), [rows, cfg]);
  const trades = useMemo(() => buildTrades(baseRows, cfg), [baseRows, cfg]);
  const metrics = useMemo(() => computeMetrics(trades, cfg.stake), [trades, cfg.stake]);
  const verdict = verdictOf(metrics);

  // Forward test of the currently-active frozen rule. Independent of the left-panel filters;
  // only stake and slippage are shared. "before" = the backtest on data that existed at freeze
  // time (optimistic, rule was tuned against it); "after" = real forward signals since then.
  const forwardOf = (strategy: typeof FROZEN_STRATEGY) => {
    const c: AnalysisConfig = { ...strategy.rule, stake: cfg.stake, slippageCents: cfg.slippageCents };
    const t0 = new Date(strategy.frozenAt).getTime();
    const base = filterBaseRows(rows, c);
    const beforeTrades = buildTrades(base.filter((r) => (r.timestamp ? new Date(r.timestamp).getTime() : 0) < t0), c);
    const afterTrades = buildTrades(base.filter((r) => (r.timestamp ? new Date(r.timestamp).getTime() : 0) >= t0), c);
    return {
      beforeTrades,
      afterTrades,
      before: computeMetrics(beforeTrades, c.stake),
      after: computeMetrics(afterTrades, c.stake),
    };
  };
  const frozen = useMemo(() => forwardOf(FROZEN_STRATEGY), [rows, cfg.stake, cfg.slippageCents]); // eslint-disable-line react-hooks/exhaustive-deps
  const frozen2 = useMemo(() => forwardOf(FROZEN_STRATEGY_2), [rows, cfg.stake, cfg.slippageCents]); // eslint-disable-line react-hooks/exhaustive-deps

  // Each closed/current rule in STRATEGY_HISTORY, scored only on its own forward window
  // [frozenAt, frozenUntil). A superseded rule's window is frozen in time, so its result never
  // changes even after the rule is retired — that is the whole point of freezing it.
  const strategyHistory = useMemo(() => {
    return STRATEGY_HISTORY.map((s) => {
      const c: AnalysisConfig = { ...s.rule, stake: cfg.stake, slippageCents: cfg.slippageCents };
      const t0 = new Date(s.frozenAt).getTime();
      const t1 = s.frozenUntil ? new Date(s.frozenUntil).getTime() : Infinity;
      const base = filterBaseRows(rows, c);
      const windowRows = base.filter((r) => {
        const t = r.timestamp ? new Date(r.timestamp).getTime() : 0;
        return t >= t0 && t < t1;
      });
      const trades = buildTrades(windowRows, c);
      return { strategy: s, trades, metrics: computeMetrics(trades, c.stake) };
    });
  }, [rows, cfg.stake, cfg.slippageCents]);

  const scenarioRows = useMemo(() => {
    const out = SCENARIOS.map((s) => {
      const c = withScenario(cfg, s.over);
      return { key: s.id, label: s.name, hint: s.hint, metrics: computeMetrics(buildTrades(baseRows, c), c.stake) };
    });
    out.push({ key: "current", label: "Your current settings", hint: "Everything set in the left panel.", metrics });
    return out;
  }, [baseRows, cfg, metrics]);

  const breakdownRows = useMemo(() => {
    const s = cfg.stake;
    switch (tab) {
      case "coin":
        return breakdown(trades, s, (t) => t.coin);
      case "direction":
        return breakdown(trades, s, (t) => t.dir, (k) => (k === "UP" ? "UP (buy Yes)" : "DOWN (buy No)"));
      case "minute":
        return breakdown(trades, s, (t) => minuteBucket(t.minute), (k) => `minute ${k}`, MINUTE_BUCKETS);
      case "price":
        return breakdown(trades, s, (t) => priceBucket(t.quote), (k) => `price ${k}`, PRICE_BUCKETS);
      case "agree":
        return breakdown(trades, s, (t) => `${t.agreeCount}/3`, (k) => `${k} models agree`, ["3/3", "2/3", "1/3", "0/3"]);
      case "hour":
        return breakdown(trades, s, (t) => String(t.hour).padStart(2, "0"), (k) => `${k}:00 ET`);
      case "day":
        return breakdown(trades, s, (t) => t.date);
    }
  }, [trades, tab, cfg.stake]);

  // Threshold sensitivity: bearish mirrors bullish around 2 (score scale 0-4).
  const grid = useMemo(() => {
    const scores = [3.0, 3.25, 3.5, 3.75];
    const confs = [80, 85, 90, 95];
    return confs.map((conf) =>
      scores.map((sc) => {
        const c = { ...cfg, bullishScore: sc, bearishScore: Number((4 - sc).toFixed(2)), bullishMinConf: conf, bearishMinConf: conf };
        return { sc, conf, m: computeMetrics(buildTrades(baseRows, c), c.stake) };
      }),
    );
  }, [baseRows, cfg]);

  const effectiveSplit = splitDate && allDates.includes(splitDate) ? splitDate : allDates[allDates.length - 1] ?? null;
  const walkForward = useMemo(() => {
    if (!effectiveSplit) return null;
    const before = trades.filter((t) => t.date < effectiveSplit);
    const after = trades.filter((t) => t.date >= effectiveSplit);
    return {
      before: computeMetrics(before, cfg.stake),
      after: computeMetrics(after, cfg.stake),
    };
  }, [trades, effectiveSplit, cfg.stake]);

  const notes = useMemo(() => {
    const out: { level: "warn" | "info"; text: string }[] = [];
    const dates = [...new Set(trades.map((t) => t.date))];
    const days = new Set(baseRows.map((r) => parseEtTime(r.et_time)?.date)).size;
    out.push({ level: days < 14 ? "warn" : "info", text: `Data covers ${days} day${days === 1 ? "" : "s"} (${dates[0] ?? "—"} → ${dates[dates.length - 1] ?? "—"}). A few days can catch one market mood; results can flip when the market changes.` });
    if (metrics.breakEven != null) {
      out.push({ level: "info", text: `Average price paid is ${cents(metrics.avgEntry)}, so the strategy needs ${pct(metrics.breakEven)} wins just to break even. A high win rate alone does not mean profit.` });
    }
    if (metrics.lateCount) {
      const late = trades.filter((t) => t.minute >= LATE_MINUTE && t.status !== "PENDING");
      const latePnl = late.reduce((a, t) => a + t.pnl, 0);
      out.push({ level: "warn", text: `${metrics.lateCount} trade(s) came at minute ${LATE_MINUTE}+ of the hour, when the result is mostly settled. They add ${money(latePnl)} of the ${money(metrics.pnl)} P&L. Filter with “Signal minute”.` });
    }
    const conflicts = conflictingHours(trades);
    if (conflicts.length) {
      out.push({ level: "warn", text: `${conflicts.length} market hour(s) (per coin) have both an UP and a DOWN trade (counting mode: first per hour + direction). One side must lose. Use “Strict” to keep only the first.` });
    }
    const coinsTraded = new Set(trades.map((t) => t.coin)).size;
    if (coinsTraded > 1) {
      const hours = new Set(trades.filter((t) => t.status !== "PENDING").map((t) => `${t.date}_${t.hour}`)).size;
      out.push({ level: "warn", text: `${coinsTraded} coins in view. Crypto coins move together, so trades in the same hour are not independent: ${metrics.resolved} trades fall in only ${hours} distinct hours. The real sample is smaller than it looks.` });
    }
    if (metrics.pending) out.push({ level: "info", text: `${metrics.pending} pending trade(s) are excluded from win rate and P&L until Polymarket resolves them.` });
    out.push({ level: "info", text: `Prices come from the 1h card at snapshot time (mid/last, not the order-book ask). Set “Slippage” to 1–2¢ to model the real fill.` });
    out.push({ level: "info", text: "Tuning thresholds on the same days you judge them on overfits. Pick settings on older days, then check the newest day in the walk-forward test." });
    return out;
  }, [trades, baseRows, metrics]);

  const exportCsv = () => {
    const header = ["et_time", "coin", "market", "minute", "direction", "model_score", "model_conf", "agree", "quote", "entry", "outcome", "status", "pnl", "file"];
    const lines = trades.map((t) =>
      [t.row.et_time, t.coin, t.row.market_slug ?? "", t.minute, t.dir, t.modelScore, t.modelConf, `${t.agreeCount}/3`,
        t.quote?.toFixed(4) ?? "", t.entry?.toFixed(4) ?? "", t.row.market_outcome ?? "", t.status, t.pnl.toFixed(4), t.row.filename]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(","),
    );
    const blob = new Blob([[header.join(","), ...lines].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `cloud-analysis-${new Date().toISOString().slice(0, 16)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const shownTrades = useMemo(() => {
    const newest = [...trades].reverse();
    return showAllTrades ? newest : newest.slice(0, 100);
  }, [trades, showAllTrades]);

  const activeScenario = SCENARIOS.find((s) => {
    const c = withScenario(cfg, s.over);
    return SIGNAL_KEYS.every((k) => c[k] === cfg[k]);
  })?.id;

  const gridColor = (roi: number | null, n: number) => {
    if (roi == null || n === 0) return "rgba(56,58,63,0.5)";
    const a = Math.min(1, Math.abs(roi) / 0.15) * 0.55 + 0.08;
    return roi >= 0 ? `rgba(106,169,216,${a})` : `rgba(229,120,127,${a})`;
  };

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-[#e8e8e4]">Cloud Analysis</h1>
          <p className="text-[13px] text-[#9a9ca3] mt-0.5">
            Honest backtest of Jev / Kev / Span signals: real entry prices, break-even, confidence ranges.
            {rows.length > 0 && <span className="text-[#73757c]"> · {rows.length} snapshots · {baseRows.length} in scope</span>}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => load(true)} disabled={loading} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] border border-white/[0.12] text-[#e8e8e4] hover:bg-white/[0.06] disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
          </button>
          <button onClick={exportCsv} disabled={!trades.length} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] border border-white/[0.12] text-[#e8e8e4] hover:bg-white/[0.06] disabled:opacity-50">
            <Download className="w-3.5 h-3.5" /> CSV
          </button>
          <button onClick={() => setCfg(DEFAULT_ANALYSIS_CONFIG)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] border border-white/[0.12] text-[#9a9ca3] hover:text-white hover:bg-white/[0.06]">
            <RotateCcw className="w-3.5 h-3.5" /> Reset
          </button>
        </div>
      </header>

      {error && <div className="rounded-xl border border-[#e5787f]/40 bg-[#e5787f]/10 px-3 py-2 text-[12px] text-[#e5787f]">Failed to load data: {error}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-[270px_minmax(0,1fr)] gap-4 items-start">
        {/* ---------- controls ---------- */}
        <aside className="lg:sticky lg:top-20 space-y-3 rounded-2xl border border-white/[0.08] bg-[#181a1e]/80 p-4 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto">
          <div className="text-[11px] font-semibold text-[#73757c]">Data scope</div>
          <Field label="Coins">
            <Chips all={allCoins} selected={cfg.coins} onChange={(v) => set("coins", v)} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="From (ET)">
              <select className={inputCls} value={cfg.dateFrom ?? ""} onChange={(e) => set("dateFrom", e.target.value || null)}>
                <option value="">first</option>
                {allDates.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </Field>
            <Field label="To (ET)">
              <select className={inputCls} value={cfg.dateTo ?? ""} onChange={(e) => set("dateTo", e.target.value || null)}>
                <option value="">latest</option>
                {allDates.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Hours of day (ET)" hint="Only markets that open in these hours">
            <Chips
              all={Array.from({ length: 24 }, (_, h) => String(h))}
              selected={cfg.hoursOfDay.map(String)}
              onChange={(v) => set("hoursOfDay", v.map(Number))}
              render={(v) => v.padStart(2, "0")}
            />
          </Field>

          <div className="h-px bg-white/[0.06]" />
          <div className="text-[11px] font-semibold text-[#73757c]">Signal</div>
          <Field label="Model">
            <Segmented
              value={cfg.model}
              onChange={(v) => set("model", v)}
              options={[
                { value: "jev", label: "Jev" },
                { value: "kev", label: "Kev" },
                { value: "span", label: "Span" },
                { value: "solar", label: "Solar" },
                { value: "avg", label: "Avg of 3", title: "Average of the three scores; confidence = agreement %" },
              ]}
            />
          </Field>
          <Field label="Confidence type">
            <Segmented
              value={cfg.confidenceType}
              onChange={(v) => set("confidenceType", v)}
              options={[{ value: "score", label: "Score conf." }, { value: "direction", label: "Direction conf." }]}
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="UP if score >"><NumberInput value={cfg.bullishScore} step={0.05} onChange={(v) => set("bullishScore", v)} /></Field>
            <Field label="DOWN if score <"><NumberInput value={cfg.bearishScore} step={0.05} onChange={(v) => set("bearishScore", v)} /></Field>
            <Field label="UP min conf %"><NumberInput value={cfg.bullishMinConf} min={0} max={100} onChange={(v) => set("bullishMinConf", v)} /></Field>
            <Field label="DOWN min conf %"><NumberInput value={cfg.bearishMinConf} min={0} max={100} onChange={(v) => set("bearishMinConf", v)} /></Field>
          </div>
          <Field label="Directions">
            <Segmented
              value={cfg.directions}
              onChange={(v) => set("directions", v)}
              options={[{ value: "both", label: "Both" }, { value: "UP", label: "UP only" }, { value: "DOWN", label: "DOWN only" }]}
            />
          </Field>

          <div className="h-px bg-white/[0.06]" />
          <div className="text-[11px] font-semibold text-[#73757c]">Filters</div>
          <Field label="Model agreement" hint="How many of Jev/Kev/Span must point the same way as the signal">
            <Segmented
              value={cfg.consensus}
              onChange={(v) => set("consensus", v)}
              options={[{ value: "none", label: "Any" }, { value: "2of3", label: "2 of 3" }, { value: "3of3", label: "3 of 3" }]}
            />
          </Field>
          <Field label="Solar-Decide" hint="Upstage Solar must point the same way as the signal. Rows without a Solar prediction are excluded.">
            <Segmented
              value={cfg.solarAgrees ? "on" : "off"}
              onChange={(v) => set("solarAgrees", v === "on")}
              options={[{ value: "off", label: "Ignore" }, { value: "on", label: "Must agree" }]}
            />
          </Field>
          <Field label="Solar min confidence %" hint="0 = off. Rows without a Solar prediction are excluded when above 0.">
            <NumberInput value={cfg.solarMinConf} min={0} max={100} onChange={(v) => set("solarMinConf", v)} />
          </Field>
          <Field label="Signal minute (of the hour)" hint="Late signals come when the result is almost settled">
            <div className="grid grid-cols-2 gap-2">
              <NumberInput value={cfg.minMinute} min={0} max={59} onChange={(v) => set("minMinute", v)} />
              <NumberInput value={cfg.maxMinute} min={0} max={59} onChange={(v) => set("maxMinute", v)} />
            </div>
          </Field>
          <Field label="Entry price (¢), min – max" hint="Price of the side you buy at signal time">
            <div className="grid grid-cols-2 gap-2">
              <NumberInput value={cfg.minEntry} min={0} max={100} onChange={(v) => set("minEntry", v)} />
              <NumberInput value={cfg.maxEntry} min={0} max={100} onChange={(v) => set("maxEntry", v)} />
            </div>
          </Field>

          <div className="h-px bg-white/[0.06]" />
          <div className="text-[11px] font-semibold text-[#73757c]">Counting</div>
          <Field label="Signals per hour">
            <Segmented
              value={cfg.dedupe}
              onChange={(v) => set("dedupe", v)}
              options={[
                { value: "firstPerHour", label: "First only", title: "One trade per market hour" },
                { value: "firstPerHourDir", label: "First per dir", title: "Dashboard mode: first UP and first DOWN" },
                { value: "all", label: "Every", title: "Every snapshot is a trade" },
              ]}
            />
          </Field>
          <Field label="Pick first…" hint="After filters: first snapshot that passes all filters. Before filters: the hour's very first signal, skipped if it fails a filter.">
            <Segmented
              value={cfg.pickOrder}
              onChange={(v) => set("pickOrder", v)}
              options={[{ value: "afterFilters", label: "after filters" }, { value: "beforeFilters", label: "before filters" }]}
            />
          </Field>

          <div className="h-px bg-white/[0.06]" />
          <div className="text-[11px] font-semibold text-[#73757c]">Money</div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Stake $ / trade"><NumberInput value={cfg.stake} min={1} onChange={(v) => set("stake", Math.max(1, v))} /></Field>
            <Field label="Slippage ¢" hint="Added to the quoted price to model spread and fill"><NumberInput value={cfg.slippageCents} step={0.5} min={0} onChange={(v) => set("slippageCents", Math.max(0, v))} /></Field>
          </div>
        </aside>

        {/* ---------- results ---------- */}
        <div className={`space-y-4 min-w-0 transition-opacity ${loading && rows.length ? "opacity-60" : ""}`}>
          {loading && !rows.length ? (
            <Card><div className="py-12 text-center text-[13px] text-[#9a9ca3]">Loading snapshots…</div></Card>
          ) : (
            <>
              <FrozenCard
                strategy={FROZEN_STRATEGY}
                title="Frozen strategy 1: forward test"
                before={frozen.before}
                after={frozen.after}
                afterTrades={frozen.afterTrades}
                history={strategyHistory}
                stake={cfg.stake}
                slippage={cfg.slippageCents}
                budget={budget}
                onBudget={setBudget}
              />
              <FrozenCard
                strategy={FROZEN_STRATEGY_2}
                title="Frozen strategy 2: forward test (Solar ≥ 80%)"
                before={frozen2.before}
                after={frozen2.after}
                afterTrades={frozen2.afterTrades}
                history={[]}
                stake={cfg.stake}
                slippage={cfg.slippageCents}
                budget={budget}
                onBudget={setBudget}
              />

              <div className="pt-2 text-[12px] font-medium text-[#73757c]">Explore: results below follow your left-panel settings</div>
              <Card>
                <div className="flex items-start gap-3">
                  <div className="mt-0.5" style={{ color: VERDICT_TEXT[verdict].color }}>
                    {verdict === "EDGE_LIKELY" ? <CheckCircle2 className="w-5 h-5" /> : verdict === "NO_EDGE" ? <XCircle className="w-5 h-5" /> : <Scale className="w-5 h-5" />}
                  </div>
                  <div>
                    <div className="text-[16px] font-semibold" style={{ color: VERDICT_TEXT[verdict].color }}>{VERDICT_TEXT[verdict].title}</div>
                    <p className="text-[12px] text-[#9a9ca3] mt-0.5">{verdictDetail(verdict, metrics)}</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-2 mt-4">
                  <Kpi label="Trades" value={String(metrics.trades)} sub={`${metrics.wins} W · ${metrics.losses} L · ${metrics.pending} P`} />
                  <Kpi label="Win rate" value={pct(metrics.winRate)} sub={`95%: ${pct(metrics.ciLow, 0)}–${pct(metrics.ciHigh, 0)}`} />
                  <Kpi label="Break-even" value={pct(metrics.breakEven)} sub={`avg price ${cents(metrics.avgEntry)}`} />
                  <Kpi label="Edge" value={metrics.edge == null ? "—" : `${metrics.edge >= 0 ? "+" : ""}${(metrics.edge * 100).toFixed(1)} pt`} color={signColor(metrics.edge)} sub="win rate − break-even" />
                  <Kpi label="P&L" value={money(metrics.pnl)} color={signColor(metrics.pnl)} sub={`ROI ${pct(metrics.roi)} · ${money(metrics.evPerTrade)}/trade`} />
                  <Kpi label="Max drawdown" value={money(-metrics.maxDrawdown)} color={metrics.maxDrawdown ? C.loss : C.text2} sub={`worst loss streak ${metrics.maxLossStreak}`} />
                </div>
              </Card>

              <Card title="Honesty notes" subtitle="What these numbers can and cannot tell you">
                <ul className="space-y-1.5">
                  {notes.map((n, i) => (
                    <li key={i} className="flex gap-2 text-[12px] leading-relaxed">
                      {n.level === "warn" ? (
                        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: C.pending }} />
                      ) : (
                        <HelpCircle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-[#73757c]" />
                      )}
                      <span className="text-[#c7cbef]">{n.text}</span>
                    </li>
                  ))}
                </ul>
              </Card>

              <Card title="Scenario comparison" subtitle="Same data scope and stake, different counting rules. Click a row to load it.">
                <MetricsTable
                  rows={scenarioRows}
                  highlight={activeScenario ?? "current"}
                  onRowClick={(k) => {
                    const s = SCENARIOS.find((x) => x.id === k);
                    if (s) setCfg((p) => withScenario(p, s.over));
                  }}
                />
              </Card>

              <Card title="Equity curve" subtitle={`Cumulative P&L at $${cfg.stake} per trade, in time order (resolved trades only)`}>
                <EquityCurve trades={trades} />
              </Card>

              <Card
                title="Walk-forward check"
                subtitle="Settings chosen on older days should still work on newer days. Compare the two rows."
                right={
                  <select className={`${inputCls} w-auto`} value={effectiveSplit ?? ""} onChange={(e) => setSplitDate(e.target.value || null)}>
                    {allDates.slice(1).map((d) => <option key={d} value={d}>test from {d}</option>)}
                  </select>
                }
              >
                {walkForward && (
                  <MetricsTable
                    rows={[
                      { key: "before", label: `Before ${effectiveSplit}`, hint: "tuning period", metrics: walkForward.before },
                      { key: "after", label: `From ${effectiveSplit}`, hint: "test period", metrics: walkForward.after },
                    ]}
                  />
                )}
              </Card>

              <LadderPanel rows={rows} baseTrades={trades} stake={cfg.stake} effectiveSplit={effectiveSplit} />

              <Card
                title="Breakdown"
                subtitle="Where the profit comes from"
                right={
                  <Segmented
                    value={tab}
                    onChange={setTab}
                    options={[
                      { value: "price", label: "Entry price" },
                      { value: "minute", label: "Minute" },
                      { value: "coin", label: "Coin" },
                      { value: "direction", label: "Direction" },
                      { value: "agree", label: "Agreement" },
                      { value: "hour", label: "Hour ET" },
                      { value: "day", label: "Day" },
                    ]}
                  />
                }
              >
                <MetricsTable rows={breakdownRows} />
              </Card>

              <Card
                title="Threshold sensitivity"
                subtitle="ROI for other score / confidence thresholds, all other settings unchanged. DOWN threshold mirrors UP (4 − score). Click a cell to use it."
              >
                <div className="overflow-x-auto">
                  <table className="text-[12px] border-separate" style={{ borderSpacing: 2 }}>
                    <thead>
                      <tr>
                        <th className="px-2 py-1 text-[11px] font-medium text-[#73757c] text-left">conf ≥ \ UP score &gt;</th>
                        {grid[0].map((c) => (
                          <th key={c.sc} className="px-2 py-1 text-[11px] font-mono font-medium text-[#9a9ca3]">{c.sc} / {(4 - c.sc).toFixed(2)}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {grid.map((row) => (
                        <tr key={row[0].conf}>
                          <td className="px-2 py-1 text-[11px] font-mono text-[#9a9ca3]">{row[0].conf}%</td>
                          {row.map((c) => {
                            const active = cfg.bullishScore === c.sc && cfg.bullishMinConf === c.conf && cfg.bearishMinConf === c.conf && cfg.bearishScore === Number((4 - c.sc).toFixed(2));
                            return (
                              <td key={c.sc} className="p-0">
                                <button
                                  type="button"
                                  onClick={() => setCfg((p) => ({ ...p, bullishScore: c.sc, bearishScore: Number((4 - c.sc).toFixed(2)), bullishMinConf: c.conf, bearishMinConf: c.conf }))}
                                  className={`w-[104px] rounded-md px-2 py-1.5 text-left ${active ? "ring-2 ring-[#e8e8e4]" : "hover:ring-1 hover:ring-white/40"}`}
                                  style={{ background: gridColor(c.m.roi, c.m.resolved) }}
                                  title={`${c.m.trades} trades, win ${pct(c.m.winRate)}, break-even ${pct(c.m.breakEven)}, P&L ${money(c.m.pnl)}`}
                                >
                                  <div className="font-mono font-semibold text-[#e8e8e4]">{pct(c.m.roi)}</div>
                                  <div className="text-[10px] text-[#c7cbef]">{c.m.resolved} res · {pct(c.m.winRate, 0)}</div>
                                </button>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex items-center gap-4 mt-2 text-[11px] text-[#9a9ca3]">
                  <span className="inline-flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-sm" style={{ background: "rgba(106,169,216,0.6)" }} />profit</span>
                  <span className="inline-flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-sm" style={{ background: "rgba(229,120,127,0.6)" }} />loss</span>
                  <span className="text-[#73757c]">Picking the best cell here overfits; use the walk-forward check after.</span>
                </div>
              </Card>

              <Card
                title={`Trades (${trades.length})`}
                subtitle="Newest first. Price = quoted price of the side bought at signal time."
                right={
                  trades.length > 100 ? (
                    <button onClick={() => setShowAllTrades((v) => !v)} className="text-[12px] text-[#9a9ca3] hover:text-white">
                      {showAllTrades ? "Show 100" : `Show all ${trades.length}`}
                    </button>
                  ) : null
                }
              >
                <div className="overflow-x-auto -mx-1">
                  <table className="w-full text-[12px] border-separate border-spacing-0">
                    <thead>
                      <tr className="text-[11px] text-[#73757c]">
                        {["Time ET", "Coin", "Min", "Signal", "Score", "Conf", "Agree", "Price", "Outcome", "Result", "P&L"].map((h) => (
                          <th key={h} className={`font-medium px-2 py-1.5 ${["Score", "Conf", "Price", "P&L"].includes(h) ? "text-right" : "text-left"}`}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {shownTrades.map((t) => (
                        <tr key={t.row.filename} className="hover:bg-white/[0.04]">
                          <td className="px-2 py-1.5 border-t border-white/[0.05] font-mono text-[#e8e8e4] whitespace-nowrap">
                            <a href={`/api/jev/history?file=${encodeURIComponent(t.row.filename)}`} target="_blank" rel="noreferrer" className="hover:underline">
                              {t.row.et_time.replace(" ET", "")}
                            </a>
                          </td>
                          <td className="px-2 py-1.5 border-t border-white/[0.05] font-mono text-[#9a9ca3]">{t.coin}</td>
                          <td className="px-2 py-1.5 border-t border-white/[0.05] font-mono" style={{ color: t.minute >= LATE_MINUTE ? C.pending : C.text2 }}>
                            {t.minute}{t.minute >= LATE_MINUTE ? " late" : ""}
                          </td>
                          <td className="px-2 py-1.5 border-t border-white/[0.05] font-semibold text-[#e8e8e4]">{t.dir === "UP" ? "▲ UP" : "▼ DOWN"}</td>
                          <td className="px-2 py-1.5 border-t border-white/[0.05] font-mono text-right text-[#9a9ca3]">{t.modelScore}</td>
                          <td className="px-2 py-1.5 border-t border-white/[0.05] font-mono text-right text-[#9a9ca3]">{t.modelConf}%</td>
                          <td className="px-2 py-1.5 border-t border-white/[0.05] font-mono text-[#9a9ca3]">{t.agreeCount}/3</td>
                          <td className="px-2 py-1.5 border-t border-white/[0.05] font-mono text-right text-[#e8e8e4]">{cents(t.entry)}</td>
                          <td className="px-2 py-1.5 border-t border-white/[0.05] font-mono text-[#9a9ca3]">{t.row.market_outcome ?? "—"}</td>
                          <td className="px-2 py-1.5 border-t border-white/[0.05]"><StatusTag status={t.status} /></td>
                          <td className="px-2 py-1.5 border-t border-white/[0.05] font-mono text-right" style={{ color: signColor(t.pnl) }}>
                            {t.status === "PENDING" ? "—" : money(t.pnl)}
                          </td>
                        </tr>
                      ))}
                      {!trades.length && (
                        <tr><td colSpan={11} className="px-2 py-6 text-center text-[#73757c]">No trades match these settings</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
