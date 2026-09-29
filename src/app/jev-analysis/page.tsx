"use client";

import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import Link from "next/link";
import {
  Sparkles,
  TrendingUp,
  TrendingDown,
  Clock,
  Filter,
  Search,
  Download,
  Eye,
  RefreshCw,
  Check,
  SlidersHorizontal,
  FileJson,
  ArrowRight,
  BarChart3,
  Calendar,
  Layers,
  ChevronDown,
  Save,
  RotateCcw,
  CheckCircle2,
  Settings2,
  Sliders,
  Tag,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Printer,
  Zap,
} from "lucide-react";

export interface SignalMarkerConfig {
  enabled: boolean;
  bullishScore: number;     // e.g. 3.5
  bullishMinConf: number;   // e.g. 90
  bearishScore: number;     // e.g. 0.5
  bearishMinConf: number;   // e.g. 90
  confidenceType: "score" | "direction" | "any";
  bullishColor: string;     // default "#6aa9d8"
  bearishColor: string;     // default "#d8646a"
  modelSource?: "jev" | "kev" | "span" | "solar" | "consensus"; // Default "jev"
}

const DEFAULT_SIGNAL_CONFIG: SignalMarkerConfig = {
  enabled: true,
  bullishScore: 3.5,
  bullishMinConf: 90,
  bearishScore: 0.5,
  bearishMinConf: 90,
  confidenceType: "score",
  bullishColor: "#6aa9d8",
  bearishColor: "#d8646a",
  modelSource: "jev",
};

export interface SignalMatch {
  type: "BULLISH" | "BEARISH";
  direction: "UP" | "DOWN";
  label: string;
  rule: string;
  color: string;
  bgColor: string;
  borderColor: string;
  score: number;
  confidence: number;
  sourceModel?: string;
}

function evaluateSignal(r: JevFileRecord, cfg: SignalMarkerConfig): SignalMatch | null {
  if (!cfg.enabled) return null;

  const modelSrc = cfg.modelSource || "jev";
  let targetScore: number | null | undefined = null;
  let conf: number | null | undefined = null;
  let modelName = "Jev";

  if (modelSrc === "kev") {
    targetScore = r.kev_score;
    if (cfg.confidenceType === "direction") {
      conf = r.kev_direction_confidence ?? r.kev_confidence;
    } else {
      conf = r.kev_score_confidence ?? r.kev_confidence;
    }
    modelName = "Kev-4b";
  } else if (modelSrc === "span") {
    targetScore = r.span_score;
    conf = r.span_confidence;
    modelName = "Span-01";
  } else if (modelSrc === "solar") {
    targetScore = r.solar_score;
    conf = cfg.confidenceType === "direction"
      ? r.solar_direction_confidence ?? r.solar_confidence
      : r.solar_score_confidence ?? r.solar_confidence;
    modelName = "Solar-Decide";
  } else if (modelSrc === "consensus") {
    const scores = [r.score, r.kev_score, r.span_score].filter((s): s is number => s != null);
    targetScore = scores.length > 0 ? Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)) : null;
    conf = r.consensus_agreement ?? r.score_confidence;
    modelName = "اجماع مدل‌ها";
  } else {
    // "jev" (default)
    targetScore = r.score;
    if (cfg.confidenceType === "direction") {
      conf = r.direction_confidence ?? null;
    } else {
      conf = r.score_confidence ?? null;
    }
    modelName = "Jev";
  }

  if (targetScore == null || conf == null || isNaN(conf)) return null;

  // Bullish: Target Score > 3.5 AND at the same time Confidence >= 90%
  if (targetScore > cfg.bullishScore && conf >= cfg.bullishMinConf) {
    return {
      type: "BULLISH",
      direction: "UP",
      label: `سیگنال صعود (${modelName} - تیک آبی)`,
      rule: `اسکور ${modelName} > ${cfg.bullishScore} و اطمینان ≥ ${cfg.bullishMinConf}%`,
      color: cfg.bullishColor || "#6aa9d8",
      bgColor: "rgba(106,169,216, 0.15)",
      borderColor: cfg.bullishColor || "#6aa9d8",
      score: targetScore,
      confidence: conf,
      sourceModel: modelName,
    };
  }

  // Bearish: Target Score < 0.5 AND at the same time Confidence >= 90%
  if (targetScore < cfg.bearishScore && conf >= cfg.bearishMinConf) {
    return {
      type: "BEARISH",
      direction: "DOWN",
      label: `سیگنال نزول (${modelName} - تیک قرمز)`,
      rule: `اسکور ${modelName} < ${cfg.bearishScore} و اطمینان ≥ ${cfg.bearishMinConf}%`,
      color: cfg.bearishColor || "#d8646a",
      bgColor: "rgba(216,100,106, 0.15)",
      borderColor: cfg.bearishColor || "#d8646a",
      score: targetScore,
      confidence: conf,
      sourceModel: modelName,
    };
  }

  return null;
}

interface JevFileRecord {
  filename: string;
  coin?: string;
  coin_label?: string | null;
  et_time: string;
  current_time_et?: string;
  timestamp?: string;
  score?: number | null;
  score_label?: string | null;
  direction?: "UP" | "DOWN" | null;
  score_confidence?: number | null;
  direction_confidence?: number | null;
  confidence?: number | null;
  prob_up?: number | null;
  prob_down?: number | null;
  up_1h?: string | null;
  down_1h?: string | null;
  up_1h_num?: number | null;
  up_15m?: string | null;
  up_15m_num?: number | null;
  up_5m?: string | null;
  up_5m_num?: number | null;
  fair_15m?: number | null;
  fair_5m?: number | null;
  fair_base?: number | null;
  fair_joint?: number | null;
  tokens?: number | null;
  cost?: number | null;

  // Kev-4b (jaredpalmer/kev-4b)
  kev_direction?: "UP" | "DOWN" | null;
  kev_score?: number | null;
  kev_score_label?: string | null;
  kev_confidence?: number | null;
  kev_score_confidence?: number | null;
  kev_direction_confidence?: number | null;
  kev_prob_up?: number | null;

  // Span-01 (respan/span-01)
  span_direction?: "UP" | "DOWN" | null;
  span_score?: number | null;
  span_score_label?: string | null;
  span_confidence?: number | null;
  // Upstage Solar-Decide (extra filter, not part of the 3-model consensus)
  solar_direction?: "UP" | "DOWN" | null;
  solar_score?: number | null;
  solar_score_label?: string | null;
  solar_confidence?: number | null;
  solar_score_confidence?: number | null;
  solar_direction_confidence?: number | null;
  solar_prob_up?: number | null;
  span_prob_up?: number | null;
  span_prob_down?: number | null;

  // Consensus (3 Models)
  consensus_direction?: "UP" | "DOWN" | "SPLIT" | null;
  consensus_summary?: string | null;
  consensus_agreement?: number | null;

  // Market Resolution & Outcome
  market_slug?: string | null;
  market_outcome?: "UP" | "DOWN" | "PENDING" | null;

  // Hourly signal deduplication metadata
  is_first_hourly_signal?: boolean;
}

function evaluateSignalOutcome(r: JevFileRecord, cfg: SignalMarkerConfig): {
  hasSignal: boolean;
  signalDirection?: "UP" | "DOWN";
  marketOutcome?: "UP" | "DOWN" | "PENDING" | null;
  status: "WIN" | "LOSS" | "PENDING" | "NO_SIGNAL";
  bgClass: string;
  borderClass: string;
} {
  const sig = evaluateSignal(r, cfg);
  const outcome = r.market_outcome;

  if (!sig) {
    return {
      hasSignal: false,
      marketOutcome: outcome,
      status: "NO_SIGNAL",
      bgClass: "",
      borderClass: "",
    };
  }

  const sigDir = sig.direction;

  if (!outcome || outcome === "PENDING") {
    return {
      hasSignal: true,
      signalDirection: sigDir,
      marketOutcome: outcome || "PENDING",
      status: "PENDING",
      bgClass: "bg-amber-500/[0.08] hover:bg-amber-500/[0.15]",
      borderClass: "border-l-4 border-l-amber-500",
    };
  }

  if (sigDir === outcome) {
    return {
      hasSignal: true,
      signalDirection: sigDir,
      marketOutcome: outcome,
      status: "WIN",
      bgClass: "bg-emerald-500/[0.14] hover:bg-emerald-500/[0.22]",
      borderClass: "border-l-4 border-l-emerald-500",
    };
  } else {
    return {
      hasSignal: true,
      signalDirection: sigDir,
      marketOutcome: outcome,
      status: "LOSS",
      bgClass: "bg-rose-500/[0.14] hover:bg-rose-500/[0.22]",
      borderClass: "border-l-4 border-l-rose-500",
    };
  }
}

interface ColumnDef {
  id: string;
  label: string;
  shortLabel: string;
  category: "jev" | "market" | "fair" | "models";
  render: (row: JevFileRecord, signalConfig?: SignalMarkerConfig) => React.ReactNode;
  exportVal: (row: JevFileRecord, signalConfig?: SignalMarkerConfig) => string | number;
  sortVal?: (row: JevFileRecord, signalConfig?: SignalMarkerConfig) => string | number | null | undefined;
}

const ALL_COLUMNS: ColumnDef[] = [
  {
    id: "coin",
    label: "ارز (Coin)",
    shortLabel: "ارز",
    category: "jev",
    render: (r) => (
      <span className="font-bold text-xs px-2.5 py-0.5 rounded-full bg-white/[0.08] border border-white/[0.15] text-[#6aa9d8]">
        {r.coin || "BTC"}
      </span>
    ),
    exportVal: (r) => r.coin || "BTC",
    sortVal: (r) => r.coin || "BTC",
  },
  {
    id: "consensus",
    label: "اجماع ۳ مدل (Consensus: Jev + Kev + Span)",
    shortLabel: "اجماع مدل‌ها",
    category: "models",
    render: (r) => {
      const dirs = [r.direction, r.kev_direction, r.span_direction].filter(Boolean) as ("UP" | "DOWN")[];
      if (dirs.length === 0) return <span className="text-[#73757c]">—</span>;
      const ups = dirs.filter((d) => d === "UP").length;
      const downs = dirs.filter((d) => d === "DOWN").length;

      if (ups === dirs.length) {
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-[#5fbf9a]/20 text-[#5fbf9a] border border-[#5fbf9a]/40">
            <span className="w-1.5 h-1.5 rounded-full bg-[#5fbf9a]" />
            {ups}/3 صعود کامل (UP)
          </span>
        );
      }
      if (downs === dirs.length) {
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-[#e5787f]/20 text-[#e5787f] border border-[#e5787f]/40">
            <span className="w-1.5 h-1.5 rounded-full bg-[#e5787f]" />
            {downs}/3 نزول کامل (DOWN)
          </span>
        );
      }
      if (ups > downs) {
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-[#5fbf9a]/10 text-[#8fd0a8] border border-[#5fbf9a]/20">
            {ups}/3 تمایل صعود
          </span>
        );
      }
      if (downs > ups) {
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-[#e5787f]/10 text-[#eba0a5] border border-[#e5787f]/20">
            {downs}/3 تمایل نزول
          </span>
        );
      }
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs text-[#9a9ca3] bg-white/[0.05] border border-white/[0.1]">
          اختلاف نظر (Split)
        </span>
      );
    },
    exportVal: (r) => {
      const dirs = [r.direction, r.kev_direction, r.span_direction].filter(Boolean);
      const ups = dirs.filter((d) => d === "UP").length;
      return `${ups}/${dirs.length} UP`;
    },
    sortVal: (r) => {
      const dirs = [r.direction, r.kev_direction, r.span_direction].filter(Boolean);
      const ups = dirs.filter((d) => d === "UP").length;
      const downs = dirs.filter((d) => d === "DOWN").length;
      if (ups === dirs.length && dirs.length > 0) return 6;
      if (ups > downs) return 5;
      if (downs === dirs.length && dirs.length > 0) return 2;
      if (downs > ups) return 3;
      return 4;
    },
  },
  {
    id: "signal",
    label: "تیک سیگنال شرطی (Signal Marker)",
    shortLabel: "سیگنال شرطی",
    category: "jev",
    render: (r, cfg) => {
      const sig = evaluateSignal(r, cfg || DEFAULT_SIGNAL_CONFIG);
      if (!sig) return <span className="text-[#73757c]">—</span>;
      return (
        <div className="flex flex-col gap-0.5 items-start">
          <span
            className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-bold border shadow-sm"
            style={{
              color: sig.color,
              borderColor: `${sig.borderColor}60`,
              backgroundColor: sig.bgColor,
            }}
          >
            <span className="font-bold">✓</span>
            {sig.type === "BULLISH" ? "سیگنال صعود (آبی)" : "سیگنال نزول (قرمز)"}
          </span>
          {r.is_first_hourly_signal ? (
            <span className="text-[10px] text-amber-300 font-semibold flex items-center gap-0.5 pr-1" title="اولین سیگنال صادر شده در این ساعت (کندل ۱ ساعته)">
              <Zap className="w-2.5 h-2.5 text-amber-400" />
              اولین سیگنال ساعت
            </span>
          ) : (
            <span className="text-[10px] text-[#73757c] pr-1" title="سیگنال تکراری با جهت یکسان در این ساعت">
              تکرار در ساعت
            </span>
          )}
        </div>
      );
    },
    exportVal: (r, cfg) => {
      const sig = evaluateSignal(r, cfg || DEFAULT_SIGNAL_CONFIG);
      if (!sig) return "";
      return `${sig.label} ${r.is_first_hourly_signal ? "(اولین سیگنال ساعت)" : "(تکرار در ساعت)"}`;
    },
    sortVal: (r, cfg) => {
      const sig = evaluateSignal(r, cfg || DEFAULT_SIGNAL_CONFIG);
      if (!sig) return 0;
      return r.is_first_hourly_signal ? (sig.type === "BULLISH" ? 4 : 3) : (sig.type === "BULLISH" ? 2 : 1);
    },
  },
  {
    id: "signal_result",
    label: "نتیجه سیگنال (برد / باخت)",
    shortLabel: "برد / باخت",
    category: "models",
    render: (r, cfg) => {
      const res = evaluateSignalOutcome(r, cfg || DEFAULT_SIGNAL_CONFIG);
      if (!res.hasSignal) return <span className="text-[#73757c]">—</span>;
      if (res.status === "WIN") {
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 shadow-sm">
            <span className="text-emerald-300 font-bold">✓</span>
            برد (WIN)
          </span>
        );
      }
      if (res.status === "LOSS") {
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-bold bg-rose-500/20 text-rose-400 border border-rose-500/40 shadow-sm">
            <span className="text-rose-300 font-bold">✗</span>
            باخت (LOSS)
          </span>
        );
      }
      return (
        <span
          className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-500/15 text-amber-300 border border-amber-500/30"
          title="سیگنال فعال است و در انتظار اتمام کندل یا تایید نهایی اوراکل UMA (بازه ۱۰-۳۰ دقیقه) می‌باشد"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
          ⏳ در انتظار نتیجه
        </span>
      );
    },
    exportVal: (r, cfg) => {
      const res = evaluateSignalOutcome(r, cfg || DEFAULT_SIGNAL_CONFIG);
      return res.hasSignal ? (res.status === "WIN" ? "برد" : res.status === "LOSS" ? "باخت" : "در انتظار") : "";
    },
    sortVal: (r, cfg) => {
      const res = evaluateSignalOutcome(r, cfg || DEFAULT_SIGNAL_CONFIG);
      if (!res.hasSignal) return 0;
      if (res.status === "WIN") return 3;
      if (res.status === "PENDING") return 2;
      return 1;
    },
  },
  {
    id: "market_outcome",
    label: "نتیجه نهایی مارکت ۱ ساعته (Polymarket Outcome)",
    shortLabel: "نتیجه مارکت",
    category: "market",
    render: (r) => {
      if (r.market_outcome === "UP") {
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
            🟢 صعود (UP)
          </span>
        );
      }
      if (r.market_outcome === "DOWN") {
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-rose-500/20 text-rose-400 border border-rose-500/30">
            🔴 نزول (DOWN)
          </span>
        );
      }
      if (r.market_outcome === "PENDING") {
        return (
          <span
            className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium text-amber-300 bg-amber-500/15 border border-amber-500/30"
            title="کندل پایان یافته و طبق روند اوراکل Polymarket UMA تایید نهایی آن بین ۱۰ الی ۳۰ دقیقه زمان می‌برد"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
            ⏳ در انتظار تایید (۱۰-۳۰ دقیقه)
          </span>
        );
      }
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] text-sky-400/80 bg-sky-500/10 border border-sky-500/20">
          ⚡ در حال معامله (جاری)
        </span>
      );
    },
    exportVal: (r) => r.market_outcome || "",
    sortVal: (r) => (r.market_outcome === "UP" ? 3 : r.market_outcome === "PENDING" ? 2 : r.market_outcome === "DOWN" ? 1 : 0),
  },
  {
    id: "direction",
    label: "جهت Jev (Direction)",
    shortLabel: "جهت Jev",
    category: "jev",
    render: (r) =>
      r.direction ? (
        <span
          className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold ${
            r.direction === "UP"
              ? "bg-[#5fbf9a]/20 text-[#5fbf9a] border border-[#5fbf9a]/30"
              : "bg-[#e5787f]/20 text-[#e5787f] border border-[#e5787f]/30"
          }`}
        >
          {r.direction === "UP" ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
          {r.direction}
        </span>
      ) : (
        <span className="text-[#73757c]">—</span>
      ),
    exportVal: (r) => r.direction || "",
  },
  {
    id: "score",
    label: "اسکور Jev (0 - 4)",
    shortLabel: "اسکور Jev",
    category: "jev",
    render: (r) =>
      r.score != null ? (
        <div className="flex items-center gap-2">
          <span
            className="font-mono text-sm font-bold tabular-nums"
            style={{
              color:
                r.score >= 3.0
                  ? "#5fbf9a"
                  : r.score >= 2.2
                  ? "#8fd0a8"
                  : r.score >= 1.8
                  ? "#9a9ca3"
                  : r.score >= 1.0
                  ? "#eba0a5"
                  : "#e5787f",
            }}
          >
            {r.score.toFixed(2)}
          </span>
          <span className="text-[10px] text-[#9a9ca3] hidden sm:inline">
            {r.score >= 3 ? "صعودی قوی" : r.score <= 1 ? "نزولی قوی" : "خنثی"}
          </span>
        </div>
      ) : (
        <span className="text-[#73757c]">—</span>
      ),
    exportVal: (r) => r.score ?? "",
  },
  {
    id: "kev_direction",
    label: "جهت Kev-4b (Direction)",
    shortLabel: "جهت Kev",
    category: "models",
    render: (r) =>
      r.kev_direction ? (
        <div className="flex items-center gap-1.5">
          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold ${
              r.kev_direction === "UP"
                ? "bg-[#6aa9d8]/20 text-[#6aa9d8] border border-[#6aa9d8]/30"
                : "bg-[#d8646a]/20 text-[#d8646a] border border-[#d8646a]/30"
            }`}
          >
            {r.kev_direction === "UP" ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
            {r.kev_direction}
          </span>
          {r.kev_score != null && (
            <span className="font-mono text-[11px] text-[#9a9ca3]">({r.kev_score.toFixed(2)})</span>
          )}
        </div>
      ) : (
        <span className="text-[#73757c]">—</span>
      ),
    exportVal: (r) => r.kev_direction || "",
  },
  {
    id: "kev_score",
    label: "اسکور Kev-4b (0 - 4)",
    shortLabel: "اسکور Kev",
    category: "models",
    render: (r) =>
      r.kev_score != null ? (
        <div className="flex items-center gap-1.5">
          <span
            className="font-mono text-xs font-bold tabular-nums"
            style={{
              color:
                r.kev_score >= 3.0
                  ? "#5fbf9a"
                  : r.kev_score >= 2.2
                  ? "#8fd0a8"
                  : r.kev_score >= 1.8
                  ? "#9a9ca3"
                  : r.kev_score >= 1.0
                  ? "#eba0a5"
                  : "#e5787f",
            }}
          >
            {r.kev_score.toFixed(2)}
          </span>
          {r.kev_confidence != null && (
            <span className="text-[10px] text-[#cfad4e]">({r.kev_confidence}%)</span>
          )}
        </div>
      ) : (
        <span className="text-[#73757c]">—</span>
      ),
    exportVal: (r) => r.kev_score ?? "",
  },
  {
    id: "kev_score_confidence",
    label: "درصد اطمینان اسکور Kev-4b (Score Confidence %)",
    shortLabel: "اطمینان اسکور Kev",
    category: "models",
    render: (r) =>
      r.kev_score_confidence != null ? (
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-xs text-[#cfad4e] font-bold tabular-nums">
            {r.kev_score_confidence}%
          </span>
          <div className="w-12 h-1.5 bg-white/[0.08] rounded-full overflow-hidden hidden sm:block">
            <div
              className="h-full bg-[#cfad4e] rounded-full"
              style={{ width: `${Math.min(100, Math.max(0, r.kev_score_confidence))}%` }}
            />
          </div>
        </div>
      ) : (
        <span className="text-[#73757c]">—</span>
      ),
    exportVal: (r) => (r.kev_score_confidence != null ? `${r.kev_score_confidence}%` : ""),
  },
  {
    id: "kev_direction_confidence",
    label: "درصد اطمینان سیگنال Kev-4b (Direction Confidence %)",
    shortLabel: "اطمینان سیگنال Kev",
    category: "models",
    render: (r) =>
      r.kev_direction_confidence != null ? (
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-xs text-[#6aa9d8] font-bold tabular-nums">
            {r.kev_direction_confidence}%
          </span>
          <div className="w-12 h-1.5 bg-white/[0.08] rounded-full overflow-hidden hidden sm:block">
            <div
              className="h-full bg-[#5a94bd] rounded-full"
              style={{ width: `${Math.min(100, Math.max(0, r.kev_direction_confidence))}%` }}
            />
          </div>
        </div>
      ) : (
        <span className="text-[#73757c]">—</span>
      ),
    exportVal: (r) => (r.kev_direction_confidence != null ? `${r.kev_direction_confidence}%` : ""),
  },
  {
    id: "kev_confidence",
    label: "اطمینان کلی Kev-4b (%)",
    shortLabel: "اطمینان Kev",
    category: "models",
    render: (r) =>
      r.kev_confidence != null ? (
        <span className="font-mono text-xs text-[#cfad4e] font-semibold tabular-nums">
          {r.kev_confidence}%
        </span>
      ) : (
        <span className="text-[#73757c]">—</span>
      ),
    exportVal: (r) => (r.kev_confidence != null ? `${r.kev_confidence}%` : ""),
  },
  {
    id: "kev_prob_up",
    label: "احتمال صعود Kev-4b (%UP)",
    shortLabel: "Kev %UP",
    category: "models",
    render: (r) =>
      r.kev_prob_up != null ? (
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-xs text-[#6aa9d8] font-semibold tabular-nums">
            {r.kev_prob_up}%
          </span>
          <div className="w-10 h-1.5 bg-white/[0.08] rounded-full overflow-hidden hidden sm:block">
            <div
              className="h-full bg-[#5a94bd] rounded-full"
              style={{ width: `${Math.min(100, Math.max(0, r.kev_prob_up))}%` }}
            />
          </div>
        </div>
      ) : (
        <span className="text-[#73757c]">—</span>
      ),
    exportVal: (r) => (r.kev_prob_up != null ? `${r.kev_prob_up}%` : ""),
  },
  {
    id: "span_direction",
    label: "سیگنال Span-01",
    shortLabel: "سیگنال Span",
    category: "models",
    render: (r) =>
      r.span_direction ? (
        <span
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold ${
            r.span_direction === "UP"
              ? "bg-[#a795d6]/20 text-[#a795d6] border border-[#a795d6]/30"
              : "bg-[#e5787f]/20 text-[#e5787f] border border-[#e5787f]/30"
          }`}
        >
          {r.span_direction === "UP" ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
          {r.span_direction}
        </span>
      ) : (
        <span className="text-[#73757c]">—</span>
      ),
    exportVal: (r) => r.span_direction || "",
  },
  {
    id: "span_score",
    label: "اسکور Span-01 (0 - 4)",
    shortLabel: "اسکور Span",
    category: "models",
    render: (r) =>
      r.span_score != null ? (
        <div className="flex items-center gap-1.5">
          <span
            className="font-mono text-xs font-bold tabular-nums"
            style={{
              color:
                r.span_score >= 3.0
                  ? "#5fbf9a"
                  : r.span_score >= 2.2
                  ? "#8fd0a8"
                  : r.span_score >= 1.8
                  ? "#9a9ca3"
                  : r.span_score >= 1.0
                  ? "#eba0a5"
                  : "#e5787f",
            }}
          >
            {r.span_score.toFixed(2)}
          </span>
          {r.span_confidence != null && (
            <span className="text-[10px] text-[#cfad4e]">({r.span_confidence}%)</span>
          )}
          <span className="text-[10px] text-[#73757c] hidden sm:inline">
            {r.span_score >= 3.0
              ? "Strong Up"
              : r.span_score >= 2.2
              ? "Lean Up"
              : r.span_score >= 1.8
              ? "Neutral"
              : r.span_score >= 1.0
              ? "Lean Down"
              : "Strong Down"}
          </span>
        </div>
      ) : (
        <span className="text-[#73757c]">—</span>
      ),
    exportVal: (r) => r.span_score ?? "",
  },
  {
    id: "solar_direction",
    label: "سیگنال Solar-Decide (فیلتر اضافه)",
    shortLabel: "سیگنال Solar",
    category: "models",
    render: (r) =>
      r.solar_direction ? (
        <span
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold ${
            r.solar_direction === "UP"
              ? "bg-[#d6a24e]/20 text-[#d6a24e] border border-[#d6a24e]/30"
              : "bg-[#e5787f]/20 text-[#e5787f] border border-[#e5787f]/30"
          }`}
        >
          {r.solar_direction === "UP" ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
          {r.solar_direction}
        </span>
      ) : (
        <span className="text-[#73757c]">—</span>
      ),
    exportVal: (r) => r.solar_direction || "",
  },
  {
    id: "solar_score",
    label: "اسکور Solar-Decide (0 - 4)",
    shortLabel: "اسکور Solar",
    category: "models",
    render: (r) =>
      r.solar_score != null ? (
        <span className="inline-flex items-center gap-1 font-mono text-xs font-semibold tabular-nums text-white">
          {r.solar_score.toFixed(2)}
          {r.solar_confidence != null && <span className="text-[10px] text-[#cfad4e]">({r.solar_confidence}%)</span>}
        </span>
      ) : (
        <span className="text-[#73757c]">—</span>
      ),
    exportVal: (r) => r.solar_score ?? "",
  },
  {
    id: "span_confidence",
    label: "اطمینان اسکور Span-01",
    shortLabel: "اطمینان Span",
    category: "models",
    render: (r) =>
      r.span_confidence != null ? (
        <span className="font-mono text-xs text-[#cfad4e] font-semibold tabular-nums">
          {r.span_confidence}%
        </span>
      ) : (
        <span className="text-[#73757c]">—</span>
      ),
    exportVal: (r) => (r.span_confidence != null ? `${r.span_confidence}%` : ""),
  },
  {
    id: "span_prob_up",
    label: "احتمال صعود Span-01 (%UP)",
    shortLabel: "Span-01 %UP",
    category: "models",
    render: (r) =>
      r.span_prob_up != null ? (
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-xs text-[#a795d6] font-semibold tabular-nums">
            {r.span_prob_up}%
          </span>
          <div className="w-10 h-1.5 bg-white/[0.08] rounded-full overflow-hidden hidden sm:block">
            <div
              className="h-full bg-[#a795d6] rounded-full"
              style={{ width: `${Math.min(100, Math.max(0, r.span_prob_up))}%` }}
            />
          </div>
        </div>
      ) : (
        <span className="text-[#73757c]">—</span>
      ),
    exportVal: (r) => (r.span_prob_up != null ? `${r.span_prob_up}%` : ""),
  },
  {
    id: "prob_up",
    label: "احتمال صعود Jev (%UP)",
    shortLabel: "احتمال UP",
    category: "jev",
    render: (r) =>
      r.prob_up != null ? (
        <span className="font-mono text-xs text-[#5fbf9a] font-semibold tabular-nums">
          {r.prob_up}%
        </span>
      ) : (
        <span className="text-[#73757c]">—</span>
      ),
    exportVal: (r) => (r.prob_up != null ? `${r.prob_up}%` : ""),
  },
  {
    id: "score_confidence",
    label: "درصد اطمینان اسکور Jev (Score Confidence %)",
    shortLabel: "اطمینان اسکور",
    category: "jev",
    render: (r) =>
      r.score_confidence != null ? (
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-xs text-[#cfad4e] font-bold tabular-nums">
            {r.score_confidence}%
          </span>
          <div className="w-12 h-1.5 bg-white/[0.08] rounded-full overflow-hidden hidden sm:block">
            <div
              className="h-full bg-[#cfad4e] rounded-full"
              style={{ width: `${Math.min(100, Math.max(0, r.score_confidence))}%` }}
            />
          </div>
        </div>
      ) : (
        <span className="text-[#73757c]">—</span>
      ),
    exportVal: (r) => (r.score_confidence != null ? `${r.score_confidence}%` : ""),
  },
  {
    id: "direction_confidence",
    label: "درصد اطمینان جهت Jev (Direction Confidence %)",
    shortLabel: "اطمینان جهت",
    category: "jev",
    render: (r) =>
      r.direction_confidence != null ? (
        <span className="font-mono text-xs text-[#9fb4ee] font-semibold tabular-nums">
          {r.direction_confidence}%
        </span>
      ) : (
        <span className="text-[#73757c]">—</span>
      ),
    exportVal: (r) => (r.direction_confidence != null ? `${r.direction_confidence}%` : ""),
  },
  {
    id: "confidence",
    label: "درصد اطمینان کلی Jev",
    shortLabel: "اطمینان کلی",
    category: "jev",
    render: (r) =>
      r.confidence != null ? (
        <span className="font-mono text-xs text-[#bdbdb8] tabular-nums">
          {r.confidence}%
        </span>
      ) : (
        <span className="text-[#73757c]">—</span>
      ),
    exportVal: (r) => (r.confidence != null ? `${r.confidence}%` : ""),
  },
  {
    id: "up_1h",
    label: "پلی‌مارکت ۱ ساعته (1H Up)",
    shortLabel: "1H Up %",
    category: "market",
    render: (r) =>
      r.up_1h ? (
        <div className="flex items-center gap-1.5 font-mono text-xs">
          <span className="text-[#6aa9d8] font-semibold">{r.up_1h}</span>
          <span className="text-[#73757c] text-[10px]">({r.down_1h || "—"})</span>
        </div>
      ) : (
        <span className="text-[#73757c]">—</span>
      ),
    exportVal: (r) => r.up_1h || "",
  },
  {
    id: "up_15m",
    label: "پلی‌مارکت ۱۵ دقیقه‌ای (15M Up)",
    shortLabel: "15M Up %",
    category: "market",
    render: (r) =>
      r.up_15m ? (
        <span className="font-mono text-xs text-[#9fb4ee] tabular-nums font-medium">
          {r.up_15m}
        </span>
      ) : (
        <span className="text-[#73757c]">—</span>
      ),
    exportVal: (r) => r.up_15m || "",
  },
  {
    id: "up_5m",
    label: "پلی‌مارکت ۵ دقیقه‌ای (5M Up)",
    shortLabel: "5M Up %",
    category: "market",
    render: (r) =>
      r.up_5m ? (
        <span className="font-mono text-xs text-[#d68aa8] tabular-nums font-medium">
          {r.up_5m}
        </span>
      ) : (
        <span className="text-[#73757c]">—</span>
      ),
    exportVal: (r) => r.up_5m || "",
  },
  {
    id: "fair_15m",
    label: "Fair Value (مدل 15m)",
    shortLabel: "Fair 15m",
    category: "fair",
    render: (r) =>
      r.fair_15m != null ? (
        <span className="font-mono text-xs text-[#6aa9d8] tabular-nums">
          {r.fair_15m.toFixed(1)}¢
        </span>
      ) : (
        <span className="text-[#73757c]">—</span>
      ),
    exportVal: (r) => (r.fair_15m != null ? `${r.fair_15m}c` : ""),
  },
  {
    id: "fair_5m",
    label: "Fair Value (مدل 5m)",
    shortLabel: "Fair 5m",
    category: "fair",
    render: (r) =>
      r.fair_5m != null ? (
        <span className="font-mono text-xs text-[#9fb4ee] tabular-nums">
          {r.fair_5m.toFixed(1)}¢
        </span>
      ) : (
        <span className="text-[#73757c]">—</span>
      ),
    exportVal: (r) => (r.fair_5m != null ? `${r.fair_5m}c` : ""),
  },
  {
    id: "fair_joint",
    label: "Fair Value (مدل Joint Solve)",
    shortLabel: "Fair Joint",
    category: "fair",
    render: (r) =>
      r.fair_joint != null ? (
        <span className="font-mono text-xs text-[#a795d6] tabular-nums">
          {r.fair_joint.toFixed(1)}¢
        </span>
      ) : (
        <span className="text-[#73757c]">—</span>
      ),
    exportVal: (r) => (r.fair_joint != null ? `${r.fair_joint}c` : ""),
  },
  {
    id: "fair_base",
    label: "Fair Value (مدل Base No Drift)",
    shortLabel: "Fair Base",
    category: "fair",
    render: (r) =>
      r.fair_base != null ? (
        <span className="font-mono text-xs text-[#bdbdb8] tabular-nums">
          {r.fair_base.toFixed(1)}¢
        </span>
      ) : (
        <span className="text-[#73757c]">—</span>
      ),
    exportVal: (r) => (r.fair_base != null ? `${r.fair_base}c` : ""),
  },
  {
    id: "tokens",
    label: "توکن و هزینه Jev",
    shortLabel: "هزینه استعلام",
    category: "jev",
    render: (r) =>
      r.tokens ? (
        <span className="font-mono text-[11px] text-[#73757c] tabular-nums">
          {r.tokens} tok (${r.cost ?? 0})
        </span>
      ) : (
        <span className="text-[#73757c]">—</span>
      ),
    exportVal: (r) => (r.tokens ? `${r.tokens} tokens ($${r.cost})` : ""),
  },
];

const PRESETS = [
  {
    id: "multi_models",
    title: "🤖 ۳ مدل هوش مصنوعی (Jev + Kev + Span)",
    cols: ["coin", "consensus", "signal", "signal_result", "direction", "score", "kev_direction", "kev_score", "span_direction", "span_score", "solar_direction", "solar_score", "up_1h", "market_outcome"],
  },
  {
    id: "top3",
    title: "🌟 شاخص‌های اصلی + ۳ مدل",
    cols: ["coin", "consensus", "signal", "signal_result", "direction", "score", "kev_direction", "kev_score", "span_direction", "span_score", "solar_direction", "solar_score", "up_1h", "market_outcome"],
  },
  {
    id: "ai",
    title: "🧠 مقایسه تفصیلی اسکور و اطمینان ۳ مدل",
    cols: ["coin", "direction", "score", "score_confidence", "kev_direction", "kev_score", "kev_score_confidence", "kev_direction_confidence", "span_direction", "span_score", "solar_direction", "solar_score", "span_confidence"],
  },
  {
    id: "markets",
    title: "📈 مقایسه ۳ تایم‌فریم بازار (1h / 15m / 5m)",
    cols: ["coin", "direction", "up_1h", "up_15m", "up_5m", "market_outcome"],
  },
  {
    id: "fair_values",
    title: "🧮 مقایسه مدل‌های Fair Value",
    cols: ["coin", "direction", "fair_15m", "fair_5m", "fair_joint"],
  },
  {
    id: "signals",
    title: "🎯 تمرکز روی سیگنال‌ها و نتایج (برد / باخت)",
    cols: ["coin", "signal", "signal_result", "market_outcome", "direction", "score", "score_confidence", "up_1h"],
  },
  {
    id: "full",
    title: "🔍 نمایش جامع (تمام شاخص‌های ۳ مدل + بازار)",
    cols: ["coin", "consensus", "signal", "signal_result", "market_outcome", "direction", "score", "score_confidence", "kev_direction", "kev_score", "kev_score_confidence", "kev_direction_confidence", "span_direction", "span_score", "solar_direction", "solar_score", "span_confidence", "span_prob_up", "up_1h", "fair_15m"],
  },
];

// Helper: generate smooth cubic bezier SVG path
function generateSmoothCurve(points: { x: number; y: number }[]) {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  if (points.length === 2) return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;

  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i === 0 ? i : i - 1];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2 < points.length ? i + 2 : i + 1];

    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;

    d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}

const AVAILABLE_COINS = [
  { key: "all", label: "همه ارزها (All)" },
  { key: "btc", label: "بیت‌کوین (BTC)", color: "#d49a4a" },
  { key: "eth", label: "اتریوم (ETH)", color: "#627EEA" },
  { key: "sol", label: "سولانا (SOL)", color: "#14F195" },
  { key: "xrp", label: "ریپل (XRP)", color: "#7FA8C9" },
  { key: "doge", label: "دوج‌کوین (DOGE)", color: "#C2A633" },
  { key: "hype", label: "هایپرلیکوئید (HYPE)", color: "#97FCE4" },
  { key: "bnb", label: "بی‌ان‌بی (BNB)", color: "#F3BA2F" },
];

export default function JevAnalysisPage() {
  const [data, setData] = useState<JevFileRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Selected coin filter (default to btc for instant loading instead of pulling all coins at once)
  const [selectedCoin, setSelectedCoin] = useState<string>("btc");
  const [visibleRowsCount, setVisibleRowsCount] = useState<number>(100);

  // Selected columns (default: coin, consensus, Jev, Kev, Span, and 1H market)
  const [selectedColIds, setSelectedColIds] = useState<string[]>([
    "coin",
    "consensus",
    "direction",
    "score",
    "kev_direction",
    "kev_score",
    "span_direction",
    "span_score",
    "solar_direction",
    "solar_score",
    "up_1h",
  ]);

  // Chart Curve Series toggles
  const [visibleCurves, setVisibleCurves] = useState<{
    score: boolean;
    scoreConfidence: boolean;
    up1h: boolean;
    up15m: boolean;
    fair15m: boolean;
    up5m: boolean;
    signals: boolean;
    kevScore: boolean;
    spanScore: boolean;
  }>({
    score: true,
    scoreConfidence: false,
    up1h: true,
    up15m: false,
    fair15m: true,
    up5m: false,
    signals: true,
    kevScore: false,
    spanScore: false,
  });

  // Signal Markers Configuration (تیک‌های شرطی آبی و قرمز روی منحنی)
  const [signals, setSignals] = useState<SignalMarkerConfig>(DEFAULT_SIGNAL_CONFIG);
  const [showSignalSettings, setShowSignalSettings] = useState(false);

  // Time Interval Filters
  const [dateFilter, setDateFilter] = useState<string>("ALL");
  const [startHour, setStartHour] = useState<number | null>(null);
  const [endHour, setEndHour] = useState<number | null>(null);
  const [activeIntervalPreset, setActiveIntervalPreset] = useState<string>("ALL");

  // General Filters & Search
  const [dirFilter, setDirFilter] = useState<
    | "ALL"
    | "UP"
    | "DOWN"
    | "SIGNALS"
    | "FIRST_HOURLY_SIGNAL"
    | "WINS"
    | "LOSSES"
    | "CONSENSUS_3_UP"
    | "CONSENSUS_3_DOWN"
    | "CONSENSUS_3_3"
  >("ALL");
  const [onlyFirstHourlySignal, setOnlyFirstHourlySignal] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedFileForModal, setSelectedFileForModal] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);

  // Dashboard Persistence (ذخیره‌سازی تنظیمات در مرورگر)
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const STORAGE_KEY = "jev_dashboard_preferences_v4";

  // Load saved preferences on client mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed.selectedCoin === "string") {
          setSelectedCoin(parsed.selectedCoin);
        }
        if (Array.isArray(parsed.selectedColIds) && parsed.selectedColIds.length > 0) {
          setSelectedColIds(parsed.selectedColIds);
        }
        if (parsed.visibleCurves) {
          setVisibleCurves((prev) => ({ ...prev, ...parsed.visibleCurves }));
        }
        if (parsed.signals) {
          setSignals((prev) => ({
            ...prev,
            ...parsed.signals,
            // Enforce score confidence as requested by user
            confidenceType: parsed.signals.confidenceType === "direction" ? "direction" : "score",
          }));
        }
        if (typeof parsed.dateFilter === "string") setDateFilter(parsed.dateFilter);
        if (parsed.startHour !== undefined) setStartHour(parsed.startHour);
        if (parsed.endHour !== undefined) setEndHour(parsed.endHour);
        if (parsed.activeIntervalPreset !== undefined) setActiveIntervalPreset(parsed.activeIntervalPreset);
        if (parsed.dirFilter !== undefined) setDirFilter(parsed.dirFilter);
      }
    } catch (e) {
      console.error("Error loading dashboard preferences:", e);
    } finally {
      setSettingsLoaded(true);
    }
  }, []);

  // Sync coin from URL search param if present (e.g. ?coin=eth)
  useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const c = params.get("coin");
      if (c) {
        setSelectedCoin(c.toLowerCase());
      }
    }
  }, []);

  // Auto-save whenever relevant settings change after initial load
  useEffect(() => {
    if (!settingsLoaded) return;
    try {
      const payload = {
        selectedCoin,
        selectedColIds,
        visibleCurves,
        signals,
        dateFilter,
        startHour,
        endHour,
        activeIntervalPreset,
        dirFilter,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      setSaveStatus("تنظیمات داشبورد به‌طور خودکار ذخیره شد");
      const t = setTimeout(() => setSaveStatus(null), 2500);
      return () => clearTimeout(t);
    } catch (e) {
      console.error("Error auto-saving preferences:", e);
    }
  }, [
    settingsLoaded,
    selectedCoin,
    selectedColIds,
    visibleCurves,
    signals,
    dateFilter,
    startHour,
    endHour,
    activeIntervalPreset,
    dirFilter,
  ]);

  const saveCurrentSettingsNow = () => {
    try {
      const payload = {
        selectedCoin,
        selectedColIds,
        visibleCurves,
        signals,
        dateFilter,
        startHour,
        endHour,
        activeIntervalPreset,
        dirFilter,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      setSaveStatus("تنظیمات داشبورد با موفقیت ذخیره شد ✓");
      setTimeout(() => setSaveStatus(null), 3000);
    } catch {
      setSaveStatus("خطا در ذخیره تنظیمات");
    }
  };

  const resetAllSettingsToDefault = () => {
    if (confirm("آیا مایلید تمام تنظیمات، ستون‌ها، فیلترها و شروط سیگنال به حالت پیش‌فرض بازگردد؟")) {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {}
      setSelectedCoin("all");
      setSelectedColIds(["coin", "consensus", "direction", "score", "kev_direction", "kev_score", "span_direction", "span_score", "solar_direction", "solar_score", "up_1h"]);
      setVisibleCurves({
        score: true,
        scoreConfidence: false,
        up1h: true,
        up15m: false,
        fair15m: true,
        up5m: false,
        signals: true,
        kevScore: false,
        spanScore: false,
      });
      setSignals(DEFAULT_SIGNAL_CONFIG);
      setDateFilter("ALL");
      setStartHour(null);
      setEndHour(null);
      setActiveIntervalPreset("ALL");
      setDirFilter("ALL");
      setOnlyFirstHourlySignal(false);
      setSaveStatus("تمام تنظیمات به حالت اولیه بازنشانی شد");
      setTimeout(() => setSaveStatus(null), 3000);
    }
  };

  // Chart hover state
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Auto-refresh state (every 30s)
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);

  const loadHistory = useCallback(
    async (coinToLoad = selectedCoin, isSilent = false) => {
      if (!isSilent) {
        setLoading(true);
        setError(null);
      } else {
        setIsRefreshing(true);
      }
      try {
        const baseUrl =
          coinToLoad && coinToLoad !== "all"
            ? `/api/jev/history?coin=${coinToLoad}`
            : "/api/jev/history";
        // Pass refresh=true so server runs throttled Polymarket resolution updates
        const url = `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}refresh=true`;
        const res = await fetch(url, { cache: "no-store" });
        const json = await res.json();
        if (json.files) {
          setData(json.files);
          setLastRefreshedAt(new Date());
        } else {
          throw new Error(json.error || "خطا در بارگذاری اطلاعات");
        }
      } catch (err: any) {
        if (!isSilent) {
          setError(err.message || "خطا در ارتباط با سرور");
        }
      } finally {
        if (!isSilent) setLoading(false);
        setIsRefreshing(false);
      }
    },
    [selectedCoin]
  );

  useEffect(() => {
    loadHistory(selectedCoin, false);
  }, [selectedCoin, loadHistory]);

  // Periodic auto-refresh every 30 seconds
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      loadHistory(selectedCoin, true);
    }, 30000);
    return () => clearInterval(interval);
  }, [autoRefresh, selectedCoin, loadHistory]);

  const viewFile = async (filename: string) => {
    setSelectedFileForModal(filename);
    setFileLoading(true);
    try {
      const res = await fetch(`/api/jev/history?file=${filename}`);
      const text = await res.text();
      setFileContent(text);
    } catch {
      setFileContent("خطا در بارگذاری محتوا");
    } finally {
      setFileLoading(false);
    }
  };

  const toggleColumn = (id: string) => {
    setSelectedColIds((prev) => {
      if (prev.includes(id)) {
        if (prev.length <= 1) return prev;
        return prev.filter((c) => c !== id);
      } else {
        return [...prev, id];
      }
    });
  };

  // Extract unique dates present in records
  const availableDates = useMemo(() => {
    const dates = new Set<string>();
    data.forEach((r) => {
      if (r.et_time) {
        const parts = r.et_time.split(" ");
        if (parts[0] && parts[0].length === 10) {
          dates.add(parts[0]);
        }
      }
    });
    return Array.from(dates).sort().reverse();
  }, [data]);

  // Set interval preset helper
  const applyIntervalPreset = (preset: string) => {
    setActiveIntervalPreset(preset);
    if (preset === "ALL") {
      setStartHour(null);
      setEndHour(null);
    } else if (preset === "13_14") {
      // 1PM to 2PM (13:00 - 14:00)
      setStartHour(13);
      setEndHour(14);
    } else if (preset === "14_15") {
      // 2PM to 3PM (14:00 - 15:00)
      setStartHour(14);
      setEndHour(15);
    } else if (preset === "15_16") {
      // 3PM to 4PM (15:00 - 16:00)
      setStartHour(15);
      setEndHour(16);
    } else if (preset === "01_02") {
      // 1AM to 2AM (01:00 - 02:00)
      setStartHour(1);
      setEndHour(2);
    } else if (preset === "23_24") {
      // 11PM to 12AM (23:00 - 24:00)
      setStartHour(23);
      setEndHour(24);
    }
  };

  // Base Filtered dataset (before direction/signal filter)
  const baseFilteredData = useMemo(() => {
    return data.filter((row) => {
      // Date filter
      if (dateFilter !== "ALL") {
        if (!row.et_time?.startsWith(dateFilter)) return false;
      }

      // Hour interval filter
      if (startHour != null && endHour != null) {
        try {
          const timePart = row.et_time ? row.et_time.split(" ")[1] : null;
          if (timePart) {
            const h = parseInt(timePart.split(":")[0], 10);
            if (h < startHour || h >= endHour) return false;
          } else {
            return false;
          }
        } catch {
          return false;
        }
      }

      // Text search
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const matchTime = row.et_time?.toLowerCase().includes(q);
        const matchFile = row.filename?.toLowerCase().includes(q);
        const matchScore = row.score?.toString().includes(q);

        const dirs = [row.direction, row.kev_direction, row.span_direction].filter(Boolean);
        const ups = dirs.filter((d) => d === "UP").length;
        const downs = dirs.filter((d) => d === "DOWN").length;
        const is3Up = ups === 3;
        const is3Down = downs === 3;

        const matchConsensus =
          (row.consensus_summary?.toLowerCase().includes(q) ?? false) ||
          (q === "3/3" && (is3Up || is3Down)) ||
          ((q.includes("3/3") || q === "up" || q === "صعود") && is3Up) ||
          ((q.includes("3/3") || q === "down" || q === "نزول") && is3Down);

        const matchDir = row.direction?.toLowerCase() === q;
        if (!matchTime && !matchFile && !matchScore && !matchConsensus && !matchDir) return false;
      }

      return true;
    });
  }, [data, dateFilter, startHour, endHour, searchQuery]);

  // Data with direction/signal filters applied (for table display)
  const filteredData = useMemo(() => {
    // 1. Filter rows matching active direction/signal/consensus criteria
    const matchingRows = baseFilteredData.filter((row) => {
      if (dirFilter === "UP" && row.direction !== "UP") return false;
      if (dirFilter === "DOWN" && row.direction !== "DOWN") return false;
      if (dirFilter === "SIGNALS" || dirFilter === "FIRST_HOURLY_SIGNAL") {
        const out = evaluateSignalOutcome(row, signals);
        if (!out.hasSignal) return false;
      }
      if (dirFilter === "WINS") {
        const out = evaluateSignalOutcome(row, signals);
        if (out.status !== "WIN") return false;
      }
      if (dirFilter === "LOSSES") {
        const out = evaluateSignalOutcome(row, signals);
        if (out.status !== "LOSS") return false;
      }
      if (dirFilter === "CONSENSUS_3_UP") {
        const dirs = [row.direction, row.kev_direction, row.span_direction].filter(Boolean);
        if (dirs.filter((d) => d === "UP").length !== 3) return false;
      }
      if (dirFilter === "CONSENSUS_3_DOWN") {
        const dirs = [row.direction, row.kev_direction, row.span_direction].filter(Boolean);
        if (dirs.filter((d) => d === "DOWN").length !== 3) return false;
      }
      if (dirFilter === "CONSENSUS_3_3") {
        const dirs = [row.direction, row.kev_direction, row.span_direction].filter(Boolean);
        const ups = dirs.filter((d) => d === "UP").length;
        const downs = dirs.filter((d) => d === "DOWN").length;
        if (ups !== 3 && downs !== 3) return false;
      }
      return true;
    });

    // 2. Identify first hourly signal chronologically within the matching rows
    const chrono = [...matchingRows].sort((a, b) => {
      const tA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const tB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      if (tA && tB) return tA - tB;
      return (a.filename || "").localeCompare(b.filename || "");
    });

    const seenGroup = new Set<string>();
    const firstHourlySignalFilenames = new Set<string>();

    for (const r of chrono) {
      const outcome = evaluateSignalOutcome(r, signals);
      if (outcome.hasSignal && outcome.signalDirection) {
        const hourMatch = r.filename?.match(/^([a-z0-9]+)_updown_(\d{4}-\d{2}-\d{2}_\d{2})/i);
        const fallbackHour = hourMatch
          ? `${hourMatch[1].toUpperCase()}_${hourMatch[2]}`
          : r.et_time?.slice(0, 13) || r.filename;
        const marketKey = r.market_slug ? `${r.coin || "BTC"}_${r.market_slug}` : fallbackHour;
        const groupKey = `${marketKey}_${outcome.signalDirection}`;

        if (!seenGroup.has(groupKey)) {
          seenGroup.add(groupKey);
          firstHourlySignalFilenames.add(r.filename);
        }
      }
    }

    // 3. Attach is_first_hourly_signal metadata
    const enriched = matchingRows.map((r) => ({
      ...r,
      is_first_hourly_signal: firstHourlySignalFilenames.has(r.filename),
    }));

    // 4. Apply deduplication if FIRST_HOURLY_SIGNAL or onlyFirstHourlySignal is active
    if (dirFilter === "FIRST_HOURLY_SIGNAL") {
      return enriched.filter((r) => firstHourlySignalFilenames.has(r.filename));
    }

    if (onlyFirstHourlySignal) {
      return enriched.filter((r) => {
        const out = evaluateSignalOutcome(r, signals);
        if (out.hasSignal && !firstHourlySignalFilenames.has(r.filename)) {
          return false;
        }
        return true;
      });
    }

    return enriched;
  }, [baseFilteredData, dirFilter, signals, onlyFirstHourlySignal]);

  // Chronological data for charting (oldest to newest)
  const chartData = useMemo(() => {
    return [...filteredData].reverse();
  }, [filteredData]);

  // Summary KPIs for current view with 1-Hour Signal Deduplication
  const stats = useMemo(() => {
    const total = baseFilteredData.length;
    const withScore = baseFilteredData.filter((d) => d.score != null);
    const avgScore =
      withScore.length > 0
        ? withScore.reduce((acc, cur) => acc + (cur.score || 0), 0) / withScore.length
        : 0;
    const upCount = baseFilteredData.filter((d) => d.direction === "UP").length;
    const downCount = baseFilteredData.filter((d) => d.direction === "DOWN").length;
    const upPct = total > 0 ? ((upCount / total) * 100).toFixed(0) : "0";
    const downPct = total > 0 ? ((downCount / total) * 100).toFixed(0) : "0";

    // Deduplicate signals per 1-hour market interval:
    // If multiple 5-min snapshots in the same 1h market have signals in the same direction,
    // they are collapsed into ONE trade/signal.
    const hourlySignalsMap = new Map<
      string,
      {
        marketKey: string;
        direction: "UP" | "DOWN";
        status: "WIN" | "LOSS" | "PENDING";
        snapshotCount: number;
      }
    >();

    let rawSignalSnapshots = 0;

    baseFilteredData.forEach((d) => {
      const outcome = evaluateSignalOutcome(d, signals);
      if (outcome.hasSignal && outcome.signalDirection) {
        rawSignalSnapshots++;
        const hourMatch = d.filename?.match(/^([a-z0-9]+)_updown_(\d{4}-\d{2}-\d{2}_\d{2})/i);
        const fallbackHour = hourMatch
          ? `${hourMatch[1].toUpperCase()}_${hourMatch[2]}`
          : d.et_time?.slice(0, 13) || d.filename;
        const marketKey = d.market_slug ? `${d.coin || "BTC"}_${d.market_slug}` : fallbackHour;
        const groupKey = `${marketKey}_${outcome.signalDirection}`;

        if (!hourlySignalsMap.has(groupKey)) {
          hourlySignalsMap.set(groupKey, {
            marketKey,
            direction: outcome.signalDirection,
            status: outcome.status as "WIN" | "LOSS" | "PENDING",
            snapshotCount: 1,
          });
        } else {
          hourlySignalsMap.get(groupKey)!.snapshotCount++;
        }
      }
    });

    const signalCount = hourlySignalsMap.size;
    let winCount = 0;
    let lossCount = 0;
    let pendingCount = 0;

    hourlySignalsMap.forEach((entry) => {
      if (entry.status === "WIN") winCount++;
      else if (entry.status === "LOSS") lossCount++;
      else if (entry.status === "PENDING") pendingCount++;
    });

    const winRate =
      winCount + lossCount > 0
        ? Number(((winCount / (winCount + lossCount)) * 100).toFixed(1))
        : null;

    // Consensus 3/3 counts across base filtered data
    const consensusUp3Count = baseFilteredData.filter((d) => {
      const dirs = [d.direction, d.kev_direction, d.span_direction].filter(Boolean);
      return dirs.filter((x) => x === "UP").length === 3;
    }).length;

    const consensusDown3Count = baseFilteredData.filter((d) => {
      const dirs = [d.direction, d.kev_direction, d.span_direction].filter(Boolean);
      return dirs.filter((x) => x === "DOWN").length === 3;
    }).length;

    const consensusFull3Count = baseFilteredData.filter((d) => {
      const dirs = [d.direction, d.kev_direction, d.span_direction].filter(Boolean);
      const ups = dirs.filter((x) => x === "UP").length;
      const downs = dirs.filter((x) => x === "DOWN").length;
      return ups === 3 || downs === 3;
    }).length;

    return {
      total,
      avgScore: avgScore.toFixed(2),
      upCount,
      downCount,
      upPct,
      downPct,
      signalCount,
      rawSignalSnapshots,
      winCount,
      lossCount,
      pendingCount,
      winRate,
      consensusUp3Count,
      consensusDown3Count,
      consensusFull3Count,
    };
  }, [baseFilteredData, signals]);

  // Sorting state for table
  const [sortConfig, setSortConfig] = useState<{
    key: string;
    dir: "asc" | "desc";
  } | null>(null);

  const handleSort = (key: string) => {
    setSortConfig((prev) => {
      if (!prev || prev.key !== key) {
        return { key, dir: "desc" };
      }
      if (prev.dir === "desc") {
        return { key, dir: "asc" };
      }
      return null;
    });
  };

  // Helper to extract a number from string or number values
  const parseSortValue = (val: any): number | null => {
    if (val == null || val === "") return null;
    if (typeof val === "number") return isNaN(val) ? null : val;
    if (typeof val === "string") {
      const cleaned = val.replace(/[\$,%]/g, "").trim();
      if (cleaned !== "" && !isNaN(Number(cleaned))) {
        return Number(cleaned);
      }
    }
    return null;
  };

  // Sorted dataset for table and exports
  const sortedData = useMemo(() => {
    if (!sortConfig) return filteredData;
    const { key, dir } = sortConfig;
    const factor = dir === "asc" ? 1 : -1;

    return [...filteredData].sort((a, b) => {
      let valA: any;
      let valB: any;

      if (key === "time") {
        valA = a.timestamp ? new Date(a.timestamp).getTime() : a.current_time_et || a.et_time;
        valB = b.timestamp ? new Date(b.timestamp).getTime() : b.current_time_et || b.et_time;
      } else {
        const col = ALL_COLUMNS.find((c) => c.id === key);
        if (col) {
          valA = col.sortVal ? col.sortVal(a, signals) : col.exportVal(a, signals);
          valB = col.sortVal ? col.sortVal(b, signals) : col.exportVal(b, signals);
        }
      }

      const isEmptyA = valA == null || valA === "";
      const isEmptyB = valB == null || valB === "";
      if (isEmptyA && isEmptyB) return 0;
      if (isEmptyA) return 1;
      if (isEmptyB) return -1;

      const numA = parseSortValue(valA);
      const numB = parseSortValue(valB);

      if (numA !== null && numB !== null) {
        return (numA - numB) * factor;
      }

      return String(valA).localeCompare(String(valB), "fa", { numeric: true }) * factor;
    });
  }, [filteredData, sortConfig, signals]);

  // Export CSV of currently sorted and filtered data
  const exportCsv = () => {
    const activeCols = ALL_COLUMNS.filter((c) => selectedColIds.includes(c.id));
    const headers = ["ردیف", "زمان (ET)", "نام فایل", ...activeCols.map((c) => c.label)];
    const rows = sortedData.map((r, idx) => [
      idx + 1,
      `"${(r.current_time_et || r.et_time || "").replace(/"/g, '""')}"`,
      `"${(r.filename || "").replace(/"/g, '""')}"`,
      ...activeCols.map((c) => `"${String(c.exportVal(r, signals) ?? "").replace(/"/g, '""')}"`),
    ]);
    const csvContent = "\uFEFF" + [headers.join(","), ...rows.map((e) => e.join(","))].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute(
      "download",
      `jev_analysis_${selectedCoin}_${new Date().toISOString().slice(0, 10)}.csv`
    );
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Export PDF / Print of currently sorted and filtered data
  const exportPdf = () => {
    const activeCols = ALL_COLUMNS.filter((c) => selectedColIds.includes(c.id));
    const printableRows = sortedData;

    const printWin = window.open("", "_blank");
    if (!printWin) {
      alert("لطفاً باز شدن پنجره‌های پاپ‌آپ (Pop-up) را در مرورگر خود مجاز فرمایید.");
      return;
    }

    const title = `گزارش تحلیل پیش‌بینی‌های هوش مصنوعی پلی‌مارکت - ${selectedCoin.toUpperCase()}`;
    const dateStr = new Date().toLocaleString("fa-IR");
    const sortLabel = sortConfig
      ? ` | مرتب‌شده بر اساس: ${
          sortConfig.key === "time"
            ? "زمان"
            : ALL_COLUMNS.find((c) => c.id === sortConfig.key)?.label || sortConfig.key
        } (${sortConfig.dir === "desc" ? "نزولی ↓" : "صعودی ↑"})`
      : "";

    const htmlContent = `
<!DOCTYPE html>
<html dir="rtl" lang="fa">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;600;700;800&display=swap');
    
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: 'Vazirmatn', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    
    @page {
      size: A4 landscape;
      margin: 10mm;
    }

    body {
      background-color: #ffffff;
      color: #111827;
      padding: 15px;
      font-size: 11px;
      line-height: 1.4;
    }

    .no-print {
      margin-bottom: 16px;
      padding: 12px 16px;
      background: #f0fdf4;
      border: 1px solid #bbf7d0;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .btn {
      background: #5a94bd;
      color: white;
      border: none;
      padding: 8px 18px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .btn:hover { background: #0369a1; }

    .header {
      border-bottom: 2px solid #e5e7eb;
      padding-bottom: 12px;
      margin-bottom: 14px;
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
    }

    .header h1 {
      font-size: 18px;
      font-weight: 800;
      color: #1e293b;
      margin-bottom: 4px;
    }

    .header .subtitle {
      font-size: 11px;
      color: #73757c;
    }

    .stats-banner {
      display: flex;
      gap: 12px;
      margin-bottom: 14px;
      background: #e8e8e4;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 10px 14px;
      flex-wrap: wrap;
    }

    .stat-pill {
      font-size: 11px;
      padding: 4px 10px;
      border-radius: 6px;
      font-weight: 600;
    }
    .pill-blue { background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe; }
    .pill-green { background: #f0fdf4; color: #15803d; border: 1px solid #bbf7d0; }
    .pill-red { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; }
    .pill-gray { background: #f1f5f9; color: #475569; border: 1px solid #bdbdb8; }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 10px;
      text-align: right;
    }

    th {
      background: #f1f5f9;
      color: #3a3c42;
      font-weight: 700;
      padding: 6px 8px;
      border: 1px solid #bdbdb8;
      white-space: nowrap;
    }

    td {
      padding: 5px 8px;
      border: 1px solid #e2e8f0;
      white-space: nowrap;
    }

    tr:nth-child(even) { background-color: #e8e8e4; }

    .row-win { background-color: #ecfdf5 !important; }
    .row-loss { background-color: #fff1f2 !important; }

    .badge-win {
      display: inline-block;
      padding: 2px 6px;
      border-radius: 4px;
      background: #dcfce7;
      color: #166534;
      font-weight: 700;
      border: 1px solid #8fd0a8;
    }

    .badge-loss {
      display: inline-block;
      padding: 2px 6px;
      border-radius: 4px;
      background: #fee2e2;
      color: #991b1b;
      font-weight: 700;
      border: 1px solid #fca5a5;
    }

    .badge-up { color: #059669; font-weight: 700; }
    .badge-down { color: #e11d48; font-weight: 700; }

    @media print {
      .no-print { display: none !important; }
      body { padding: 0; }
      table { page-break-inside: auto; }
      tr { page-break-inside: avoid; page-break-after: auto; }
      thead { display: table-header-group; }
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
  </style>
</head>
<body>
  <div class="no-print">
    <div>
      <strong>پیش‌نمایش چاپ و دریافت فایل PDF</strong>
      <div style="font-size: 11px; color: #475569; margin-top: 2px;">
        برای ذخیره نسخه PDF، روی دکمه زیر کلیک کرده و در پنجره چاپ، گزینه <strong>Save as PDF</strong> را انتخاب نمایید.
      </div>
    </div>
    <button class="btn" onclick="window.print()">
      🖨️ چاپ / ذخیره به صورت PDF
    </button>
  </div>

  <div class="header">
    <div>
      <h1>${title}</h1>
      <div class="subtitle">تاریخ گزارش: ${dateStr} · ارز: ${selectedCoin.toUpperCase()} · فیلتر تاریخ: ${
      dateFilter === "ALL" ? "تمام تاریخ‌ها" : dateFilter
    } · تعداد سطرها: ${printableRows.length}${sortLabel}</div>
    </div>
    <div style="text-align: left; font-size: 10px; color: #73757c;">
      Polymarket Up/Down | Jev & Multi-Model
    </div>
  </div>

  <div class="stats-banner">
    <div class="stat-pill pill-blue">🎯 کل سیگنال‌های ساعتی: ${stats.signalCount}</div>
    <div class="stat-pill pill-green">🏆 برد (WIN): ${stats.winCount}</div>
    <div class="stat-pill pill-red">❌ باخت (LOSS): ${stats.lossCount}</div>
    ${stats.winRate != null ? `<div class="stat-pill pill-green">📊 وین‌ریت ساعتی: ${stats.winRate}%</div>` : ""}
    <div class="stat-pill pill-gray">تعداد سطرهای این خروجی: ${printableRows.length}</div>
  </div>

  <table>
    <thead>
      <tr>
        <th style="width: 35px; text-align: center;">#</th>
        <th>زمان و ساعت (ET)</th>
        ${activeCols.map((c) => `<th>${c.label}</th>`).join("")}
      </tr>
    </thead>
    <tbody>
      ${printableRows
        .map((row, idx) => {
          const outcomeInfo = evaluateSignalOutcome(row, signals);
          let rowClass = "";
          if (outcomeInfo.hasSignal) {
            if (outcomeInfo.status === "WIN") rowClass = "row-win";
            else if (outcomeInfo.status === "LOSS") rowClass = "row-loss";
          }
          return `
          <tr class="${rowClass}">
            <td style="text-align: center; color: #73757c;">${idx + 1}</td>
            <td style="font-family: monospace; font-weight: 600;">${
              row.current_time_et || row.et_time
            }</td>
            ${activeCols
              .map((col) => {
                const val = col.exportVal(row, signals);
                let formatted = String(val ?? "");
                if (col.id === "signal_result") {
                  if (outcomeInfo.status === "WIN") formatted = '<span class="badge-win">✓ برد (WIN)</span>';
                  else if (outcomeInfo.status === "LOSS") formatted = '<span class="badge-loss">✗ باخت (LOSS)</span>';
                  else if (outcomeInfo.status === "PENDING") formatted = '⏳ در انتظار';
                } else if (col.id === "market_outcome") {
                  if (val === "UP") formatted = '<span class="badge-up">🟢 صعود</span>';
                  else if (val === "DOWN") formatted = '<span class="badge-down">🔴 نزول</span>';
                }
                return `<td>${formatted}</td>`;
              })
              .join("")}
          </tr>`;
        })
        .join("")}
    </tbody>
  </table>

  <script>
    window.addEventListener('load', () => {
      setTimeout(() => {
        window.print();
      }, 500);
    });
  </script>
</body>
</html>
    `;

    printWin.document.open();
    printWin.document.write(htmlContent);
    printWin.document.close();
  };

  const activeColumns = useMemo(
    () => ALL_COLUMNS.filter((c) => selectedColIds.includes(c.id)),
    [selectedColIds]
  );

  // SVG Chart Geometry
  const chartWidth = 920;
  const chartHeight = 280;
  const padding = { top: 25, right: 45, bottom: 35, left: 45 };
  const plotWidth = chartWidth - padding.left - padding.right;
  const plotHeight = chartHeight - padding.top - padding.bottom;

  // Chart coordinates calculation
  const curveCoordinates = useMemo(() => {
    if (chartData.length < 2) return null;

    const n = chartData.length;
    const getX = (i: number) => padding.left + (i / (n - 1)) * plotWidth;

    // Y values:
    // Right Axis: 0% to 100% -> y: padding.top + plotHeight - (val / 100) * plotHeight
    // Left Axis: Score 0 to 4 -> y: padding.top + plotHeight - (score / 4) * plotHeight
    const getYPct = (pct: number) =>
      padding.top + plotHeight - (Math.max(0, Math.min(100, pct)) / 100) * plotHeight;
    const getYScore = (sc: number) =>
      padding.top + plotHeight - (Math.max(0, Math.min(4, sc)) / 4) * plotHeight;

    const scorePoints: { x: number; y: number }[] = [];
    const kevScorePoints: { x: number; y: number }[] = [];
    const spanScorePoints: { x: number; y: number }[] = [];
    const scoreConfidencePoints: { x: number; y: number }[] = [];
    const up1hPoints: { x: number; y: number }[] = [];
    const up15mPoints: { x: number; y: number }[] = [];
    const fair15mPoints: { x: number; y: number }[] = [];
    const up5mPoints: { x: number; y: number }[] = [];

    const signalMarkers: {
      index: number;
      x: number;
      y: number;
      signal: SignalMatch;
      item: JevFileRecord;
    }[] = [];

    chartData.forEach((d, i) => {
      const x = getX(i);
      if (d.score != null) {
        scorePoints.push({ x, y: getYScore(d.score) });
      }
      if (d.kev_score != null) {
        kevScorePoints.push({ x, y: getYScore(d.kev_score) });
      }
      if (d.span_score != null) {
        spanScorePoints.push({ x, y: getYScore(d.span_score) });
      }

      const sig = evaluateSignal(d, signals);
      if (sig) {
        signalMarkers.push({
          index: i,
          x,
          y: getYScore(sig.score),
          signal: sig,
          item: d,
        });
      }

      if (d.score_confidence != null) scoreConfidencePoints.push({ x, y: getYPct(d.score_confidence) });
      if (d.up_1h_num != null) up1hPoints.push({ x, y: getYPct(d.up_1h_num) });
      if (d.up_15m_num != null) up15mPoints.push({ x, y: getYPct(d.up_15m_num) });
      if (d.fair_15m != null) fair15mPoints.push({ x, y: getYPct(d.fair_15m) });
      if (d.up_5m_num != null) up5mPoints.push({ x, y: getYPct(d.up_5m_num) });
    });

    return {
      scorePath: generateSmoothCurve(scorePoints),
      scorePoints,
      kevScorePath: generateSmoothCurve(kevScorePoints),
      kevScorePoints,
      spanScorePath: generateSmoothCurve(spanScorePoints),
      spanScorePoints,
      scoreConfidencePath: generateSmoothCurve(scoreConfidencePoints),
      scoreConfidencePoints,
      up1hPath: generateSmoothCurve(up1hPoints),
      up1hPoints,
      up15mPath: generateSmoothCurve(up15mPoints),
      up15mPoints,
      fair15mPath: generateSmoothCurve(fair15mPoints),
      fair15mPoints,
      up5mPath: generateSmoothCurve(up5mPoints),
      up5mPoints,
      signalMarkers,
      getX,
      bottomY: padding.top + plotHeight,
    };
  }, [chartData, plotWidth, plotHeight, padding.left, padding.top, signals]);

  const bullishMatches = useMemo(
    () => curveCoordinates?.signalMarkers.filter((m) => m.signal.type === "BULLISH") || [],
    [curveCoordinates]
  );
  const bearishMatches = useMemo(
    () => curveCoordinates?.signalMarkers.filter((m) => m.signal.type === "BEARISH") || [],
    [curveCoordinates]
  );

  // Handle Chart mouse move
  const handleSvgMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current || chartData.length === 0) return;
    const rect = svgRef.current.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const relX = (mouseX / rect.width) * chartWidth;

    const clampedX = Math.max(padding.left, Math.min(padding.left + plotWidth, relX));
    const ratio = (clampedX - padding.left) / plotWidth;
    const idx = Math.round(ratio * (chartData.length - 1));
    setHoverIndex(idx);
  };

  const handleSvgMouseLeave = () => {
    setHoverIndex(null);
  };

  const hoveredItem = hoverIndex != null && chartData[hoverIndex] ? chartData[hoverIndex] : null;

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 border-b border-white/[0.08] pb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Link
              href="/updown"
              className="inline-flex items-center gap-1 text-xs text-[#9a9ca3] hover:text-[#6aa9d8] transition-colors"
            >
              <ArrowRight className="w-3.5 h-3.5 rotate-180" />
              بازگشت به صفحه Up/Down
            </Link>
            <span className="text-xs text-[#73757c]">/</span>
            <span className="text-xs text-[#6aa9d8] font-medium">Jev JSON Analyzer</span>
          </div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2.5">
            <BarChart3 className="w-6 h-6 text-[#6aa9d8]" />
            داشبورد آنالیز، فیلتر بازه زمانی و رسم منحنی Jev
          </h1>
          <p className="text-xs text-[#9a9ca3] mt-1">
            رسم منحنی‌های زمانی مقادیر در بازه‌های دلخواه (مثلاً ساعت ۱ تا ۲) و مقایسه داده‌ها
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Quick Save / Reset Buttons */}
          <button
            onClick={saveCurrentSettingsNow}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#6aa9d8]/15 hover:bg-[#6aa9d8]/25 text-xs text-[#6aa9d8] border border-[#6aa9d8]/30 transition-all font-medium"
            title="ذخیره تنظیمات فعلی، ستون‌ها، بازه‌ها و شروط سیگنال در مرورگر"
          >
            <Save className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">ذخیره تنظیمات</span>
          </button>

          <button
            onClick={resetAllSettingsToDefault}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-xs text-[#9a9ca3] hover:text-[#e5787f] border border-white/[0.08] transition-all"
            title="بازنشانی تمام فیلترها، ستون‌ها و شروط به حالت اولیه"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">بازنشانی</span>
          </button>

          <button
            onClick={exportCsv}
            disabled={sortedData.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] text-xs text-[#bdbdb8] border border-white/[0.08] transition-all disabled:opacity-50 font-medium"
            title="دانلود خروجی CSV از جدول جاری (با اعمال سورت و فیلترهای فعال)"
          >
            <Download className="w-3.5 h-3.5 text-[#6aa9d8]" />
            <span>خروجی CSV ({sortedData.length})</span>
          </button>

          <button
            onClick={exportPdf}
            disabled={sortedData.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#6aa9d8]/15 hover:bg-[#6aa9d8]/25 text-xs text-[#6aa9d8] border border-[#6aa9d8]/30 transition-all disabled:opacity-50 font-medium"
            title="چاپ و دانلود خروجی PDF جدول جاری با رنگ‌بندی کامل برد و باخت"
          >
            <Printer className="w-3.5 h-3.5" />
            <span>خروجی PDF ({sortedData.length})</span>
          </button>

          {/* Auto Refresh Toggle Button */}
          <button
            onClick={() => setAutoRefresh((prev) => !prev)}
            className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border transition-all ${
              autoRefresh
                ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/25"
                : "bg-white/[0.04] text-[#9a9ca3] border-white/[0.08] hover:bg-white/[0.08]"
            }`}
            title="بروزرسانی خودکار جدول هر ۳۰ ثانیه (همگام با تاخیر ۱۰-۳۰ دقیقه‌ای تایید نهایی اوراکل Polymarket)"
          >
            <span
              className={`w-2 h-2 rounded-full ${
                autoRefresh ? "bg-emerald-400" : "bg-[#73757c]"
              }`}
            />
            <span className="hidden sm:inline">
              {autoRefresh ? "بروزرسانی خودکار: روشن (۳۰s)" : "بروزرسانی خودکار: خاموش"}
            </span>
            <span className="sm:hidden">{autoRefresh ? "خودکار: روشن" : "خودکار: خاموش"}</span>
            {isRefreshing && <RefreshCw className="w-3 h-3 text-emerald-400 animate-spin" />}
          </button>

          {lastRefreshedAt && (
            <span className="text-[11px] text-[#73757c] hidden xl:inline-block font-mono" title="زمان آخرین دریافت داده‌ها از سرور">
              آخرین دریافت: {lastRefreshedAt.toLocaleTimeString("fa-IR")}
            </span>
          )}

          <button
            onClick={() => loadHistory(selectedCoin, false)}
            disabled={loading || isRefreshing}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#6366f1] text-white text-xs font-medium hover:opacity-90 transition-opacity shadow-md disabled:opacity-50"
            title="تازه‌سازی دستی و استعلام آخرین نتایج تایید شده از Polymarket"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading || isRefreshing ? "animate-spin" : ""}`} />
            تازه‌سازی
          </button>
        </div>
      </div>

      {/* Floating Save Status Toast */}
      {saveStatus && (
        <div className="fixed bottom-6 left-6 z-50 bg-[#181a1e]/95 border border-[#5fbf9a]/50 text-[#5fbf9a] px-4 py-2.5 rounded-xl shadow-2xl backdrop-blur-md text-xs flex items-center gap-2.5 animate-in fade-in slide-in-from-bottom-2 duration-200">
          <CheckCircle2 className="w-4 h-4 text-[#5fbf9a]" />
          <span className="font-medium">{saveStatus}</span>
        </div>
      )}

      {/* COIN SELECTOR BAR (انتخاب و فیلتر ارزها) */}
      <div className="bg-[#181a1e]/90 border border-[rgba(190,190,200,0.18)] p-3.5 rounded-2xl flex flex-wrap items-center justify-between gap-3 shadow-md">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-[#9a9ca3] px-2 flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-[#d4b063]" />
            انتخاب ارز:
          </span>
          <div className="flex flex-wrap items-center gap-1.5">
            {AVAILABLE_COINS.map((c) => {
              const isActive = selectedCoin === c.key;
              return (
                <button
                  key={c.key}
                  onClick={() => setSelectedCoin(c.key)}
                  className={`text-xs px-3 py-1.5 rounded-xl font-medium transition-all flex items-center gap-1.5 border ${
                    isActive
                      ? "bg-[#6aa9d8]/20 border-[#6aa9d8] text-white shadow-sm font-bold"
                      : "bg-white/[0.04] border-white/[0.08] text-[#9a9ca3] hover:text-white hover:bg-white/[0.08]"
                  }`}
                >
                  {c.color && (
                    <span
                      className="w-2 h-2 rounded-full"
                      style={{ backgroundColor: c.color }}
                    />
                  )}
                  <span>{c.label}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="text-xs text-[#73757c] mr-auto pl-2">
          {selectedCoin === "all" ? "نمایش تمام پیش‌بینی‌های ثبت‌شده" : `نمایش تحلیل‌های اختصاصی ${selectedCoin.toUpperCase()}`}
        </div>
      </div>

      {/* TIME RANGE FILTER CONTROLS (ساعت ۱ تا ۲ و بازه‌های دلخواه) */}
      <div className="bg-[#181a1e]/90 border border-[#6aa9d8]/30 rounded-2xl p-5 space-y-4 shadow-xl">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.08] pb-3">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-[#6aa9d8]" />
            <span className="text-sm font-bold text-white">
              انتخاب بازه زمانی جهت رسم منحنی و فیلتر جدول (Time Window):
            </span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-[#6aa9d8]/15 text-[#6aa9d8] font-bold">
              {filteredData.length} اسنپ‌شات در بازه انتخابی
            </span>
          </div>

          {/* Quick presets (ساعت ۱ تا ۲ و ...) */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-[#9a9ca3] ml-1">بازه‌های سریع:</span>
            {[
              { id: "ALL", label: "کل داده‌ها" },
              { id: "13_14", label: "ساعت ۱ تا ۲ ظهر (13:00-14:00)" },
              { id: "14_15", label: "ساعت ۲ تا ۳ عصر (14:00-15:00)" },
              { id: "15_16", label: "ساعت ۳ تا ۴ عصر (15:00-16:00)" },
              { id: "23_24", label: "ساعت ۱۱ تا ۱۲ شب (23:00-24:00)" },
              { id: "01_02", label: "ساعت ۱ تا ۲ بامداد (01:00-02:00)" },
            ].map((preset) => (
              <button
                key={preset.id}
                onClick={() => applyIntervalPreset(preset.id)}
                className={`text-xs px-2.5 py-1 rounded-lg border transition-all ${
                  activeIntervalPreset === preset.id
                    ? "bg-[#6aa9d8]/20 border-[#6aa9d8] text-[#6aa9d8] font-semibold"
                    : "bg-white/[0.04] border-white/[0.08] text-[#9a9ca3] hover:text-white hover:bg-white/[0.08]"
                }`}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>

        {/* Date & Custom Hour Pickers */}
        <div className="grid grid-cols-1 sm:grid-cols-3 md:grid-cols-4 gap-3 text-xs">
          {/* Date Selector */}
          <div className="flex items-center gap-2 bg-white/[0.03] p-2.5 rounded-xl border border-white/[0.07]">
            <Calendar className="w-3.5 h-3.5 text-[#6aa9d8]" />
            <span className="text-[#9a9ca3]">تاریخ:</span>
            <select
              value={dateFilter}
              onChange={(e) => setDateFilter(e.target.value)}
              className="bg-[#0f1013] text-white border border-white/[0.15] rounded px-2 py-1 flex-1 focus:outline-none focus:border-[#6aa9d8]"
            >
              <option value="ALL">تمام روزها ({availableDates.length} روز)</option>
              {availableDates.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>

          {/* Start Hour */}
          <div className="flex items-center gap-2 bg-white/[0.03] p-2.5 rounded-xl border border-white/[0.07]">
            <Clock className="w-3.5 h-3.5 text-[#5fbf9a]" />
            <span className="text-[#9a9ca3]">از ساعت:</span>
            <select
              value={startHour ?? ""}
              onChange={(e) => {
                const val = e.target.value === "" ? null : parseInt(e.target.value, 10);
                setStartHour(val);
                setActiveIntervalPreset("custom");
              }}
              className="bg-[#0f1013] text-white border border-white/[0.15] rounded px-2 py-1 flex-1 focus:outline-none focus:border-[#5fbf9a]"
            >
              <option value="">شروع (00:00)</option>
              {Array.from({ length: 24 }).map((_, i) => (
                <option key={i} value={i}>
                  {i.toString().padStart(2, "0")}:00 ({i === 13 ? "1 PM" : i === 1 ? "1 AM" : `${i}:00`})
                </option>
              ))}
            </select>
          </div>

          {/* End Hour */}
          <div className="flex items-center gap-2 bg-white/[0.03] p-2.5 rounded-xl border border-white/[0.07]">
            <Clock className="w-3.5 h-3.5 text-[#e5787f]" />
            <span className="text-[#9a9ca3]">تا ساعت:</span>
            <select
              value={endHour ?? ""}
              onChange={(e) => {
                const val = e.target.value === "" ? null : parseInt(e.target.value, 10);
                setEndHour(val);
                setActiveIntervalPreset("custom");
              }}
              className="bg-[#0f1013] text-white border border-white/[0.15] rounded px-2 py-1 flex-1 focus:outline-none focus:border-[#e5787f]"
            >
              <option value="">پایان (24:00)</option>
              {Array.from({ length: 24 }).map((_, i) => (
                <option key={i + 1} value={i + 1}>
                  {(i + 1).toString().padStart(2, "0")}:00 ({i + 1 === 14 ? "2 PM" : i + 1 === 2 ? "2 AM" : `${i + 1}:00`})
                </option>
              ))}
            </select>
          </div>

          {/* Reset Filters */}
          <div className="flex items-center">
            <button
              onClick={() => {
                setDateFilter("ALL");
                applyIntervalPreset("ALL");
              }}
              className="w-full text-center py-2 px-3 rounded-xl bg-white/[0.05] hover:bg-white/[0.09] text-[#9a9ca3] hover:text-white border border-white/[0.08] transition-colors"
            >
              بازنشانی بازه زمانی (کل داده‌ها)
            </button>
          </div>
        </div>
      </div>

      {/* INTERACTIVE CURVE CHART COMPONENT (رسم منحنی مقادیر) */}
      <div className="bg-[#131418] border border-[rgba(190,190,200,0.2)] rounded-2xl p-5 space-y-4 shadow-2xl relative">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 border-b border-white/[0.08] pb-3">
          <div>
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-[#d4b063]" />
              منحنی تغییرات مقادیر در بازه انتخابی (Interactive Value Curves)
            </h2>
            <p className="text-[11px] text-[#9a9ca3] mt-0.5">
              نمایش همزمان و تطبیق منحنی اسکور Jev، درصدهای بازار و Fair Value با حرکت موس روی نمودار
            </p>
          </div>

          {/* Curve Toggles */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-[#9a9ca3] text-[11px]">منحنی‌های فعال:</span>

            {/* Signal Ticks Toggle Button */}
            <button
              onClick={() => setVisibleCurves((p) => ({ ...p, signals: !p.signals }))}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs transition-all ${
                visibleCurves.signals
                  ? "bg-gradient-to-r from-[#6aa9d8]/20 via-[#5fbf9a]/15 to-[#d8646a]/20 border-[#6aa9d8] text-white font-bold shadow-sm"
                  : "bg-white/[0.03] border-white/[0.1] text-[#73757c] opacity-60"
              }`}
              title="نمایش تیک‌های شرطی آبی و قرمز روی نقاط منحنی"
            >
              <div className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-[#6aa9d8]" />
                <span className="w-2 h-2 rounded-full bg-[#d8646a]" />
              </div>
              <span>تیک‌های سیگنال</span>
              <span className="text-[10px] font-mono opacity-85 px-1.5 py-0.2 rounded bg-black/40">
                {bullishMatches.length} آبی / {bearishMatches.length} قرمز
              </span>
            </button>

            {/* Signal Settings Accordion Toggle */}
            <button
              onClick={() => setShowSignalSettings((p) => !p)}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg border text-xs transition-all ${
                showSignalSettings
                  ? "bg-[#6aa9d8]/20 border-[#6aa9d8] text-[#6aa9d8] font-bold"
                  : "bg-white/[0.04] border-white/[0.1] text-[#9a9ca3] hover:text-white"
              }`}
              title="تنظیم شروط مقادیر اسکور و درصد اطمینان برای تیک‌های آبی و قرمز"
            >
              <Settings2 className="w-3.5 h-3.5" />
              <span>تنظیم شروط تیک‌ها</span>
              <ChevronDown className={`w-3 h-3 transition-transform ${showSignalSettings ? "rotate-180" : ""}`} />
            </button>

            <button
              onClick={() => setVisibleCurves((p) => ({ ...p, score: !p.score }))}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs transition-all ${
                visibleCurves.score
                  ? "bg-[#a795d6]/20 border-[#a795d6] text-[#a795d6] font-bold"
                  : "bg-white/[0.03] border-white/[0.1] text-[#73757c] opacity-60"
              }`}
            >
              <span className="w-2.5 h-2.5 rounded-full bg-[#a795d6]" />
              اسکور Jev (0-4)
            </button>

            <button
              onClick={() => setVisibleCurves((p) => ({ ...p, kevScore: !p.kevScore }))}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs transition-all ${
                visibleCurves.kevScore
                  ? "bg-[#6aa9d8]/20 border-[#6aa9d8] text-[#6aa9d8] font-bold"
                  : "bg-white/[0.03] border-white/[0.1] text-[#73757c] opacity-60"
              }`}
              title="نمایش منحنی اسکور مدل Kev-4b (۰ تا ۴)"
            >
              <span className="w-2.5 h-2.5 rounded-full bg-[#6aa9d8]" />
              اسکور Kev-4b (0-4)
            </button>

            <button
              onClick={() => setVisibleCurves((p) => ({ ...p, spanScore: !p.spanScore }))}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs transition-all ${
                visibleCurves.spanScore
                  ? "bg-[#b58ac9]/20 border-[#b58ac9] text-[#b58ac9] font-bold"
                  : "bg-white/[0.03] border-white/[0.1] text-[#73757c] opacity-60"
              }`}
              title="نمایش منحنی اسکور مدل Span-01 (۰ تا ۴)"
            >
              <span className="w-2.5 h-2.5 rounded-full bg-[#b58ac9]" />
              اسکور Span-01 (0-4)
            </button>

            <button
              onClick={() => setVisibleCurves((p) => ({ ...p, scoreConfidence: !p.scoreConfidence }))}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs transition-all ${
                visibleCurves.scoreConfidence
                  ? "bg-[#cfad4e]/20 border-[#cfad4e] text-[#cfad4e] font-bold"
                  : "bg-white/[0.03] border-white/[0.1] text-[#73757c] opacity-60"
              }`}
            >
              <span className="w-2.5 h-2.5 rounded-full bg-[#cfad4e]" />
              اطمینان اسکور Jev (%)
            </button>

            <button
              onClick={() => setVisibleCurves((p) => ({ ...p, up1h: !p.up1h }))}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs transition-all ${
                visibleCurves.up1h
                  ? "bg-[#5fbf9a]/20 border-[#5fbf9a] text-[#5fbf9a] font-bold"
                  : "bg-white/[0.03] border-white/[0.1] text-[#73757c] opacity-60"
              }`}
            >
              <span className="w-2.5 h-2.5 rounded-full bg-[#5fbf9a]" />
              1H Up % بازار
            </button>

            <button
              onClick={() => setVisibleCurves((p) => ({ ...p, up15m: !p.up15m }))}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs transition-all ${
                visibleCurves.up15m
                  ? "bg-[#6aa9d8]/20 border-[#6aa9d8] text-[#6aa9d8] font-bold"
                  : "bg-white/[0.03] border-white/[0.1] text-[#73757c] opacity-60"
              }`}
            >
              <span className="w-2.5 h-2.5 rounded-full bg-[#6aa9d8]" />
              15M Up % بازار
            </button>

            <button
              onClick={() => setVisibleCurves((p) => ({ ...p, fair15m: !p.fair15m }))}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs transition-all ${
                visibleCurves.fair15m
                  ? "bg-[#d4a24f]/20 border-[#d4a24f] text-[#d4a24f] font-bold"
                  : "bg-white/[0.03] border-white/[0.1] text-[#73757c] opacity-60"
              }`}
            >
              <span className="w-2.5 h-2.5 rounded-full bg-[#d4a24f]" />
              Fair Value 15m
            </button>

            <button
              onClick={() => setVisibleCurves((p) => ({ ...p, up5m: !p.up5m }))}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs transition-all ${
                visibleCurves.up5m
                  ? "bg-[#d68aa8]/20 border-[#d68aa8] text-[#d68aa8] font-bold"
                  : "bg-white/[0.03] border-white/[0.1] text-[#73757c] opacity-60"
              }`}
            >
              <span className="w-2.5 h-2.5 rounded-full bg-[#d68aa8]" />
              5M Up % بازار
            </button>
          </div>
        </div>

        {/* CONDITIONAL SIGNAL MARKERS CONFIGURATION PANEL */}
        {showSignalSettings && (
          <div className="bg-[#0f1013]/90 border border-[#6aa9d8]/30 rounded-xl p-4 space-y-3.5 text-xs animate-in fade-in slide-in-from-top-2 duration-200">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.08] pb-2.5">
              <div className="flex items-center gap-2">
                <Sliders className="w-4 h-4 text-[#6aa9d8]" />
                <span className="font-bold text-white text-sm">
                  تعریف شروط تیک‌های روی منحنی (Conditional Signal Markers):
                </span>
              </div>
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1.5 text-[#bdbdb8] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={signals.enabled}
                    onChange={(e) => setSignals((p) => ({ ...p, enabled: e.target.checked }))}
                    className="accent-[#6aa9d8] rounded"
                  />
                  <span>فعال‌سازی سیستم تیک‌های شرطی</span>
                </label>
                <button
                  onClick={() => setSignals(DEFAULT_SIGNAL_CONFIG)}
                  className="text-[11px] px-2.5 py-1 rounded bg-white/[0.05] hover:bg-white/[0.1] text-[#9a9ca3] hover:text-white transition-colors"
                >
                  بازنشانی شروط
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {/* Bullish Condition (Blue Tick) */}
              <div className="bg-[#131418] p-3 rounded-xl border border-[#6aa9d8]/30 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 font-bold text-[#6aa9d8]">
                    <span className="w-3.5 h-3.5 rounded-full bg-[#6aa9d8] flex items-center justify-center text-[10px] text-black font-black">✓</span>
                    <span>شرط تیک آبی (صعودی / Bullish):</span>
                  </div>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#6aa9d8]/15 text-[#6aa9d8] font-bold">
                    {bullishMatches.length} مورد فعال
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  <div>
                    <label className="text-[#9a9ca3] block mb-1">حداقل اسکور (0 - 4):</label>
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      max="4"
                      value={signals.bullishScore}
                      onChange={(e) =>
                        setSignals((p) => ({
                          ...p,
                          bullishScore: parseFloat(e.target.value) || 0,
                        }))
                      }
                      className="w-full bg-[#0f1013] text-white border border-[#6aa9d8]/40 rounded-lg px-2.5 py-1 font-mono font-bold focus:outline-none focus:border-[#6aa9d8]"
                    />
                  </div>
                  <div>
                    <label className="text-[#9a9ca3] block mb-1">حداقل اطمینان (%):</label>
                    <input
                      type="number"
                      step="5"
                      min="0"
                      max="100"
                      value={signals.bullishMinConf}
                      onChange={(e) =>
                        setSignals((p) => ({
                          ...p,
                          bullishMinConf: parseInt(e.target.value, 10) || 0,
                        }))
                      }
                      className="w-full bg-[#0f1013] text-white border border-[#6aa9d8]/40 rounded-lg px-2.5 py-1 font-mono font-bold focus:outline-none focus:border-[#6aa9d8]"
                    />
                  </div>
                </div>
                <p className="text-[10px] text-[#6aa9d8]">
                  قانون تیک آبی: اسکور بالای {signals.bullishScore} و همزمان اطمینان اسکور حداقل {signals.bullishMinConf}%
                </p>
              </div>

              {/* Bearish Condition (Red Tick) */}
              <div className="bg-[#131418] p-3 rounded-xl border border-[#d8646a]/30 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 font-bold text-[#d8646a]">
                    <span className="w-3.5 h-3.5 rounded-full bg-[#d8646a] flex items-center justify-center text-[10px] text-white font-black">✓</span>
                    <span>شرط تیک قرمز (نزولی / Bearish):</span>
                  </div>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#d8646a]/15 text-[#d8646a] font-bold">
                    {bearishMatches.length} مورد فعال
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  <div>
                    <label className="text-[#9a9ca3] block mb-1">حداکثر اسکور (0 - 4):</label>
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      max="4"
                      value={signals.bearishScore}
                      onChange={(e) =>
                        setSignals((p) => ({
                          ...p,
                          bearishScore: parseFloat(e.target.value) || 0,
                        }))
                      }
                      className="w-full bg-[#0f1013] text-white border border-[#d8646a]/40 rounded-lg px-2.5 py-1 font-mono font-bold focus:outline-none focus:border-[#d8646a]"
                    />
                  </div>
                  <div>
                    <label className="text-[#9a9ca3] block mb-1">حداقل اطمینان (%):</label>
                    <input
                      type="number"
                      step="5"
                      min="0"
                      max="100"
                      value={signals.bearishMinConf}
                      onChange={(e) =>
                        setSignals((p) => ({
                          ...p,
                          bearishMinConf: parseInt(e.target.value, 10) || 0,
                        }))
                      }
                      className="w-full bg-[#0f1013] text-white border border-[#d8646a]/40 rounded-lg px-2.5 py-1 font-mono font-bold focus:outline-none focus:border-[#d8646a]"
                    />
                  </div>
                </div>
                <p className="text-[10px] text-[#d8646a]">
                  قانون تیک قرمز: اسکور کمتر از {signals.bearishScore} و همزمان اطمینان اسکور حداقل {signals.bearishMinConf}%
                </p>
              </div>

              {/* Model Source & Confidence Settings */}
              <div className="bg-[#131418] p-3 rounded-xl border border-white/[0.1] space-y-2 flex flex-col justify-between">
                <div className="space-y-2">
                  <div>
                    <label className="text-[#9a9ca3] block mb-1 font-medium">مدل هوش‌مصنوعی مبنای سیگنال:</label>
                    <select
                      value={signals.modelSource || "jev"}
                      onChange={(e) =>
                        setSignals((p) => ({
                          ...p,
                          modelSource: e.target.value as "jev" | "kev" | "span" | "solar" | "consensus",
                        }))
                      }
                      className="w-full bg-[#0f1013] text-white border border-white/[0.15] rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-[#6aa9d8]"
                    >
                      <option value="jev">مدل Jev (انحصاری Jev - پیش‌فرض)</option>
                      <option value="kev">مدل Kev-4b (اسکور ۰ تا ۴)</option>
                      <option value="span">مدل Span-01 (اسکور ۰ تا ۴)</option>
                      <option value="solar">مدل Solar-Decide (اسکور ۰ تا ۴)</option>
                      <option value="consensus">اجماع هر ۳ مدل (میانگین اسکور)</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[#9a9ca3] block mb-1 font-medium">مبنای سنجش درصد اطمینان:</label>
                    <select
                      value={signals.confidenceType}
                      onChange={(e) =>
                        setSignals((p) => ({
                          ...p,
                          confidenceType: e.target.value as "score" | "direction" | "any",
                        }))
                      }
                      className="w-full bg-[#0f1013] text-white border border-white/[0.15] rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-[#6aa9d8]"
                    >
                      <option value="score">فقط درصد اطمینان اسکور (Score Confidence - قانون اصلی)</option>
                      <option value="direction">فقط درصد اطمینان جهت (Direction Confidence)</option>
                    </select>
                  </div>
                </div>
                <div className="text-[11px] text-[#9a9ca3] bg-white/[0.03] p-2 rounded-lg border border-white/[0.05]">
                  💡 تیک‌ها به همراه خط چین راهنما مستقیماً در صورت برقراری همزمان هر دو شرط اسکور و اطمینان اسکور رسم می‌شوند.
                </div>
              </div>
            </div>
          </div>
        )}

        {/* The SVG Smooth Curve Canvas */}
        {chartData.length < 2 ? (
          <div className="h-64 flex flex-col items-center justify-center text-center p-6 text-[#9a9ca3] bg-white/[0.02] rounded-xl border border-dashed border-white/[0.08]">
            <Clock className="w-8 h-8 text-[#73757c] mb-2" />
            <p className="text-xs font-semibold text-white">برای این بازه داده کافی برای رسم منحنی وجود ندارد</p>
            <p className="text-[11px] text-[#73757c] mt-1">
              لطفاً بازه زمانی را وسیع‌تر انتخاب کنید (مثلاً تمام ساعات یا ساعت‌های دیگر که داده ثبت شده است).
            </p>
          </div>
        ) : (
          <div className="relative overflow-hidden select-none">
            <svg
              ref={svgRef}
              viewBox={`0 0 ${chartWidth} ${chartHeight}`}
              className="w-full h-auto cursor-crosshair overflow-visible"
              onMouseMove={handleSvgMouseMove}
              onMouseLeave={handleSvgMouseLeave}
            >
              <defs>
                {/* Gradients for Curve Glow & Area */}
                <linearGradient id="scoreGlow" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#a795d6" stopOpacity="0.25" />
                  <stop offset="100%" stopColor="#a795d6" stopOpacity="0.0" />
                </linearGradient>
                <linearGradient id="up1hGlow" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#5fbf9a" stopOpacity="0.25" />
                  <stop offset="100%" stopColor="#5fbf9a" stopOpacity="0.0" />
                </linearGradient>
                <linearGradient id="fairGlow" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#d4a24f" stopOpacity="0.2" />
                  <stop offset="100%" stopColor="#d4a24f" stopOpacity="0.0" />
                </linearGradient>
              </defs>

              {/* Grid Lines */}
              {[0, 25, 50, 75, 100].map((pct) => {
                const y = padding.top + plotHeight - (pct / 100) * plotHeight;
                const scoreEquiv = ((pct / 100) * 4).toFixed(1);
                return (
                  <g key={pct}>
                    <line
                      x1={padding.left}
                      y1={y}
                      x2={padding.left + plotWidth}
                      y2={y}
                      stroke="rgba(255,255,255, 0.07)"
                      strokeDasharray="4 4"
                    />
                    {/* Left Axis: Jev Score */}
                    <text
                      x={padding.left - 8}
                      y={y + 3}
                      fill="#9fb4ee"
                      fontSize="9"
                      textAnchor="end"
                      fontFamily="monospace"
                    >
                      {scoreEquiv}
                    </text>
                    {/* Right Axis: Percentage */}
                    <text
                      x={padding.left + plotWidth + 8}
                      y={y + 3}
                      fill="#9a9ca3"
                      fontSize="9"
                      textAnchor="start"
                      fontFamily="monospace"
                    >
                      {pct}%
                    </text>
                  </g>
                );
              })}

              {/* Horizontal Center Baseline (Score 2.0 / 50%) */}
              <line
                x1={padding.left}
                y1={padding.top + plotHeight / 2}
                x2={padding.left + plotWidth}
                y2={padding.top + plotHeight / 2}
                stroke="rgba(190,190,200, 0.25)"
                strokeWidth="1.2"
              />

              {/* CURVE: Fair Value 15m */}
              {visibleCurves.fair15m && curveCoordinates?.fair15mPath && (
                <path
                  d={curveCoordinates.fair15mPath}
                  fill="none"
                  stroke="#d4a24f"
                  strokeWidth="2"
                  strokeDasharray="3 3"
                  className="transition-all duration-300"
                />
              )}

              {/* CURVE: 15M Up % */}
              {visibleCurves.up15m && curveCoordinates?.up15mPath && (
                <path
                  d={curveCoordinates.up15mPath}
                  fill="none"
                  stroke="#6aa9d8"
                  strokeWidth="1.8"
                  className="transition-all duration-300"
                />
              )}

              {/* CURVE: 5M Up % */}
              {visibleCurves.up5m && curveCoordinates?.up5mPath && (
                <path
                  d={curveCoordinates.up5mPath}
                  fill="none"
                  stroke="#d68aa8"
                  strokeWidth="1.5"
                  className="transition-all duration-300"
                />
              )}

              {/* CURVE: 1H Up % */}
              {visibleCurves.up1h && curveCoordinates?.up1hPath && (
                <g>
                  {/* Glowing Area under 1h Up */}
                  <path
                    d={`${curveCoordinates.up1hPath} L ${curveCoordinates.up1hPoints[curveCoordinates.up1hPoints.length - 1]?.x} ${curveCoordinates.bottomY} L ${curveCoordinates.up1hPoints[0]?.x} ${curveCoordinates.bottomY} Z`}
                    fill="url(#up1hGlow)"
                  />
                  <path
                    d={curveCoordinates.up1hPath}
                    fill="none"
                    stroke="#5fbf9a"
                    strokeWidth="2.5"
                    className="transition-all duration-300"
                  />
                </g>
              )}

              {/* CURVE: Jev Score Confidence % */}
              {visibleCurves.scoreConfidence && curveCoordinates?.scoreConfidencePath && (
                <path
                  d={curveCoordinates.scoreConfidencePath}
                  fill="none"
                  stroke="#cfad4e"
                  strokeWidth="2.2"
                  strokeDasharray="4 2"
                  className="transition-all duration-300"
                />
              )}

              {/* CURVE: Jev Score (0-4) */}
              {visibleCurves.score && curveCoordinates?.scorePath && (
                <g>
                  {/* Glowing Area under Score */}
                  <path
                    d={`${curveCoordinates.scorePath} L ${curveCoordinates.scorePoints[curveCoordinates.scorePoints.length - 1]?.x} ${curveCoordinates.bottomY} L ${curveCoordinates.scorePoints[0]?.x} ${curveCoordinates.bottomY} Z`}
                    fill="url(#scoreGlow)"
                  />
                  <path
                    d={curveCoordinates.scorePath}
                    fill="none"
                    stroke="#a795d6"
                    strokeWidth="3"
                    className="transition-all duration-300"
                  />
                </g>
              )}

              {/* CURVE: Kev-4b Score (0-4) */}
              {visibleCurves.kevScore && curveCoordinates?.kevScorePath && (
                <path
                  d={curveCoordinates.kevScorePath}
                  fill="none"
                  stroke="#6aa9d8"
                  strokeWidth="2.5"
                  strokeDasharray="4 2"
                  className="transition-all duration-300"
                />
              )}

              {/* CURVE: Span-01 Score (0-4) */}
              {visibleCurves.spanScore && curveCoordinates?.spanScorePath && (
                <path
                  d={curveCoordinates.spanScorePath}
                  fill="none"
                  stroke="#b58ac9"
                  strokeWidth="2.5"
                  strokeDasharray="2 2"
                  className="transition-all duration-300"
                />
              )}

              {/* CONDITIONAL SIGNAL MARKER PINS ON THE CURVE */}
              {visibleCurves.signals &&
                curveCoordinates?.signalMarkers.map((marker) => {
                  const isHovered = hoverIndex === marker.index;
                  const isBull = marker.signal.type === "BULLISH";
                  // Pin position: 24px above the score point, clamped within canvas
                  const pinY = Math.max(padding.top + 16, marker.y - 24);
                  const stemBottom = marker.y - 4;

                  return (
                    <g
                      key={`sig-${marker.index}`}
                      className="cursor-pointer transition-all duration-200"
                      onMouseEnter={() => setHoverIndex(marker.index)}
                    >
                      {/* Vertical connecting dashed line to curve point */}
                      <line
                        x1={marker.x}
                        y1={pinY + 8}
                        x2={marker.x}
                        y2={stemBottom}
                        stroke={marker.signal.color}
                        strokeWidth={isHovered ? "2" : "1.2"}
                        strokeDasharray="2 2"
                        opacity={isHovered ? "1" : "0.75"}
                      />

                      {/* Pulsing glow halo */}
                      <circle
                        cx={marker.x}
                        cy={pinY}
                        r={isHovered ? 13 : 9.5}
                        fill={marker.signal.color}
                        opacity={isHovered ? "0.35" : "0.2"}
                        className=""
                      />

                      {/* Pin background circle */}
                      <circle
                        cx={marker.x}
                        cy={pinY}
                        r={isHovered ? 9.5 : 8}
                        fill="#0f1013"
                        stroke={marker.signal.color}
                        strokeWidth={isHovered ? "2.5" : "1.8"}
                      />

                      {/* Checkmark icon inside pin */}
                      <text
                        x={marker.x}
                        y={pinY + 3.5}
                        fill={marker.signal.color}
                        fontSize={isHovered ? "11" : "9.5"}
                        fontWeight="bold"
                        textAnchor="middle"
                        fontFamily="sans-serif"
                      >
                        ✓
                      </text>

                      {/* Floating tag on hover */}
                      {isHovered && (
                        <g>
                          <rect
                            x={marker.x - 36}
                            y={pinY - 22}
                            width="72"
                            height="16"
                            rx="8"
                            fill={marker.signal.color}
                            filter="drop-shadow(0 2px 4px rgba(0,0,0,0.6))"
                          />
                          <text
                            x={marker.x}
                            y={pinY - 11}
                            fill="#000"
                            fontSize="9"
                            fontWeight="bold"
                            textAnchor="middle"
                            fontFamily="sans-serif"
                          >
                            {isBull ? "تیک صعودی" : "تیک نزولی"}
                          </text>
                        </g>
                      )}
                    </g>
                  );
                })}

              {/* Data Point Dots on Curves */}
              {curveCoordinates &&
                chartData.map((pt, i) => {
                  const x = curveCoordinates.getX(i);
                  const isHovered = hoverIndex === i;
                  return (
                    <g key={i}>
                      {visibleCurves.score && pt.score != null && (
                        <circle
                          cx={x}
                          cy={padding.top + plotHeight - (pt.score / 4) * plotHeight}
                          r={isHovered ? 5 : 2.5}
                          fill={isHovered ? "#fff" : "#a795d6"}
                          stroke="#131418"
                          strokeWidth="1.5"
                        />
                      )}
                      {visibleCurves.kevScore && pt.kev_score != null && (
                        <circle
                          cx={x}
                          cy={padding.top + plotHeight - (pt.kev_score / 4) * plotHeight}
                          r={isHovered ? 5 : 2.5}
                          fill={isHovered ? "#fff" : "#6aa9d8"}
                          stroke="#131418"
                          strokeWidth="1.5"
                        />
                      )}
                      {visibleCurves.spanScore && pt.span_score != null && (
                        <circle
                          cx={x}
                          cy={padding.top + plotHeight - (pt.span_score / 4) * plotHeight}
                          r={isHovered ? 5 : 2.5}
                          fill={isHovered ? "#fff" : "#b58ac9"}
                          stroke="#131418"
                          strokeWidth="1.5"
                        />
                      )}
                      {visibleCurves.scoreConfidence && pt.score_confidence != null && (
                        <circle
                          cx={x}
                          cy={padding.top + plotHeight - (pt.score_confidence / 100) * plotHeight}
                          r={isHovered ? 5 : 2.5}
                          fill={isHovered ? "#fff" : "#cfad4e"}
                          stroke="#131418"
                          strokeWidth="1.5"
                        />
                      )}
                      {visibleCurves.up1h && pt.up_1h_num != null && (
                        <circle
                          cx={x}
                          cy={padding.top + plotHeight - (pt.up_1h_num / 100) * plotHeight}
                          r={isHovered ? 5 : 2.5}
                          fill={isHovered ? "#fff" : "#5fbf9a"}
                          stroke="#131418"
                          strokeWidth="1.5"
                        />
                      )}
                    </g>
                  );
                })}

              {/* Interactive Hover Crosshair Line */}
              {hoverIndex != null && curveCoordinates && (
                <line
                  x1={curveCoordinates.getX(hoverIndex)}
                  y1={padding.top}
                  x2={curveCoordinates.getX(hoverIndex)}
                  y2={padding.top + plotHeight}
                  stroke="#6aa9d8"
                  strokeWidth="1.5"
                  strokeDasharray="4 3"
                />
              )}

              {/* X Axis Time Labels */}
              {curveCoordinates &&
                [0, Math.floor(chartData.length / 4), Math.floor(chartData.length / 2), Math.floor((chartData.length * 3) / 4), chartData.length - 1].map(
                  (idx) => {
                    const item = chartData[idx];
                    if (!item) return null;
                    const x = curveCoordinates.getX(idx);
                    const timeLabel = item.current_time_et || item.et_time?.split(" ")[1] || item.et_time || item.filename || "";
                    return (
                      <text
                        key={idx}
                        x={x}
                        y={padding.top + plotHeight + 20}
                        fill="#9a9ca3"
                        fontSize="10"
                        textAnchor="middle"
                        fontFamily="monospace"
                      >
                        {timeLabel}
                      </text>
                    );
                  }
                )}
            </svg>

            {/* Hover Tooltip Card */}
            {hoveredItem && hoverIndex != null && curveCoordinates && (
              <div
                className="absolute top-2 pointer-events-none z-30 transition-all duration-100"
                style={{
                  left: `min(${Math.max(10, (curveCoordinates.getX(hoverIndex) / chartWidth) * 100)}%, calc(100% - 240px))`,
                }}
              >
                <div className="bg-[#0f1013]/95 border border-[#6aa9d8]/40 rounded-xl p-3 shadow-2xl backdrop-blur-md text-xs space-y-1.5 min-w-[210px]">
                  <div className="flex items-center justify-between border-b border-white/[0.08] pb-1">
                    <span className="font-mono text-[#6aa9d8] font-bold">
                      {hoveredItem.current_time_et || hoveredItem.et_time}
                    </span>
                    {hoveredItem.direction && (
                      <span
                        className={`px-1.5 py-0.2 rounded text-[10px] font-bold ${
                          hoveredItem.direction === "UP" ? "bg-[#5fbf9a]/20 text-[#5fbf9a]" : "bg-[#e5787f]/20 text-[#e5787f]"
                        }`}
                      >
                        {hoveredItem.direction}
                      </span>
                    )}
                  </div>

                  {/* Signal Match Banner in Tooltip */}
                  {hoveredItem && (() => {
                    const sig = evaluateSignal(hoveredItem, signals);
                    if (!sig) return null;
                    return (
                      <div
                        className="px-2 py-1.5 rounded-lg border flex items-center justify-between gap-2 shadow-md animate-in fade-in"
                        style={{
                          backgroundColor: sig.bgColor,
                          borderColor: sig.borderColor,
                        }}
                      >
                        <div className="flex items-center gap-1.5">
                          <span
                            className="w-3.5 h-3.5 rounded-full flex items-center justify-center text-[9px] font-black text-black"
                            style={{ backgroundColor: sig.color }}
                          >
                            ✓
                          </span>
                          <span className="font-bold text-[11px]" style={{ color: sig.color }}>
                            {sig.label}
                          </span>
                        </div>
                        <span className="text-[10px] opacity-85 font-mono text-[#bdbdb8]">
                          {sig.rule}
                        </span>
                      </div>
                    );
                  })()}

                  {hoveredItem.score != null && (
                    <div className="flex items-center justify-between">
                      <span className="text-[#9a9ca3]">اسکور Jev:</span>
                      <span className="font-mono text-[#a795d6] font-bold tabular-nums">
                        {hoveredItem.score.toFixed(2)} / 4.0
                      </span>
                    </div>
                  )}

                  {hoveredItem.score_confidence != null && (
                    <div className="flex items-center justify-between">
                      <span className="text-[#9a9ca3]">اطمینان اسکور:</span>
                      <span className="font-mono text-[#cfad4e] font-bold tabular-nums">
                        {hoveredItem.score_confidence}%
                      </span>
                    </div>
                  )}

                  {hoveredItem.kev_score != null && (
                    <div className="flex items-center justify-between">
                      <span className="text-[#9a9ca3]">اسکور Kev-4b:</span>
                      <span className="font-mono text-[#6aa9d8] font-bold tabular-nums">
                        {hoveredItem.kev_score.toFixed(2)} / 4.0 {hoveredItem.kev_confidence != null ? `(${hoveredItem.kev_confidence}%)` : ""}
                      </span>
                    </div>
                  )}

                  {hoveredItem.span_score != null && (
                    <div className="flex items-center justify-between">
                      <span className="text-[#9a9ca3]">اسکور Span-01:</span>
                      <span className="font-mono text-[#b58ac9] font-bold tabular-nums">
                        {hoveredItem.span_score.toFixed(2)} / 4.0 {hoveredItem.span_confidence != null ? `(${hoveredItem.span_confidence}%)` : ""}
                      </span>
                    </div>
                  )}

                  {hoveredItem.up_1h_num != null && (
                    <div className="flex items-center justify-between">
                      <span className="text-[#9a9ca3]">1H Up بازار:</span>
                      <span className="font-mono text-[#5fbf9a] font-bold tabular-nums">
                        {hoveredItem.up_1h_num}%
                      </span>
                    </div>
                  )}

                  {hoveredItem.up_15m_num != null && (
                    <div className="flex items-center justify-between">
                      <span className="text-[#9a9ca3]">15M Up بازار:</span>
                      <span className="font-mono text-[#6aa9d8] font-medium tabular-nums">
                        {hoveredItem.up_15m_num}%
                      </span>
                    </div>
                  )}

                  {hoveredItem.fair_15m != null && (
                    <div className="flex items-center justify-between">
                      <span className="text-[#9a9ca3]">Fair Value 15m:</span>
                      <span className="font-mono text-[#d4a24f] font-medium tabular-nums">
                        {hoveredItem.fair_15m.toFixed(1)}¢
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between text-[11px] text-[#73757c] pt-2 border-t border-white/[0.06]">
          <span>محور عمودی چپ: اسکور هوش‌مصنوعی (۰ تا ۴) · محور عمودی راست: درصد بازار (۰٪ تا ۱۰۰٪)</span>
          <span>تعداد نقاط متصل روی منحنی: {chartData.length} مقطع ۵ دقیقه‌ای</span>
        </div>
      </div>

      {/* Column & Metric Selector (User customizable view) */}
      <div className="bg-[#181a1e]/90 border border-[rgba(190,190,200,0.18)] rounded-2xl p-5 space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 border-b border-white/[0.08] pb-3">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="w-4 h-4 text-[#6aa9d8]" />
            <span className="text-sm font-semibold text-white">
              انتخاب شاخص‌های جدول (مشخص کنید چه مواردی را فقط نشان دهد):
            </span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-[#6aa9d8]/15 text-[#6aa9d8] font-bold">
              {selectedColIds.length} ستون فعال
            </span>
          </div>

          {/* Quick Presets */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-[#9a9ca3] ml-1">پیش‌فرض‌ها:</span>
            {PRESETS.map((p) => {
              const isActive =
                selectedColIds.length === p.cols.length &&
                p.cols.every((c) => selectedColIds.includes(c));
              return (
                <button
                  key={p.id}
                  onClick={() => setSelectedColIds(p.cols)}
                  className={`text-xs px-2.5 py-1 rounded-lg border transition-all ${
                    isActive
                      ? "bg-[#6aa9d8]/20 border-[#6aa9d8] text-[#6aa9d8] font-semibold"
                      : "bg-white/[0.04] border-white/[0.08] text-[#9a9ca3] hover:text-white hover:bg-white/[0.08]"
                  }`}
                >
                  {p.title}
                </button>
              );
            })}
          </div>
        </div>

        {/* Individual Column Chips / Toggles */}
        <div className="flex flex-wrap gap-2">
          {ALL_COLUMNS.map((col) => {
            const isSelected = selectedColIds.includes(col.id);
            return (
              <button
                key={col.id}
                onClick={() => toggleColumn(col.id)}
                className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-all ${
                  isSelected
                    ? "bg-[#6b86d6]/25 border-[#8ea4e8] text-white shadow-sm"
                    : "bg-white/[0.03] border-white/[0.07] text-[#9a9ca3] hover:text-[#bdbdb8] hover:bg-white/[0.06]"
                }`}
              >
                <div
                  className={`w-3.5 h-3.5 rounded flex items-center justify-center text-[10px] ${
                    isSelected ? "bg-[#6aa9d8] text-black font-bold" : "border border-white/20"
                  }`}
                >
                  {isSelected && <Check className="w-2.5 h-2.5 stroke-[3]" />}
                </div>
                <span>{col.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Filter & Search Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-[#181a1e]/70 p-3 rounded-xl border border-[rgba(190,190,200,0.12)]">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 text-xs text-[#9a9ca3]">
            <Filter className="w-3.5 h-3.5 text-[#6aa9d8]" />
            <span>فیلتر جهت:</span>
          </div>
          <button
            onClick={() => setDirFilter("ALL")}
            className={`text-xs px-2.5 py-1 rounded-md transition-all ${
              dirFilter === "ALL"
                ? "bg-white/[0.15] text-white font-medium"
                : "text-[#9a9ca3] hover:text-white"
            }`}
          >
            همه ({data.length})
          </button>
          <button
            onClick={() => setDirFilter("UP")}
            className={`text-xs px-2.5 py-1 rounded-md transition-all ${
              dirFilter === "UP"
                ? "bg-[#5fbf9a]/20 text-[#5fbf9a] font-semibold"
                : "text-[#9a9ca3] hover:text-[#5fbf9a]"
            }`}
          >
            فقط صعودی UP ({stats.upCount})
          </button>
          <button
            onClick={() => setDirFilter("DOWN")}
            className={`text-xs px-2.5 py-1 rounded-md transition-all ${
              dirFilter === "DOWN"
                ? "bg-[#e5787f]/20 text-[#e5787f] font-semibold"
                : "text-[#9a9ca3] hover:text-[#e5787f]"
            }`}
          >
            فقط نزولی DOWN ({stats.downCount})
          </button>

          <div className="h-4 w-[1px] bg-white/10 mx-0.5 hidden sm:block" />

          <button
            onClick={() => setDirFilter("CONSENSUS_3_UP")}
            className={`text-xs px-2.5 py-1 rounded-md transition-all flex items-center gap-1.5 ${
              dirFilter === "CONSENSUS_3_UP"
                ? "bg-[#5fbf9a]/25 text-[#5fbf9a] font-semibold border border-[#5fbf9a]/50 shadow-sm"
                : "text-[#9a9ca3] hover:text-[#5fbf9a]"
            }`}
            title="فقط اسنپ‌شات‌هایی که هر ۳ مدل (Jev + Kev + Span) صعود کامل ۳/۳ داده‌اند"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-[#5fbf9a]" />
            <span>۳/۳ صعود ({stats.consensusUp3Count})</span>
          </button>

          <button
            onClick={() => setDirFilter("CONSENSUS_3_DOWN")}
            className={`text-xs px-2.5 py-1 rounded-md transition-all flex items-center gap-1.5 ${
              dirFilter === "CONSENSUS_3_DOWN"
                ? "bg-[#e5787f]/25 text-[#e5787f] font-semibold border border-[#e5787f]/50 shadow-sm"
                : "text-[#9a9ca3] hover:text-[#e5787f]"
            }`}
            title="فقط اسنپ‌شات‌هایی که هر ۳ مدل (Jev + Kev + Span) نزول کامل ۳/۳ داده‌اند"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-[#e5787f]" />
            <span>۳/۳ نزول ({stats.consensusDown3Count})</span>
          </button>

          <button
            onClick={() => setDirFilter("CONSENSUS_3_3")}
            className={`text-xs px-2.5 py-1 rounded-md transition-all flex items-center gap-1.5 ${
              dirFilter === "CONSENSUS_3_3"
                ? "bg-[#a795d6]/25 text-[#a795d6] font-semibold border border-[#a795d6]/50 shadow-sm"
                : "text-[#9a9ca3] hover:text-[#a795d6]"
            }`}
            title="هر نوع اجماع قاطع ۳ از ۳ (چه صعود و چه نزول)"
          >
            <span>⚡ هر ۳/۳ ({stats.consensusFull3Count})</span>
          </button>

          <div className="h-4 w-[1px] bg-white/10 mx-0.5 hidden sm:block" />
          <button
            onClick={() => setDirFilter("SIGNALS")}
            title={`نمایش تمام اسنپ‌شات‌های دارای سیگنال (${stats.rawSignalSnapshots} اسنپ‌شات ۵ دقیقه‌ای)`}
            className={`text-xs px-2.5 py-1 rounded-md transition-all ${
              dirFilter === "SIGNALS"
                ? "bg-[#6aa9d8]/20 text-[#6aa9d8] font-semibold border border-[#6aa9d8]/40"
                : "text-[#9a9ca3] hover:text-[#6aa9d8]"
            }`}
          >
            🎯 تمام سیگنال‌ها ({stats.rawSignalSnapshots})
          </button>
          <button
            onClick={() => setDirFilter("FIRST_HOURLY_SIGNAL")}
            title="فقط اولین سیگنال صادر شده در هر ساعت (حذف سیگنال‌های تکراری با جهت یکسان در همان ساعت)"
            className={`text-xs px-2.5 py-1 rounded-md transition-all flex items-center gap-1.5 ${
              dirFilter === "FIRST_HOURLY_SIGNAL"
                ? "bg-amber-500/25 text-amber-300 font-semibold border border-amber-500/50 shadow-sm"
                : "text-[#9a9ca3] hover:text-amber-300"
            }`}
          >
            <Zap className="w-3 h-3 text-amber-400" />
            <span>⚡ اولین سیگنال هر ساعت ({stats.signalCount})</span>
          </button>
          <button
            onClick={() => setDirFilter("WINS")}
            title={`${stats.winCount} کندل ساعتی برنده`}
            className={`text-xs px-2.5 py-1 rounded-md transition-all ${
              dirFilter === "WINS"
                ? "bg-emerald-500/25 text-emerald-300 font-semibold border border-emerald-500/40"
                : "text-[#9a9ca3] hover:text-emerald-400"
            }`}
          >
            🏆 برد ({stats.winCount})
          </button>
          <button
            onClick={() => setDirFilter("LOSSES")}
            title={`${stats.lossCount} کندل ساعتی بازنده`}
            className={`text-xs px-2.5 py-1 rounded-md transition-all ${
              dirFilter === "LOSSES"
                ? "bg-rose-500/25 text-rose-300 font-semibold border border-rose-500/40"
                : "text-[#9a9ca3] hover:text-rose-400"
            }`}
          >
            ❌ باخت ({stats.lossCount})
          </button>
          {stats.winRate != null && (
            <div
              className="flex items-center gap-1.5 px-3 py-1 rounded-md bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs font-bold"
              title={`${stats.winCount} برد از ${stats.winCount + stats.lossCount} کندل ساعتی بسته‌شده (${stats.rawSignalSnapshots} اسنپ‌شات کل)`}
            >
              <span>وین‌ریت ساعتی:</span>
              <span className="font-mono text-sm">{stats.winRate}%</span>
              {stats.pendingCount > 0 && (
                <span className="text-[10px] text-amber-300 font-normal mr-1">
                  ({stats.pendingCount} زنده)
                </span>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Checkbox: Hide Duplicate Hourly Signals */}
          <label
            className={`flex items-center gap-1.5 text-xs cursor-pointer select-none px-2.5 py-1 rounded-lg border transition-all ${
              onlyFirstHourlySignal
                ? "bg-amber-500/15 text-amber-300 border-amber-500/40 font-medium"
                : "bg-white/[0.04] text-[#9a9ca3] border-white/[0.08] hover:bg-white/[0.08] hover:text-white"
            }`}
            title="عدم نمایش سیگنال‌های تکراری با جهت یکسان در طول همان ساعت (فقط اولین اسنپ‌شات سیگنال‌دار در هر ساعت نمایش داده می‌شود)"
          >
            <input
              type="checkbox"
              checked={onlyFirstHourlySignal}
              onChange={(e) => setOnlyFirstHourlySignal(e.target.checked)}
              className="rounded border-white/20 bg-[#181a1e] text-[#6aa9d8] focus:ring-0 focus:ring-offset-0 cursor-pointer w-3.5 h-3.5"
            />
            <span className="flex items-center gap-1">
              <Zap className="w-3 h-3 text-amber-400" />
              <span>فقط اولین سیگنال ساعت (حذف تکراری‌های هم‌جهت)</span>
            </span>
          </label>
          {sortConfig && (
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#6aa9d8]/15 border border-[#6aa9d8]/30 text-[#6aa9d8] text-xs font-medium animate-in fade-in">
              <span>
                مرتب‌سازی:{" "}
                {sortConfig.key === "time"
                  ? "زمان"
                  : ALL_COLUMNS.find((c) => c.id === sortConfig.key)?.label || sortConfig.key}{" "}
                ({sortConfig.dir === "desc" ? "نزولی ↓" : "صعودی ↑"})
              </span>
              <button
                onClick={() => setSortConfig(null)}
                className="hover:text-white mr-1 text-sm font-bold transition-colors"
                title="حذف مرتب‌سازی و بازگشت به ترتیب پیش‌فرض زمانی"
              >
                ✕
              </button>
            </div>
          )}

          <div className="relative">
            <Search className="w-3.5 h-3.5 text-[#73757c] absolute right-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="جستجو در زمان، ساعت یا اسکور..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-white/[0.05] border border-white/[0.1] rounded-lg pr-8 pl-3 py-1 text-xs text-white placeholder-[#73757c] focus:outline-none focus:border-[#6aa9d8] w-52"
            />
          </div>

          <button
            onClick={exportCsv}
            disabled={sortedData.length === 0}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] text-xs text-[#bdbdb8] border border-white/[0.08] transition-all disabled:opacity-50"
            title="دانلود خروجی CSV"
          >
            <Download className="w-3 h-3 text-[#6aa9d8]" />
            <span className="hidden sm:inline">CSV</span>
          </button>

          <button
            onClick={exportPdf}
            disabled={sortedData.length === 0}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#6aa9d8]/15 hover:bg-[#6aa9d8]/25 text-xs text-[#6aa9d8] border border-[#6aa9d8]/30 transition-all disabled:opacity-50 font-medium"
            title="چاپ و دانلود خروجی PDF"
          >
            <Printer className="w-3 h-3" />
            <span className="hidden sm:inline">PDF</span>
          </button>
        </div>
      </div>

      {/* Main Table */}
      <div className="bg-[#131418] border border-[rgba(190,190,200,0.15)] rounded-2xl overflow-hidden shadow-lg">
        {loading ? (
          <div className="p-12 text-center text-xs text-[#9a9ca3] flex flex-col items-center justify-center gap-3">
            <RefreshCw className="w-6 h-6 animate-spin text-[#6aa9d8]" />
            <span>در حال بارگذاری فایل‌های تاریخی Jev...</span>
          </div>
        ) : error ? (
          <div className="p-8 text-center text-xs text-[#e5787f]">{error}</div>
        ) : sortedData.length === 0 ? (
          <div className="p-12 text-center text-xs text-[#9a9ca3]">
            هیچ داده‌ای مطابق با بازه زمانی یا فیلترهای انتخابی یافت نشد.
          </div>
        ) : (
          <div className="overflow-x-auto max-h-[650px] overflow-y-auto">
            <table className="w-full text-right text-xs border-collapse">
              <thead className="sticky top-0 z-10 bg-[#181a1e] text-[#9a9ca3] border-b border-white/[0.1] text-[11px] tracking-wider">
                <tr>
                  <th className="py-3.5 px-4 font-semibold text-center w-14">ردیف</th>
                  <th
                    onClick={() => handleSort("time")}
                    className="py-3.5 px-4 font-semibold cursor-pointer select-none hover:text-white transition-colors group"
                    title="برای مرتب‌سازی بر اساس زمان و تاریخ کلیک کنید"
                  >
                    <div className="flex items-center gap-1.5">
                      <span>زمان و ساعت (ET)</span>
                      {sortConfig?.key === "time" ? (
                        sortConfig.dir === "desc" ? (
                          <ArrowDown className="w-3.5 h-3.5 text-[#6aa9d8]" />
                        ) : (
                          <ArrowUp className="w-3.5 h-3.5 text-[#6aa9d8]" />
                        )
                      ) : (
                        <ArrowUpDown className="w-3 h-3 text-[#73757c] opacity-40 group-hover:opacity-100" />
                      )}
                    </div>
                  </th>
                  {activeColumns.map((col) => {
                    const isSorted = sortConfig?.key === col.id;
                    return (
                      <th
                        key={col.id}
                        onClick={() => handleSort(col.id)}
                        className="py-3.5 px-4 font-semibold cursor-pointer select-none hover:text-white transition-colors group"
                        title={`برای مرتب‌سازی بر اساس ${col.label} کلیک کنید`}
                      >
                        <div className="flex items-center gap-1.5">
                          <span>{col.label}</span>
                          {isSorted ? (
                            sortConfig.dir === "desc" ? (
                              <ArrowDown className="w-3.5 h-3.5 text-[#6aa9d8]" />
                            ) : (
                              <ArrowUp className="w-3.5 h-3.5 text-[#6aa9d8]" />
                            )
                          ) : (
                            <ArrowUpDown className="w-3 h-3 text-[#73757c] opacity-40 group-hover:opacity-100" />
                          )}
                        </div>
                      </th>
                    );
                  })}
                  <th className="py-3.5 px-4 font-semibold text-center">عملیات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.05]">
                {sortedData.slice(0, visibleRowsCount).map((row, index) => {
                  const outcomeInfo = evaluateSignalOutcome(row, signals);
                  return (
                    <tr
                      key={row.filename}
                      className={`transition-colors group cursor-pointer ${
                        outcomeInfo.hasSignal
                          ? `${outcomeInfo.bgClass} ${outcomeInfo.borderClass}`
                          : "hover:bg-white/[0.03]"
                      }`}
                      onClick={() => viewFile(row.filename)}
                    >
                      <td className="py-3 px-4 text-[#73757c] font-mono tabular-nums text-center">
                        {sortConfig && sortConfig.dir === "asc"
                          ? index + 1
                          : sortedData.length - index}
                      </td>

                      <td className="py-3 px-4 font-mono text-[#e8e8e4] whitespace-nowrap">
                        <div className="font-semibold text-white">
                          {row.current_time_et || row.et_time}
                        </div>
                        <div className="text-[10px] text-[#73757c] truncate max-w-[170px]" title={row.filename}>
                          {row.filename}
                        </div>
                      </td>

                    {activeColumns.map((col) => (
                      <td key={col.id} className="py-3 px-4 whitespace-nowrap">
                        {col.render(row, signals)}
                      </td>
                    ))}

                    <td
                      className="py-3 px-4 text-center whitespace-nowrap"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="flex items-center justify-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => viewFile(row.filename)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-[#6aa9d8]/15 hover:bg-[#6aa9d8]/25 text-[#6aa9d8] text-[11px] transition-colors"
                        >
                          <Eye className="w-3 h-3" />
                          مشاهده
                        </button>
                        <a
                          href={`/api/jev/history?file=${row.filename}`}
                          target="_blank"
                          rel="noreferrer"
                          className="p-1 rounded bg-white/[0.06] hover:bg-white/[0.12] text-[#9a9ca3] hover:text-white transition-colors"
                          title="دانلود فایل JSON"
                        >
                          <Download className="w-3 h-3" />
                        </a>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            </table>
          </div>
        )}

        {visibleRowsCount < sortedData.length && (
          <div className="flex items-center justify-center gap-3 p-3.5 border-t border-white/[0.08] bg-[#181a1e]/80">
            <button
              type="button"
              onClick={() => setVisibleRowsCount((prev) => prev + 100)}
              className="px-4 py-1.5 rounded-lg bg-[#6aa9d8]/20 hover:bg-[#6aa9d8]/30 text-[#6aa9d8] text-xs font-medium transition-colors"
            >
              نمایش ۱۰۰ سطر دیگر ({Math.min(visibleRowsCount, sortedData.length)} از {sortedData.length})
            </button>
            <button
              type="button"
              onClick={() => setVisibleRowsCount(sortedData.length)}
              className="px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] text-[#9a9ca3] text-xs font-medium transition-colors"
            >
              نمایش همه ({sortedData.length})
            </button>
          </div>
        )}

        <div className="bg-[#181a1e]/90 border-t border-white/[0.08] px-4 py-2.5 flex items-center justify-between text-[11px] text-[#9a9ca3]">
          <span>نمایش {Math.min(visibleRowsCount, sortedData.length)} از {filteredData.length} فایل اسنپ‌شات (در بازه انتخابی)</span>
          <span>مسیر فایل‌ها در سرور: <code className="text-[#6aa9d8]">/jev/history/</code></span>
        </div>
      </div>

      {/* JSON Viewer Modal */}
      {selectedFileForModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#131418] border border-[#6aa9d8]/40 rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/[0.08] bg-[#181a1e]">
              <div className="flex items-center gap-2">
                <FileJson className="w-4 h-4 text-[#6aa9d8]" />
                <span className="text-xs font-semibold text-white">
                  محتوای کامل فایل: <b className="font-mono text-[#6aa9d8]">{selectedFileForModal}</b>
                </span>
              </div>
              <div className="flex items-center gap-2">
                <a
                  href={`/api/jev/history?file=${selectedFileForModal}`}
                  target="_blank"
                  rel="noreferrer"
                  className="px-2.5 py-1 rounded bg-white/[0.08] hover:bg-white/[0.15] text-[11px] text-[#bdbdb8] transition-colors"
                >
                  دانلود مستقیم
                </a>
                <button
                  type="button"
                  onClick={() => setSelectedFileForModal(null)}
                  className="text-[#9a9ca3] hover:text-white text-base px-2"
                >
                  ✕
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-auto p-4 bg-[#0f1013]">
              {fileLoading ? (
                <div className="p-12 text-center text-xs text-[#9a9ca3]">
                  در حال بازخوانی فایل JSON...
                </div>
              ) : (
                <pre className="font-mono text-[11px] leading-relaxed text-[#bdbdb8] whitespace-pre selection:bg-[#6aa9d8]/30">
                  {fileContent}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
