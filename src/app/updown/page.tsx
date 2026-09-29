"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bitcoin, RefreshCw, Clock, Activity, Zap, ChevronRight, Sparkles, FileText, Download, Eye, ChevronDown, BarChart3 } from "lucide-react";

const COINS = [
  { key: "btc", label: "Bitcoin", sym: "₿", color: "#d49a4a" },
  { key: "eth", label: "Ethereum", sym: "Ξ", color: "#627EEA" },
  { key: "sol", label: "Solana", sym: "◎", color: "#14F195" },
  { key: "xrp", label: "XRP", sym: "✕", color: "#7FA8C9" },
  { key: "doge", label: "Dogecoin", sym: "Ð", color: "#C2A633" },
  { key: "hype", label: "Hyperliquid", sym: "H", color: "#97FCE4" },
  { key: "bnb", label: "BNB", sym: "◆", color: "#F3BA2F" },
];

function Collapsible({ id, openState, toggle, color, title, subtitle, badge, children }: {
  id: string; openState: boolean; toggle: () => void; color: string; title: string; subtitle?: string;
  badge?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="bg-white/[0.08] border border-[rgba(190,190,200,0.15)] rounded-2xl shadow-sm overflow-hidden">
      <button onClick={toggle} className="w-full flex items-center justify-between px-6 py-4 text-left hover:bg-white/[0.08] transition-colors">
        <span className="flex items-center gap-2 min-w-0">
          <ChevronRight className={`w-4 h-4 text-[#73757c] transition-transform shrink-0 ${openState ? "rotate-90" : ""}`} />
          <span className="text-base font-medium flex items-center gap-2 truncate" style={{ color: openState ? "#fff" : color }}>
            {title} {subtitle && <span className="text-xs text-[#73757c] font-normal">{subtitle}</span>}
          </span>
        </span>
        <span className="shrink-0 ml-3">{badge}</span>
      </button>
      {openState && <div className="px-6 pb-6">{children}</div>}
    </div>
  );
}

interface MarketRow {
  slug: string; title: string; up: number; down: number; live: number | null; liveDown?: number | null;
  closed: boolean; accepting: boolean; tokenUp: string;
}

function pct(v: number | null | undefined) {
  return v == null ? "—" : (v * 100).toFixed(1) + "¢";
}

export default function UpDownPage() {
  const [coin, setCoin] = useState("btc");
  const [sigmaInput, setSigmaInput] = useState(""); // "" = auto (API uses realized vol of the last 60 1m bars)
  const sigmaVal = parseFloat(sigmaInput);
  const sigma = Number.isFinite(sigmaVal) && sigmaVal > 0 ? sigmaVal : null;
  const sigmaQs = sigma != null ? `&sigma=${sigma}` : "";
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const [countdown, setCountdown] = useState(5);
  const [liveMode, setLiveMode] = useState(false);
  const [copied, setCopied] = useState(false);
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    console.log('[CLOCK EFFECT RUNNING]');
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // data polling — merged into a guaranteed-run effect
  useEffect(() => {
    console.log('[POLL EFFECT RUNNING]');
    let cancelled = false;
    const tick = async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/updown?coin=${coin}${sigmaQs}`, { cache: "no-store" });
        if (!res.ok) throw new Error("API " + res.status);
        const d = await res.json();
        if (!cancelled) { setData(d); setErr(null); }
      } catch (e: any) { if (!cancelled) setErr(e.message); }
      finally { if (!cancelled) setLoading(false); }
    };
    tick();
    const iv = setInterval(tick, 5000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [coin, sigmaQs]);
  const [open15, setOpen15] = useState(false);
  const [open5, setOpen5] = useState(false);
  const [openA, setOpenA] = useState(false);
  const [openC, setOpenC] = useState(false);
  const [openSnap, setOpenSnap] = useState(false);
  const [openAudit, setOpenAudit] = useState(false);
  const [copiedAudit, setCopiedAudit] = useState(false);
  const [openJev, setOpenJev] = useState(true);
  const [jevLoading, setJevLoading] = useState(false);
  const [jevResult, setJevResult] = useState<any>(null);
  const [jevError, setJevError] = useState<string | null>(null);
  const [historyFiles, setHistoryFiles] = useState<any[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [viewingFile, setViewingFile] = useState<string | null>(null);
  const [viewingContent, setViewingContent] = useState<string | null>(null);
  const [jevCountdown, setJevCountdown] = useState<number>(300);
  const esRef = useRef<EventSource | null>(null);
  const timerRef = useRef<any>(null);

  const fetchHistoryFiles = useCallback(async (targetCoin?: string) => {
    setHistoryLoading(true);
    try {
      const c = targetCoin || coin;
      const res = await fetch(`/api/jev/history?coin=${c}`);
      const d = await res.json();
      if (d.files) setHistoryFiles(d.files);
    } catch {
      // fallback
    } finally {
      setHistoryLoading(false);
    }
  }, [coin]);

  const viewFileDetails = async (filename: string) => {
    if (viewingFile === filename) {
      setViewingFile(null);
      setViewingContent(null);
      return;
    }
    setViewingFile(filename);
    try {
      const res = await fetch(`/api/jev/history?file=${filename}`);
      const text = await res.text();
      setViewingContent(text);
    } catch {
      setViewingContent("خطا در بارگذاری محتوای فایل");
    }
  };

  const fetchJevPrediction = useCallback(async (isManual = false, targetCoin?: string) => {
    setJevLoading(true);
    setJevError(null);
    try {
      const c = targetCoin || coin;
      const url = isManual ? `/api/jev/predict?force=true&coin=${c}` : `/api/jev/predict?coin=${c}`;
      const res = await fetch(url, { method: isManual ? "POST" : "GET" });
      const d = await res.json();
      if (!res.ok || d.error) throw new Error(d.error || "خطا در دریافت پاسخ از Jev");
      setJevResult(d);
      if (d.next_refresh_seconds != null) {
        setJevCountdown(Math.max(5, d.next_refresh_seconds));
      } else {
        setJevCountdown(300);
      }
      fetchHistoryFiles(c);
    } catch (e: any) {
      setJevError(e.message || "خطا در ارتباط با مدل تصمیم‌گیری Jev");
    } finally {
      setJevLoading(false);
    }
  }, [coin, fetchHistoryFiles]);

  // When coin changes, load prediction and history for that coin
  useEffect(() => {
    fetchJevPrediction(false, coin);
    fetchHistoryFiles(coin);
  }, [coin, fetchJevPrediction, fetchHistoryFiles]);

  // Automatic 5-minute timer countdown & execution
  useEffect(() => {
    const timer = setInterval(() => {
      setJevCountdown(prev => {
        if (prev <= 1) {
          fetchJevPrediction(false, coin);
          return 300;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [coin, fetchJevPrediction]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/updown?coin=${coin}${sigmaQs}`, { cache: "no-store" });
      if (!res.ok) throw new Error("API " + res.status);
      const d = await res.json();
      setData(d);
      setErr(null);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [coin, sigmaQs]);

const m = data?.model;
  const m5model = data?.model5;
  const modelA = data?.modelA;
  const modelC = data?.modelC;
  const m1h: MarketRow | null = data?.m1h;
  const m15: MarketRow | null = data?.m15;
  const m5: MarketRow | null = data?.m5;
  const m5m: MarketRow | null = data?.m5;
  const n15 = data?.n15, n5 = data?.n5;
  const market1h = m1h?.live ?? m1h?.up ?? null;
  const fair = m?.fairUp ?? null;
  const edge = m?.edge ?? null;

  const badge15 = fair != null && (
    <span className={`text-sm font-bold tabular-nums ${edge != null && Math.abs(edge) > 0.03 ? (edge > 0 ? "text-[#5fbf9a]" : "text-[#e5787f]") : "text-[#9a9ca3]"}`}>
      {(fair * 100).toFixed(1)}¢{edge != null && (edge > 0 ? " ↑" : " ↓")}
    </span>
  );
  const badge5 = m5model?.fairUp != null && (
    <span className="text-sm font-bold tabular-nums text-[#d4b063]">{(m5model.fairUp * 100).toFixed(1)}¢</span>
  );
  const badgeA = modelA?.fairUp != null && (
    <span className="text-sm font-bold tabular-nums text-[#9fb4ee]">{(modelA.fairUp * 100).toFixed(1)}¢</span>
  );
  const badgeC = modelC?.valid && modelC?.fairUp != null && (
    <span className="text-sm font-bold tabular-nums text-[#d68aa8]">{(modelC.fairUp * 100).toFixed(1)}¢</span>
  );

  const nowClk = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const fmt = (v: number | null | undefined, digits = 2) => (v == null ? "—" : v.toLocaleString("en-US", { maximumFractionDigits: digits }));
  const snapshot = [
    `1- Current time (${nowClk})`,
    `2- S0 = ${fmt(m?.s0, 2)}`,
    `3- SA = ${fmt(m?.sa, 2)}`,
    `4- ST = ${fmt(m?.st, 2)}`,
    `5- P15 = ${m?.p15 != null ? (m.p15 * 100).toFixed(2) + "¢" : "—"}`,
    `6- P5 = ${m5?.live != null ? (m5.live * 100).toFixed(2) + "¢" : "—"}`,
  ].join("\n");

  const copySnapshot = async () => {
    try {
      await navigator.clipboard.writeText(snapshot);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  const fmtRemain = (tick: number, periodSec: number) => {
    const remain = periodSec - (Math.floor(tick / 1000) % periodSec);
    const m = Math.floor(remain / 60), s = remain % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  const auditText = [
    "۱. ورودی‌های فرمول پایه‌ی ۱ ساعته (مدل الف):",
    `• S₀ = ${fmt(m?.s0)} | Sₜ = ${fmt(m?.st)} | xₜ = ln(Sₜ/S₀) = ${m?.xt != null ? m.xt.toFixed(6) : "—"}`,
    `• τ (hours) = ${modelA ? modelA.tauHours.toFixed(4) : "—"}`,
    `• σ₁ₕ = ${data?.sigma1h != null ? data.sigma1h.toFixed(4) : "—"} (${data?.sigmaSource ?? "—"})`,
    "",
    "۲. ورودی‌های حل دستگاه (مدل ب — ۵ و ۱۵ دقیقه‌ای):",
    `• τ₅ = ${m5model ? m5model.tau5.toFixed(2) : "—"} دقیقه | τ₁₅ = ${m ? m.tau15.toFixed(2) : "—"} دقیقه`,
    `• Sₐ₅ = ${fmt(m5model?.sa5)} | y₅ = ln(Sₜ/Sₐ₅) = ${m5model ? m5model.y5.toFixed(6) : "—"}`,
    `• Sₐ₁₅ = ${fmt(m?.sa)} | y₁₅ = ln(Sₜ/Sₐ₁₅) = ${m ? m.y.toFixed(6) : "—"}`,
    `• p₅ = ${m5m?.live != null ? (m5m.live * 100).toFixed(2) + "¢" : "—"} | p₁₅ = ${m?.p15 != null ? (m.p15 * 100).toFixed(2) + "¢" : "—"}`,
    "",
    "۳. ورودی‌های ارزش منصفانه‌ی نهایی (با رانش):",
    `• xₜ = ${m?.xt != null ? m.xt.toFixed(6) : "—"}`,
    `• τ₆₀ = ${m ? m.tau60.toFixed(2) : "—"} دقیقه`,
    `• σₘ (حل‌شده) = ${modelC ? modelC.sigmaM.toFixed(6) : "—"} | μ (حل‌شده) = ${modelC ? modelC.mu.toFixed(6) : "—"}`,
  ].join("\n");

  const copyAudit = async () => {
    try {
      await navigator.clipboard.writeText(auditText);
      setCopiedAudit(true);
      setTimeout(() => setCopiedAudit(false), 1500);
    } catch {}
  };

  const Row = ({ title, row, next }: { title: string; row: MarketRow | null; next?: MarketRow | null }) => (
    <div className="bg-white/[0.08] border border-[rgba(190,190,200,0.15)] rounded-2xl p-5 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-[#9a9ca3] font-medium">{title}</p>
        {row?.accepting ? (
          <span className="inline-flex items-center gap-1 text-[10px] text-[#5fbf9a]"><span className="w-1.5 h-1.5 rounded-full bg-[#5fbf9a]" /> OPEN</span>
        ) : (
          <span className="text-[10px] text-[#73757c]">CLOSED</span>
        )}
      </div>
      {row ? (
        <>
          <p className="text-sm text-[#e8e8e4] font-medium mb-3 truncate" title={row.title}>{row.title}</p>
          <div className="grid grid-cols-2 gap-3">
            <div className={`rounded-xl p-3 border ${ (row.live ?? row.up) >= 0.5 ? "bg-[#5fbf9a]/10 border-[#5fbf9a]/35" : "bg-white/[0.08] border-[rgba(190,190,200,0.13)]"}`}>
              <p className="text-[10px] text-[#9a9ca3] mb-1">Up</p>
              <p className={`text-2xl font-bold tabular-nums ${(row.live ?? row.up) >= 0.5 ? "text-[#5fbf9a]" : "text-[#bdbdb8]"}`}>{pct(row.live ?? row.up)}</p>
            </div>
            <div className={`rounded-xl p-3 border ${ (row.liveDown ?? 1 - (row.live ?? row.up)) > 0.5 ? "bg-[#e5787f]/10 border-[#e5787f]/35" : "bg-white/[0.08] border-[rgba(190,190,200,0.13)]"}`}>
              <p className="text-[10px] text-[#9a9ca3] mb-1">Down</p>
              <p className={`text-2xl font-bold tabular-nums ${(row.liveDown ?? 1 - (row.live ?? row.up)) > 0.5 ? "text-[#e5787f]" : "text-[#bdbdb8]"}`}>{pct(row.liveDown ?? 1 - (row.live ?? row.up))}</p>
            </div>
          </div>
        </>
      ) : next ? (
        <p className="text-xs text-[#73757c]">
          no active market — next opens: <span className="text-[#bdbdb8]">{next.title?.replace(/^.*? - /, "")}</span>
        </p>
      ) : (
        <p className="text-xs text-[#73757c]">market not found</p>
      )}
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3 justify-between">
        <div>
          <h1 className="text-2xl font-semibold mb-1 tracking-tight flex items-center gap-2">
            <Zap className="w-6 h-6 text-[#d4b063]" />
            <span className="">Up/Down Markets</span>
            <span className="text-[#e8e8e4]">— Live Fair Value</span>
            <span className="ml-1 inline-flex items-center gap-1.5 text-[11px] text-[#5fbf9a]"><span className="pulse-dot" /> LIVE</span>
          </h1>
          <p className="text-sm text-[#9a9ca3]">Polymarket hourly &amp; sub-hourly crypto markets, synced live · drift-extraction fair value for the 1H</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-9 flex justify-center">{loading && <RefreshCw className="w-4 h-4 animate-spin text-[#73757c]" />}</span>
          <span className="text-xs text-[#73757c] tabular-nums w-24">{auto ? `next refresh ${countdown}s` : ""}</span>
          <button onClick={() => setAuto(a => !a)}
            className={`text-xs font-medium rounded-lg px-3 py-1.5 border ${auto ? "bg-[#5fbf9a]/10 text-[#5fbf9a] border-[#5fbf9a]/35" : "text-[#9a9ca3] border-[rgba(190,190,200,0.15)]"}`}>
            {auto ? "Auto 5s ON" : "Auto OFF"}
          </button>
          <button onClick={load} className="text-xs font-medium rounded-lg px-3 py-1.5 border border-[rgba(190,190,200,0.15)] text-[#bdbdb8] hover:border-[rgba(190,190,200,0.28)]">
            Refresh
          </button>
        </div>
      </div>

      {/* live clock + candle countdowns — sticky, never moves */}
      <div className="sticky top-14 z-40 -mx-1 px-1 py-1.5 rounded-xl bg-[#181a1e]/85 backdrop-blur-md border border-[rgba(190,190,200,0.14)] flex items-center justify-center gap-5 text-xs tabular-nums shadow-sm">
        <span className="flex items-center gap-1.5 text-[#e8e8e4] font-medium">
          <Clock className="w-3.5 h-3.5 text-[#9a9ca3]" />
          {new Date(nowTick).toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          <span className="text-[#73757c]">ET</span>
        </span>
        <span className="w-px h-4 bg-[rgba(190,190,200,0.2)]" />
        <span className="text-[#d4b063]">5m close <b className="font-semibold">{fmtRemain(nowTick, 300)}</b></span>
        <span className="text-[#6aa9d8]">15m close <b className="font-semibold">{fmtRemain(nowTick, 900)}</b></span>
        <span className="text-[#e5787f]">1h close <b className="font-semibold">{fmtRemain(nowTick, 3600)}</b></span>
      </div>

      {/* coin selector */}
      <div className="flex flex-wrap gap-2">
        {COINS.map(c => (
          <button key={c.key} onClick={() => setCoin(c.key)}
            className={`inline-flex items-center gap-1.5 text-sm font-medium rounded-full px-4 py-1.5 border transition-colors ${coin === c.key ? "text-[#131418] border-transparent" : "text-[#9a9ca3] border-[rgba(190,190,200,0.15)] hover:border-[rgba(190,190,200,0.28)]"}`}
            style={coin === c.key ? { background: c.color } : {}}>
            <span>{c.sym}</span> {c.label}
          </button>
        ))}
      </div>

      {err && <div className="bg-[#e5787f]/10 border border-[#e5787f]/35 text-[#e5787f] rounded-xl px-4 py-3 text-sm">{err}</div>}

      {/* three market cards */}
      <div className="grid md:grid-cols-3 gap-4">
        <Row title="1 Hour market" row={m1h} />
        <Row title="15 minute market" row={m15} next={n15} />
        <Row title="5 minute market" row={m5} next={n5} />
      </div>

      {/* Jev Decision Model — 1-Hour Prediction (First card under prices) */}
      <Collapsible id="openJev" openState={openJev} toggle={() => setOpenJev(!openJev)}
        color={COINS.find(c => c.key === coin)?.color || "#6aa9d8"}
        title={`Jev Decision Model — پیش‌بینی ۱ ساعته ${COINS.find(c => c.key === coin)?.label || coin.toUpperCase()}`}
        subtitle="OpenRouter typesafe/jev-1.13"
        badge={
          jevResult?.decision?.answers?.one_hour_score?.score != null ? (
            <span className="inline-flex items-center gap-2 text-xs font-bold tabular-nums">
              <span className="text-[#6aa9d8]">اسکور: {Number(jevResult.decision.answers.one_hour_score.score).toFixed(2)}/4.0</span>
              {jevResult?.decision?.answers?.one_hour_direction?.choice && (
                <span className={`px-2 py-0.5 rounded text-[11px] font-semibold ${jevResult.decision.answers.one_hour_direction.choice === 'UP' ? 'bg-[#5fbf9a]/20 text-[#5fbf9a]' : 'bg-[#e5787f]/20 text-[#e5787f]'}`}>
                  {jevResult.decision.answers.one_hour_direction.choice}
                </span>
              )}
            </span>
          ) : (
            <span className="text-xs text-[#73757c]">آماده استعلام</span>
          )
        }>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 bg-[#181a1e]/70 p-3.5 rounded-xl border border-[rgba(190,190,200,0.13)]">
            <div className="flex flex-wrap items-center gap-3 text-xs text-[#bdbdb8]">
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#5fbf9a]/10 border border-[#5fbf9a]/30 text-[#5fbf9a] text-[11px] font-medium">
                <span className="w-2 h-2 rounded-full bg-[#5fbf9a]"></span>
                <span>استعلام خودکار ۵ دقیقه‌ای ({coin.toUpperCase()}): <b>فعال</b></span>
                <span className="text-white/80 tabular-nums font-mono mr-1">
                  (استعلام بعدی: {Math.floor(jevCountdown / 60)}:{(jevCountdown % 60).toString().padStart(2, '0')})
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-[11px] text-[#9a9ca3]">
                <Sparkles className="w-3.5 h-3.5 text-[#d4b063]" />
                <span className="font-mono text-[#6aa9d8]">typesafe/jev-1.13</span>
                {jevResult?.timestamp && (
                  <span className="text-[#73757c]">
                    · آخرین ثبت ({jevResult.coin || coin.toUpperCase()}): {new Date(jevResult.timestamp).toLocaleTimeString("en-GB", { timeZone: "America/New_York" })} ET
                  </span>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Link
                href={`/jev-analysis?coin=${coin}`}
                className="inline-flex items-center gap-1.5 text-xs font-semibold rounded-lg px-3 py-2 bg-[#6b86d6]/25 hover:bg-[#6b86d6]/40 text-[#bdbdb8] hover:text-white border border-[#8ea4e8]/40 transition-all shadow-sm"
                title="مشاهده داشبورد تحلیلی و انتخاب ۳ شاخص دلخواه">
                <BarChart3 className="w-3.5 h-3.5 text-[#6aa9d8]" />
                داشبورد آنالیز و مقایسه 📊
              </Link>
              <button
                type="button"
                onClick={() => { setShowHistory(!showHistory); if (!showHistory) fetchHistoryFiles(coin); }}
                className={`inline-flex items-center gap-1.5 text-xs font-medium rounded-lg px-3 py-2 border transition-all ${showHistory ? 'bg-[#6aa9d8]/20 border-[#6aa9d8] text-[#6aa9d8]' : 'bg-white/[0.08] hover:bg-white/[0.12] border-[rgba(190,190,200,0.2)] text-[#bdbdb8]'}`}>
                <Clock className="w-3.5 h-3.5 text-[#6aa9d8]" />
                فایل‌های ۵ دقیقه‌ای {coin.toUpperCase()} ({historyFiles.length})
                <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showHistory ? "rotate-180" : ""}`} />
              </button>
              <button
                type="button"
                onClick={() => fetchJevPrediction(true, coin)}
                disabled={jevLoading}
                className="inline-flex items-center gap-2 text-xs font-medium rounded-lg px-3.5 py-2 bg-[#6366f1] text-white hover:opacity-90 transition-opacity disabled:opacity-50 shadow-md"
                title="نیازی به کلیک نیست، هر ۵ دقیقه به طور خودکار انجام می‌شود">
                <RefreshCw className={`w-3.5 h-3.5 ${jevLoading ? "animate-spin" : ""}`} />
                {jevLoading ? "در حال استعلام Jev..." : `استعلام دستی فوری ${coin.toUpperCase()}`}
              </button>
            </div>
          </div>

          {jevError && (
            <div className="bg-[#e5787f]/10 border border-[#e5787f]/35 text-[#e5787f] rounded-xl px-4 py-3 text-xs">
              {jevError}
            </div>
          )}

          {jevResult?.decision?.answers ? (
            <div className="space-y-4">
              <div className="grid md:grid-cols-2 gap-4">
                {/* Score Card */}
                {jevResult.decision.answers.one_hour_score && (
                  <div className="bg-[#181a1e]/90 rounded-xl p-5 border border-[rgba(190,190,200,0.18)] flex flex-col justify-between">
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs text-[#9a9ca3] font-medium tracking-wider">اسکور پیش‌بینی ۱ ساعته (Score)</span>
                        <span className="text-xs text-[#73757c] tabular-nums">
                          اطمینان: {(Number(jevResult.decision.answers.one_hour_score.confidence || 0) * 100).toFixed(0)}%
                        </span>
                      </div>
                      <div className="flex items-baseline gap-3 my-2">
                        <span className="text-4xl font-extrabold text-[#6aa9d8] tabular-nums">
                          {Number(jevResult.decision.answers.one_hour_score.score).toFixed(2)}
                        </span>
                        <span className="text-sm text-[#73757c]">از ۴.۰</span>
                        <span className="text-sm font-semibold mr-auto text-[#e8e8e4]">
                          {(() => {
                            const sc = Number(jevResult.decision.answers.one_hour_score.score);
                            if (sc >= 3.0) return "صعودی قوی (Strong Up) 🚀";
                            if (sc >= 2.2) return "تمایل به صعود (Lean Up) ↗";
                            if (sc >= 1.8) return "خنثی / تعادل (Neutral) ⚖";
                            if (sc >= 1.0) return "تمایل به نزول (Lean Down) ↘";
                            return "نزولی قوی (Strong Down) 🔻";
                          })()}
                        </span>
                      </div>

                      {/* Score gauge bar */}
                      <div className="mt-4 mb-2">
                        <div className="relative h-2.5 w-full rounded-full bg-gradient-to-r from-[#e5787f] via-[#d4b063] to-[#5fbf9a]">
                          <div
                            className="absolute top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-white shadow-lg border-2 border-[#131418] transition-all duration-300"
                            style={{
                              left: `calc(${Math.min(100, Math.max(0, (Number(jevResult.decision.answers.one_hour_score.score) / 4) * 100))}% - 8px)`,
                            }}
                          />
                        </div>
                        <div className="flex justify-between text-[10px] text-[#73757c] mt-1.5 tabular-nums">
                          <span>0: Strong Down</span>
                          <span>1: Lean Down</span>
                          <span>2: Neutral</span>
                          <span>3: Lean Up</span>
                          <span>4: Strong Up</span>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Direction Card */}
                {jevResult.decision.answers.one_hour_direction && (
                  <div className="bg-[#181a1e]/90 rounded-xl p-5 border border-[rgba(190,190,200,0.18)] flex flex-col justify-between">
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs text-[#9a9ca3] font-medium tracking-wider">جهت نهایی (Direction Choice)</span>
                        <span className="text-xs text-[#73757c] tabular-nums">
                          اطمینان: {(Number(jevResult.decision.answers.one_hour_direction.confidence || 0) * 100).toFixed(0)}%
                        </span>
                      </div>
                      <div className="flex items-center gap-3 my-2">
                        <span className={`text-4xl font-extrabold ${jevResult.decision.answers.one_hour_direction.choice === 'UP' ? 'text-[#5fbf9a]' : 'text-[#e5787f]'}`}>
                          {jevResult.decision.answers.one_hour_direction.choice}
                        </span>
                        <span className="text-sm text-[#bdbdb8]">
                          {jevResult.decision.answers.one_hour_direction.choice === 'UP' ? 'احتمال بسته شدن بالای قیمت آغازین' : 'احتمال بسته شدن پایین قیمت آغازین'}
                        </span>
                      </div>

                      {jevResult.decision.answers.one_hour_direction.probabilities && (
                        <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
                          <div className="p-2.5 rounded-lg bg-white/[0.04] border border-[rgba(190,190,200,0.12)]">
                            <span className="text-[#9a9ca3] block text-[10px]">احتمال UP</span>
                            <span className="text-lg font-bold text-[#5fbf9a] tabular-nums">
                              {((jevResult.decision.answers.one_hour_direction.probabilities.UP || 0) * 100).toFixed(1)}%
                            </span>
                          </div>
                          <div className="p-2.5 rounded-lg bg-white/[0.04] border border-[rgba(190,190,200,0.12)]">
                            <span className="text-[#9a9ca3] block text-[10px]">احتمال DOWN</span>
                            <span className="text-lg font-bold text-[#e5787f] tabular-nums">
                              {((jevResult.decision.answers.one_hour_direction.probabilities.DOWN || 0) * 100).toFixed(1)}%
                            </span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Probabilities distribution levels */}
              {jevResult.decision.answers.one_hour_score?.probabilities && (
                <div className="bg-[#181a1e]/70 rounded-xl p-4 border border-[rgba(190,190,200,0.12)]">
                  <p className="text-xs text-[#9a9ca3] font-medium tracking-wider mb-3">توزیع احتمالات سطوح اسکور (Probability Distribution)</p>
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-center text-xs tabular-nums">
                    {[
                      { key: "0", label: "Strong Down", color: "#e5787f" },
                      { key: "1", label: "Lean Down", color: "#eba0a5" },
                      { key: "2", label: "Neutral", color: "#9a9ca3" },
                      { key: "3", label: "Lean Up", color: "#8fd0a8" },
                      { key: "4", label: "Strong Up", color: "#5fbf9a" },
                    ].map(lvl => {
                      const prob = Number(jevResult.decision.answers.one_hour_score.probabilities[lvl.key] || 0);
                      return (
                        <div key={lvl.key} className="p-2.5 rounded-lg bg-white/[0.04] border border-[rgba(190,190,200,0.1)] flex flex-col justify-between">
                          <span className="text-[11px] text-[#9a9ca3] mb-1 truncate">{lvl.label}</span>
                          <span className="text-base font-bold" style={{ color: lvl.color }}>
                            {(prob * 100).toFixed(1)}%
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Model usage & state toggle */}
              <div className="flex flex-wrap items-center justify-between text-[11px] text-[#73757c] pt-1">
                <span>توکن ورودی: {jevResult.decision.usage?.input_tokens ?? "—"} · هزینه استعلام: ${(jevResult.decision.usage?.cost ?? 0).toFixed(6)}</span>
                <span>منبع داده: فایل <code className="text-[#bdbdb8]">/jev/btc_updown.json</code></span>
              </div>
            </div>
          ) : (
            <div className="p-6 text-center text-xs text-[#9a9ca3] bg-[#181a1e]/50 rounded-xl border border-dashed border-[rgba(190,190,200,0.15)]">
              برای محاسبه‌ی اسکور پیش‌بینی ۱ ساعته بیت‌کوین بر اساس داده‌های کارت‌ها و Fair Valueهای فعلی، روی دکمه‌ی «استعلام پیش‌بینی ۱ ساعته از Jev» کلیک کنید.
            </div>
          )}

          {/* 5-Minute Historical Files Section */}
          {showHistory && (
            <div className="mt-4 p-4 rounded-xl bg-[#131418] border border-[#6aa9d8]/30 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.08] pb-3">
                <div className="flex items-center gap-2">
                  <FileText className="w-4 h-4 text-[#6aa9d8]" />
                  <span className="text-xs font-semibold text-white">فایل‌های تاریخی ذخیره شده هر ۵ دقیقه (داده‌ها + پیش‌بینی Jev)</span>
                  <span className="text-[11px] px-2 py-0.5 rounded-full bg-[#6aa9d8]/15 text-[#6aa9d8] font-bold">
                    {historyFiles.length} فایل
                  </span>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-[11px] text-[#73757c]">مسیر ذخیره: <code className="text-[#bdbdb8]">/jev/history/</code></span>
                  <button
                    type="button"
                    onClick={() => fetchHistoryFiles(coin)}
                    className="p-1 rounded hover:bg-white/[0.08] text-[#9a9ca3] hover:text-white transition-colors"
                    title="تازه‌سازی لیست">
                    <RefreshCw className={`w-3.5 h-3.5 ${historyLoading ? "animate-spin" : ""}`} />
                  </button>
                </div>
              </div>

              {historyFiles.length === 0 ? (
                <div className="text-center py-6 text-xs text-[#9a9ca3]">
                  هنوز فایلی ثبت نشده است یا در حال ذخیره‌سازی اولین فایل ۵ دقیقه‌ای هستیم...
                </div>
              ) : (
                <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                  {historyFiles.map((f: any) => (
                    <div
                      key={f.filename}
                      className="p-2.5 rounded-lg bg-white/[0.03] border border-white/[0.06] hover:border-[#6aa9d8]/40 transition-colors flex flex-wrap items-center justify-between gap-2 text-xs">
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="font-mono text-[#6aa9d8] text-[11px] truncate max-w-[200px]" title={f.filename}>
                          {f.filename}
                        </span>
                        <span className="text-[#9a9ca3] text-[11px]">
                          {f.et_time || f.filename}
                        </span>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {f.direction && (
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${f.direction === 'UP' ? 'bg-[#5fbf9a]/20 text-[#5fbf9a]' : 'bg-[#e5787f]/20 text-[#e5787f]'}`}>
                            {f.direction}
                          </span>
                        )}
                        {f.score != null && (
                          <span className="px-2 py-0.5 rounded bg-white/[0.06] text-[#bdbdb8] text-[10px] tabular-nums font-mono">
                            اسکور: {Number(f.score).toFixed(2)}
                          </span>
                        )}
                        {f.up_1h && (
                          <span className="text-[10px] text-[#73757c] hidden sm:inline">
                            (1h: ↑{f.up_1h} ↓{f.down_1h})
                          </span>
                        )}

                        <button
                          type="button"
                          onClick={() => viewFileDetails(f.filename)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-[#6aa9d8]/15 hover:bg-[#6aa9d8]/25 text-[#6aa9d8] text-[11px] transition-colors">
                          <Eye className="w-3 h-3" />
                          {viewingFile === f.filename ? "بستن" : "مشاهده JSON"}
                        </button>
                        <a
                          href={`/api/jev/history?file=${f.filename}`}
                          target="_blank"
                          rel="noreferrer"
                          className="p-1 rounded bg-white/[0.06] hover:bg-white/[0.12] text-[#9a9ca3] hover:text-white transition-colors"
                          title="دانلود مستقیم JSON">
                          <Download className="w-3 h-3" />
                        </a>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Inline JSON Viewer */}
              {viewingFile && viewingContent && (
                <div className="mt-3 p-3 rounded-lg bg-black/60 border border-[rgba(190,190,200,0.2)] font-mono text-[11px] text-[#9fb4ee] space-y-2">
                  <div className="flex items-center justify-between border-b border-white/[0.08] pb-1.5 text-xs text-white">
                    <span>محتوای فایل: <b className="text-[#6aa9d8]">{viewingFile}</b></span>
                    <button
                      type="button"
                      onClick={() => { setViewingFile(null); setViewingContent(null); }}
                      className="text-[#9a9ca3] hover:text-white text-xs">
                      ✕ بستن
                    </button>
                  </div>
                  <pre className="overflow-x-auto max-h-64 text-[10px] leading-relaxed text-[#bdbdb8] whitespace-pre p-2 bg-[#0f1013] rounded border border-white/[0.05]">
                    {viewingContent}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      </Collapsible>

      {/* Fair Value — 1H Up (μ from 15m) — collapsible */}
      <Collapsible id="open15" openState={open15} toggle={() => setOpen15(!open15)}
        color="#6aa9d8" title="Fair Value — 1H Up (μ from 15m)" subtitle="مدل ۱۵ دقیقه‌ای" badge={badge15}>
        <div className="flex items-center justify-end mb-4">
          <label className="flex items-center gap-2 text-xs text-[#9a9ca3]">
            σ₁ₕ (hourly vol):
            <input type="number" step="0.0005" min="0.002" max="0.2" value={sigmaInput}
              placeholder={data?.sigma1h != null ? data.sigma1h.toFixed(4) : "auto"}
              onChange={e => setSigmaInput(e.target.value)}
              className="w-20 bg-white/[0.08] border border-[rgba(190,190,200,0.15)] rounded-lg px-2 py-1 text-white tabular-nums focus:outline-none focus:border-[#9fb4ee]" />
            {sigma == null
              ? <span className="text-[10px] text-[#73757c]">auto · {({ "realized-60m": "60m realized", "realized-7d": "7d realized", default: "default 0.02 (no Binance data)" } as Record<string, string>)[data?.sigmaSource] ?? "…"}</span>
              : <button onClick={() => setSigmaInput("")} className="text-[10px] text-[#9fb4ee] hover:underline">reset to auto</button>}
          </label>
        </div>

        {m ? (
          <div className="space-y-4">
            <div className="grid md:grid-cols-3 gap-4">
              <div className="bg-[#181a1e]/80 rounded-xl p-4 border border-[rgba(190,190,200,0.13)]">
                <p className="text-[10px] text-[#73757c] mb-1">Model fair value (Up)</p>
                <p className="text-3xl font-bold text-[#9fb4ee] tabular-nums">{(fair * 100).toFixed(1)}¢</p>
              </div>
              <div className="bg-[#181a1e]/80 rounded-xl p-4 border border-[rgba(190,190,200,0.13)]">
                <p className="text-[10px] text-[#73757c] mb-1">Market price (Up)</p>
                <p className="text-3xl font-bold text-white tabular-nums">{market1h != null ? (market1h * 100).toFixed(1) + "¢" : "—"}</p>
              </div>
              <div className={`bg-[#181a1e]/80 rounded-xl p-4 border ${edge != null && Math.abs(edge) > 0.03 ? (edge > 0 ? "border-[#5fbf9a]/40" : "border-[#e5787f]/40") : "border-[rgba(190,190,200,0.13)]"}`}>
                <p className="text-[10px] text-[#73757c] mb-1">Edge (fair − market)</p>
                <p className={`text-3xl font-bold tabular-nums ${edge == null ? "text-[#73757c]" : edge > 0.03 ? "text-[#5fbf9a]" : edge < -0.03 ? "text-[#e5787f]" : "text-[#bdbdb8]"}`}>
                  {edge == null ? "—" : (edge > 0 ? "+" : "") + (edge * 100).toFixed(1) + "¢"}
                </p>
                <p className="text-[10px] text-[#73757c] mt-1">{edge != null && Math.abs(edge) > 0.03 ? (edge > 0 ? "Up looks underpriced" : "Down looks underpriced") : "within noise band ±3¢"}</p>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs whitespace-nowrap">
                <thead className="text-[#73757c] border-b border-[rgba(190,190,200,0.15)]">
                  <tr><th className="py-2 pr-4">input</th><th className="py-2 pr-4">value</th><th className="py-2 pr-4">input</th><th className="py-2">value</th></tr>
                </thead>
                <tbody className="divide-y divide-[rgba(190,190,200,0.10)] text-[#bdbdb8] tabular-nums">
                  <tr><td className="py-1.5 pr-4">t (min into hour)</td><td className="py-1.5 pr-4">{m.t.toFixed(2)}</td><td className="py-1.5 pr-4">S₀ (hour open)</td><td className="py-1.5">${m.s0?.toLocaleString()}</td></tr>
                  <tr><td className="py-1.5 pr-4">a (15m block start)</td><td className="py-1.5 pr-4">:{String(Math.floor(m.a)).padStart(2, "0")}</td><td className="py-1.5 pr-4">Sₐ (block open)</td><td className="py-1.5">${m.sa?.toLocaleString()}</td></tr>
                  <tr><td className="py-1.5 pr-4">q (into block)</td><td className="py-1.5 pr-4">{m.q.toFixed(2)}</td><td className="py-1.5 pr-4">Sₜ (now)</td><td className="py-1.5">${m.st?.toLocaleString()}</td></tr>
                  <tr><td className="py-1.5 pr-4">τ₁₅ remaining</td><td className="py-1.5 pr-4">{m.tau15.toFixed(2)} min</td><td className="py-1.5 pr-4">xₜ = ln(Sₜ/S₀)</td><td>{m.xt.toFixed(5)}</td></tr>
                  <tr><td className="py-1.5 pr-4">τ₆₀ remaining</td><td className="py-1.5 pr-4">{m.tau60.toFixed(2)} min</td><td className="py-1.5 pr-4">y = ln(Sₜ/Sₐ)</td><td>{m.y.toFixed(5)}</td></tr>
                  <tr><td className="py-1.5 pr-4">σ₁ₕ / σₘ</td><td className="py-1.5 pr-4">{m.sigma1h} / {m.sigmaM.toFixed(5)}</td><td className="py-1.5 pr-4">p₁₅ (live 15m Up)</td><td>{(m.p15 * 100).toFixed(1)}¢</td></tr>
                  <tr><td className="py-1.5 pr-4">z₁₅ = Φ⁻¹(p₁₅)</td><td className="py-1.5 pr-4">{m.z15.toFixed(4)}</td><td className="py-1.5 pr-4">μ (implied drift)</td><td className={m.mu >= 0 ? "text-[#5fbf9a]" : "text-[#e5787f]"}>{m.mu.toFixed(6)}/min</td></tr>
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-[#73757c]">
              μ extracted from the live 15¢ market: μ = (z₁₅·σₘ·√τ₁₅ − y) / τ₁₅ · fair = Φ((xₜ + μ·τ₁₅)/(σₘ·√τ₆₀)) (drift only until the 15m window ends) · spot: Binance 1m klines (S₀ = hour open, Sₐ = active 15m block open) · market: CLOB midpoints
            </p>
          </div>
        ) : (
          <p className="text-sm text-[#73757c]">
            {m1h?.closed
              ? "1H market already settled — model needs an active hour market."
              : "Waiting for spot + market data (need S₀, Sₜ and a live 15m price in (0,1))."}
          </p>
        )}
      </Collapsible>

      {/* Fair Value — 1H Up (μ from 5m) — collapsible */}
      <Collapsible id="open5" openState={open5} toggle={() => setOpen5(!open5)}
        color="#d4b063" title="Fair Value — 1H Up (μ from 5m)" subtitle="مدل ۵ دقیقه‌ای" badge={badge5}>
        {m5model ? (
        <>
          <div className="grid md:grid-cols-3 gap-4">
            <div className="bg-[#181a1e]/80 rounded-xl p-4 border border-[rgba(190,190,200,0.13)]">
              <p className="text-[10px] text-[#73757c] mb-1">Model fair value (Up) — 5m calib</p>
              <p className="text-3xl font-bold text-[#d4b063] tabular-nums">{(m5model.fairUp * 100).toFixed(1)}¢</p>
            </div>
            <div className="bg-[#181a1e]/80 rounded-xl p-4 border border-[rgba(190,190,200,0.13)]">
              <p className="text-[10px] text-[#73757c] mb-1">Market price (Up)</p>
              <p className="text-3xl font-bold text-white tabular-nums">{market1h != null ? (market1h * 100).toFixed(1) + "¢" : "—"}</p>
            </div>
            <div className={`bg-[#181a1e]/80 rounded-xl p-4 border ${m5model.edge != null && Math.abs(m5model.edge) > 0.03 ? (m5model.edge > 0 ? "border-[#5fbf9a]/40" : "border-[#e5787f]/40") : "border-[rgba(190,190,200,0.13)]"}`}>
              <p className="text-[10px] text-[#73757c] mb-1">Edge (fair − market)</p>
              <p className={`text-3xl font-bold tabular-nums ${m5model.edge == null ? "text-[#73757c]" : m5model.edge > 0.03 ? "text-[#5fbf9a]" : m5model.edge < -0.03 ? "text-[#e5787f]" : "text-[#bdbdb8]"}`}>
                {m5model.edge == null ? "—" : (m5model.edge > 0 ? "+" : "") + (m5model.edge * 100).toFixed(1) + "¢"}
              </p>
            </div>
          </div>
          <div className="overflow-x-auto mt-4">
            <table className="w-full text-left text-xs whitespace-nowrap">
              <tbody className="divide-y divide-[rgba(190,190,200,0.10)] text-[#bdbdb8] tabular-nums">
                <tr><td className="py-1.5 pr-4">a₅ (5m block start)</td><td className="py-1.5 pr-4">:{String(Math.floor(m5model.a5)).padStart(2, "0")}</td><td className="py-1.5 pr-4">Sₐ₅ (block open)</td><td className="py-1.5">${m5model.sa5?.toLocaleString()}</td></tr>
                <tr><td className="py-1.5 pr-4">q₅ (into block)</td><td className="py-1.5 pr-4">{m5model.q5.toFixed(2)}</td><td className="py-1.5 pr-4">y₅ = ln(Sₜ/Sₐ₅)</td><td>{m5model.y5.toFixed(5)}</td></tr>
                <tr><td className="py-1.5 pr-4">τ₅ remaining</td><td className="py-1.5 pr-4">{m5model.tau5.toFixed(2)} min</td><td className="py-1.5 pr-4">p₅ (live 5m Up)</td><td>{(m5model.p5 * 100).toFixed(1)}¢</td></tr>
                <tr><td className="py-1.5 pr-4">z₅ = Φ⁻¹(p₅)</td><td className="py-1.5 pr-4">{m5model.z5.toFixed(4)}</td><td className="py-1.5 pr-4">μ₅ (implied drift)</td><td className={m5model.mu5 >= 0 ? "text-[#5fbf9a]" : "text-[#e5787f]"}>{m5model.mu5.toFixed(6)}/min</td></tr>
                <tr><td className="py-1.5 pr-4">τ₆₀ remaining</td><td className="py-1.5 pr-4">{m?.tau60?.toFixed(2) ?? "—"} min</td><td className="py-1.5 pr-4">xₜ = ln(Sₜ/S₀)</td><td>{m?.xt?.toFixed(5) ?? "—"}</td></tr>
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-[#73757c] mt-3">
            Same formula as the 15m panel, but μ extracted from the live 5¢ market: μ₅ = (z₅·σₘ·√τ₅ − y₅) / τ₅ · fair = Φ((xₜ + μ₅·τ₅)/(σₘ·√τ₆₀)) (drift only until the 5m window ends)
          </p>
        </>
        ) : <p className="text-xs text-[#73757c]">5m model inactive (market near resolution or missing data).</p>}
      </Collapsible>

      {/* الف — Base (no drift) — collapsible */}
      <Collapsible id="openA" openState={openA} toggle={() => setOpenA(!openA)}
        color="#9fb4ee" title="الف — Base (no drift)" subtitle="فرمول پایه" badge={badgeA}>
        {modelA ? (
        <>
          <div className="grid md:grid-cols-3 gap-4">
            <div className="bg-[#181a1e]/80 rounded-xl p-4 border border-[rgba(190,190,200,0.13)]">
              <p className="text-[10px] text-[#73757c] mb-1">Fair value (Up)</p>
              <p className="text-3xl font-bold text-[#9fb4ee] tabular-nums">{(modelA.fairUp * 100).toFixed(1)}¢</p>
            </div>
            <div className="bg-[#181a1e]/80 rounded-xl p-4 border border-[rgba(190,190,200,0.13)]">
              <p className="text-[10px] text-[#73757c] mb-1">Market price (Up)</p>
              <p className="text-3xl font-bold text-white tabular-nums">{market1h != null ? (market1h * 100).toFixed(1) + "¢" : "—"}</p>
            </div>
            <div className={`bg-[#181a1e]/80 rounded-xl p-4 border ${modelA.edge != null && Math.abs(modelA.edge) > 0.03 ? (modelA.edge > 0 ? "border-[#5fbf9a]/40" : "border-[#e5787f]/40") : "border-[rgba(190,190,200,0.13)]"}`}>
              <p className="text-[10px] text-[#73757c] mb-1">Edge (fair − market)</p>
              <p className={`text-3xl font-bold tabular-nums ${modelA.edge == null ? "text-[#73757c]" : modelA.edge > 0.03 ? "text-[#5fbf9a]" : modelA.edge < -0.03 ? "text-[#e5787f]" : "text-[#bdbdb8]"}`}>
                {modelA.edge == null ? "—" : (modelA.edge > 0 ? "+" : "") + (modelA.edge * 100).toFixed(1) + "¢"}
              </p>
            </div>
          </div>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-xs whitespace-nowrap">
              <tbody className="divide-y divide-[rgba(190,190,200,0.10)] text-[#bdbdb8] tabular-nums">
                <tr><td className="py-1.5 pr-4">xₜ = ln(Sₜ/S₀)</td><td className="py-1.5 pr-4">{modelA.x_t.toFixed(5)}</td><td className="py-1.5 pr-4">τ (hours)</td><td className="py-1.5 pr-4">{modelA.tauHours.toFixed(4)} h</td><td className="py-1.5 pr-4">σ₁ₕ</td><td className="py-1.5">{modelA.sigma1h}</td></tr>
              </tbody>
            </table>
          </div>
        </>
        ) : <p className="text-xs text-[#73757c]">مدل الف نیاز به S₀ و Sₜ زنده دارد.</p>}
      </Collapsible>

      {/* Joint Solve — σ & μ — collapsible */}
      <Collapsible id="openC" openState={openC} toggle={() => setOpenC(!openC)}
        color="#d68aa8" title="Joint Solve — σ & μ" subtitle="حل دستگاه" badge={badgeC}>
        {modelC && modelC.valid ? (
        <>
          <p className="text-[11px] text-[#73757c] mb-4">
            Φ⁻¹(p₅) = (y₅ + μ·τ₅)/(σₘ·√τ₅) · Φ⁻¹(p₁₅) = (y₁₅ + μ·τ₁₅)/(σₘ·√τ₁₅) → solves σₘ and μ simultaneously, then fair = Φ((xₜ + μ·τ₁₅)/(σₘ·√τ₆₀))
          </p>
          <div className="grid md:grid-cols-3 gap-4">
            <div className="bg-[#181a1e]/80 rounded-xl p-4 border border-[rgba(190,190,200,0.13)]">
              <p className="text-[10px] text-[#73757c] mb-1">Fair value (Up)</p>
              <p className="text-3xl font-bold text-[#d68aa8] tabular-nums">{(modelC.fairUp * 100).toFixed(1)}¢</p>
            </div>
            <div className="bg-[#181a1e]/80 rounded-xl p-4 border border-[rgba(190,190,200,0.13)]">
              <p className="text-[10px] text-[#73757c] mb-1">Implied σ₁ₕ (joint)</p>
              <p className="text-3xl font-bold text-white tabular-nums">{modelC.sigma1h.toFixed(4)}</p>
            </div>
            <div className={`bg-[#181a1e]/80 rounded-xl p-4 border ${modelC.edge != null && Math.abs(modelC.edge) > 0.03 ? (modelC.edge > 0 ? "border-[#5fbf9a]/40" : "border-[#e5787f]/40") : "border-[rgba(190,190,200,0.13)]"}`}>
              <p className="text-[10px] text-[#73757c] mb-1">Edge (fair − market)</p>
              <p className={`text-3xl font-bold tabular-nums ${modelC.edge == null ? "text-[#73757c]" : modelC.edge > 0.03 ? "text-[#5fbf9a]" : modelC.edge < -0.03 ? "text-[#e5787f]" : "text-[#bdbdb8]"}`}>
                {modelC.edge == null ? "—" : (modelC.edge > 0 ? "+" : "") + (modelC.edge * 100).toFixed(1) + "¢"}
              </p>
            </div>
          </div>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-xs whitespace-nowrap">
              <tbody className="divide-y divide-[rgba(190,190,200,0.10)] text-[#bdbdb8] tabular-nums">
                <tr><td className="py-1.5 pr-4">τ₅ / τ₁₅</td><td className="py-1.5 pr-4">{modelC.tau5.toFixed(2)} / {modelC.tau15.toFixed(2)} min</td><td className="py-1.5 pr-4">y₅ / y₁₅</td><td className="py-1.5 pr-4">{modelC.y5.toFixed(5)} / {modelC.y15.toFixed(5)}</td></tr>
                <tr><td className="py-1.5 pr-4">p₅ / p₁₅</td><td className="py-1.5 pr-4">{(modelC.p5 * 100).toFixed(1)}¢ / {(modelC.p15 * 100).toFixed(1)}¢</td><td className="py-1.5 pr-4">z₅ / z₁₅</td><td className="py-1.5 pr-4">{modelC.z5.toFixed(4)} / {modelC.z15.toFixed(4)}</td></tr>
                <tr><td className="py-1.5 pr-4">σₘ (solved)</td><td className="py-1.5 pr-4">{modelC.sigmaM.toFixed(6)}</td><td className="py-1.5 pr-4">μ (solved)</td><td className={modelC.mu >= 0 ? "text-[#5fbf9a]" : "text-[#e5787f]"}>{modelC.mu.toFixed(6)}/min</td></tr>
              </tbody>
            </table>
          </div>
        </>
        ) : (
        <p className="text-xs text-[#9a9ca3]">
          Joint solve needs both 5m &amp; 15m markets live (or they disagree → σ ≤ 0). System inputs this minute: τ₅={modelC?.tau5?.toFixed(1) ?? "—"}m τ₁₅={modelC?.tau15?.toFixed(1) ?? "—"}m y₅={modelC?.y5?.toFixed(5) ?? "—"} y₁₅={modelC?.y15?.toFixed(5) ?? "—"} z₅={modelC?.z5?.toFixed(3) ?? "—"} z₁₅={modelC?.z15?.toFixed(3) ?? "—"}
        </p>
        )}
      </Collapsible>

      {/* Snapshot (S₀/SA/ST/P15/P5) — collapsible */}
      <Collapsible id="openSnap" openState={openSnap} toggle={() => setOpenSnap(!openSnap)}
        color="#9a9ca3" title="Snapshot (S₀/SA/ST/P15/P5)" subtitle="کپی سریع" badge={null}>
        <div className="flex items-center justify-end mb-3">
          <button onClick={copySnapshot}
            className={`text-xs font-medium rounded-lg px-3 py-1.5 border transition-colors ${copied ? "bg-[#5fbf9a]/10 text-[#5fbf9a] border-[#5fbf9a]/35" : "text-[#bdbdb8] border-[rgba(190,190,200,0.15)] hover:border-[rgba(190,190,200,0.28)]"}`}>
            {copied ? "✓ Copied" : "Copy all"}
          </button>
        </div>
        <table className="w-full text-left text-sm whitespace-nowrap">
          <tbody className="divide-y divide-[rgba(190,190,200,0.10)] text-[#bdbdb8] tabular-nums">
            <tr><td className="py-2 pr-6 text-[#73757c]">1- Current time</td><td className="py-2">{nowClk}</td></tr>
            <tr><td className="py-2 pr-6 text-[#73757c]">2- S0</td><td className="py-2">${fmt(m?.s0)}</td><td className="py-2 pl-6 text-[10px] text-[#73757c]">hour open ({data?.openSources?.s0 === "polymarket-chainlink" ? "Chainlink" : "Binance"})</td></tr>
            <tr><td className="py-2 pr-6 text-[#73757c]">3- SA</td><td className="py-2">${fmt(m?.sa)}</td><td className="py-2 pl-6 text-[10px] text-[#73757c]">15m block open ({data?.openSources?.sa === "polymarket-chainlink" ? "Chainlink" : "Binance"})</td></tr>
            <tr><td className="py-2 pr-6 text-[#73757c]">4- ST</td><td className="py-2">${fmt(m?.st)}</td><td className="py-2 pl-6 text-[10px] text-[#73757c]">live spot (Binance)</td></tr>
            <tr><td className="py-2 pr-6 text-[#73757c]">5- P15</td><td className="py-2">{m?.p15 != null ? (m.p15 * 100).toFixed(2) + "¢" : "—"}</td><td className="py-2 pl-6 text-[10px] text-[#73757c]">live 15m Up (CLOB mid)</td></tr>
            <tr><td className="py-2 pr-6 text-[#73757c]">6- P5</td><td className="py-2">{m5?.live != null ? (m5.live * 100).toFixed(2) + "¢" : "—"}</td><td className="py-2 pl-6 text-[10px] text-[#73757c]">live 5m Up (CLOB mid)</td></tr>
          </tbody>
        </table>
      </Collapsible>

      {/* Formula Audit — ورودی‌های سه مدل — collapsible */}
      <Collapsible id="openAudit" openState={openAudit} toggle={() => setOpenAudit(!openAudit)}
        color="#9a9ca3" title="Formula Audit — ورودی‌های سه مدل" subtitle="کپی کامل" badge={null}>
        <div className="flex items-center justify-end mb-3">
          <button onClick={copyAudit}
            className={`text-xs font-medium rounded-lg px-3 py-1.5 border transition-colors ${copiedAudit ? "bg-[#5fbf9a]/10 text-[#5fbf9a] border-[#5fbf9a]/35" : "text-[#bdbdb8] border-[rgba(190,190,200,0.15)] hover:border-[rgba(190,190,200,0.28)]"}`}>
            {copiedAudit ? "✓ Copied" : "Copy all"}
          </button>
        </div>
        <div className="space-y-4 text-sm">
          <div>
            <p className="text-xs font-semibold text-[#9fb4ee] tracking-wide mb-1.5">۱. ورودی‌های فرمول پایه‌ی ۱ ساعته (مدل الف)</p>
            <ul className="text-[#bdbdb8] space-y-1 text-[13px] tabular-nums">
              <li>• S₀ (قیمت شروع ساعت) = <b className="text-white">{fmt(m?.s0)}</b> · Sₜ (قیمت لحظه‌ای) = <b className="text-white">{fmt(m?.st)}</b> → xₜ = ln(Sₜ/S₀) = <b className="text-white">{m?.xt != null ? m.xt.toFixed(6) : "—"}</b></li>
              <li>• τ (hours) = <b className="text-white">{modelA ? modelA.tauHours.toFixed(4) : "—"}</b></li>
              <li>• σ₁ₕ = <b className="text-white">{data?.sigma1h != null ? data.sigma1h.toFixed(4) : "—"}</b> ({data?.sigmaSource ?? "—"})</li>
            </ul>
          </div>
          <div>
            <p className="text-xs font-semibold text-[#d4b063] tracking-wide mb-1.5">۲. ورودی‌های حل دستگاه (مدل ب — ۵ و ۱۵ دقیقه‌ای)</p>
            <ul className="text-[#bdbdb8] space-y-1 text-[13px] tabular-nums">
              <li>• τ₅ = <b className="text-white">{m5model ? m5model.tau5.toFixed(2) : "—"}</b> دقیقه · τ₁₅ = <b className="text-white">{m ? m.tau15.toFixed(2) : "—"}</b> دقیقه</li>
              <li>• Sₐ₅ (شروع بلاک ۵m) = <b className="text-white">{fmt(m5model?.sa5 ?? m5model?.sa5)}</b> → y₅ = ln(Sₜ/Sₐ₅) = <b className="text-white">{m5model ? m5model.y5.toFixed(6) : "—"}</b></li>
              <li>• Sₐ₁₅ (شروع بلاک ۱۵m) = <b className="text-white">{fmt(m?.sa)}</b> → y₁₅ = ln(Sₜ/Sₐ₁₅) = <b className="text-white">{m ? m.y.toFixed(6) : "—"}</b></li>
              <li>• p₅ = <b className="text-white">{m5m?.live != null ? (m5m.live * 100).toFixed(2) + "¢" : "—"}</b> · p₁₅ = <b className="text-white">{m?.p15 != null ? (m.p15 * 100).toFixed(2) + "¢" : "—"}</b></li>
            </ul>
          </div>
          <div>
            <p className="text-xs font-semibold text-[#d68aa8] tracking-wide mb-1.5">۳. ورودی‌های ارزش منصفانه‌ی نهایی (با رانش)</p>
            <ul className="text-[#bdbdb8] space-y-1 text-[13px] tabular-nums">
              <li>• xₜ = <b className="text-white">{m?.xt != null ? m.xt.toFixed(6) : "—"}</b></li>
              <li>• τ₆₀ = <b className="text-white">{m ? m.tau60.toFixed(2) + " دقیقه" : "—"}</b></li>
              <li>• σₘ (حل‌شده از دستگاه) = <b className="text-white">{modelC ? modelC.sigmaM.toFixed(6) : "—"}</b> · μ = <b className="text-white">{modelC ? modelC.mu.toFixed(6) : "—"}</b></li>
              <li className="text-[#73757c] text-xs">(اگر مستقیماً همین خروجی را بفرستی، نیازی به محاسبه‌ی مجدد مرحله‌ی ۲ نیست)</li>
            </ul>
          </div>
        </div>
      </Collapsible>

{/* debug slugs */}
      {data && (
        <p className="text-[10px] text-[#73757c] font-mono">
          slugs · 1h: {m1h?.slug || "—"} · 15m: {m15?.slug || "—"} · 5m: {m5?.slug || "—"} · server t={data.t?.toFixed(1)}m
        </p>
      )}
    </div>
  );
}
