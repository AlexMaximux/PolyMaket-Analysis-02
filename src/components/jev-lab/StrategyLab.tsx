"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Activity, ArrowDownToLine, ArrowLeft, Check, ChevronDown, Copy, FlaskConical, GitCompareArrows, History, LoaderCircle, Play, Plus, RefreshCw, RotateCcw, Save, Search, SlidersHorizontal, Square, Trash2, Upload, X } from "lucide-react";
import { FieldFilterPanel } from "@/components/FieldFilterPanel";
import { tradeFilterFields } from "@/lib/snapshotFilterFields";
import { JEV_COINS } from "@/lib/coins";
import { LAB_PRESETS, FROZEN_STRATEGY, computeMetrics, type AnalysisConfig, type Metrics, type SnapshotRow, verdictOf } from "@/lib/signalAnalysis";
import { createLabSplit, optimizeLab, runLab, sanitizeLabConfig, type LabOptimizationResult } from "@/lib/jevLab";
import { EquityChart, BreakdownChart } from "./LabCharts";
import { TFM_MAX_CONTEXT as TFM_DEFAULT_CONTEXT } from "@/lib/tfm/types";

type View = "overview" | "optimizer" | "trades" | "library";
type Dataset = "original" | "cl";
type Experiment = { id: string; name: string; savedAt: string; config: AnalysisConfig; dataset: Dataset };
const STORAGE_KEY = "jev-strategy-lab-v2";
const MODEL_NAMES = { jev: "Jev", kev: "Kev-4b", span: "Span-01", solar: "Solar-Decide", tev: "Tev-4b", mercury: "Mercury-Decide", liquid: "Liquid-D1", tfm: "TimesFM", avg: "Jev / Kev / Span · میانگین" };
const COINS = JEV_COINS.map(coin => coin.toUpperCase());
const INITIAL_CONFIG = { ...FROZEN_STRATEGY.rule, fieldFilters: [], hoursOfDay: [] };
const PRESET_NAMES: Record<string, string> = { v1: "اجماع پایه", v2: "اجماع پس از دقیقهٔ ۳۲", s2: "اجماع + اطمینان Solar", s3: "اجماع بدون تغییر جهت", s4: "سیگنال دیرهنگام · همهٔ ارزها", s5: "پارامترهای بهینه‌شدهٔ S5", s7: "اجماع + تأیید TimesFM", s8: "اجماع · دقیقهٔ ۳۴+ · سقف ۹۲¢ · TimesFM ≥ ۵۰٪", s9: "اجماع · دقیقهٔ ۳۲+ · سقف ۹۰¢ · TimesFM · فیلتر حرکت تند" };
const TABS: { id: View; name: string; icon: typeof Activity }[] = [
  { id: "overview", name: "نمای عملکرد", icon: Activity },
  { id: "optimizer", name: "بهینه‌سازی", icon: FlaskConical },
  { id: "trades", name: "معاملات", icon: History },
  { id: "library", name: "کتابخانهٔ استراتژی", icon: GitCompareArrows },
];
const number = (n: number, digits = 0) => n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
const percent = (n: number | null) => n == null ? "—" : `${number(n * 100, 1)}%`;
const money = (n: number, signed = false) => `${n < 0 ? "−" : signed && n > 0 ? "+" : ""}$${number(Math.abs(n), 2)}`;

function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportConfig(config: AnalysisConfig, dataset: Dataset, name: string) {
  download("jev-strategy-v2.json", JSON.stringify({ schemaVersion: 1, name, dataset, config }, null, 2), "application/json");
}
function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="jl-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
function Numeric({ label, value, onChange, min = 0, max = 100, step = 1, unit, hint }: { label: string; value: number; onChange: (n: number) => void; min?: number; max?: number; step?: number; unit?: string; hint?: string }) {
  return <Field label={label} hint={hint}><span className="jl-input-unit"><input aria-label={label} type="number" dir="ltr" min={min} max={max} step={step} value={value} onChange={e => { const n = e.target.valueAsNumber; if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n))); }} />{unit && <span>{unit}</span>}</span></Field>;
}
function Toggle({ checked, onChange, children, hint }: { checked: boolean; onChange: (b: boolean) => void; children: ReactNode; hint?: string }) {
  return <label className="jl-toggle-row"><span>{children}{hint && <small>{hint}</small>}</span><input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} /></label>;
}
function Panel({ title, right, children, className = "" }: { title: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`jl-panel ${className}`}><div className="jl-panel-head"><h2>{title}</h2>{right}</div>{children}</section>;
}
function MetricCell({ label, value, sub, negative }: { label: string; value: string; sub: string; negative?: boolean }) {
  return <div className="jl-metric"><span>{label}</span><strong dir="ltr" className={negative ? "jl-negative" : ""}>{value}</strong><small>{sub}</small></div>;
}
function Status({ metrics }: { metrics: Metrics }) {
  const verdict = verdictOf(metrics);
  const text = { NO_DATA: "هنوز نتیجهٔ قطعی نداریم", TOO_FEW: "نمونهٔ محدود", EDGE_LIKELY: "نشانهٔ مزیت آماری", POSITIVE_UNPROVEN: "مثبت، نیازمند شواهد بیشتر", NO_EDGE: "مزیت مشاهده نشد" }[verdict];
  return <span className={`jl-status ${verdict === "EDGE_LIKELY" ? "jl-status-good" : ""}`}><span />{text}</span>;
}

export function StrategyLab() {
  const [config, setConfig] = useState<AnalysisConfig>(INITIAL_CONFIG);
  const [dataset, setDataset] = useState<Dataset>("original");
  // TimesFM context length of the forecasts joined to the rows; each value is its own store (backfill --context=N).
  const [tfmContext, setTfmContext] = useState(TFM_DEFAULT_CONTEXT);
  const [tfmContexts, setTfmContexts] = useState<number[]>([TFM_DEFAULT_CONTEXT]);
  const [rows, setRows] = useState<SnapshotRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [refreshIndex, setRefreshIndex] = useState(0);
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<View>("overview");
  const [editorOpen, setEditorOpen] = useState(false);
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [name, setName] = useState("استراتژی من");
  const [notice, setNotice] = useState("");
  const [compare, setCompare] = useState(true);
  const [breakdown, setBreakdown] = useState<"coin" | "hour" | "direction">("coin");
  const [tradeSearch, setTradeSearch] = useState("");
  const [tradeStatus, setTradeStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [optimization, setOptimization] = useState<LabOptimizationResult | null>(null);
  const [optimizationContext, setOptimizationContext] = useState<{ config: AnalysisConfig; dataset: Dataset; options: string; dataRevision: string | null; tfm?: boolean } | null>(null);
  const [searching, setSearching] = useState(false);
  const [progress, setProgress] = useState({ evaluated: 0, total: 0 });
  const [searchError, setSearchError] = useState("");
  const [grid, setGrid] = useState({ confidence: { min: 80, max: 95, step: 5 }, minMinute: { min: 20, max: 45, step: 5 }, maxEntry: { min: 85, max: 95, step: 5 }, minimumTrainResolved: 20, objective: "pnl" as "pnl" | "roi" | "winRate", trainFraction: 0.7, tfmProb: { on: false, min: 50, max: 70, step: 10 }, tfmEdge: { on: false, min: 0, max: 10, step: 5 } });
  const fileInput = useRef<HTMLInputElement>(null);
  const searchAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;
    Promise.resolve().then(() => {
      if (!active) return;
      try {
        const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
        if (stored) {
          setConfig(sanitizeLabConfig(stored.config));
          setDataset(stored.dataset === "cl" ? "cl" : "original");
          if (Number.isInteger(stored.tfmContext) && stored.tfmContext >= 32 && stored.tfmContext <= 16384) setTfmContext(stored.tfmContext);
          if (typeof stored.name === "string") setName(stored.name.slice(0, 100));
          if (Array.isArray(stored.experiments)) setExperiments(stored.experiments.slice(0, 40).filter((e: Experiment) => typeof e.id === "string" && typeof e.name === "string").map((e: Experiment) => ({ ...e, config: sanitizeLabConfig(e.config), dataset: e.dataset === "cl" ? "cl" : "original" })));
        }
      } catch { setNotice("تنظیمات ذخیره‌شده قابل بازیابی نبود؛ تنظیمات پایه بارگذاری شد."); }
      if (new URLSearchParams(window.location.search).get("set") === "cl") setDataset("cl");
      setReady(true);
    });
    return () => { active = false; searchAbort.current?.abort(); };
  }, []);

  useEffect(() => {
    if (!ready) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ config, dataset, tfmContext, name, experiments })); }
    catch { /* Explicit save reports a storage error if the browser is full or storage is blocked. */ }
  }, [config, dataset, tfmContext, name, experiments, ready]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 5500);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      setError(null);
      try {
        // Load a common dataset once: coin edits and saved strategy comparisons must
        // always operate on complete history, independent of the current selection.
        const params = new URLSearchParams({ coin: "all", view: "lab" });
        if (dataset === "cl") params.set("set", "cl");
        if (tfmContext !== TFM_DEFAULT_CONTEXT) params.set("tfmContext", String(tfmContext));
        if (refreshIndex) params.set("refresh", "true");
        const response = await fetch(`/api/jev/history?${params}`, { cache: "no-store", signal: controller.signal });
        const result = await response.json();
        if (!response.ok || !Array.isArray(result.files)) throw new Error(result.error || "دریافت تاریخچه ناموفق بود.");
        if (!controller.signal.aborted) {
          setRows(result.files);
          setUpdatedAt(new Date().toISOString());
          const available: number[] = Array.isArray(result.tfmContexts) ? result.tfmContexts.filter((n: unknown) => Number.isInteger(n)) : [];
          // the chosen context stays listed even when its store is gone, so the select never shows a value it lacks
          setTfmContexts([...new Set([TFM_DEFAULT_CONTEXT, tfmContext, ...available])].sort((a, b) => a - b));
        }
      } catch (cause) {
        if (!controller.signal.aborted) { setRows([]); setError(cause instanceof Error ? cause.message : "خطا در دریافت تاریخچه"); }
      } finally { if (!controller.signal.aborted) setLoading(false); }
    }
    void load();
    return () => controller.abort();
  }, [dataset, tfmContext, refreshIndex, ready]);

  const patch = useCallback((over: Partial<AnalysisConfig>) => setConfig(current => sanitizeLabConfig({ ...current, ...over })), []);
  const lab = useMemo(() => runLab(rows, config), [rows, config]);
  // Coverage is counted on the same coin/date/hour scope the lab runs on (lab.rows = filterBaseRows).
  const tfmCoverage = useMemo(() => ({ withTfm: lab.rows.filter(row => row.tfm_prob_up != null).length, total: lab.rows.length }), [lab.rows]);
  const tfmFilterOn = config.tfmMinProb > 0 || config.tfmMinEdge > -100;
  const baseline = useMemo(() => runLab(rows, { ...FROZEN_STRATEGY.rule, coins: config.coins, dateFrom: config.dateFrom, dateTo: config.dateTo, hoursOfDay: config.hoursOfDay, stake: config.stake, stakePlan: config.stakePlan, bankroll: config.bankroll, stakePercent: config.stakePercent, stakeCap: config.stakeCap, slippageCents: config.slippageCents }), [rows, config.coins, config.dateFrom, config.dateTo, config.hoursOfDay, config.stake, config.stakePlan, config.bankroll, config.stakePercent, config.stakeCap, config.slippageCents]);
  const split = useMemo(() => createLabSplit(lab.rows, grid.trainFraction), [lab.rows, grid.trainFraction]);
  const validation = useMemo(() => {
    const trainKeys = new Set(split.trainMarketKeys);
    const holdoutKeys = new Set(split.holdoutMarketKeys);
    return { train: lab.trades.filter(t => trainKeys.has(t.marketKey)), holdout: lab.trades.filter(t => holdoutKeys.has(t.marketKey)) };
  }, [lab.trades, split]);
  const validationTrain = useMemo(() => computeMetrics(validation.train, config.stake), [validation.train, config.stake]);
  const validationHoldout = useMemo(() => computeMetrics(validation.holdout, config.stake), [validation.holdout, config.stake]);
  const fields = useMemo(() => tradeFilterFields(COINS).filter(f => f.id !== "trade_result" && f.id !== "market_outcome"), []);
  const filteredTrades = useMemo(() => [...lab.trades].reverse().filter(t => (tradeStatus === "all" || t.status === tradeStatus) && `${t.coin} ${t.date} ${t.dir} ${t.row.filename}`.toLowerCase().includes(tradeSearch.toLowerCase())), [lab.trades, tradeStatus, tradeSearch]);
  const activePage = Math.min(page, Math.max(1, Math.ceil(filteredTrades.length / 25)));
  const pageTrades = filteredTrades.slice((activePage - 1) * 25, activePage * 25);
  const combinations = [grid.confidence, grid.minMinute, grid.maxEntry, ...(grid.tfmProb.on ? [grid.tfmProb] : []), ...(grid.tfmEdge.on ? [grid.tfmEdge] : [])].reduce((total, range) => total * (range.step > 0 && range.max >= range.min ? Math.floor((range.max - range.min) / range.step + 1e-8) + 1 : 0), 1);
  const optimizationStale = !!optimizationContext && (JSON.stringify(optimizationContext.config) !== JSON.stringify(config) || optimizationContext.dataset !== dataset || optimizationContext.options !== JSON.stringify(grid) || optimizationContext.dataRevision !== updatedAt);
  const dataDates = useMemo(() => lab.rows.map(row => row.et_time.slice(0, 10)).sort(), [lab.rows]);
  const libraryMetrics = useMemo(() => new Map(view === "library" ? experiments.filter(experiment => experiment.dataset === dataset).map(experiment => [experiment.id, runLab(rows, experiment.config).metrics]) : []), [view, experiments, dataset, rows]);

  function saveExperiment() {
    const experiment: Experiment = { id: crypto.randomUUID(), name: name.trim() || "استراتژی بدون نام", savedAt: new Date().toISOString(), config: structuredClone(config), dataset };
    const next = [experiment, ...experiments].slice(0, 40);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ config, dataset, name, experiments: next })); setExperiments(next); setNotice("استراتژی در این مرورگر ذخیره شد."); }
    catch { setNotice("ذخیره در مرورگر ممکن نیست؛ فایل JSON را خروجی بگیرید."); }
  }
  async function importExperiment(file?: File) {
    if (!file) return;
    try {
      if (file.size > 1_000_000) throw new Error("حجم فایل باید کمتر از یک مگابایت باشد.");
      const parsed = JSON.parse(await file.text());
      if (!parsed || typeof parsed.config !== "object" || !parsed.config || parsed.schemaVersion !== 1) throw new Error("فایل معتبر استراتژی v2 با schemaVersion: 1 انتخاب کنید.");
      setConfig(sanitizeLabConfig(parsed.config));
      setDataset(parsed.dataset === "cl" ? "cl" : "original");
      setName(typeof parsed.name === "string" ? parsed.name.slice(0, 100) : "استراتژی واردشده");
      setNotice("استراتژی وارد شد؛ پارامترها اعتبارسنجی شدند و شرط‌های وابسته به نتیجه حذف شدند.");
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : "فایل قابل خواندن نیست."); }
    if (fileInput.current) fileInput.current.value = "";
  }
  async function startOptimization() {
    const controller = new AbortController();
    searchAbort.current = controller;
    setSearching(true); setSearchError(""); setOptimization(null); setOptimizationContext(null); setProgress({ evaluated: 0, total: combinations });
    const context = { config: structuredClone(config), dataset, options: JSON.stringify(grid), dataRevision: updatedAt, tfm: grid.tfmProb.on || grid.tfmEdge.on };
    try {
      const { tfmProb, tfmEdge, ...searchGrid } = grid;
      const result = await optimizeLab(rows, config, { ...searchGrid, ...(tfmProb.on ? { tfmMinProb: { min: tfmProb.min, max: tfmProb.max, step: tfmProb.step } } : {}), ...(tfmEdge.on ? { tfmMinEdge: { min: tfmEdge.min, max: tfmEdge.max, step: tfmEdge.step } } : {}), signal: controller.signal, onProgress: (evaluated, total) => setProgress({ evaluated, total }) });
      if (!controller.signal.aborted) { setOptimization(result); setOptimizationContext(context); }
      else setNotice("جست‌وجو متوقف شد.");
    } catch (cause) { setSearchError(cause instanceof Error ? cause.message : "بهینه‌سازی ناموفق بود."); }
    finally { setSearching(false); }
  }
  function csvExport() {
    const cell = (value: unknown) => { const s = String(value ?? ""); return `"${s.replace(/^[=+@\t\r]/, "'$&").replaceAll('"', '""')}"`; };
    const csv = [["file", "coin", "ET time", "direction", "score", "confidence %", "quote cents", "entry cents", "TimesFM P(side) %", "TimesFM edge cents", "stake USD", "result", "net P&L USD"], ...filteredTrades.map(t => [t.row.filename, t.coin, t.row.et_time, t.dir, t.modelScore, t.modelConf, t.quote == null ? "" : (t.quote * 100).toFixed(2), t.entry == null ? "" : (t.entry * 100).toFixed(2), t.tfmProb ?? "", t.tfmEdge ?? "", (t.stake ?? config.stake).toFixed(2), t.status, t.pnl.toFixed(4)])].map(row => row.map(cell).join(",")).join("\r\n");
    download("jev-lab-trades.csv", "\uFEFF" + csv, "text/csv;charset=utf-8");
  }
  function loadPreset(id: string) {
    setConfig(sanitizeLabConfig({ ...LAB_PRESETS[id].rule, stake: config.stake, stakePlan: config.stakePlan, bankroll: config.bankroll, stakePercent: config.stakePercent, stakeCap: config.stakeCap, slippageCents: config.slippageCents }));
    setName(PRESET_NAMES[id]); setNotice("یک کپی قابل ویرایش از قانون بارگذاری شد.");
  }

  return <div className="jl-app" data-wide data-jev-lab dir="rtl" lang="fa">
    <div className="jl-heading">
      <div className="jl-brand-heading"><span className="jl-mark" aria-hidden="true"><Activity size={25} strokeWidth={1.5} /></span><div><div className="jl-eyebrow" dir="ltr">JEV / STRATEGY LAB <span>v2</span></div><h1>آزمایشگاه استراتژی</h1><p>از یک فرضیه تا یک نتیجهٔ قابل بررسی.</p></div></div>
      <div className="jl-heading-actions"><Link href="/jev-analysis" className="jl-text-link">پنل قبلی <ArrowLeft size={14} /></Link><button className="jl-button" onClick={() => exportConfig(config, dataset, name)}><ArrowDownToLine size={14} />خروجی JSON</button><button className="jl-button jl-primary" onClick={saveExperiment}><Save size={14} />ذخیرهٔ استراتژی</button></div>
    </div>

    <div className="jl-scope">
      <div className="jl-coins" role="group" aria-label="انتخاب ارز"><button className={!config.coins.length ? "is-active" : ""} onClick={() => patch({ coins: [] })}>همهٔ ارزها</button>{COINS.map(coin => <button key={coin} className={config.coins.includes(coin) ? "is-active" : ""} onClick={() => patch({ coins: config.coins.includes(coin) ? config.coins.filter(c => c !== coin) : [...config.coins, coin] })}>{coin}</button>)}</div>
      <div className="jl-scope-fields"><Field label="مجموعهٔ داده"><select aria-label="مجموعهٔ داده" value={dataset} onChange={e => setDataset(e.target.value as Dataset)}><option value="original">Original · اصلی</option><option value="cl">CL · با ارزش منصفانهٔ Claude</option></select></Field><Field label="کانتکست TimesFM" hint="تعداد قیمت‌های ۱ دقیقه‌ای که مدل می‌بیند. هر مقدار جدا محاسبه می‌شود: npm run backfill:tfm -- --context=N. ربات و S7/S8 همیشه ۱۰۲۴ هستند."><select aria-label="کانتکست TimesFM" value={tfmContext} onChange={e => setTfmContext(Number(e.target.value))}>{tfmContexts.map(c => <option key={c} value={c}>{c === TFM_DEFAULT_CONTEXT ? `${c} · پیش‌فرض (زنده)` : `${c} دقیقه`}</option>)}</select></Field><Field label="از تاریخ · ET"><input aria-label="از تاریخ" type="date" value={config.dateFrom || ""} onInput={e => patch({ dateFrom: e.currentTarget.value || null })} onChange={e => patch({ dateFrom: e.target.value || null })} /></Field><Field label="تا تاریخ · ET"><input aria-label="تا تاریخ" type="date" value={config.dateTo || ""} onInput={e => patch({ dateTo: e.currentTarget.value || null })} onChange={e => patch({ dateTo: e.target.value || null })} /></Field><button className="jl-icon-button" title="پاک کردن بازهٔ تاریخ" aria-label="پاک کردن بازهٔ تاریخ" onClick={() => patch({ dateFrom: null, dateTo: null })}><X size={15} /></button><div className="jl-freshness"><span>{loading ? "در حال دریافت تاریخچه…" : `${number(rows.length)} اسنپ‌شات`}<small>{updatedAt ? `دریافت ${new Date(updatedAt).toLocaleTimeString("fa-IR", { hour: "2-digit", minute: "2-digit" })}` : "تاریخچهٔ واقعی بازار"}</small></span><button className="jl-icon-button" disabled={loading} aria-label="تازه‌سازی داده‌ها" title="تازه‌سازی داده‌ها و نتایج بازار" onClick={() => setRefreshIndex(n => n + 1)}><RefreshCw size={15} className={loading ? "jl-spinning" : ""} /></button></div></div>
    </div>

    <div className="jl-tabs-row"><nav className="jl-tabs" aria-label="بخش‌های آزمایشگاه">{TABS.map(({ id, name: label, icon: Icon }) => <button key={id} aria-current={view === id ? "page" : undefined} className={view === id ? "is-active" : ""} onClick={() => setView(id)}><Icon size={15} />{label}</button>)}</nav><button className="jl-button jl-editor-trigger" onClick={() => setEditorOpen(!editorOpen)} aria-expanded={editorOpen}><SlidersHorizontal size={15} />تنظیم قوانین</button><span className="jl-research-label">آزمایش روی تاریخچه · بدون اجرای سفارش</span></div>

    {error && <div className="jl-error" role="alert"><span>تاریخچه دریافت نشد: {error}</span><button onClick={() => setRefreshIndex(n => n + 1)}>تلاش دوباره</button></div>}
    {notice && <div className="jl-toast" role="status"><Check size={15} /><span>{notice}</span><button aria-label="بستن پیام" onClick={() => setNotice("")}><X size={14} /></button></div>}
    <div className="jl-workspace" aria-busy={loading}>
      <aside className={`jl-editor ${editorOpen ? "jl-editor-open" : ""}`} aria-label="سازندهٔ استراتژی">
        <div className="jl-editor-heading"><div><SlidersHorizontal size={16} /><h2>قوانین استراتژی</h2></div><button className="jl-icon-button" title="بازنشانی به قانون پایه" aria-label="بازنشانی قوانین" onClick={() => { setConfig(INITIAL_CONFIG); setName("استراتژی من"); }}><RotateCcw size={14} /></button></div>
        <div className="jl-editor-body"><Field label="نام آزمایش"><input value={name} maxLength={100} onChange={e => setName(e.target.value)} /></Field><Field label="شروع از یک قانون آماده"><select aria-label="قانون آماده" value="" onChange={e => loadPreset(e.target.value)}><option value="" disabled>انتخاب و ویرایش…</option>{Object.keys(PRESET_NAMES).map(id => <option key={id} value={id}>{id.toUpperCase()} · {PRESET_NAMES[id]}</option>)}</select></Field></div>
        <details className="jl-editor-section" open><summary>مدل و سیگنال <ChevronDown size={14} /></summary><div className="jl-editor-body"><div className="jl-two-fields"><Field label="مدل تصمیم‌گیر"><select value={config.model} onChange={e => patch({ model: e.target.value as AnalysisConfig["model"] })}>{Object.entries(MODEL_NAMES).map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></Field><Field label="نوع اطمینان"><select value={config.confidenceType} onChange={e => patch({ confidenceType: e.target.value as "score" | "direction" })}><option value="score">اطمینان امتیاز</option><option value="direction">اطمینان جهت</option></select></Field></div><Field label="جهت مجاز"><select value={config.directions} onChange={e => patch({ directions: e.target.value as AnalysisConfig["directions"] })}><option value="both">هر دو جهت · UP + DOWN</option><option value="UP">فقط UP</option><option value="DOWN">فقط DOWN</option></select></Field><div className="jl-signal-rule"><div className="jl-rule-label"><span>خرید UP</span><span dir="ltr">Score &gt; {config.bullishScore}</span></div><Numeric label="امتیاز بیشتر از · UP" value={config.bullishScore} min={0} max={4} step={0.25} onChange={n => patch({ bullishScore: n })} /><div className="jl-two-fields"><Numeric label="حداقل اطمینان UP" value={config.bullishMinConf} onChange={n => patch({ bullishMinConf: n, bullishMaxConf: Math.max(n, config.bullishMaxConf) })} unit="%" /><Numeric label="حداکثر اطمینان UP" value={config.bullishMaxConf} onChange={n => patch({ bullishMaxConf: n, bullishMinConf: Math.min(n, config.bullishMinConf) })} unit="%" /></div></div><div className="jl-signal-rule"><div className="jl-rule-label"><span>خرید DOWN</span><span dir="ltr">Score &lt; {config.bearishScore}</span></div><Numeric label="امتیاز کمتر از · DOWN" value={config.bearishScore} min={0} max={4} step={0.25} onChange={n => patch({ bearishScore: n })} /><div className="jl-two-fields"><Numeric label="حداقل اطمینان DOWN" value={config.bearishMinConf} onChange={n => patch({ bearishMinConf: n, bearishMaxConf: Math.max(n, config.bearishMaxConf) })} unit="%" /><Numeric label="حداکثر اطمینان DOWN" value={config.bearishMaxConf} onChange={n => patch({ bearishMaxConf: n, bearishMinConf: Math.min(n, config.bearishMinConf) })} unit="%" /></div></div></div></details>
        <details className="jl-editor-section" open><summary>زمان و قیمت ورود <ChevronDown size={14} /></summary><div className="jl-editor-body"><div className="jl-minute-preview" aria-label={`بازهٔ ورود دقیقه ${config.minMinute} تا ${config.maxMinute}`}><div><span>دقیقهٔ مجاز هر ساعت</span><b dir="ltr">{config.minMinute} — {config.maxMinute}</b></div><div className="jl-minute-track"><span style={{ right: `${config.minMinute / 60 * 100}%`, width: `${(config.maxMinute - config.minMinute + 1) / 60 * 100}%` }} /></div><div dir="ltr" className="jl-minute-axis"><span>00</span><span>15</span><span>30</span><span>45</span><span>59</span></div></div><div className="jl-two-fields"><Numeric label="از دقیقه" value={config.minMinute} max={59} onChange={n => patch({ minMinute: n, maxMinute: Math.max(n, config.maxMinute) })} /><Numeric label="تا دقیقه" value={config.maxMinute} max={59} onChange={n => patch({ maxMinute: n, minMinute: Math.min(n, config.minMinute) })} /><Numeric label="حداقل قیمت سهم" value={config.minEntry} onChange={n => patch({ minEntry: n, maxEntry: Math.max(n, config.maxEntry) })} unit="¢" /><Numeric label="حداکثر قیمت سهم" value={config.maxEntry} onChange={n => patch({ maxEntry: n, minEntry: Math.min(n, config.minEntry) })} unit="¢" /></div></div></details>
        <details className="jl-editor-section" open={config.moveFilter !== "off"}><summary>فیلتر حرکت تند قیمت <ChevronDown size={14} /></summary><div className="jl-editor-body"><Field label="وقتی قیمت تند حرکت کرد" hint="حرکت = بیشترین تغییر قیمت این اسنپ‌شات نسبت به اسنپ‌شات‌های همان کوین در بازهٔ زمانی (با ۱ دقیقه تلورانس). با اسنپ‌شات‌های ۵ دقیقه‌ای و بازهٔ ۵ دقیقه، یعنی تغییر نسبت به اسنپ‌شات قبلی."><select value={config.moveFilter} onChange={e => patch({ moveFilter: e.target.value as AnalysisConfig["moveFilter"] })}><option value="off">خاموش</option><option value="snapshot">فقط همان اسنپ‌شات نادیده گرفته شود</option><option value="restOfHour">از آن لحظه تا آخر ساعت سیگنال نده</option></select></Field><div className="jl-two-fields"><Field label="واحد"><select value={config.moveUnit} onChange={e => patch({ moveUnit: e.target.value as AnalysisConfig["moveUnit"], moveThreshold: e.target.value === "pct" ? 0.3 : 200 })}><option value="usd">دلار</option><option value="pct">درصد</option></select></Field><Numeric label="حرکت بیشتر از" value={config.moveThreshold} min={0} max={config.moveUnit === "pct" ? 100 : 1_000_000} step={config.moveUnit === "pct" ? 0.05 : 10} onChange={n => patch({ moveThreshold: n })} unit={config.moveUnit === "pct" ? "%" : "$"} /><Numeric label="بازهٔ زمانی" value={config.moveWindowMin} min={1} max={60} onChange={n => patch({ moveWindowMin: Math.round(n) })} unit="دقیقه" /></div></div></details>
        <details className="jl-editor-section"><summary>تأیید مدل‌ها و تکرار سیگنال <ChevronDown size={14} /></summary><div className="jl-editor-body"><Field label="اجماع Jev / Kev / Span"><select value={config.consensus} onChange={e => patch({ consensus: e.target.value as AnalysisConfig["consensus"] })}><option value="none">بدون نیاز به اجماع</option><option value="2of3">حداقل ۲ مدل از ۳</option><option value="3of3">هر ۳ مدل هم‌جهت</option></select></Field><Toggle checked={config.solarAgrees} onChange={n => patch({ solarAgrees: n })}>Solar هم‌جهت باشد</Toggle><Numeric label="حداقل اطمینان Solar" value={config.solarMinConf} onChange={n => patch({ solarMinConf: n })} unit="%" /><Toggle checked={config.noPriorOpposite} onChange={n => patch({ noPriorOpposite: n })} hint="سیگنال مخالف پیشین، حتی با اطمینان کم، آن ساعت را حذف می‌کند.">حذف ساعت‌هایی که جهت عوض کرده‌اند</Toggle><Field label="حذف سیگنال‌های تکراری"><select value={config.dedupe} onChange={e => patch({ dedupe: e.target.value as AnalysisConfig["dedupe"] })}><option value="firstPerHour">اولین سیگنال هر بازار / ساعت</option><option value="firstPerHourDir">اولین سیگنال هر جهت / ساعت</option><option value="all">همهٔ اسنپ‌شات‌ها · هم‌پوشانی دارد</option></select></Field><Field label="ترتیب انتخاب و فیلتر"><select value={config.pickOrder} onChange={e => patch({ pickOrder: e.target.value as AnalysisConfig["pickOrder"] })}><option value="afterFilters">اول فیلتر، سپس اولین سیگنال</option><option value="beforeFilters">اولین سیگنال؛ فقط اگر فیلتر را گذراند</option></select></Field></div></details>
        <details className="jl-editor-section" data-tfm-section><summary>TimesFM · تأیید یا سیگنال <ChevronDown size={14} /></summary><div className="jl-editor-body"><p className="jl-help">برای اینکه TimesFM خودش سیگنال بدهد، بالا «TimesFM» را به‌عنوان مدل تصمیم‌گیر انتخاب کنید (امتیاز = ۴ × P(Up)؛ مثلاً UP بالای ۳٫۴ یعنی P(Up) بالای ۸۵٪). این‌جا TimesFM تأییدکنندهٔ سیگنالِ هر مدلی است.</p><Numeric label="حداقل احتمال TimesFM برای سمت معامله (%)" value={config.tfmMinProb} min={0} max={100} step={1} onChange={n => patch({ tfmMinProb: n })} unit="%" hint="۰ = خاموش · ۵۰ = فقط وقتی TimesFM موافق است" /><Numeric label="حداقل edge TimesFM نسبت به قیمت (¢)" value={config.tfmMinEdge} min={-100} max={100} step={1} onChange={n => patch({ tfmMinEdge: n })} unit="¢" hint="‎-100 = خاموش" /><p className="jl-help jl-tfm-coverage" data-tfm-coverage>{number(tfmCoverage.withTfm)} از {number(tfmCoverage.total)} اسنپ‌شاتِ محدودهٔ فعلی دادهٔ TimesFM دارند{tfmFilterOn && tfmCoverage.withTfm < tfmCoverage.total && <b> · اسنپ‌شات‌های بدون TimesFM حذف می‌شوند</b>}</p></div></details>
        <details className="jl-editor-section"><summary>سرمایه و ساعت فعالیت <ChevronDown size={14} /></summary><div className="jl-editor-body"><div className="jl-two-fields">{config.stakePlan === "p4" ? <Numeric label="درصد موجودی در هر معامله" value={config.stakePercent} min={0.1} max={100} step={1} onChange={n => patch({ stakePercent: n })} unit="٪" /> : <Numeric label={config.stakePlan === "flat" ? "سرمایهٔ هر معامله" : "سرمایهٔ پایهٔ هر معامله"} value={config.stake} min={0.01} max={1000000} step={1} onChange={n => patch({ stake: n })} unit="$" />}<Numeric label="لغزش قیمت" value={config.slippageCents} max={100} step={0.1} onChange={n => patch({ slippageCents: n })} unit="¢" /></div><Field label="روش تعیین سرمایهٔ معامله" hint={config.stakePlan === "flat" ? "هر معامله دقیقاً سرمایهٔ بالاست." : config.stakePlan === "p4" ? "هر معامله این درصد از موجودی همان لحظه است و بعد از هر باخت دو برابر این درصد (مثلاً ۱۰٪ و بعد از باخت ۲۰٪). سرمایه هیچ‌وقت از سقف بیشتر نمی‌شود." : "بعد از هر باخت، معاملهٔ بعدی دو برابر پایه است و بعد از هر برد به پایه برمی‌گردد. سرمایه هیچ‌وقت از موجودی بیشتر نمی‌شود. بالاتر از حدود ۸۰۰ دلار، دفتر سفارش معمولاً قیمت را بدتر از لغزش تنظیم‌شده می‌کند."}><select aria-label="روش تعیین سرمایه" value={config.stakePlan} onChange={e => patch({ stakePlan: e.target.value as AnalysisConfig["stakePlan"] })}><option value="flat">ثابت · همیشه سرمایهٔ پایه</option><option value="p1">P1 · بعد از باخت ۲×، پایه ثابت</option><option value="p2">P2 · ۲× بعد از باخت، پایه با دو برابر شدن موجودی دو برابر می‌شود (بالا و پایین)</option><option value="p3">P3 · مثل P2، ولی پایه هرگز پایین نمی‌آید</option><option value="p4">P4 · درصدی از موجودی، بعد از باخت دو برابر آن درصد، با سقف</option></select></Field>{config.stakePlan !== "flat" && <Numeric label="موجودی اولیه" value={config.bankroll} min={1} max={100000000} step={50} onChange={n => patch({ bankroll: n })} unit="$" hint={config.stakePlan === "p4" ? "موجودی شروع. درصد هر معامله از موجودی جاری گرفته می‌شود." : "پایه در P2 و P3 هر بار که موجودی نسبت به این مقدار دو برابر شود، دو برابر می‌شود."} />}{config.stakePlan === "p4" && <Numeric label="سقف سرمایهٔ یک معامله" value={config.stakeCap} min={1} max={100000000} step={50} onChange={n => patch({ stakeCap: n })} unit="$" hint="بالاتر از حدود ۸۰۰ دلار دفتر سفارش معمولاً قیمت را بدتر از لغزش تنظیم‌شده می‌کند." />}<div className="jl-hour-heading"><span>ساعت‌های فعال · ET</span><button onClick={() => patch({ hoursOfDay: [] })}>همه</button></div><div className="jl-hours">{Array.from({ length: 24 }, (_, hour) => <button key={hour} aria-label={`ساعت ${hour} ET`} aria-pressed={config.hoursOfDay.includes(hour)} className={config.hoursOfDay.includes(hour) ? "is-active" : ""} onClick={() => patch({ hoursOfDay: config.hoursOfDay.includes(hour) ? config.hoursOfDay.filter(h => h !== hour) : [...config.hoursOfDay, hour] })}>{String(hour).padStart(2, "0")}</button>)}</div><p className="jl-help">بدون انتخاب ساعت = تمام ساعت‌ها. تاریخ و ساعت داده‌ها بر اساس نیویورک (ET) است.</p></div></details>
        <div className="jl-editor-footer"><span className="jl-live-dot" />نتایج با تغییر قوانین محاسبه می‌شوند.</div>
      </aside>

      <div className="jl-results">
        {loading ? <div className="jl-loading" role="status"><LoaderCircle size={24} className="jl-spinning" /><h2>در حال خواندن تاریخچهٔ بازار</h2><p>نتایج از اسنپ‌شات‌ها و تسویه‌های واقعی محاسبه می‌شوند.</p><div className="jl-skeleton-strip"><i /><i /><i /><i /></div></div> : <>
        {view === "overview" && <>
          <div className="jl-result-heading"><div><h2>عملکرد قانون فعلی</h2><p>{lab.rows.length ? <><bdi dir="ltr">{dataDates[0]}</bdi> تا <bdi dir="ltr">{dataDates[dataDates.length - 1]}</bdi></> : "داده‌ای در این بازه وجود ندارد"} <span>·</span> {number(lab.rows.length)} اسنپ‌شات در محدوده</p></div><Status metrics={lab.metrics} /></div>
          <div className="jl-metrics"><MetricCell label="سود و زیان خالصِ شبیه‌سازی" value={money(lab.metrics.pnl, true)} sub={`بازده ${percent(lab.metrics.roi)} روی سرمایهٔ معاملات قطعی`} negative={lab.metrics.pnl < 0} /><MetricCell label="نرخ برد" value={percent(lab.metrics.winRate)} sub={`${number(lab.metrics.wins)} برد / ${number(lab.metrics.losses)} باخت`} /><MetricCell label="معاملات قابل محاسبه" value={number(lab.metrics.trades)} sub={`${number(lab.metrics.pending)} در انتظار تسویه`} /><MetricCell label="بیشترین افت تجمعی" value={money(lab.metrics.maxDrawdown)} sub={`بیشترین باخت متوالی: ${lab.metrics.maxLossStreak}`} /></div>
          {lab.staking && <div className="jl-metrics"><MetricCell label={`موجودی نهایی · ${lab.staking.plan.toUpperCase()}`} value={money(lab.staking.final)} sub={`شروع ${money(lab.staking.start)} · اوج ${money(lab.staking.peak)}`} negative={lab.staking.final < lab.staking.start} /><MetricCell label="کمترین موجودی" value={money(lab.staking.lowest)} sub={`بیشترین افت از اوج: ${number(lab.staking.maxDrawdownPct * 100, 0)}٪`} /><MetricCell label="بزرگ‌ترین سرمایهٔ یک معامله" value={money(lab.staking.maxStake)} sub={lab.staking.maxStake > 800 ? "بالاتر از ۸۰۰$ دفتر سفارش معمولاً کافی نیست" : "در محدودهٔ عمق معمول دفتر سفارش"} negative={lab.staking.maxStake > 800} /><MetricCell label={lab.staking.plan === "p4" ? "افت به نصف موجودی اولیه" : "ورشکستگی"} value={lab.staking.ruined ? "بله" : "خیر"} sub={lab.staking.plan === "p4" ? (lab.staking.ruined ? `بعد از معاملهٔ ${number(lab.staking.ruinedAtTrade ?? 0)}، موجودی به ۵۰٪ شروع یا کمتر رسید` : "موجودی هرگز به نصف شروع نرسید") : lab.staking.ruined ? `از معاملهٔ ${number(lab.staking.ruinedAtTrade ?? 0)}، موجودی کمتر از سرمایهٔ پایه شد` : "موجودی همیشه برای سرمایهٔ پایه کافی بود"} negative={lab.staking.ruined} /></div>}
          <Panel title="مسیر سود و زیان" right={<label className="jl-inline-check"><input type="checkbox" checked={compare} onChange={e => setCompare(e.target.checked)} />مقایسه با قانون پایه V2</label>}><EquityChart trades={lab.trades} compareTrades={compare ? baseline.trades : undefined} stake={config.stake} /><div className="jl-chart-foot"><span>سود تجمعی معاملات قطعی · دلار</span>{compare && <span dir="rtl">اختلاف با پایه: <b dir="ltr">{money(lab.metrics.pnl - baseline.metrics.pnl, true)}</b></span>}</div></Panel>
          <div className="jl-analysis-grid"><Panel title="سهم هر گروه در نتیجه" right={<select aria-label="گروه‌بندی عملکرد" value={breakdown} onChange={e => setBreakdown(e.target.value as typeof breakdown)}><option value="coin">بر اساس ارز</option><option value="hour">ساعت ورود · ET</option><option value="direction">جهت معامله</option></select>}><BreakdownChart trades={lab.trades} stake={config.stake} groupBy={breakdown} /></Panel><Panel title="آیا نتیجه قابل اتکاست؟" right={<span className="jl-meta">بازهٔ اطمینان ۹۵٪</span>}><div className="jl-evidence"><div><span>نرخ برد مشاهده‌شده</span><b dir="ltr">{percent(lab.metrics.winRate)}</b></div><div><span>نرخ برد سربه‌سر با قیمت ورود</span><b dir="ltr">{percent(lab.metrics.breakEven)}</b></div><div><span>بازهٔ اطمینان نرخ برد</span><b dir="ltr">{percent(lab.metrics.ciLow)} — {percent(lab.metrics.ciHigh)}</b></div><div><span>میانگین قیمت ورود</span><b dir="ltr">{lab.metrics.avgEntry == null ? "—" : `${number(lab.metrics.avgEntry * 100, 1)}¢`}</b></div><p>{lab.metrics.resolved < 30 ? "کمتر از ۳۰ معاملهٔ قطعی دارید؛ نتیجه هنوز برای نتیجه‌گیری محکم کافی نیست." : "این بازه استقلال معاملات را فرض می‌کند؛ معاملات ارزهای هم‌بسته شواهد مستقل نیستند."}</p></div></Panel></div>
          <Panel title="بررسی زمانی خارج از نمونه" right={<button className="jl-text-button" onClick={() => setView("optimizer")}>تنظیم و جست‌وجو <ArrowLeft size={13} /></button>}><div className="jl-split-summary"><div><span>آموزش · {number(grid.trainFraction * 100)}٪ ساعت‌های ابتدایی</span><strong dir="ltr">{money(validationTrain.pnl, true)}</strong><small>{number(validationTrain.resolved)} معاملهٔ قطعی · نرخ برد {percent(validationTrain.winRate)}</small></div><div><span>ارزیابی · {number((1 - grid.trainFraction) * 100)}٪ ساعت‌های بعدی</span><strong dir="ltr">{money(validationHoldout.pnl, true)}</strong><small>{number(validationHoldout.resolved)} معاملهٔ قطعی · نرخ برد {percent(validationHoldout.winRate)}</small></div><p>این تقسیم یک بررسی تاریخی است. پس از دیدن نتایج، بخش ارزیابی دیگر ناشناخته نیست. {split.cutoff && <span>مرز زمانی: <b dir="ltr">{split.cutoff}</b> ET.</span>}</p></div></Panel>
        </>}

        {view === "optimizer" && <>
          <div className="jl-result-heading"><div><h2>جست‌وجوی پارامترها</h2><p>انتخاب روی آموزش؛ ارزیابی جدا روی ساعت‌های بعدی.</p></div><span className="jl-status"><FlaskConical size={13} />حداکثر ۴۰۰ ترکیب</span></div>
          <Panel title="فضای جست‌وجو" right={<span className="jl-meta">{number(combinations)} ترکیب</span>}>
            <p className="jl-panel-description">قوانین مدل، امتیاز و تأییدها ثابت می‌مانند. حداقل اطمینان هر دو جهت با یک مقدار مشترک جست‌وجو می‌شود.</p>
            <div className="jl-grid-fields"><span>پارامتر</span><span>از</span><span>تا</span><span>گام</span>{(["confidence", "minMinute", "maxEntry"] as const).map(key => <div className="jl-grid-row" key={key}><span>{{ confidence: "حداقل اطمینان · %", minMinute: "شروع ورود · دقیقه", maxEntry: "سقف قیمت ورود · ¢" }[key]}</span>{(["min", "max", "step"] as const).map(part => <input key={part} aria-label={`${key} ${part}`} dir="ltr" type="number" min={part === "step" ? 1 : 0} max={key === "minMinute" ? 59 : 100} value={grid[key][part]} onChange={e => { const value = e.target.valueAsNumber; if (Number.isFinite(value)) setGrid(current => ({ ...current, [key]: { ...current[key], [part]: value } })); }} />)}</div>)}</div>
            <div className="jl-tfm-search" data-tfm-search><div className="jl-rule-label"><span>جست‌وجوی TimesFM</span><span className="jl-meta">اختیاری · پیش‌فرض خاموش</span></div><p className="jl-help">با روشن کردن هر ردیف، آستانهٔ TimesFM هم مثل بقیهٔ پارامترها جست‌وجو می‌شود؛ ردیف خاموش، مقدار فعلی قوانین را ثابت نگه می‌دارد.</p><div className="jl-grid-fields"><span>پارامتر</span><span>از</span><span>تا</span><span>گام</span>{(["tfmProb", "tfmEdge"] as const).map(key => <div className="jl-grid-row" key={key}><span><label className="jl-inline-check"><input type="checkbox" aria-label={`جست‌وجوی ${key === "tfmProb" ? "احتمال" : "edge"} TimesFM`} checked={grid[key].on} onChange={e => setGrid(current => ({ ...current, [key]: { ...current[key], on: e.target.checked } }))} />{{ tfmProb: "حداقل احتمال TimesFM · %", tfmEdge: "حداقل edge TimesFM · ¢" }[key]}</label></span>{(["min", "max", "step"] as const).map(part => <input key={part} aria-label={`${key} ${part}`} dir="ltr" type="number" disabled={!grid[key].on} min={part === "step" ? 1 : key === "tfmEdge" ? -100 : 0} max={100} value={grid[key][part]} onChange={e => { const value = e.target.valueAsNumber; if (Number.isFinite(value)) setGrid(current => ({ ...current, [key]: { ...current[key], [part]: value } })); }} />)}</div>)}</div></div>
            <div className="jl-optimizer-options"><Field label="معیار رتبه‌بندی آموزش"><select value={grid.objective} onChange={e => setGrid(g => ({ ...g, objective: e.target.value as typeof grid.objective }))}><option value="pnl">سود و زیان خالص</option><option value="roi">بازده سرمایه</option><option value="winRate">نرخ برد</option></select></Field><Numeric label="حداقل معاملات قطعی آموزش" value={grid.minimumTrainResolved} min={1} max={10000} onChange={n => setGrid(g => ({ ...g, minimumTrainResolved: n }))} /><Field label="سهم دادهٔ آموزش"><select value={grid.trainFraction} onChange={e => setGrid(g => ({ ...g, trainFraction: Number(e.target.value) }))}><option value={0.6}>۶۰٪ آموزش / ۴۰٪ ارزیابی</option><option value={0.7}>۷۰٪ آموزش / ۳۰٪ ارزیابی</option><option value={0.8}>۸۰٪ آموزش / ۲۰٪ ارزیابی</option></select></Field></div>
            <div className="jl-search-footer"><p>{split.trainHours} ساعت آموزش / {split.holdoutHours} ساعت ارزیابی. همهٔ ارزهای یک ساعت در یک بخش می‌مانند.</p>{searching ? <button className="jl-button" onClick={() => searchAbort.current?.abort()}><Square size={13} />توقف</button> : <button className="jl-button jl-primary" disabled={!rows.length || combinations < 1 || combinations > 400} onClick={() => void startOptimization()}><Play size={14} />اجرای {number(combinations)} ترکیب</button>}</div>
            {combinations > 400 && <p className="jl-inline-error">بازه‌ها را کوچک‌تر یا گام‌ها را بزرگ‌تر کنید؛ حداکثر ۴۰۰ ترکیب مجاز است.</p>}{searching && <div className="jl-progress" role="status"><progress max={progress.total || 1} value={progress.evaluated} /><span>{progress.evaluated} / {progress.total}</span></div>}{searchError && <p className="jl-inline-error" role="alert">{searchError}</p>}
          </Panel>
          <Panel title="نتایج جست‌وجو" right={optimization && <span className="jl-meta">{optimization.evaluated} ترکیب بررسی شد</span>}>
            {optimizationStale && <p className="jl-inline-error">قوانین، داده یا فضای جست‌وجو تغییر کرده است؛ نتایج زیر مربوط به اجرای قبلی است.</p>}
            {!optimization ? <div className="jl-empty"><FlaskConical size={24} /><h3>فرضیه‌تان را آزمایش کنید</h3><p>پس از اجرا، ترکیب‌ها با معیار آموزش مرتب می‌شوند. بخش ارزیابی در انتخاب بهترین ترکیب دخالت ندارد.</p></div> : optimization.candidates.length === 0 ? <div className="jl-empty"><h3>ترکیبی با نمونهٔ کافی پیدا نشد</h3><p>حداقل معاملات آموزش را کم کنید یا بازهٔ قوانین را بازتر کنید.</p></div> : <div className="jl-table-scroll"><table className="jl-table jl-optimization-table"><thead><tr><th>رتبه</th><th>اطمینان</th><th>دقیقهٔ شروع</th><th>سقف ورود</th>{optimizationContext?.tfm && <><th>احتمال TFM</th><th>edge TFM</th></>}<th>معاملات آموزش</th><th>سود آموزش</th><th>بازده آموزش</th><th>نرخ برد آموزش</th><th>سود ارزیابی</th><th>معاملات ارزیابی</th><th>عملیات</th></tr></thead><tbody>{optimization.candidates.slice(0, 20).map((candidate, index) => <tr key={candidate.id}><td>{index + 1}</td><td>{candidate.config.bullishMinConf}%</td><td>{candidate.config.minMinute}</td><td>{candidate.config.maxEntry}¢</td>{optimizationContext?.tfm && <><td dir="ltr">{candidate.config.tfmMinProb > 0 ? `${candidate.config.tfmMinProb}%` : "—"}</td><td dir="ltr">{candidate.config.tfmMinEdge > -100 ? `${candidate.config.tfmMinEdge}¢` : "—"}</td></>}<td>{candidate.train.resolved}</td><td dir="ltr">{money(candidate.train.pnl, true)}</td><td dir="ltr">{percent(candidate.train.roi)}</td><td dir="ltr">{percent(candidate.train.winRate)}</td><td dir="ltr" className={candidate.holdout.pnl < 0 ? "jl-negative" : ""}>{money(candidate.holdout.pnl, true)}</td><td>{candidate.holdout.resolved}</td><td><button className="jl-text-button" disabled={searching || optimizationContext?.dataset !== dataset} onClick={() => { setConfig(sanitizeLabConfig(candidate.config)); setName(`آزمایش بهینه‌سازی ${index + 1}`); setView("overview"); }}>اعمال قانون <ArrowLeft size={12} /></button></td></tr>)}</tbody></table></div>}
          </Panel>
          <div className="jl-method-note"><h3>روش انتخاب</h3><p>تقسیم زمانی بر اساس ساعت بازار انجام می‌شود؛ یک بازار بین دو بخش تقسیم نمی‌شود. حداقل نمونه و رتبه‌بندی فقط روی آموزش اعمال می‌شوند. نتیجهٔ ارزیابی، تأیید سودآوری آینده نیست. بازهٔ اطمینان و افت سرمایه را هم بررسی کنید.</p></div>
        </>}

        {view === "trades" && <>
          <div className="jl-result-heading"><div><h2>دفتر معاملات شبیه‌سازی‌شده</h2><p>هر ردیف، یک سیگنال منتخب از قانون فعلی است.</p></div><button className="jl-button" onClick={csvExport} disabled={!filteredTrades.length}><ArrowDownToLine size={14} />خروجی CSV</button></div>
          <div className="jl-trade-toolbar"><label className="jl-search"><Search size={15} /><input aria-label="جست‌وجوی معاملات" placeholder="جست‌وجوی ارز، تاریخ یا فایل…" value={tradeSearch} onChange={e => { setTradeSearch(e.target.value); setPage(1); }} /></label><select aria-label="فیلتر نتیجهٔ معامله" value={tradeStatus} onChange={e => { setTradeStatus(e.target.value); setPage(1); }}><option value="all">همهٔ نتایج</option><option value="WIN">برد</option><option value="LOSS">باخت</option><option value="PENDING">در انتظار</option></select><span>{number(filteredTrades.length)} معامله</span></div>
          <Panel title="سیگنال‌ها و نتیجهٔ تسویه" right={<span className="jl-meta">جدیدترین در ابتدا · ET</span>}><div className="jl-table-scroll"><table className="jl-table jl-trades-table"><thead><tr><th>بازار و زمان</th><th>جهت</th><th>امتیاز</th><th>اطمینان</th><th>ورود با لغزش</th><th>TFM</th><th>نتیجه</th><th>سود / زیان</th><th>جزئیات</th></tr></thead><tbody>{pageTrades.map(trade => <tr key={trade.row.filename}><td className="jl-market-cell"><b>{trade.coin}</b><span dir="ltr">{trade.row.et_time.replace(" ET", "")}</span></td><td><span className="jl-direction" dir="ltr">{trade.dir === "UP" ? "↗ UP" : "↘ DOWN"}</span></td><td>{number(trade.modelScore, 2)}</td><td>{trade.modelConf}%</td><td>{trade.entry == null ? "—" : `${number(trade.entry * 100, 1)}¢`}</td><td className="jl-tfm-cell" dir="ltr" data-tfm-cell>{trade.tfmProb == null ? "—" : <>{number(trade.tfmProb, 1)}%<small className={trade.tfmEdge != null && trade.tfmEdge < 0 ? "jl-negative" : ""}>{trade.tfmEdge == null ? "—" : `${trade.tfmEdge > 0 ? "+" : trade.tfmEdge < 0 ? "−" : ""}${number(Math.abs(trade.tfmEdge), 1)}¢`}</small></>}</td><td><span className={`jl-trade-status jl-${trade.status.toLowerCase()}`}>{{ WIN: "برد", LOSS: "باخت", PENDING: "در انتظار" }[trade.status]}</span></td><td dir="ltr" className={trade.pnl < 0 ? "jl-negative" : ""}>{trade.status === "PENDING" ? "—" : money(trade.pnl, true)}</td><td><a className="jl-text-link" href={`/api/jev/history?file=${encodeURIComponent(trade.row.filename)}${dataset === "cl" ? "&set=cl" : ""}`} target="_blank" rel="noreferrer" aria-label={`JSON ${trade.row.filename}`}>JSON <ArrowLeft size={12} /></a></td></tr>)}</tbody></table>{!filteredTrades.length && <div className="jl-empty"><h3>معامله‌ای با این شرایط نیست</h3><p>قوانین ورود، تاریخ یا فیلتر نتیجه را تغییر دهید.</p></div>}</div><div className="jl-pagination"><span>{filteredTrades.length ? `${number((activePage - 1) * 25 + 1)}–${number(Math.min(activePage * 25, filteredTrades.length))} از ${number(filteredTrades.length)}` : "۰ معامله"}</span><div><button className="jl-button" disabled={activePage <= 1} onClick={() => setPage(activePage - 1)}>قبلی</button><button className="jl-button" disabled={activePage * 25 >= filteredTrades.length} onClick={() => setPage(activePage + 1)}>بعدی</button></div></div></Panel>
        </>}

        {view === "library" && <>
          <div className="jl-result-heading"><div><h2>کتابخانهٔ استراتژی</h2><p>قوانین را ذخیره کنید، مقایسه کنید و برای آزمایش بعدی نگه دارید.</p></div><button className="jl-button" onClick={() => fileInput.current?.click()}><Upload size={14} />ورود فایل JSON</button></div>
          <Panel title="آزمایش‌های من" right={<span className="jl-meta">ذخیره در همین مرورگر · {experiments.length} / 40</span>}>{experiments.length === 0 ? <div className="jl-empty"><Save size={24} /><h3>اولین فرضیه را نگه دارید</h3><p>نام آزمایش را در ستون قوانین بنویسید و «ذخیرهٔ استراتژی» را بزنید.</p><button className="jl-button" onClick={saveExperiment}><Plus size={14} />ذخیرهٔ قانون فعلی</button></div> : <div className="jl-experiments">{experiments.map(experiment => {
            const result = libraryMetrics.get(experiment.id);
            return <div className="jl-experiment" key={experiment.id}><div><h3>{experiment.name}</h3><p>{MODEL_NAMES[experiment.config.model]} · {experiment.config.coins.join(" / ") || "همهٔ ارزها"} · {experiment.dataset === "cl" ? "CL" : "Original"}</p><small>{new Date(experiment.savedAt).toLocaleDateString("fa-IR")} · دقیقهٔ {experiment.config.minMinute}–{experiment.config.maxMinute}</small></div><div className="jl-experiment-result"><b dir="ltr">{result ? money(result.pnl, true) : "—"}</b><small>{result ? `${number(result.resolved)} قطعی · ${percent(result.winRate)} برد` : "مجموعهٔ دادهٔ دیگر"}</small></div><div className="jl-experiment-actions"><button className="jl-button" onClick={() => { setConfig(experiment.config); setDataset(experiment.dataset); setName(experiment.name); setView("overview"); }}>بارگذاری</button><button className="jl-icon-button" title="خروجی JSON" aria-label={`خروجی ${experiment.name}`} onClick={() => exportConfig(experiment.config, experiment.dataset, experiment.name)}><ArrowDownToLine size={14} /></button><button className="jl-icon-button" title="حذف آزمایش ذخیره‌شده" aria-label={`حذف ${experiment.name}`} onClick={() => { setExperiments(current => current.filter(e => e.id !== experiment.id)); setNotice("نسخهٔ ذخیره‌شده حذف شد؛ قانون فعلی حفظ شده است."); }}><Trash2 size={14} /></button></div></div>;
          })}</div>}</Panel>
          <Panel title="قوانین آمادهٔ پروژه" right={<span className="jl-meta">برای شروع یک آزمایش مستقل</span>}><div className="jl-presets">{Object.entries(LAB_PRESETS).map(([id, preset]) => <div className="jl-preset" key={id}><div><span className="jl-preset-id">{id.toUpperCase()}</span><h3>{PRESET_NAMES[id]}</h3></div><p dir="ltr">{preset.name}</p><small>شروع ثبت نتیجهٔ فوروارد: {new Date(preset.frozenAt).toLocaleDateString("fa-IR")}</small><button className="jl-text-button" onClick={() => { loadPreset(id); setView("overview"); }}><Copy size={13} />استفاده از یک کپی <ArrowLeft size={13} /></button></div>)}</div><p className="jl-library-note">بارگذاری این قوانین فقط یک کپی پژوهشی می‌سازد. نتایج این صفحه، بک‌تست کل بازهٔ انتخابی هستند؛ آمار فوروارد هر قانون را در پنل اصلی پروژه بررسی کنید.</p></Panel>
        </>}
        <details className="jl-advanced"><summary><span><SlidersHorizontal size={15} />شرط‌های پیشرفته روی فیلدها <b>{config.fieldFilters.reduce((n, group) => n + group.conditions.filter(c => c.enabled).length, 0)}</b></span><ChevronDown size={14} /></summary><div className="jl-advanced-body" dir="ltr"><FieldFilterPanel fields={fields} groups={config.fieldFilters} onChange={fieldFilters => patch({ fieldFilters })} quickFieldIds={["trade_price", "trade_agree", "trade_flipped", "fair_claude", "fair_15m"]} total={lab.rows.length} countText={`${lab.trades.length} executable trades after all rules`} hint="AND inside a group · OR between groups. Market outcomes and trade results are excluded from strategy rules." /></div></details>
        <div className="jl-data-note"><div><span className="jl-live-dot" /><span>{number(lab.missingPriceCount)} سیگنال بدون قیمت معتبر از محاسبهٔ مالی حذف شد.</span></div><p>شبیه‌سازی با سرمایهٔ ثابت {money(config.stake)}، قیمت تاریخی و لغزش {config.slippageCents}¢؛ کارمزد، عمق سفارش و امکان پر شدن معامله مدل نشده‌اند. {config.dedupe === "all" && <strong>اسنپ‌شات‌های تکراری می‌توانند به یک بازار مربوط باشند.</strong>}</p>{dataset === "cl" && <p>دادهٔ CL پاسخ مجدد مدل‌ها با ارزش منصفانهٔ Claude است و لزوماً سیگنالِ قابل دسترس در زمان اصلی نیست.</p>}</div>
        </>}
      </div>
    </div>
    <input ref={fileInput} type="file" accept=".json,application/json" className="jl-hidden" aria-label="ورود فایل استراتژی" onChange={e => void importExperiment(e.target.files?.[0])} />
  </div>;
}

