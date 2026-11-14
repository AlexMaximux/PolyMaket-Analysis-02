"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Activity, ArrowDownToLine, ArrowLeft, Check, ChevronDown, ChevronLeft, ChevronRight, Crosshair, Expand, FileJson, Filter, LoaderCircle, Pause, Pin, Play, Printer, RefreshCw, RotateCcw, Save, Search, Settings2, SlidersHorizontal, Upload, X, ZoomIn, ZoomOut } from "lucide-react";
import { CURVE_DEFINITIONS, CURVE_BY_ID, CURVE_PRESETS, buildCurvePoints, curveRowTime, filterCurveRows, sanitizeCurveIds, withCurveScoreBounds, withoutCurveScoreBounds, type CurveDefinition, type CurveRow } from "@/lib/jevCurves";
import { DEFAULT_ANALYSIS_CONFIG, buildTrades, type AnalysisConfig } from "@/lib/signalAnalysis";
import { sanitizeLabConfig } from "@/lib/jevLab";
import { JEV_COINS } from "@/lib/coins";
import { compileFilters, sanitizeFilterGroups, type FilterGroup } from "@/lib/fieldFilters";
import { snapshotFilterFields, tradeFilterFields } from "@/lib/snapshotFilterFields";
import { FieldFilterPanel } from "@/components/FieldFilterPanel";
import { CurveChart, CurveNavigator } from "./CurveChart";
import { CurveOptimizer } from "./CurveOptimizer";

const KEY = "jev-curve-workbench-v1";
const MODEL_NAMES: Record<AnalysisConfig["model"], string> = { jev: "Jev", kev: "Kev-4b", span: "Span-01", solar: "Solar-Decide", tev: "Tev-4b", mercury: "Mercury", liquid: "Liquid-D1", tfm: "TimesFM", avg: "Core consensus" };
const PRESET_NAMES: Record<string, string> = { core: "نمای اصلی", models: "امتیاز مدل‌ها", confidence: "اطمینان", probabilities: "احتمال‌ها", fair: "ارزش منصفانه", edge: "اختلاف با بازار", spot: "قیمت دارایی" };
const PERIODS = [{ id: "1h", label: "۱ ساعت", ms: 3600000 }, { id: "4h", label: "۴ ساعت", ms: 14400000 }, { id: "24h", label: "۲۴ ساعت", ms: 86400000 }, { id: "7d", label: "۷ روز", ms: 604800000 }, { id: "all", label: "همه", ms: Infinity }];
const nf = (value: number, digits = 0) => value.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
const fmt = (value: number | null, definition: CurveDefinition) => value == null ? "—" : `${nf(value, definition.unit === "usd" ? 2 : 2)}${["percent", "change"].includes(definition.unit) ? "%" : ["cents", "edge"].includes(definition.unit) ? "¢" : definition.unit === "usd" ? " USD" : ""}`;
const timeFormatter = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const timeText = (time: number | null) => time == null ? "—" : timeFormatter.format(time);
const fieldClass = "cw-field";
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className={fieldClass}><span>{label}</span>{children}</label>; }
function NumberField({ label, value, onChange, min = 0, max = 100, step = 1 }: { label: string; value: number; onChange: (value: number) => void; min?: number; max?: number; step?: number }) {
  return <Field label={label}><input aria-label={label} dir="ltr" type="number" min={min} max={max} step={step} value={value} onChange={event => { const n = event.target.valueAsNumber; if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n))); }} /></Field>;
}
function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function initialConfig(): AnalysisConfig { return { ...DEFAULT_ANALYSIS_CONFIG, coins: ["BTC"], fieldFilters: [] }; }

export function CurveWorkbench() {
  const [coin, setCoin] = useState("BTC");
  const [dataset, setDataset] = useState<"original" | "cl">("original");
  const [rows, setRows] = useState<CurveRow[]>([]);
  const [ready, setReady] = useState(false);
  const [loadingState, setLoadingState] = useState(true);
  const [loadedSource, setLoadedSource] = useState("");
  const sourceRef = useRef("");
  const sourceKey = `${coin}:${dataset}`;
  const loading = loadingState || !ready || loadedSource !== sourceKey;
  const [refreshing, setRefreshing] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState("");
  const [curveIds, setCurveIds] = useState<string[]>(CURVE_PRESETS.core);
  const [tableIds, setTableIds] = useState<string[]>(CURVE_PRESETS.core);
  const [seriesSearch, setSeriesSearch] = useState("");
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [timeFiltersOpen, setTimeFiltersOpen] = useState(false);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [startHour, setStartHour] = useState(0);
  const [endHour, setEndHour] = useState(24);
  const [period, setPeriod] = useState("24h");
  const [customRange, setCustomRange] = useState<[number, number] | null>(null);
  const [hoveredTime, setHoveredTime] = useState<number | null>(null);
  const [pinnedFile, setPinnedFile] = useState<string | null>(null);
  const [config, setConfig] = useState<AnalysisConfig>(initialConfig);
  const [upMax, setUpMax] = useState(4);
  const [downMin, setDownMin] = useState(0);
  const [showSignals, setShowSignals] = useState(true);
  const [showReferences, setShowReferences] = useState(true);
  const [averageWindow, setAverageWindow] = useState(0);
  const [fieldFilters, setFieldFilters] = useState<FilterGroup[]>([]);
  const [viewFilter, setViewFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState({ id: "time", asc: false });
  const [page, setPage] = useState(1);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState("");
  const [fileError, setFileError] = useState("");
  const [fileLoading, setFileLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const importInput = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  const restore = useCallback((raw: Record<string, unknown>) => {
    if (typeof raw.coin === "string" && JEV_COINS.some(c => c.toUpperCase() === raw.coin)) setCoin(raw.coin);
    setDataset(raw.dataset === "cl" ? "cl" : "original");
    setCurveIds(sanitizeCurveIds(raw.curveIds));
    setTableIds(sanitizeCurveIds(raw.tableIds));
    setConfig(withoutCurveScoreBounds(sanitizeLabConfig(raw.config)));
    setUpMax(typeof raw.upMax === "number" && Number.isFinite(raw.upMax) ? Math.max(0, Math.min(4, raw.upMax)) : 4);
    setDownMin(typeof raw.downMin === "number" && Number.isFinite(raw.downMin) ? Math.max(0, Math.min(4, raw.downMin)) : 0);
    const date = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "";
    setDateFrom(date(raw.dateFrom)); setDateTo(date(raw.dateTo));
    setStartHour(typeof raw.startHour === "number" && Number.isInteger(raw.startHour) ? Math.max(0, Math.min(23, raw.startHour)) : 0);
    setEndHour(typeof raw.endHour === "number" && Number.isInteger(raw.endHour) ? Math.max(1, Math.min(24, raw.endHour)) : 24);
    setFieldFilters(sanitizeFilterGroups(raw.fieldFilters));
    if ([0, 3, 5, 10, 20].includes(Number(raw.averageWindow))) setAverageWindow(Number(raw.averageWindow));
    if (typeof raw.showSignals === "boolean") setShowSignals(raw.showSignals);
    if (typeof raw.showReferences === "boolean") setShowReferences(raw.showReferences);
  }, []);

  useEffect(() => {
    let active = true;
    Promise.resolve().then(() => {
      if (!active) return;
      try {
        const saved = JSON.parse(localStorage.getItem(KEY) || "null");
        if (saved && typeof saved === "object") restore(saved);
      } catch { setNotice("تنظیمات قبلی قابل خواندن نبود؛ نمای اصلی بارگذاری شد."); }
      const params = new URLSearchParams(window.location.search);
      const urlCoin = params.get("coin")?.toLowerCase();
      if (urlCoin && JEV_COINS.some(c => c === urlCoin)) setCoin(urlCoin.toUpperCase());
      if (params.get("set") === "cl") setDataset("cl");
      setReady(true);
    });
    return () => { active = false; };
  }, [restore]);

  const settings = useMemo(() => ({ schemaVersion: 1, coin, dataset, curveIds, tableIds, config, upMax, downMin, dateFrom, dateTo, startHour, endHour, fieldFilters, averageWindow, showSignals, showReferences }), [coin, dataset, curveIds, tableIds, config, upMax, downMin, dateFrom, dateTo, startHour, endHour, fieldFilters, averageWindow, showSignals, showReferences]);
  useEffect(() => { if (ready) { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* Manual export remains available. */ } } }, [settings, ready]);
  useEffect(() => { if (notice) { const timer = setTimeout(() => setNotice(""), 5000); return () => clearTimeout(timer); } }, [notice]);
  useEffect(() => { if (autoRefresh) { const timer = setInterval(() => setRefreshTick(n => n + 1), 30000); return () => clearInterval(timer); } }, [autoRefresh]);

  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    async function load() {
      if (sourceRef.current !== sourceKey) { setLoadingState(true); setRows([]); }
      else setRefreshing(true);
      setError("");
      try {
        const params = new URLSearchParams({ coin: coin.toLowerCase(), view: "lab" });
        if (dataset === "cl") params.set("set", "cl");
        if (refreshTick) params.set("refresh", "true");
        const response = await fetch(`/api/jev/history?${params}`, { cache: "no-store", signal: controller.signal });
        const data = await response.json();
        if (!response.ok || !Array.isArray(data.files)) throw new Error(data.error || "دریافت تاریخچه ناموفق بود.");
        if (!controller.signal.aborted) { setRows(data.files); sourceRef.current = sourceKey; setLoadedSource(sourceKey); setRevision(new Date().toISOString()); }
      } catch (cause) {
        if (!controller.signal.aborted) { setRows([]); sourceRef.current = sourceKey; setLoadedSource(sourceKey); setError(cause instanceof Error ? cause.message : "تاریخچه دریافت نشد."); }
      } finally { if (!controller.signal.aborted) { setLoadingState(false); setRefreshing(false); } }
    }
    void load();
    return () => controller.abort();
  }, [coin, dataset, refreshTick, ready, sourceKey]);

  useEffect(() => {
    if (!selectedFile) return;
    const controller = new AbortController();
    const modal = dialog.current;
    if (modal && !modal.open) modal.showModal();
    async function loadFile() {
      setFileLoading(true); setFileError(""); setFileContent("");
      try {
        const response = await fetch(`/api/jev/history?file=${encodeURIComponent(selectedFile!)}${dataset === "cl" ? "&set=cl" : ""}`, { signal: controller.signal });
        if (!response.ok) throw new Error("فایل دریافت نشد.");
        const value = await response.json();
        if (!controller.signal.aborted) setFileContent(JSON.stringify(value, null, 2));
      } catch (cause) { if (!controller.signal.aborted) setFileError(cause instanceof Error ? cause.message : "خطا در دریافت فایل"); }
      finally { if (!controller.signal.aborted) setFileLoading(false); }
    }
    void loadFile();
    return () => controller.abort();
  }, [selectedFile, dataset]);

  const hours = useMemo(() => startHour === 0 && endHour === 24 ? [] : Array.from({ length: 24 }, (_, i) => i).filter(h => startHour < endHour ? h >= startHour && h < endHour : h >= startHour || h < endHour), [startHour, endHour]);
  const scopeRows = useMemo(() => filterCurveRows(loadedSource === sourceKey ? rows : [], { coin, dateFrom: dateFrom || undefined, dateTo: dateTo || undefined, hours }), [rows, coin, dateFrom, dateTo, hours, loadedSource, sourceKey]);
  const signalConfig = useMemo(() => withCurveScoreBounds({ ...config, coins: [coin], dateFrom: dateFrom || null, dateTo: dateTo || null, hoursOfDay: hours }, upMax, downMin), [config, coin, dateFrom, dateTo, hours, upMax, downMin]);
  // Build candidates before zoom or display filters; neither may erase earlier signals.
  const trades = useMemo(() => buildTrades(scopeRows, signalConfig), [scopeRows, signalConfig]);
  const tradeMap = useMemo(() => new Map(trades.map(trade => [trade.row.filename, trade])), [trades]);
  const domain = useMemo<[number, number] | null>(() => {
    const times = scopeRows.map(curveRowTime).filter((time): time is number => time != null);
    return times.length ? [times[0], times[times.length - 1]] : null;
  }, [scopeRows]);
  const range = useMemo<[number, number] | null>(() => {
    if (!domain || period === "all") return null;
    if (period === "custom" && customRange) return [Math.max(domain[0], customRange[0]), Math.min(domain[1], customRange[1])];
    const duration = PERIODS.find(p => p.id === period)?.ms ?? 86400000;
    return [Math.max(domain[0], domain[1] - duration), domain[1]];
  }, [domain, period, customRange]);
  const applyRange = useCallback((next: [number, number] | null) => { setCustomRange(next); setPeriod(next ? "custom" : "all"); setHoveredTime(null); setPage(1); }, []);
  const fields = useMemo(() => snapshotFilterFields<CurveRow>(row => row, [coin]), [coin]);
  const executionFields = useMemo(() => tradeFilterFields([coin]).filter(field => field.id !== "trade_result" && field.id !== "market_outcome"), [coin]);
  const fieldMap = useMemo(() => new Map(fields.map(field => [field.id, field])), [fields]);
  const fieldTest = useMemo(() => compileFilters(fieldFilters, fieldMap), [fieldFilters, fieldMap]);
  const displayRows = useMemo(() => scopeRows.filter(row => {
    if (fieldTest && !fieldTest(row)) return false;
    const trade = tradeMap.get(row.filename);
    if (viewFilter === "signals" && !trade) return false;
    if (viewFilter === "wins" && trade?.status !== "WIN") return false;
    if (viewFilter === "losses" && trade?.status !== "LOSS") return false;
    if (viewFilter === "UP" && row.direction !== "UP") return false;
    if (viewFilter === "DOWN" && row.direction !== "DOWN") return false;
    if (viewFilter === "3up" && [row.direction, row.kev_direction, row.span_direction].filter(d => d === "UP").length < 3) return false;
    if (viewFilter === "3down" && [row.direction, row.kev_direction, row.span_direction].filter(d => d === "DOWN").length < 3) return false;
    return true;
  }), [scopeRows, fieldTest, viewFilter, tradeMap]);
  const visibleRows = useMemo(() => displayRows.filter(row => { const time = curveRowTime(row); return time != null && (!range || (time >= range[0] && time <= range[1])); }), [displayRows, range]);
  const visibleFiles = useMemo(() => new Set(visibleRows.map(row => row.filename)), [visibleRows]);
  const markers = useMemo(() => trades.filter(trade => visibleFiles.has(trade.row.filename)).flatMap(trade => { const time = curveRowTime(trade.row); return time == null ? [] : [{ filename: trade.row.filename, time, direction: trade.dir, outcome: trade.status }]; }), [trades, visibleFiles]);
  const definitions = useMemo(() => curveIds.map(id => CURVE_BY_ID.get(id)).filter((definition): definition is CurveDefinition => !!definition), [curveIds]);
  const columns = useMemo(() => tableIds.map(id => CURVE_BY_ID.get(id)).filter((definition): definition is CurveDefinition => !!definition), [tableIds]);
  const chartSeries = useMemo(() => {
    if (!averageWindow) return definitions;
    return definitions.flatMap(definition => {
      const values = new Map(buildCurvePoints(scopeRows, definition, { transform: "mean", window: averageWindow }).map(point => [point.row.filename, point.value]));
      return [definition, { ...definition, id: `${definition.id}_ma`, label: `${definition.label} · MA${averageWindow}`, dash: "2 4", get: (row: CurveRow) => values.get(row.filename) ?? null }];
    });
  }, [definitions, averageWindow, scopeRows]);
  const hoveredRow = useMemo(() => {
    if (pinnedFile) return scopeRows.find(row => row.filename === pinnedFile) ?? null;
    if (!visibleRows.length) return null;
    if (hoveredTime == null) return visibleRows[visibleRows.length - 1];
    let left = 0, right = visibleRows.length - 1;
    while (left < right) { const mid = Math.floor((left + right) / 2); if ((curveRowTime(visibleRows[mid]) ?? 0) < hoveredTime) left = mid + 1; else right = mid; }
    const previous = visibleRows[Math.max(0, left - 1)], current = visibleRows[left];
    return Math.abs((curveRowTime(previous) ?? 0) - hoveredTime) < Math.abs((curveRowTime(current) ?? 0) - hoveredTime) ? previous : current;
  }, [scopeRows, visibleRows, pinnedFile, hoveredTime]);
  const tableRows = useMemo(() => {
    const found = visibleRows.filter(row => `${row.filename} ${row.et_time} ${row.direction || ""}`.toLowerCase().includes(query.toLowerCase()));
    return [...found].sort((a, b) => {
      const value = (row: CurveRow) => sort.id === "time" ? curveRowTime(row) : sort.id === "result" ? tradeMap.get(row.filename)?.status ?? "" : CURVE_BY_ID.get(sort.id)?.get(row);
      const aValue = value(a), bValue = value(b);
      if (aValue == null) return bValue == null ? 0 : 1;
      if (bValue == null) return -1;
      const comparison = typeof aValue === "number" && typeof bValue === "number" ? aValue - bValue : String(aValue).localeCompare(String(bValue));
      return sort.asc ? comparison : -comparison;
    });
  }, [visibleRows, query, sort, tradeMap]);
  const activePage = Math.min(page, Math.max(1, Math.ceil(tableRows.length / 50)));
  const pageRows = tableRows.slice((activePage - 1) * 50, activePage * 50);
  const groups = useMemo(() => [...new Set(CURVE_DEFINITIONS.map(definition => definition.group))], []);
  const visibleDefs = useMemo(() => CURVE_DEFINITIONS.filter(definition => `${definition.label} ${definition.group}`.toLowerCase().includes(seriesSearch.toLowerCase())), [seriesSearch]);
  const coverage = useMemo(() => new Map(CURVE_DEFINITIONS.map(definition => [definition.id, scopeRows.reduce((count, row) => count + (definition.get(row) == null ? 0 : 1), 0)])), [scopeRows]);
  const winCount = markers.filter(marker => marker.outcome === "WIN").length;
  const lossCount = markers.filter(marker => marker.outcome === "LOSS").length;
  const patchConfig = (over: Partial<AnalysisConfig>) => setConfig(current => sanitizeLabConfig({ ...current, ...over }));
  const references = useMemo(() => showReferences ? [
    { unit: "score" as const, value: config.bullishScore, label: `UP > ${config.bullishScore}` },
    { unit: "score" as const, value: config.bearishScore, label: `DOWN < ${config.bearishScore}` },
    { unit: "percent" as const, value: config.bullishMinConf, label: `UP conf ≥ ${config.bullishMinConf}%` },
    ...(config.bearishMinConf !== config.bullishMinConf ? [{ unit: "percent" as const, value: config.bearishMinConf, label: `DOWN conf ≥ ${config.bearishMinConf}%` }] : []),
  ] : [], [showReferences, config.bullishScore, config.bearishScore, config.bullishMinConf, config.bearishMinConf]);

  function zoom(factor: number, direction = 0) {
    if (!domain) return;
    const current = range || domain;
    const duration = Math.max(60000, (current[1] - current[0]) * factor);
    const center = (current[0] + current[1]) / 2 + direction * (current[1] - current[0]) * .6;
    let from = center - duration / 2, to = center + duration / 2;
    if (from < domain[0]) { to += domain[0] - from; from = domain[0]; }
    if (to > domain[1]) { from -= to - domain[1]; to = domain[1]; }
    applyRange([Math.max(domain[0], from), Math.min(domain[1], to)]);
  }
  function exportCsv() {
    const escape = (value: unknown) => `"${String(value ?? "").replace(/^[=+@\t\r]/, "'$&").replaceAll('"', '""')}"`;
    const data = [["file", "coin", "ET time", "signal", "outcome", ...columns.map(definition => definition.label)], ...tableRows.map(row => [row.filename, row.coin, row.et_time, tradeMap.get(row.filename)?.dir ?? "", tradeMap.get(row.filename)?.status ?? "", ...columns.map(definition => definition.get(row))])];
    download("jev-curves.csv", "\uFEFF" + data.map(row => row.map(escape).join(",")).join("\r\n"), "text/csv;charset=utf-8");
  }
  function reset() { setCurveIds(CURVE_PRESETS.core); setTableIds(CURVE_PRESETS.core); setConfig(initialConfig()); setUpMax(4); setDownMin(0); setDateFrom(""); setDateTo(""); setStartHour(0); setEndHour(24); setFieldFilters([]); setViewFilter("all"); setPeriod("24h"); setCustomRange(null); setPinnedFile(null); setAverageWindow(0); setShowSignals(true); setShowReferences(true); setNotice("نمای اصلی و قوانین سیگنال بازنشانی شدند."); }
  async function importSettings(file?: File) {
    if (!file) return;
    try {
      if (file.size > 1000000) throw new Error("فایل تنظیمات باید کمتر از یک مگابایت باشد.");
      const parsed = JSON.parse(await file.text());
      if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.curveIds)) throw new Error("فایل تنظیمات معتبر منحنی‌ها انتخاب کنید.");
      restore(parsed); setPeriod("24h"); setCustomRange(null); setPinnedFile(null); setNotice("تنظیمات منحنی‌ها بارگذاری شد.");
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : "فایل قابل خواندن نیست."); }
    if (importInput.current) importInput.current.value = "";
  }

  return <div className="cw-app" data-wide data-jev-curves dir="rtl" lang="fa">
    <div className="cw-heading"><div><div className="cw-product"><Activity size={17} /><span dir="ltr">JEV / CURVE WORKBENCH</span></div><h1>میز تحلیل منحنی‌ها</h1><p>رفتار مدل‌ها را کنار بازار ببین؛ شرط‌ها را روی همان منحنی آزمایش کن.</p></div><div className="cw-heading-actions"><Link href="/jev-analysis/v2">آزمایشگاه استراتژی <ArrowLeft size={13} /></Link><button className="cw-button" onClick={() => { download("jev-curve-workspace.json", JSON.stringify(settings, null, 2), "application/json"); setNotice("فایل تنظیمات آماده شد؛ تغییرات در مرورگر هم ذخیره می‌شوند."); }}><Save size={14} />ذخیرهٔ نما</button><button className="cw-icon" aria-label="بازنشانی میز تحلیل" title="بازنشانی میز تحلیل" onClick={reset}><RotateCcw size={15} /></button></div></div>

    <div className="cw-scope" data-time-open={timeFiltersOpen}><Field label="دارایی"><select aria-label="دارایی منحنی" value={coin} onChange={event => { setCoin(event.target.value); setPinnedFile(null); setHoveredTime(null); setCustomRange(null); setPeriod("24h"); setLoadingState(true); }}>{JEV_COINS.map(c => <option key={c} value={c.toUpperCase()}>{c.toUpperCase()}</option>)}</select></Field><Field label="مجموعهٔ داده"><select aria-label="مجموعهٔ دادهٔ منحنی" value={dataset} onChange={event => { setDataset(event.target.value as typeof dataset); setPinnedFile(null); setLoadingState(true); }}><option value="original">Original</option><option value="cl">CL · Claude fair</option></select></Field><Field label="از تاریخ · ET"><input aria-label="از تاریخ منحنی" type="date" value={dateFrom} onInput={event => { setDateFrom(event.currentTarget.value); setPeriod("all"); }} onChange={event => setDateFrom(event.target.value)} /></Field><Field label="تا تاریخ · ET"><input aria-label="تا تاریخ منحنی" type="date" value={dateTo} onInput={event => { setDateTo(event.currentTarget.value); setPeriod("all"); }} onChange={event => setDateTo(event.target.value)} /></Field><Field label="از ساعت · ET"><select value={startHour} onChange={e => setStartHour(Number(e.target.value))}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}</select></Field><Field label="تا ساعت · ET"><select value={endHour} onChange={e => setEndHour(Number(e.target.value))}>{Array.from({ length: 24 }, (_, h) => h + 1).map(h => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}</select></Field><div className="cw-fresh"><span>{loading ? "در حال خواندن تاریخچه…" : `${nf(scopeRows.length)} اسنپ‌شات`}<small>{revision ? `دریافت ${new Date(revision).toLocaleTimeString("fa-IR", { hour: "2-digit", minute: "2-digit" })}` : "دادهٔ واقعی JEV"}</small></span><button className="cw-icon" disabled={loading || refreshing} aria-label="تازه‌سازی منحنی‌ها" title="تازه‌سازی منحنی‌ها و تسویه‌ها" onClick={() => setRefreshTick(tick => tick + 1)}><RefreshCw size={15} className={loading || refreshing ? "cw-spin" : ""} /></button><button className={`cw-icon ${autoRefresh ? "is-active" : ""}`} aria-label={autoRefresh ? "توقف تازه‌سازی خودکار" : "تازه‌سازی خودکار هر ۳۰ ثانیه"} title="تازه‌سازی خودکار هر ۳۰ ثانیه" onClick={() => setAutoRefresh(value => !value)}>{autoRefresh ? <Pause size={14} /> : <Play size={14} />}</button></div></div>
    {error && <div className="cw-error" role="alert">{error}<button onClick={() => setRefreshTick(tick => tick + 1)}>تلاش دوباره</button></div>}
    {notice && <div className="cw-toast" role="status"><Check size={15} /><span>{notice}</span><button aria-label="بستن پیام" onClick={() => setNotice("")}><X size={14} /></button></div>}

    <div className="cw-mobile-toolbar"><button className="cw-button" aria-expanded={catalogOpen} onClick={() => setCatalogOpen(value => !value)}><SlidersHorizontal size={15} />انتخاب پارامترها · {curveIds.length}</button><button className="cw-button" aria-expanded={timeFiltersOpen} onClick={() => setTimeFiltersOpen(value => !value)}><Filter size={14} />بازه و ساعت</button></div>
    <div className="cw-workspace">
      <aside className={`cw-catalog ${catalogOpen ? "cw-catalog-open" : ""}`} aria-label="فهرست پارامترهای منحنی"><div className="cw-catalog-title"><h2>پارامترهای منحنی</h2><span dir="ltr">{curveIds.length} / {CURVE_DEFINITIONS.length}</span></div><label className="cw-search"><Search size={14} /><input aria-label="جست‌وجوی پارامتر منحنی" placeholder="نام مدل یا پارامتر…" value={seriesSearch} onChange={e => setSeriesSearch(e.target.value)} /></label><div className="cw-presets">{Object.entries(PRESET_NAMES).map(([id, label]) => <button key={id} onClick={() => setCurveIds(CURVE_PRESETS[id])}>{label}</button>)}</div><div className="cw-selection-actions"><button onClick={() => setCurveIds([])}>پاک کردن انتخاب‌ها</button><button onClick={() => importInput.current?.click()}>ورود نما <Upload size={12} /></button></div><div className="cw-catalog-groups">{groups.map(group => {
        const options = visibleDefs.filter(definition => definition.group === group);
        if (!options.length) return null;
        return <details key={group} open><summary>{group}<span dir="ltr">{options.filter(definition => curveIds.includes(definition.id)).length} / {options.length}</span><ChevronDown size={12} /></summary><div>{options.map(definition => <label className={`cw-series-option ${curveIds.includes(definition.id) ? "is-selected" : ""}`} key={definition.id}><input type="checkbox" checked={curveIds.includes(definition.id)} onChange={event => setCurveIds(current => event.target.checked ? [...current, definition.id] : current.filter(id => id !== definition.id))} /><i style={{ borderColor: definition.color, borderTopStyle: definition.dash ? "dashed" : "solid" }} /><span dir="ltr">{definition.label}</span><small title="اسنپ‌شات‌های دارای مقدار در محدوده">{nf(coverage.get(definition.id) ?? 0)}</small></label>)}</div></details>;
      })}</div><p className="cw-catalog-note">هر دارایی یک خط زمانی مستقل دارد. مقدار ناموجود، خطی رسم نمی‌کند.</p></aside>
      <div className="cw-main">
        <section className="cw-chart-section" aria-busy={loading}>
          <div className="cw-chart-heading"><div><h2><span dir="ltr">{coin}</span> · منحنی‌های هم‌زمان</h2><p><Crosshair size={12} />حرکت برای مقایسه · کلیک برای تثبیت اسنپ‌شات · کشیدن برای بزرگ‌نمایی</p></div><div className="cw-chart-actions"><button className="cw-icon" title="بازهٔ قبلی" aria-label="بازهٔ قبلی" onClick={() => zoom(1, -1)}><ChevronRight size={16} /></button><button className="cw-icon" title="بازهٔ بعدی" aria-label="بازهٔ بعدی" onClick={() => zoom(1, 1)}><ChevronLeft size={16} /></button><button className="cw-icon" title="بزرگ‌نمایی" aria-label="بزرگ‌نمایی منحنی" onClick={() => zoom(.5)}><ZoomIn size={16} /></button><button className="cw-icon" title="کوچک‌نمایی" aria-label="کوچک‌نمایی منحنی" onClick={() => zoom(2)}><ZoomOut size={16} /></button><button className="cw-icon" title="کل بازه" aria-label="نمایش کل بازه" onClick={() => applyRange(null)}><Expand size={15} /></button><button className="cw-icon" title="چاپ نمودار و صفحهٔ جدول" aria-label="چاپ نمای تحلیل" onClick={() => window.print()}><Printer size={15} /></button></div></div>
          <div className="cw-chart-toolbar"><div className="cw-periods">{PERIODS.map(item => <button key={item.id} className={period === item.id ? "is-active" : ""} onClick={() => { setPeriod(item.id); setPage(1); }}>{item.label}</button>)}{period === "custom" && <span>بازهٔ انتخابی</span>}</div><Field label="میانگین متحرک"><select aria-label="میانگین متحرک" value={averageWindow} onChange={event => setAverageWindow(Number(event.target.value))}><option value={0}>خام</option>{[3, 5, 10, 20].map(window => <option key={window} value={window}>خام + MA {window}</option>)}</select></Field><label className="cw-inline"><input type="checkbox" checked={showSignals} onChange={e => setShowSignals(e.target.checked)} />نشانگر سیگنال</label></div>
          <div className="cw-visible-summary"><span><b>{nf(visibleRows.length)}</b> نقطه در نما</span><span><b>{markers.filter(marker => marker.direction === "UP").length}</b> UP / <b>{markers.filter(marker => marker.direction === "DOWN").length}</b> DOWN</span><span>{winCount} برد / {lossCount} باخت / {markers.length - winCount - lossCount} نامشخص</span><span dir="ltr">{timeText(range?.[0] ?? domain?.[0] ?? null)} — {timeText(range?.[1] ?? domain?.[1] ?? null)} ET</span></div>
          {loading ? <div className="cw-loading" role="status"><LoaderCircle size={24} className="cw-spin" /><p>در حال آماده‌سازی منحنی‌ها…</p><div /><div /></div> : <><CurveChart rows={displayRows} series={chartSeries} range={range} onRangeChange={applyRange} hoveredTime={hoveredTime} onHover={setHoveredTime} onSelectRow={row => setPinnedFile(row.filename)} markers={showSignals ? markers : []} references={references} /><CurveNavigator rows={scopeRows} series={definitions[0]} range={range} onRangeChange={applyRange} /></>}
          <div className="cw-chart-note">محورها بر اساس واحد جدا هستند: امتیاز، درصد، سنت و دلار. فاصلهٔ افقی، زمان واقعی است؛ شکاف داده و مقدار ناموجود به هم وصل نمی‌شوند.{averageWindow > 0 && ` MA${averageWindow} میانگین ${averageWindow} مشاهدهٔ اخیر است.`}</div>
        </section>

        <section className="cw-inspector"><div className="cw-section-title"><h2><Pin size={14} />{pinnedFile ? "اسنپ‌شات تثبیت‌شده" : "خوانش هم‌زمان پارامترها"}</h2><div><span dir="ltr">{hoveredRow?.et_time || "—"}</span>{pinnedFile && <button className="cw-icon" title="آزاد کردن اسنپ‌شات" aria-label="آزاد کردن اسنپ‌شات" onClick={() => setPinnedFile(null)}><X size={14} /></button>}{hoveredRow && <button className="cw-button" onClick={() => setSelectedFile(hoveredRow.filename)}><FileJson size={13} />JSON</button>}</div></div><div className="cw-readings">{definitions.length ? definitions.map(definition => <div key={definition.id}><span><i style={{ borderColor: definition.color, borderTopStyle: definition.dash ? "dashed" : "solid" }} />{definition.label}</span><b dir="ltr">{fmt(hoveredRow ? definition.get(hoveredRow) : null, definition)}</b></div>) : <p>یک پارامتر از فهرست انتخاب کنید.</p>}</div></section>

        <details className="cw-signal-panel" open><summary><span><Settings2 size={15} />شرط‌های نشانگر روی منحنی</span><ChevronDown size={14} /></summary><div className="cw-signal-body"><div className="cw-signal-top"><Field label="مدل سیگنال"><select value={config.model} onChange={e => patchConfig({ model: e.target.value as AnalysisConfig["model"] })}>{Object.entries(MODEL_NAMES).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></Field><Field label="نوع اطمینان"><select value={config.confidenceType} onChange={e => patchConfig({ confidenceType: e.target.value as "score" | "direction" })}><option value="score">اطمینان امتیاز</option><option value="direction">اطمینان جهت</option></select></Field><Field label="انتخاب سیگنال"><select value={config.dedupe} onChange={e => patchConfig({ dedupe: e.target.value as AnalysisConfig["dedupe"] })}><option value="all">تمام سیگنال‌ها</option><option value="firstPerHourDir">اولین هر جهت / ساعت</option><option value="firstPerHour">اولین هر بازار / ساعت</option></select></Field><Field label="اجماع Jev / Kev / Span"><select value={config.consensus} onChange={e => patchConfig({ consensus: e.target.value as AnalysisConfig["consensus"] })}><option value="none">بدون شرط</option><option value="2of3">۲ از ۳</option><option value="3of3">۳ از ۳</option></select></Field></div><div className="cw-signal-rules"><div><h3 dir="ltr">UP</h3><NumberField label="امتیاز بیشتر از" value={config.bullishScore} max={4} step={.25} onChange={n => patchConfig({ bullishScore: n })} /><NumberField label="امتیاز حداکثر" value={upMax} max={4} step={.25} onChange={setUpMax} /><NumberField label="حداقل اطمینان UP" value={config.bullishMinConf} onChange={n => patchConfig({ bullishMinConf: n, bullishMaxConf: Math.max(n, config.bullishMaxConf) })} /><NumberField label="حداکثر اطمینان UP" value={config.bullishMaxConf} onChange={n => patchConfig({ bullishMaxConf: n, bullishMinConf: Math.min(n, config.bullishMinConf) })} /></div><div><h3 dir="ltr">DOWN</h3><NumberField label="امتیاز کمتر از" value={config.bearishScore} max={4} step={.25} onChange={n => patchConfig({ bearishScore: n })} /><NumberField label="امتیاز حداقل" value={downMin} max={4} step={.25} onChange={setDownMin} /><NumberField label="حداقل اطمینان DOWN" value={config.bearishMinConf} onChange={n => patchConfig({ bearishMinConf: n, bearishMaxConf: Math.max(n, config.bearishMaxConf) })} /><NumberField label="حداکثر اطمینان DOWN" value={config.bearishMaxConf} onChange={n => patchConfig({ bearishMaxConf: n, bearishMinConf: Math.min(n, config.bearishMinConf) })} /></div></div><div className="cw-signal-top"><NumberField label="از دقیقهٔ ساعت" value={config.minMinute} max={59} onChange={n => patchConfig({ minMinute: n, maxMinute: Math.max(n, config.maxMinute) })} /><NumberField label="تا دقیقهٔ ساعت" value={config.maxMinute} max={59} onChange={n => patchConfig({ maxMinute: n, minMinute: Math.min(n, config.minMinute) })} /><NumberField label="حداقل مظنهٔ ورود · ¢" value={config.minEntry} onChange={n => patchConfig({ minEntry: n, maxEntry: Math.max(n, config.maxEntry) })} /><NumberField label="حداکثر مظنهٔ ورود · ¢" value={config.maxEntry} onChange={n => patchConfig({ maxEntry: n, minEntry: Math.min(n, config.minEntry) })} /></div><div className="cw-signal-options"><label><input type="checkbox" checked={config.noPriorOpposite} onChange={e => patchConfig({ noPriorOpposite: e.target.checked })} />بدون سیگنال مخالف قبلی</label><label><input type="checkbox" checked={config.solarAgrees} onChange={e => patchConfig({ solarAgrees: e.target.checked })} />تأیید جهت Solar</label><label><input type="checkbox" checked={showReferences} onChange={e => setShowReferences(e.target.checked)} />نمایش خطوط آستانه</label><Field label="ترتیب انتخاب"><select value={config.pickOrder} onChange={e => patchConfig({ pickOrder: e.target.value as AnalysisConfig["pickOrder"] })}><option value="afterFilters">اول فیلتر، بعد انتخاب اولین</option><option value="beforeFilters">اولین سیگنال، فقط اگر مجاز بود</option></select></Field></div><details className="cw-execution-options"><summary>جهت، فرض‌های مالی و تأییدهای تکمیلی <ChevronDown size={13} /></summary><div className="cw-signal-top"><Field label="جهت سیگنال"><select value={config.directions} onChange={e => patchConfig({ directions: e.target.value as AnalysisConfig["directions"] })}><option value="both">هر دو جهت</option><option value="UP">فقط UP</option><option value="DOWN">فقط DOWN</option></select></Field><NumberField label="سرمایهٔ هر معامله · $" value={config.stake} min={0.01} max={1000000} step={1} onChange={n => patchConfig({ stake: n })} /><NumberField label="لغزش قیمت · ¢" value={config.slippageCents} step={.1} onChange={n => patchConfig({ slippageCents: n })} /><NumberField label="حداقل اطمینان Solar · %" value={config.solarMinConf} onChange={n => patchConfig({ solarMinConf: n })} /><NumberField label="حداقل احتمال TimesFM برای جهت · %" value={config.tfmMinProb} onChange={n => patchConfig({ tfmMinProb: n })} /><NumberField label="حداقل اختلاف TimesFM با مظنه · ¢" value={config.tfmMinEdge} min={-100} step={.1} onChange={n => patchConfig({ tfmMinEdge: n })} /></div><p>احتمال TimesFM برابر صفر و اختلاف آن برابر منفی ۱۰۰ یعنی تأیید مربوطه خاموش است.</p></details><p>سیگنال‌ها از تمام تاریخچهٔ محدوده انتخاب می‌شوند؛ بزرگ‌نمایی و فیلتر نمایشی، سابقهٔ همان ساعت را تغییر نمی‌دهند. خطوط آستانه برای مدل انتخاب‌شده‌اند؛ در نمای چندمدلی، مدل سیگنال را ملاک بگیرید.</p></div></details>

        <details className="cw-filter-panel"><summary><span><Filter size={15} />شرط‌های تکمیلی سیگنال <b>{config.fieldFilters.flatMap(group => group.conditions).filter(condition => condition.enabled).length}</b></span><ChevronDown size={14} /></summary><p className="cw-filter-explanation">این شرط‌ها در انتخاب نشانگرها و جست‌وجوی بهینه‌سازی ثابت می‌مانند؛ زمینهٔ منحنی را حذف نمی‌کنند.</p><div dir="ltr"><FieldFilterPanel fields={executionFields} groups={config.fieldFilters} onChange={groups => patchConfig({ fieldFilters: groups })} quickFieldIds={["trade_price", "trade_agree", "trade_flipped", "solar_score_confidence", "fair_claude"]} countText={`${trades.length} selected signals in the full time scope`} hint="Executable conditions: AND within a group, OR between groups. Outcome and trade-result fields are excluded." /></div></details>

        {!loading && <CurveOptimizer rows={scopeRows} config={signalConfig} dataRevision={`${revision}:${coin}:${dataset}`} onApply={next => { setConfig(withoutCurveScoreBounds(sanitizeLabConfig(next))); setShowSignals(true); setNotice("شرط منتخب روی نشانگرهای همین منحنی اعمال شد."); }} />}

        <details className="cw-filter-panel"><summary><span><Filter size={15} />فیلتر نمایشی روی فیلدها <b>{fieldFilters.flatMap(group => group.conditions).filter(condition => condition.enabled).length}</b></span><ChevronDown size={14} /></summary><div dir="ltr"><FieldFilterPanel fields={fields} groups={fieldFilters} onChange={groups => { setFieldFilters(groups); setPage(1); }} quickFieldIds={["score", "kev_score", "solar_score", "minute", "fair_claude", "claude_edge"]} matched={displayRows.length} total={scopeRows.length} hint="Display filters affect the curve and snapshot table only. Optimization uses the complete coin/date/hour scope, without outcome-based display filters." /></div></details>

        <section className="cw-table-section"><div className="cw-section-title"><h2>اسنپ‌شات‌های روی نمودار <span>{nf(tableRows.length)}</span></h2><div><button className="cw-button" disabled={!tableRows.length} onClick={exportCsv}><ArrowDownToLine size={14} />CSV</button><details className="cw-columns"><summary>ستون‌ها <Settings2 size={13} /></summary><div><button className="cw-text-button" onClick={() => setTableIds(curveIds)}>همسان با منحنی‌های فعال</button>{columns.map(definition => <label key={definition.id}><input type="checkbox" checked onChange={() => setTableIds(current => current.filter(id => id !== definition.id))} />{definition.label}</label>)}<select aria-label="افزودن ستون" value="" onChange={e => setTableIds(current => [...current, e.target.value])}><option value="">افزودن یک پارامتر…</option>{CURVE_DEFINITIONS.filter(definition => !tableIds.includes(definition.id)).map(definition => <option value={definition.id} key={definition.id}>{definition.label}</option>)}</select></div></details></div></div><div className="cw-table-toolbar"><label className="cw-search"><Search size={14} /><input aria-label="جست‌وجوی اسنپ‌شات" placeholder="تاریخ، نام فایل یا جهت…" value={query} onChange={e => { setQuery(e.target.value); setPage(1); }} /></label><select aria-label="نمای داده و سیگنال" value={viewFilter} onChange={e => { setViewFilter(e.target.value); setPage(1); }}><option value="all">همهٔ اسنپ‌شات‌ها</option><option value="signals">فقط سیگنال‌های منتخب</option><option value="wins">سیگنال‌های برنده</option><option value="losses">سیگنال‌های بازنده</option><option value="UP">جهت Jev: UP</option><option value="DOWN">جهت Jev: DOWN</option><option value="3up">اجماع کامل UP</option><option value="3down">اجماع کامل DOWN</option></select><span>فیلتر و مرتب‌سازی روی خروجی CSV هم اعمال می‌شود.</span></div><div className="cw-table-scroll"><table className="cw-table"><thead><tr><th><button onClick={() => setSort(current => ({ id: "time", asc: current.id === "time" ? !current.asc : false }))}>زمان · ET {sort.id === "time" ? sort.asc ? "↑" : "↓" : ""}</button></th>{columns.map(definition => <th key={definition.id}><button onClick={() => setSort(current => ({ id: definition.id, asc: current.id === definition.id ? !current.asc : false }))}>{definition.label} {sort.id === definition.id ? sort.asc ? "↑" : "↓" : ""}</button></th>)}<th><button onClick={() => setSort(current => ({ id: "result", asc: current.id === "result" ? !current.asc : false }))}>سیگنال / نتیجه</button></th><th>فایل</th></tr></thead><tbody>{pageRows.map(row => <tr key={row.filename} className={pinnedFile === row.filename ? "is-pinned" : ""}><td><button className="cw-time-button" onClick={() => setPinnedFile(row.filename)}>{row.et_time.replace(" ET", "")}</button></td>{columns.map(definition => <td key={definition.id} dir="ltr">{fmt(definition.get(row), definition)}</td>)}<td>{tradeMap.get(row.filename) ? <span dir="ltr">{tradeMap.get(row.filename)!.dir} · {tradeMap.get(row.filename)!.status}</span> : "—"}</td><td><button className="cw-text-button" onClick={() => setSelectedFile(row.filename)}>JSON</button></td></tr>)}</tbody></table>{!pageRows.length && <p className="cw-empty">داده‌ای با این بازه و فیلتر وجود ندارد؛ بازه را بازتر کنید.</p>}</div><div className="cw-pagination"><span>{tableRows.length ? `${nf((activePage - 1) * 50 + 1)}–${nf(Math.min(activePage * 50, tableRows.length))} از ${nf(tableRows.length)}` : "۰ اسنپ‌شات"}</span><div><button className="cw-button" disabled={activePage === 1} onClick={() => setPage(activePage - 1)}>قبلی</button><button className="cw-button" disabled={activePage * 50 >= tableRows.length} onClick={() => setPage(activePage + 1)}>بعدی</button></div></div></section>
        <div className="cw-footer"><p>نشانگر برد و باخت از نتیجهٔ تسویهٔ بازار ۱ ساعته می‌آید؛ هر اسنپ‌شات یک معاملهٔ مستقل نیست. دادهٔ CL پاسخ مجدد مدل‌هاست و لزوماً در زمان اصلی در دسترس نبوده است.</p><div><Link href="/jev-analysis/classic">نمای کلاسیک JEV</Link><Link href="/jev-analysis/v2">آزمایشگاه استراتژی و بک‌تست <ArrowLeft size={12} /></Link></div></div>
      </div>
    </div>
    <input className="cw-hidden" type="file" accept=".json,application/json" ref={importInput} aria-label="ورود تنظیمات منحنی" onChange={e => void importSettings(e.target.files?.[0])} />
    {selectedFile && <dialog ref={dialog} className="cw-json-dialog" onCancel={() => setSelectedFile(null)} onClose={() => setSelectedFile(null)}><div className="cw-section-title"><h2><FileJson size={16} />فایل اسنپ‌شات</h2><div><a href={`/api/jev/history?file=${encodeURIComponent(selectedFile)}${dataset === "cl" ? "&set=cl" : ""}`} target="_blank" rel="noreferrer">نمای مستقیم</a><button className="cw-icon" aria-label="بستن فایل JSON" onClick={() => { dialog.current?.close(); setSelectedFile(null); }}><X size={18} /></button></div></div><p className="cw-json-name" dir="ltr">{selectedFile}</p>{fileLoading ? <p className="cw-empty">در حال خواندن فایل…</p> : fileError ? <p className="cw-error">{fileError}</p> : <pre dir="ltr">{fileContent}</pre>}</dialog>}
  </div>;
}
