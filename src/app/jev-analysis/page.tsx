"use client";

import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import Link from "next/link";
import { withHistorySet } from "@/lib/historyDataset";
import { DatasetSwitch } from "@/components/DatasetSwitch";
import { FieldFilterPanel } from "@/components/FieldFilterPanel";
import { DIR_CHOICES, claudeEdge, snapshotFilterFields } from "@/lib/snapshotFilterFields";
import {
  NONE,
  addCondition,
  compileFilters,
  describeFilters,
  isConditionReady,
  sanitizeFilterGroups,
  type FilterField,
  type FilterGroup,
} from "@/lib/fieldFilters";
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
  bullishScore: number;     // e.g. 3.5 (score must be above this)
  bullishMaxScore: number;  // e.g. 4; score must be at or below this
  bullishMinConf: number;   // e.g. 90
  bullishMaxConf: number;   // e.g. 98; 100 = no upper cap
  bearishScore: number;     // e.g. 0.5 (score must be below this)
  bearishMinScore: number;  // e.g. 0; score must be at or above this
  bearishMinConf: number;   // e.g. 90
  bearishMaxConf: number;   // e.g. 98; 100 = no upper cap
  confidenceType: "score" | "direction" | "any";
  bullishColor: string;     // default "#6aa9d8"
  bearishColor: string;     // default "#d8646a"
  modelSource?: "jev" | "kev" | "span" | "solar" | "tev" | "mercury" | "liquid" | "consensus"; // Default "jev"
}

const DEFAULT_SIGNAL_CONFIG: SignalMarkerConfig = {
  enabled: true,
  bullishScore: 3.5,
  bullishMaxScore: 4,
  bullishMinConf: 90,
  bullishMaxConf: 100,
  bearishScore: 0.5,
  bearishMinScore: 0,
  bearishMinConf: 90,
  bearishMaxConf: 100,
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
  } else if (modelSrc === "tev") {
    targetScore = r.tev_score;
    conf = cfg.confidenceType === "direction"
      ? r.tev_direction_confidence ?? r.tev_confidence
      : r.tev_score_confidence ?? r.tev_confidence;
    modelName = "Tev-4b";
  } else if (modelSrc === "mercury") {
    targetScore = r.mercury_score;
    conf = cfg.confidenceType === "direction"
      ? r.mercury_direction_confidence ?? r.mercury_confidence
      : r.mercury_score_confidence ?? r.mercury_confidence;
    modelName = "Mercury-Decide";
  } else if (modelSrc === "liquid") {
    targetScore = r.liquid_score;
    conf = cfg.confidenceType === "direction"
      ? r.liquid_direction_confidence ?? r.liquid_confidence
      : r.liquid_score_confidence ?? r.liquid_confidence;
    modelName = "Liquid-D1";
  } else if (modelSrc === "consensus") {
    const scores = [r.score, r.kev_score, r.span_score].filter((s): s is number => s != null);
    targetScore = scores.length > 0 ? Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)) : null;
    conf = r.consensus_agreement ?? r.score_confidence;
    modelName = "Model consensus";
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

  const bullishMaxConf = cfg.bullishMaxConf ?? 100;
  const bearishMaxConf = cfg.bearishMaxConf ?? 100;
  const bullishMaxScore = cfg.bullishMaxScore ?? 4;
  const bearishMinScore = cfg.bearishMinScore ?? 0;

  // Bullish: 3.5 < Target Score <= Max score AND at the same time Min <= Confidence <= Max (e.g. 90..98%)
  if (targetScore > cfg.bullishScore && targetScore <= bullishMaxScore && conf >= cfg.bullishMinConf && conf <= bullishMaxConf) {
    return {
      type: "BULLISH",
      direction: "UP",
      label: `Bullish signal (${modelName} - blue tick)`,
      rule: `${modelName} score > ${cfg.bullishScore} and confidence ${cfg.bullishMinConf}–${bullishMaxConf}%`,
      color: cfg.bullishColor || "#6aa9d8",
      bgColor: "rgba(106,169,216, 0.15)",
      borderColor: cfg.bullishColor || "#6aa9d8",
      score: targetScore,
      confidence: conf,
      sourceModel: modelName,
    };
  }

  // Bearish: Min score <= Target Score < 0.5 AND at the same time Min <= Confidence <= Max (e.g. 90..98%)
  if (targetScore < cfg.bearishScore && targetScore >= bearishMinScore && conf >= cfg.bearishMinConf && conf <= bearishMaxConf) {
    return {
      type: "BEARISH",
      direction: "DOWN",
      label: `Bearish signal (${modelName} - red tick)`,
      rule: `${modelName} score < ${cfg.bearishScore} and confidence ${cfg.bearishMinConf}–${bearishMaxConf}%`,
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
  fair_claude?: number | null; // Claude 1H fair value, cents; only CL records carry it
  spot_price?: number | null;
  open_price?: number | null;
  price_to_beat?: number | null;
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
  // Together Tev-4b and Inception Mercury-Decide (extras, not part of the 3-model consensus)
  tev_direction?: "UP" | "DOWN" | null;
  tev_score?: number | null;
  tev_score_label?: string | null;
  tev_confidence?: number | null;
  tev_score_confidence?: number | null;
  tev_direction_confidence?: number | null;
  tev_prob_up?: number | null;
  mercury_direction?: "UP" | "DOWN" | null;
  mercury_score?: number | null;
  mercury_score_label?: string | null;
  mercury_confidence?: number | null;
  mercury_score_confidence?: number | null;
  mercury_direction_confidence?: number | null;
  mercury_prob_up?: number | null;
  // Liquid D1 (extra, not part of the 3-model consensus)
  liquid_direction?: "UP" | "DOWN" | null;
  liquid_score?: number | null;
  liquid_score_label?: string | null;
  liquid_confidence?: number | null;
  liquid_score_confidence?: number | null;
  liquid_direction_confidence?: number | null;
  liquid_prob_up?: number | null;
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

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** UP probability and confidence columns for the extra models (Solar, Tev, Mercury, Liquid), mirroring the Kev columns. */
function extraModelColumns(
  prefix: "solar" | "tev" | "mercury" | "liquid",
  name: string,
  short: string,
  color: string
): ColumnDef[] {
  const val = (r: JevFileRecord, key: string): number | null =>
    (r as unknown as Record<string, number | null | undefined>)[`${prefix}_${key}`] ?? null;
  const col = (key: string, label: string, shortLabel: string, withBar: boolean): ColumnDef => ({
    id: `${prefix}_${key}`,
    label,
    shortLabel,
    category: "models",
    render: (r) => {
      const v = val(r, key);
      if (v == null) return <span className="text-[#73757c]">—</span>;
      return (
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-xs font-semibold tabular-nums" style={{ color }}>
            {v}%
          </span>
          {withBar && (
            <div className="w-10 h-1.5 bg-white/[0.08] rounded-full overflow-hidden hidden sm:block">
              <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, v))}%`, backgroundColor: color }} />
            </div>
          )}
        </div>
      );
    },
    exportVal: (r) => {
      const v = val(r, key);
      return v != null ? `${v}%` : "";
    },
  });
  return [
    col("prob_up", `${name} UP Probability (%UP)`, `${short} %UP`, true),
    col("score_confidence", `${name} Score Confidence (%)`, `${short} score confidence`, true),
    col("direction_confidence", `${name} Direction Confidence (%)`, `${short} direction confidence`, true),
    col("confidence", `${name} Overall Confidence (%)`, `${short} confidence`, false),
  ];
}

const ALL_COLUMNS: ColumnDef[] = [
  {
    id: "coin",
    label: "Coin",
    shortLabel: "Coin",
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
    label: "3-model consensus (Jev + Kev + Span)",
    shortLabel: "Model consensus",
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
            {ups}/3 full UP
          </span>
        );
      }
      if (downs === dirs.length) {
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-[#e5787f]/20 text-[#e5787f] border border-[#e5787f]/40">
            <span className="w-1.5 h-1.5 rounded-full bg-[#e5787f]" />
            {downs}/3 full DOWN
          </span>
        );
      }
      if (ups > downs) {
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-[#5fbf9a]/10 text-[#8fd0a8] border border-[#5fbf9a]/20">
            {ups}/3 leaning UP
          </span>
        );
      }
      if (downs > ups) {
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-[#e5787f]/10 text-[#eba0a5] border border-[#e5787f]/20">
            {downs}/3 leaning DOWN
          </span>
        );
      }
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs text-[#9a9ca3] bg-white/[0.05] border border-white/[0.1]">
          Split
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
    label: "Conditional signal tick",
    shortLabel: "Signal tick",
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
            {sig.type === "BULLISH" ? "Bullish signal (blue)" : "Bearish signal (red)"}
          </span>
          {r.is_first_hourly_signal ? (
            <span className="text-[10px] text-amber-300 font-semibold flex items-center gap-0.5 pr-1" title="First signal issued this hour (1-hour candle)">
              <Zap className="w-2.5 h-2.5 text-amber-400" />
              First signal of hour
            </span>
          ) : (
            <span className="text-[10px] text-[#73757c] pr-1" title="Repeat signal in the same direction this hour">
              Repeat in hour
            </span>
          )}
        </div>
      );
    },
    exportVal: (r, cfg) => {
      const sig = evaluateSignal(r, cfg || DEFAULT_SIGNAL_CONFIG);
      if (!sig) return "";
      return `${sig.label} ${r.is_first_hourly_signal ? "(first signal of hour)" : "(repeat in hour)"}`;
    },
    sortVal: (r, cfg) => {
      const sig = evaluateSignal(r, cfg || DEFAULT_SIGNAL_CONFIG);
      if (!sig) return 0;
      return r.is_first_hourly_signal ? (sig.type === "BULLISH" ? 4 : 3) : (sig.type === "BULLISH" ? 2 : 1);
    },
  },
  {
    id: "signal_result",
    label: "Signal result (win / loss)",
    shortLabel: "Win / Loss",
    category: "models",
    render: (r, cfg) => {
      const res = evaluateSignalOutcome(r, cfg || DEFAULT_SIGNAL_CONFIG);
      if (!res.hasSignal) return <span className="text-[#73757c]">—</span>;
      if (res.status === "WIN") {
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 shadow-sm">
            <span className="text-emerald-300 font-bold">✓</span>
            WIN
          </span>
        );
      }
      if (res.status === "LOSS") {
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-bold bg-rose-500/20 text-rose-400 border border-rose-500/40 shadow-sm">
            <span className="text-rose-300 font-bold">✗</span>
            LOSS
          </span>
        );
      }
      return (
        <span
          className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-500/15 text-amber-300 border border-amber-500/30"
          title="Signal is active, waiting for the candle to close or final UMA oracle confirmation (10-30 minute window)"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
          ⏳ Awaiting result
        </span>
      );
    },
    exportVal: (r, cfg) => {
      const res = evaluateSignalOutcome(r, cfg || DEFAULT_SIGNAL_CONFIG);
      return res.hasSignal ? (res.status === "WIN" ? "Win" : res.status === "LOSS" ? "Loss" : "Pending") : "";
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
    label: "Final 1-hour market result (Polymarket Outcome)",
    shortLabel: "Market result",
    category: "market",
    render: (r) => {
      if (r.market_outcome === "UP") {
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
            🟢 UP
          </span>
        );
      }
      if (r.market_outcome === "DOWN") {
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-rose-500/20 text-rose-400 border border-rose-500/30">
            🔴 DOWN
          </span>
        );
      }
      if (r.market_outcome === "PENDING") {
        return (
          <span
            className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium text-amber-300 bg-amber-500/15 border border-amber-500/30"
            title="Candle has closed; final confirmation by the Polymarket UMA oracle takes 10 to 30 minutes"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
            ⏳ Awaiting confirmation (10-30 min)
          </span>
        );
      }
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] text-sky-400/80 bg-sky-500/10 border border-sky-500/20">
          ⚡ Live (current candle)
        </span>
      );
    },
    exportVal: (r) => r.market_outcome || "",
    sortVal: (r) => (r.market_outcome === "UP" ? 3 : r.market_outcome === "PENDING" ? 2 : r.market_outcome === "DOWN" ? 1 : 0),
  },
  {
    id: "direction",
    label: "Jev Direction",
    shortLabel: "Jev direction",
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
    label: "Jev Score (0 - 4)",
    shortLabel: "Jev score",
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
            {r.score >= 3 ? "Strong bullish" : r.score <= 1 ? "Strong bearish" : "Neutral"}
          </span>
        </div>
      ) : (
        <span className="text-[#73757c]">—</span>
      ),
    exportVal: (r) => r.score ?? "",
  },
  {
    id: "kev_direction",
    label: "Kev-4b Direction",
    shortLabel: "Kev direction",
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
    label: "Kev-4b Score (0 - 4)",
    shortLabel: "Kev score",
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
    label: "Kev-4b Score Confidence (%)",
    shortLabel: "Kev score confidence",
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
    label: "Kev-4b Direction Confidence (%)",
    shortLabel: "Kev direction confidence",
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
    label: "Kev-4b Overall Confidence (%)",
    shortLabel: "Kev confidence",
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
    label: "Kev-4b UP Probability (%UP)",
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
    label: "Span-01 Signal",
    shortLabel: "Span signal",
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
    label: "Span-01 Score (0 - 4)",
    shortLabel: "Span score",
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
    label: "Solar-Decide Signal (extra filter)",
    shortLabel: "Solar signal",
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
    label: "Solar-Decide Score (0 - 4)",
    shortLabel: "Solar score",
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
    id: "tev_direction",
    label: "Tev-4b Signal",
    shortLabel: "Tev signal",
    category: "models",
    render: (r) =>
      r.tev_direction ? (
        <span
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold ${
            r.tev_direction === "UP"
              ? "bg-[#4fb8b0]/20 text-[#4fb8b0] border border-[#4fb8b0]/30"
              : "bg-[#e5787f]/20 text-[#e5787f] border border-[#e5787f]/30"
          }`}
        >
          {r.tev_direction === "UP" ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
          {r.tev_direction}
        </span>
      ) : (
        <span className="text-[#73757c]">—</span>
      ),
    exportVal: (r) => r.tev_direction || "",
  },
  {
    id: "tev_score",
    label: "Tev-4b Score (0 - 4)",
    shortLabel: "Tev score",
    category: "models",
    render: (r) =>
      r.tev_score != null ? (
        <span className="inline-flex items-center gap-1 font-mono text-xs font-semibold tabular-nums text-white">
          {r.tev_score.toFixed(2)}
          {r.tev_confidence != null && <span className="text-[10px] text-[#4fb8b0]">({r.tev_confidence}%)</span>}
        </span>
      ) : (
        <span className="text-[#73757c]">—</span>
      ),
    exportVal: (r) => r.tev_score ?? "",
  },
  {
    id: "mercury_direction",
    label: "Mercury-Decide Signal",
    shortLabel: "Mercury signal",
    category: "models",
    render: (r) =>
      r.mercury_direction ? (
        <span
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold ${
            r.mercury_direction === "UP"
              ? "bg-[#9ccf6a]/20 text-[#9ccf6a] border border-[#9ccf6a]/30"
              : "bg-[#e5787f]/20 text-[#e5787f] border border-[#e5787f]/30"
          }`}
        >
          {r.mercury_direction === "UP" ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
          {r.mercury_direction}
        </span>
      ) : (
        <span className="text-[#73757c]">—</span>
      ),
    exportVal: (r) => r.mercury_direction || "",
  },
  {
    id: "mercury_score",
    label: "Mercury-Decide Score (0 - 4)",
    shortLabel: "Mercury score",
    category: "models",
    render: (r) =>
      r.mercury_score != null ? (
        <span className="inline-flex items-center gap-1 font-mono text-xs font-semibold tabular-nums text-white">
          {r.mercury_score.toFixed(2)}
          {r.mercury_confidence != null && <span className="text-[10px] text-[#9ccf6a]">({r.mercury_confidence}%)</span>}
        </span>
      ) : (
        <span className="text-[#73757c]">—</span>
      ),
    exportVal: (r) => r.mercury_score ?? "",
  },
  {
    id: "liquid_direction",
    label: "Liquid-D1 Signal",
    shortLabel: "Liquid signal",
    category: "models",
    render: (r) =>
      r.liquid_direction ? (
        <span
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold ${
            r.liquid_direction === "UP"
              ? "bg-[#9ccf6a]/20 text-[#9ccf6a] border border-[#9ccf6a]/30"
              : "bg-[#e5787f]/20 text-[#e5787f] border border-[#e5787f]/30"
          }`}
        >
          {r.liquid_direction === "UP" ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
          {r.liquid_direction}
        </span>
      ) : (
        <span className="text-[#73757c]">—</span>
      ),
    exportVal: (r) => r.liquid_direction || "",
  },
  {
    id: "liquid_score",
    label: "Liquid-D1 Score (0 - 4)",
    shortLabel: "Liquid score",
    category: "models",
    render: (r) =>
      r.liquid_score != null ? (
        <span className="inline-flex items-center gap-1 font-mono text-xs font-semibold tabular-nums text-white">
          {r.liquid_score.toFixed(2)}
          {r.liquid_confidence != null && <span className="text-[10px] text-[#b58cd9]">({r.liquid_confidence}%)</span>}
        </span>
      ) : (
        <span className="text-[#73757c]">—</span>
      ),
    exportVal: (r) => r.liquid_score ?? "",
  },
  {
    id: "span_confidence",
    label: "Span-01 Score Confidence",
    shortLabel: "Span confidence",
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
    label: "Span-01 UP Probability (%UP)",
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
    label: "Jev UP Probability (%UP)",
    shortLabel: "UP probability",
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
    label: "Jev Score Confidence (%)",
    shortLabel: "Score confidence",
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
    label: "Jev Direction Confidence (%)",
    shortLabel: "Direction confidence",
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
    label: "Jev Overall Confidence (%)",
    shortLabel: "Overall confidence",
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
    label: "Polymarket 1-hour (1H Up)",
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
    label: "Polymarket 15-minute (15M Up)",
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
    label: "Polymarket 5-minute (5M Up)",
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
    label: "Fair Value (15m model)",
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
    label: "Fair Value (5m model)",
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
    label: "Fair Value (Joint Solve model)",
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
    label: "Fair Value (Base No Drift model)",
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
    id: "fair_claude",
    label: "Fair Value (Claude 1H model)",
    shortLabel: "Fair Claude",
    category: "fair",
    render: (r) =>
      r.fair_claude != null ? (
        <span className="font-mono text-xs text-[#d97757] tabular-nums">
          {r.fair_claude.toFixed(1)}¢
        </span>
      ) : (
        <span className="text-[#73757c]" title="Only the CL dataset has the Claude fair value">—</span>
      ),
    exportVal: (r) => (r.fair_claude != null ? `${r.fair_claude}c` : ""),
  },
  {
    id: "claude_edge",
    label: "Claude edge (Claude fair value − 1H Up price)",
    shortLabel: "Claude edge",
    category: "fair",
    render: (r) => {
      const e = claudeEdge(r);
      if (e == null) return <span className="text-[#73757c]">—</span>;
      return (
        <span
          className="font-mono text-xs tabular-nums font-semibold"
          style={{ color: e > 0 ? "#5fbf9a" : e < 0 ? "#e5787f" : "#9a9ca3" }}
          title="Positive: Claude prices UP above the market. Negative: below it."
        >
          {e > 0 ? "+" : ""}
          {e.toFixed(1)}¢
        </span>
      );
    },
    exportVal: (r) => {
      const e = claudeEdge(r);
      return e != null ? `${e}c` : "";
    },
    sortVal: (r) => claudeEdge(r),
  },
  {
    id: "tokens",
    label: "Jev Tokens & Cost",
    shortLabel: "Query cost",
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
  ...extraModelColumns("solar", "Solar-Decide", "Solar", "#d49a4a"),
  ...extraModelColumns("tev", "Tev-4b", "Tev", "#4fb8b0"),
  ...extraModelColumns("mercury", "Mercury-Decide", "Mercury", "#9ccf6a"),
  ...extraModelColumns("liquid", "Liquid-D1", "Liquid", "#b58cd9"),
];

const PRESETS = [
  {
    id: "multi_models",
    title: "All models",
    cols: ["coin", "consensus", "signal", "signal_result", "direction", "score", "kev_direction", "kev_score", "span_direction", "span_score", "solar_direction", "solar_score", "tev_direction", "tev_score", "mercury_direction", "mercury_score", "liquid_direction", "liquid_score", "up_1h", "market_outcome"],
  },
  {
    id: "top3",
    title: "Core",
    cols: ["coin", "consensus", "signal", "signal_result", "direction", "score", "kev_direction", "kev_score", "span_direction", "span_score", "solar_direction", "solar_score", "up_1h", "market_outcome"],
  },
  {
    id: "ai",
    title: "Confidence",
    cols: ["coin", "direction", "score", "score_confidence", "kev_direction", "kev_score", "kev_score_confidence", "kev_direction_confidence", "span_direction", "span_score", "solar_direction", "solar_score", "span_confidence"],
  },
  {
    id: "markets",
    title: "Markets",
    cols: ["coin", "direction", "up_1h", "up_15m", "up_5m", "market_outcome"],
  },
  {
    id: "fair_values",
    title: "Fair value",
    cols: ["coin", "direction", "fair_15m", "fair_5m", "fair_joint", "fair_claude"],
  },
  {
    id: "signals",
    title: "Signals",
    cols: ["coin", "signal", "signal_result", "market_outcome", "direction", "score", "score_confidence", "up_1h"],
  },
  {
    id: "full",
    title: "Full",
    cols: ["coin", "consensus", "signal", "signal_result", "market_outcome", "direction", "score", "score_confidence", "kev_direction", "kev_score", "kev_score_confidence", "kev_direction_confidence", "span_direction", "span_score", "solar_direction", "solar_score", "tev_direction", "tev_score", "mercury_direction", "mercury_score", "liquid_direction", "liquid_score", "span_confidence", "span_prob_up", "up_1h", "fair_15m"],
  },
];

// Column picker layout: columns grouped by AI model. Display only; ColumnDef.label stays as-is for headers/exports.
const COLUMN_GROUPS: { id: string; title: string; dot: string; cols: [string, string][] }[] = [
  {
    id: "general",
    title: "General",
    dot: "#bdbdb8",
    cols: [
      ["coin", "Coin"],
      ["consensus", "3-model consensus"],
      ["signal", "Signal marker"],
      ["signal_result", "Signal win/loss"],
      ["market_outcome", "Market outcome"],
    ],
  },
  {
    id: "jev",
    title: "Jev",
    dot: "#6aa9d8",
    cols: [
      ["direction", "Direction"],
      ["score", "Score"],
      ["prob_up", "Prob UP"],
      ["score_confidence", "Score conf."],
      ["direction_confidence", "Direction conf."],
      ["confidence", "Overall conf."],
      ["tokens", "Tokens / cost"],
    ],
  },
  {
    id: "kev",
    title: "Kev-4b",
    dot: "#a795d6",
    cols: [
      ["kev_direction", "Direction"],
      ["kev_score", "Score"],
      ["kev_prob_up", "Prob UP"],
      ["kev_score_confidence", "Score conf."],
      ["kev_direction_confidence", "Direction conf."],
      ["kev_confidence", "Overall conf."],
    ],
  },
  {
    id: "span",
    title: "Span-01",
    dot: "#d68aa8",
    cols: [
      ["span_direction", "Direction"],
      ["span_score", "Score"],
      ["span_prob_up", "Prob UP"],
      ["span_confidence", "Confidence"],
    ],
  },
  {
    id: "solar",
    title: "Solar-Decide",
    dot: "#d49a4a",
    cols: [
      ["solar_direction", "Direction"],
      ["solar_score", "Score"],
      ["solar_prob_up", "Prob UP"],
      ["solar_score_confidence", "Score conf."],
      ["solar_direction_confidence", "Direction conf."],
      ["solar_confidence", "Overall conf."],
    ],
  },
  {
    id: "tev",
    title: "Tev-4b",
    dot: "#4fb8b0",
    cols: [
      ["tev_direction", "Direction"],
      ["tev_score", "Score"],
      ["tev_prob_up", "Prob UP"],
      ["tev_score_confidence", "Score conf."],
      ["tev_direction_confidence", "Direction conf."],
      ["tev_confidence", "Overall conf."],
    ],
  },
  {
    id: "mercury",
    title: "Mercury-Decide",
    dot: "#9ccf6a",
    cols: [
      ["mercury_direction", "Direction"],
      ["mercury_score", "Score"],
      ["mercury_prob_up", "Prob UP"],
      ["mercury_score_confidence", "Score conf."],
      ["mercury_direction_confidence", "Direction conf."],
      ["mercury_confidence", "Overall conf."],
    ],
  },
  {
    id: "liquid",
    title: "Liquid-D1",
    dot: "#b58cd9",
    cols: [
      ["liquid_direction", "Direction"],
      ["liquid_score", "Score"],
      ["liquid_prob_up", "Prob UP"],
      ["liquid_score_confidence", "Score conf."],
      ["liquid_direction_confidence", "Direction conf."],
      ["liquid_confidence", "Overall conf."],
    ],
  },
  {
    id: "market",
    title: "Polymarket",
    dot: "#5fbf9a",
    cols: [
      ["up_1h", "1H Up"],
      ["up_15m", "15M Up"],
      ["up_5m", "5M Up"],
    ],
  },
  {
    id: "fair",
    title: "Fair value",
    dot: "#9fb4ee",
    cols: [
      ["fair_15m", "15m"],
      ["fair_5m", "5m"],
      ["fair_joint", "Joint solve"],
      ["fair_base", "Base (no drift)"],
      ["fair_claude", "Claude"],
      ["claude_edge", "Claude edge"],
    ],
  },
];

// ---------- field filters ----------
/**
 * Every field the filter panel can test: the shared snapshot fields, plus the signal tick and its result, which
 * follow the current tick conditions. Ids match the table column ids, so the visible columns can be offered first.
 */
function buildFilterFields(signals: SignalMarkerConfig, coins: string[]): FilterField<JevFileRecord>[] {
  return snapshotFilterFields<JevFileRecord>((r) => r, coins, [
    { id: "signal", label: "Signal tick", group: "Signal", kind: "choice", choices: DIR_CHOICES, get: (r) => evaluateSignal(r, signals)?.direction },
    {
      id: "signal_result", label: "Signal result", group: "Signal", kind: "choice",
      choices: [{ value: "WIN", label: "WIN" }, { value: "LOSS", label: "LOSS" }, { value: "PENDING", label: "pending" }, { value: NONE, label: "no signal" }],
      get: (r) => {
        const s = evaluateSignalOutcome(r, signals).status;
        return s === "NO_SIGNAL" ? null : s;
      },
    },
  ]);
}

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
  { key: "all", label: "All coins" },
  { key: "btc", label: "Bitcoin (BTC)", color: "#d49a4a" },
  { key: "eth", label: "Ethereum (ETH)", color: "#627EEA" },
  { key: "sol", label: "Solana (SOL)", color: "#14F195" },
  { key: "xrp", label: "Ripple (XRP)", color: "#7FA8C9" },
  { key: "doge", label: "Dogecoin (DOGE)", color: "#C2A633" },
  { key: "hype", label: "Hyperliquid (HYPE)", color: "#97FCE4" },
  { key: "bnb", label: "BNB", color: "#F3BA2F" },
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
    fairClaude: boolean;
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
    fairClaude: false,
    up5m: false,
    signals: true,
    kevScore: false,
    spanScore: false,
  });

  // Signal Markers Configuration (blue and red conditional ticks on the curve)
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
  // Conditions on any field (ranges, comparisons, choices): ANDed within a group, groups ORed
  const [fieldFilters, setFieldFilters] = useState<FilterGroup[]>([]);
  const filterPanelRef = useRef<HTMLDivElement | null>(null);
  const [selectedFileForModal, setSelectedFileForModal] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);

  // Dashboard Persistence (saving settings in the browser)
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
        if (parsed.fieldFilters !== undefined) setFieldFilters(sanitizeFilterGroups(parsed.fieldFilters));
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
        fieldFilters,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      setSaveStatus("Dashboard settings saved automatically");
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
    fieldFilters,
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
        fieldFilters,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      setSaveStatus("Dashboard settings saved ✓");
      setTimeout(() => setSaveStatus(null), 3000);
    } catch {
      setSaveStatus("Error saving settings");
    }
  };

  const resetAllSettingsToDefault = () => {
    if (confirm("Reset all settings, columns, filters and signal conditions to defaults?")) {
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
        fairClaude: false,
        up5m: false,
        signals: true,
        kevScore: false,
        spanScore: false,
      });
      setSignals(DEFAULT_SIGNAL_CONFIG);
      setFieldFilters([]);
      setDateFilter("ALL");
      setStartHour(null);
      setEndHour(null);
      setActiveIntervalPreset("ALL");
      setDirFilter("ALL");
      setOnlyFirstHourlySignal(false);
      setSaveStatus("All settings reset to defaults");
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
        const res = await fetch(withHistorySet(url), { cache: "no-store" });
        const json = await res.json();
        if (json.files) {
          setData(json.files);
          setLastRefreshedAt(new Date());
        } else {
          throw new Error(json.error || "Error loading data");
        }
      } catch (err: any) {
        if (!isSilent) {
          setError(err.message || "Error communicating with the server");
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
      const res = await fetch(withHistorySet(`/api/jev/history?file=${filename}`));
      const text = await res.text();
      setFileContent(text);
    } catch {
      setFileContent("Error loading content");
    } finally {
      setFileLoading(false);
    }
  };

  const toggleColumnGroup = (ids: string[]) => {
    setSelectedColIds((prev) => {
      const allOn = ids.every((id) => prev.includes(id));
      if (allOn) {
        const rest = prev.filter((c) => !ids.includes(c));
        return rest.length ? rest : prev;
      }
      return [...prev, ...ids.filter((id) => !prev.includes(id))];
    });
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

  // Field filters: the fields on offer, the applied filter as one row test, and which fields it uses
  const coinsInData = useMemo(() => [...new Set(data.map((r) => (r.coin || "BTC").toUpperCase()))].sort(), [data]);
  const filterFields = useMemo(() => buildFilterFields(signals, coinsInData), [signals, coinsInData]);
  const filterFieldMap = useMemo(() => new Map(filterFields.map((f) => [f.id, f])), [filterFields]);
  const fieldFilterFn = useMemo(() => compileFilters(fieldFilters, filterFieldMap), [fieldFilters, filterFieldMap]);
  const filteredFieldIds = useMemo(
    () => new Set(fieldFilters.flatMap((g) => g.conditions.filter((c) => isConditionReady(c, filterFieldMap.get(c.field))).map((c) => c.field))),
    [fieldFilters, filterFieldMap]
  );
  const fieldFilterSummary = useMemo(() => describeFilters(fieldFilters, filterFieldMap), [fieldFilters, filterFieldMap]);
  // Visible columns first, then the time fields, so "minute 45 to 56" is always one click away
  const quickFilterFieldIds = useMemo(
    () => [...new Set([...selectedColIds, "minute", "hour"])].filter((id) => filterFieldMap.has(id)),
    [selectedColIds, filterFieldMap]
  );
  const addFieldFilter = (fieldId: string) => {
    const f = filterFieldMap.get(fieldId);
    if (!f) return;
    setFieldFilters((prev) => addCondition(prev, f));
    filterPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // Rows in the time window (date, hours, text search), before the field filters
  const windowData = useMemo(() => {
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
          ((q.includes("3/3") || q === "up" || q === "bullish") && is3Up) ||
          ((q.includes("3/3") || q === "down" || q === "bearish") && is3Down);

        const matchDir = row.direction?.toLowerCase() === q;
        if (!matchTime && !matchFile && !matchScore && !matchConsensus && !matchDir) return false;
      }

      return true;
    });
  }, [data, dateFilter, startHour, endHour, searchQuery]);

  // Base Filtered dataset (before direction/signal filter): the time window narrowed by the field filters
  const baseFilteredData = useMemo(
    () => (fieldFilterFn ? windowData.filter(fieldFilterFn) : windowData),
    [windowData, fieldFilterFn]
  );

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
    const headers = ["No.", "Time (ET)", "File name", ...activeCols.map((c) => c.label)];
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
      alert("Please allow pop-ups in your browser.");
      return;
    }

    const title = `Polymarket AI Prediction Analysis Report - ${selectedCoin.toUpperCase()}`;
    const dateStr = new Date().toLocaleString("en-US");
    const sortLabel = sortConfig
      ? ` | Sorted by: ${
          sortConfig.key === "time"
            ? "Time"
            : ALL_COLUMNS.find((c) => c.id === sortConfig.key)?.label || sortConfig.key
        } (${sortConfig.dir === "desc" ? "descending ↓" : "ascending ↑"})`
      : "";

    const htmlContent = `
<!DOCTYPE html>
<html dir="ltr" lang="en">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
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
      text-align: left;
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
      <strong>Print preview and PDF download</strong>
      <div style="font-size: 11px; color: #475569; margin-top: 2px;">
        To save a PDF, click the button below and choose <strong>Save as PDF</strong> in the print dialog.
      </div>
    </div>
    <button class="btn" onclick="window.print()">
      🖨️ Print / Save as PDF
    </button>
  </div>

  <div class="header">
    <div>
      <h1>${title}</h1>
      <div class="subtitle">Report date: ${dateStr} · Coin: ${selectedCoin.toUpperCase()} · Date filter: ${
      dateFilter === "ALL" ? "All dates" : dateFilter
    } · Rows: ${printableRows.length}${sortLabel}${
      fieldFilterSummary ? ` · Field filters: ${escapeHtml(fieldFilterSummary)}` : ""
    }</div>
    </div>
    <div style="text-align: right; font-size: 10px; color: #73757c;">
      Polymarket Up/Down | Jev & Multi-Model
    </div>
  </div>

  <div class="stats-banner">
    <div class="stat-pill pill-blue">🎯 Total hourly signals: ${stats.signalCount}</div>
    <div class="stat-pill pill-green">🏆 Wins (WIN): ${stats.winCount}</div>
    <div class="stat-pill pill-red">❌ Losses (LOSS): ${stats.lossCount}</div>
    ${stats.winRate != null ? `<div class="stat-pill pill-green">📊 Hourly win rate: ${stats.winRate}%</div>` : ""}
    <div class="stat-pill pill-gray">Rows in this export: ${printableRows.length}</div>
  </div>

  <table>
    <thead>
      <tr>
        <th style="width: 35px; text-align: center;">#</th>
        <th>Date & time (ET)</th>
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
                  if (outcomeInfo.status === "WIN") formatted = '<span class="badge-win">✓ WIN</span>';
                  else if (outcomeInfo.status === "LOSS") formatted = '<span class="badge-loss">✗ LOSS</span>';
                  else if (outcomeInfo.status === "PENDING") formatted = '⏳ Pending';
                } else if (col.id === "market_outcome") {
                  if (val === "UP") formatted = '<span class="badge-up">🟢 UP</span>';
                  else if (val === "DOWN") formatted = '<span class="badge-down">🔴 DOWN</span>';
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

  // SVG Chart Geometry: the viewBox follows the container width so labels keep their size on wide screens
  const [chartEl, setChartEl] = useState<HTMLDivElement | null>(null);
  const [chartWidth, setChartWidth] = useState(920);
  useEffect(() => {
    if (!chartEl) return;
    const update = () => {
      const w = Math.round(chartEl.getBoundingClientRect().width);
      if (w > 0) setChartWidth(Math.max(640, Math.min(2400, w)));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(chartEl);
    return () => ro.disconnect();
  }, [chartEl]);
  const chartHeight = chartWidth > 1400 ? 340 : 280;
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
    const fairClaudePoints: { x: number; y: number }[] = [];
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
      if (d.fair_claude != null) fairClaudePoints.push({ x, y: getYPct(d.fair_claude) });
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
      fairClaudePath: generateSmoothCurve(fairClaudePoints),
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
    <div data-wide className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 border-b border-white/[0.08] pb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Link
              href="/updown"
              className="inline-flex items-center gap-1 text-xs text-[#9a9ca3] hover:text-[#6aa9d8] transition-colors"
            >
              <ArrowRight className="w-3.5 h-3.5 rotate-180" />
              Back to Up/Down page
            </Link>
            <span className="text-xs text-[#73757c]">/</span>
            <span className="text-xs text-[#6aa9d8] font-medium">Jev JSON Analyzer</span>
          </div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2.5">
            <BarChart3 className="w-6 h-6 text-[#6aa9d8]" />
            Analysis dashboard, time-window filter and Jev curve chart
          </h1>
          <p className="text-xs text-[#9a9ca3] mt-1">
            Plot value curves over custom time windows (e.g. 1:00 to 2:00) and compare data
          </p>
          <div className="mt-2"><DatasetSwitch path="/jev-analysis" /></div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Quick Save / Reset Buttons */}
          <button
            onClick={saveCurrentSettingsNow}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#6aa9d8]/15 hover:bg-[#6aa9d8]/25 text-xs text-[#6aa9d8] border border-[#6aa9d8]/30 transition-all font-medium"
            title="Save current settings, columns, time windows and signal conditions in the browser"
          >
            <Save className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Save settings</span>
          </button>

          <button
            onClick={resetAllSettingsToDefault}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-xs text-[#9a9ca3] hover:text-[#e5787f] border border-white/[0.08] transition-all"
            title="Reset all filters, columns and conditions to defaults"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Reset</span>
          </button>

          <button
            onClick={exportCsv}
            disabled={sortedData.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] text-xs text-[#bdbdb8] border border-white/[0.08] transition-all disabled:opacity-50 font-medium"
            title="Download CSV of the current table (with active sort and filters applied)"
          >
            <Download className="w-3.5 h-3.5 text-[#6aa9d8]" />
            <span>CSV export ({sortedData.length})</span>
          </button>

          <button
            onClick={exportPdf}
            disabled={sortedData.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#6aa9d8]/15 hover:bg-[#6aa9d8]/25 text-xs text-[#6aa9d8] border border-[#6aa9d8]/30 transition-all disabled:opacity-50 font-medium"
            title="Print / download PDF of the current table with full win/loss coloring"
          >
            <Printer className="w-3.5 h-3.5" />
            <span>PDF export ({sortedData.length})</span>
          </button>

          {/* Auto Refresh Toggle Button */}
          <button
            onClick={() => setAutoRefresh((prev) => !prev)}
            className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border transition-all ${
              autoRefresh
                ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/25"
                : "bg-white/[0.04] text-[#9a9ca3] border-white/[0.08] hover:bg-white/[0.08]"
            }`}
            title="Auto-refresh the table every 30 seconds (in step with the 10-30 minute Polymarket oracle final-confirmation delay)"
          >
            <span
              className={`w-2 h-2 rounded-full ${
                autoRefresh ? "bg-emerald-400" : "bg-[#73757c]"
              }`}
            />
            <span className="hidden sm:inline">
              {autoRefresh ? "Auto-refresh: on (30s)" : "Auto-refresh: off"}
            </span>
            <span className="sm:hidden">{autoRefresh ? "Auto: on" : "Auto: off"}</span>
            {isRefreshing && <RefreshCw className="w-3 h-3 text-emerald-400 animate-spin" />}
          </button>

          {lastRefreshedAt && (
            <span className="text-[11px] text-[#73757c] hidden xl:inline-block font-mono" title="Time of last data fetch from the server">
              Last fetched: {lastRefreshedAt.toLocaleTimeString("en-US")}
            </span>
          )}

          <button
            onClick={() => loadHistory(selectedCoin, false)}
            disabled={loading || isRefreshing}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#6366f1] text-white text-xs font-medium hover:opacity-90 transition-opacity shadow-md disabled:opacity-50"
            title="Manual refresh; fetch the latest confirmed results from Polymarket"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading || isRefreshing ? "animate-spin" : ""}`} />
            Refresh
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

      {/* COIN SELECTOR BAR (coin selection and filter) */}
      <div className="bg-[#181a1e]/90 border border-[rgba(190,190,200,0.18)] p-3.5 rounded-2xl flex flex-wrap items-center justify-between gap-3 shadow-md">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-[#9a9ca3] px-2 flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-[#d4b063]" />
            Select coin:
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
          {selectedCoin === "all" ? "Showing all recorded predictions" : `Showing analyses for ${selectedCoin.toUpperCase()}`}
        </div>
      </div>

      {/* TIME RANGE FILTER CONTROLS (1:00 to 2:00 and custom windows) */}
      <div className="bg-[#181a1e]/90 border border-[#6aa9d8]/30 rounded-2xl p-5 space-y-4 shadow-xl">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.08] pb-3">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-[#6aa9d8]" />
            <span className="text-sm font-bold text-white">
              Select a time window for the curve chart and table filter (Time Window):
            </span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-[#6aa9d8]/15 text-[#6aa9d8] font-bold">
              {filteredData.length} snapshots in the selected window
            </span>
          </div>

          {/* Quick presets (1:00 to 2:00, ...) */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-[#9a9ca3] ml-1">Quick windows:</span>
            {[
              { id: "ALL", label: "All data" },
              { id: "13_14", label: "1 PM to 2 PM (13:00-14:00)" },
              { id: "14_15", label: "2 PM to 3 PM (14:00-15:00)" },
              { id: "15_16", label: "3 PM to 4 PM (15:00-16:00)" },
              { id: "23_24", label: "11 PM to 12 AM (23:00-24:00)" },
              { id: "01_02", label: "1 AM to 2 AM (01:00-02:00)" },
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
            <span className="text-[#9a9ca3]">Date:</span>
            <select
              value={dateFilter}
              onChange={(e) => setDateFilter(e.target.value)}
              className="bg-[#0f1013] text-white border border-white/[0.15] rounded px-2 py-1 flex-1 focus:outline-none focus:border-[#6aa9d8]"
            >
              <option value="ALL">All days ({availableDates.length} days)</option>
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
            <span className="text-[#9a9ca3]">From:</span>
            <select
              value={startHour ?? ""}
              onChange={(e) => {
                const val = e.target.value === "" ? null : parseInt(e.target.value, 10);
                setStartHour(val);
                setActiveIntervalPreset("custom");
              }}
              className="bg-[#0f1013] text-white border border-white/[0.15] rounded px-2 py-1 flex-1 focus:outline-none focus:border-[#5fbf9a]"
            >
              <option value="">Start (00:00)</option>
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
            <span className="text-[#9a9ca3]">To:</span>
            <select
              value={endHour ?? ""}
              onChange={(e) => {
                const val = e.target.value === "" ? null : parseInt(e.target.value, 10);
                setEndHour(val);
                setActiveIntervalPreset("custom");
              }}
              className="bg-[#0f1013] text-white border border-white/[0.15] rounded px-2 py-1 flex-1 focus:outline-none focus:border-[#e5787f]"
            >
              <option value="">End (24:00)</option>
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
              Reset time window (all data)
            </button>
          </div>
        </div>
      </div>

      {/* INTERACTIVE CURVE CHART COMPONENT (value curve chart) */}
      <div className="bg-[#131418] border border-[rgba(190,190,200,0.2)] rounded-2xl p-5 space-y-4 shadow-2xl relative">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 border-b border-white/[0.08] pb-3">
          <div>
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-[#d4b063]" />
              Value curves over the selected window (Interactive Value Curves)
            </h2>
            <p className="text-[11px] text-[#9a9ca3] mt-0.5">
              Compare the Jev score curve, market percentages and Fair Value side by side by hovering over the chart
            </p>
          </div>

          {/* Curve Toggles */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-[#9a9ca3] text-[11px]">Active curves:</span>

            {/* Signal Ticks Toggle Button */}
            <button
              onClick={() => setVisibleCurves((p) => ({ ...p, signals: !p.signals }))}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs transition-all ${
                visibleCurves.signals
                  ? "bg-gradient-to-r from-[#6aa9d8]/20 via-[#5fbf9a]/15 to-[#d8646a]/20 border-[#6aa9d8] text-white font-bold shadow-sm"
                  : "bg-white/[0.03] border-white/[0.1] text-[#73757c] opacity-60"
              }`}
              title="Show blue and red conditional ticks on curve points"
            >
              <div className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-[#6aa9d8]" />
                <span className="w-2 h-2 rounded-full bg-[#d8646a]" />
              </div>
              <span>Signal ticks</span>
              <span className="text-[10px] font-mono opacity-85 px-1.5 py-0.2 rounded bg-black/40">
                {bullishMatches.length} blue / {bearishMatches.length} red
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
              title="Set score and confidence thresholds for the blue and red ticks"
            >
              <Settings2 className="w-3.5 h-3.5" />
              <span>Tick conditions</span>
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
              Jev Score (0-4)
            </button>

            <button
              onClick={() => setVisibleCurves((p) => ({ ...p, kevScore: !p.kevScore }))}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs transition-all ${
                visibleCurves.kevScore
                  ? "bg-[#6aa9d8]/20 border-[#6aa9d8] text-[#6aa9d8] font-bold"
                  : "bg-white/[0.03] border-white/[0.1] text-[#73757c] opacity-60"
              }`}
              title="Show the Kev-4b model score curve (0 to 4)"
            >
              <span className="w-2.5 h-2.5 rounded-full bg-[#6aa9d8]" />
              Kev-4b Score (0-4)
            </button>

            <button
              onClick={() => setVisibleCurves((p) => ({ ...p, spanScore: !p.spanScore }))}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs transition-all ${
                visibleCurves.spanScore
                  ? "bg-[#b58ac9]/20 border-[#b58ac9] text-[#b58ac9] font-bold"
                  : "bg-white/[0.03] border-white/[0.1] text-[#73757c] opacity-60"
              }`}
              title="Show the Span-01 model score curve (0 to 4)"
            >
              <span className="w-2.5 h-2.5 rounded-full bg-[#b58ac9]" />
              Span-01 Score (0-4)
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
              Jev Score Confidence (%)
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
              1H Up % market
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
              15M Up % market
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
              onClick={() => setVisibleCurves((p) => ({ ...p, fairClaude: !p.fairClaude }))}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs transition-all ${
                visibleCurves.fairClaude
                  ? "bg-[#d97757]/20 border-[#d97757] text-[#d97757] font-bold"
                  : "bg-white/[0.03] border-white/[0.1] text-[#73757c] opacity-60"
              }`}
              title="Claude 1H fair value (only the CL dataset has it)"
            >
              <span className="w-2.5 h-2.5 rounded-full bg-[#d97757]" />
              Fair Value Claude
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
              5M Up % market
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
                  Define curve tick conditions (Conditional Signal Markers):
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
                  <span>Enable conditional tick system</span>
                </label>
                <button
                  onClick={() => setSignals(DEFAULT_SIGNAL_CONFIG)}
                  className="text-[11px] px-2.5 py-1 rounded bg-white/[0.05] hover:bg-white/[0.1] text-[#9a9ca3] hover:text-white transition-colors"
                >
                  Reset conditions
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {/* Bullish Condition (Blue Tick) */}
              <div className="bg-[#131418] p-3 rounded-xl border border-[#6aa9d8]/30 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 font-bold text-[#6aa9d8]">
                    <span className="w-3.5 h-3.5 rounded-full bg-[#6aa9d8] flex items-center justify-center text-[10px] text-black font-black">✓</span>
                    <span>Blue tick condition (Bullish):</span>
                  </div>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#6aa9d8]/15 text-[#6aa9d8] font-bold">
                    {bullishMatches.length} matches
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  <div>
                    <label className="text-[#9a9ca3] block mb-1">Min score (0 - 4):</label>
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
                    <label className="text-[#9a9ca3] block mb-1">Max score (0 - 4):</label>
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      max="4"
                      value={signals.bullishMaxScore ?? 4}
                      onChange={(e) =>
                        setSignals((p) => ({
                          ...p,
                          bullishMaxScore: parseFloat(e.target.value) || 0,
                        }))
                      }
                      className="w-full bg-[#0f1013] text-white border border-[#6aa9d8]/40 rounded-lg px-2.5 py-1 font-mono font-bold focus:outline-none focus:border-[#6aa9d8]"
                    />
                  </div>
                  <div>
                    <label className="text-[#9a9ca3] block mb-1">Min confidence (%):</label>
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
                  <div>
                    <label className="text-[#9a9ca3] block mb-1">Max confidence (%):</label>
                    <input
                      type="number"
                      step="1"
                      min="0"
                      max="100"
                      value={signals.bullishMaxConf ?? 100}
                      onChange={(e) =>
                        setSignals((p) => ({
                          ...p,
                          bullishMaxConf: parseInt(e.target.value, 10) || 0,
                        }))
                      }
                      className="w-full bg-[#0f1013] text-white border border-[#6aa9d8]/40 rounded-lg px-2.5 py-1 font-mono font-bold focus:outline-none focus:border-[#6aa9d8]"
                    />
                  </div>
                </div>
                <p className="text-[10px] text-[#6aa9d8]">
                  Blue tick rule: score above {signals.bullishScore} up to {signals.bullishMaxScore ?? 4} and score confidence between {signals.bullishMinConf}% and {signals.bullishMaxConf ?? 100}%
                </p>
              </div>

              {/* Bearish Condition (Red Tick) */}
              <div className="bg-[#131418] p-3 rounded-xl border border-[#d8646a]/30 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 font-bold text-[#d8646a]">
                    <span className="w-3.5 h-3.5 rounded-full bg-[#d8646a] flex items-center justify-center text-[10px] text-white font-black">✓</span>
                    <span>Red tick condition (Bearish):</span>
                  </div>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#d8646a]/15 text-[#d8646a] font-bold">
                    {bearishMatches.length} matches
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  <div>
                    <label className="text-[#9a9ca3] block mb-1">Min score (0 - 4):</label>
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      max="4"
                      value={signals.bearishMinScore ?? 0}
                      onChange={(e) =>
                        setSignals((p) => ({
                          ...p,
                          bearishMinScore: parseFloat(e.target.value) || 0,
                        }))
                      }
                      className="w-full bg-[#0f1013] text-white border border-[#d8646a]/40 rounded-lg px-2.5 py-1 font-mono font-bold focus:outline-none focus:border-[#d8646a]"
                    />
                  </div>
                  <div>
                    <label className="text-[#9a9ca3] block mb-1">Max score (0 - 4):</label>
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
                    <label className="text-[#9a9ca3] block mb-1">Min confidence (%):</label>
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
                  <div>
                    <label className="text-[#9a9ca3] block mb-1">Max confidence (%):</label>
                    <input
                      type="number"
                      step="1"
                      min="0"
                      max="100"
                      value={signals.bearishMaxConf ?? 100}
                      onChange={(e) =>
                        setSignals((p) => ({
                          ...p,
                          bearishMaxConf: parseInt(e.target.value, 10) || 0,
                        }))
                      }
                      className="w-full bg-[#0f1013] text-white border border-[#d8646a]/40 rounded-lg px-2.5 py-1 font-mono font-bold focus:outline-none focus:border-[#d8646a]"
                    />
                  </div>
                </div>
                <p className="text-[10px] text-[#d8646a]">
                  Red tick rule: score from {signals.bearishMinScore ?? 0} to below {signals.bearishScore} and score confidence between {signals.bearishMinConf}% and {signals.bearishMaxConf ?? 100}%
                </p>
              </div>

              {/* Model Source & Confidence Settings */}
              <div className="bg-[#131418] p-3 rounded-xl border border-white/[0.1] space-y-2 flex flex-col justify-between">
                <div className="space-y-2">
                  <div>
                    <label className="text-[#9a9ca3] block mb-1 font-medium">AI model for signal basis:</label>
                    <select
                      value={signals.modelSource || "jev"}
                      onChange={(e) =>
                        setSignals((p) => ({
                          ...p,
                          modelSource: e.target.value as "jev" | "kev" | "span" | "solar" | "tev" | "mercury" | "liquid" | "consensus",
                        }))
                      }
                      className="w-full bg-[#0f1013] text-white border border-white/[0.15] rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-[#6aa9d8]"
                    >
                      <option value="jev">Jev model (Jev only - default)</option>
                      <option value="kev">Kev-4b model (score 0 to 4)</option>
                      <option value="span">Span-01 model (score 0 to 4)</option>
                      <option value="solar">Solar-Decide model (score 0 to 4)</option>
                      <option value="tev">Tev-4b model (score 0 to 4)</option>
                      <option value="mercury">Mercury-Decide model (score 0 to 4)</option>
                      <option value="liquid">Liquid-D1 model (score 0 to 4)</option>
                      <option value="consensus">Consensus of all 3 models (average score)</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[#9a9ca3] block mb-1 font-medium">Confidence measure basis:</label>
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
                      <option value="score">Score confidence only (Score Confidence - main rule)</option>
                      <option value="direction">Direction confidence only (Direction Confidence)</option>
                    </select>
                  </div>
                </div>
                <div className="text-[11px] text-[#9a9ca3] bg-white/[0.03] p-2 rounded-lg border border-white/[0.05]">
                  💡 Ticks, together with a dashed guide line, are drawn only when both the score and score-confidence conditions are met.
                </div>
              </div>
            </div>
          </div>
        )}

        {/* The SVG Smooth Curve Canvas */}
        {chartData.length < 2 ? (
          <div className="h-64 flex flex-col items-center justify-center text-center p-6 text-[#9a9ca3] bg-white/[0.02] rounded-xl border border-dashed border-white/[0.08]">
            <Clock className="w-8 h-8 text-[#73757c] mb-2" />
            <p className="text-xs font-semibold text-white">Not enough data to draw a curve for this window</p>
            <p className="text-[11px] text-[#73757c] mt-1">
              Please choose a wider time window (e.g. all hours, or other hours that have recorded data).
            </p>
          </div>
        ) : (
          <div ref={setChartEl} className="relative overflow-hidden select-none">
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

              {/* CURVE: Fair Value Claude */}
              {visibleCurves.fairClaude && curveCoordinates?.fairClaudePath && (
                <path
                  d={curveCoordinates.fairClaudePath}
                  fill="none"
                  stroke="#d97757"
                  strokeWidth="2"
                  strokeDasharray="6 3"
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
                            {isBull ? "Bullish tick" : "Bearish tick"}
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
                // a Set: with fewer than 5 points the indices repeat, and repeated keys make React warn
                [...new Set([0, Math.floor(chartData.length / 4), Math.floor(chartData.length / 2), Math.floor((chartData.length * 3) / 4), chartData.length - 1])].map(
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
                      <span className="text-[#9a9ca3]">Jev score:</span>
                      <span className="font-mono text-[#a795d6] font-bold tabular-nums">
                        {hoveredItem.score.toFixed(2)} / 4.0
                      </span>
                    </div>
                  )}

                  {hoveredItem.score_confidence != null && (
                    <div className="flex items-center justify-between">
                      <span className="text-[#9a9ca3]">Score confidence:</span>
                      <span className="font-mono text-[#cfad4e] font-bold tabular-nums">
                        {hoveredItem.score_confidence}%
                      </span>
                    </div>
                  )}

                  {hoveredItem.kev_score != null && (
                    <div className="flex items-center justify-between">
                      <span className="text-[#9a9ca3]">Kev-4b score:</span>
                      <span className="font-mono text-[#6aa9d8] font-bold tabular-nums">
                        {hoveredItem.kev_score.toFixed(2)} / 4.0 {hoveredItem.kev_confidence != null ? `(${hoveredItem.kev_confidence}%)` : ""}
                      </span>
                    </div>
                  )}

                  {hoveredItem.span_score != null && (
                    <div className="flex items-center justify-between">
                      <span className="text-[#9a9ca3]">Span-01 score:</span>
                      <span className="font-mono text-[#b58ac9] font-bold tabular-nums">
                        {hoveredItem.span_score.toFixed(2)} / 4.0 {hoveredItem.span_confidence != null ? `(${hoveredItem.span_confidence}%)` : ""}
                      </span>
                    </div>
                  )}

                  {hoveredItem.up_1h_num != null && (
                    <div className="flex items-center justify-between">
                      <span className="text-[#9a9ca3]">1H Up market:</span>
                      <span className="font-mono text-[#5fbf9a] font-bold tabular-nums">
                        {hoveredItem.up_1h_num}%
                      </span>
                    </div>
                  )}

                  {hoveredItem.up_15m_num != null && (
                    <div className="flex items-center justify-between">
                      <span className="text-[#9a9ca3]">15M Up market:</span>
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

                  {hoveredItem.fair_claude != null && (
                    <div className="flex items-center justify-between">
                      <span className="text-[#9a9ca3]">Fair Value Claude:</span>
                      <span className="font-mono text-[#d97757] font-medium tabular-nums">
                        {hoveredItem.fair_claude.toFixed(1)}¢
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between text-[11px] text-[#73757c] pt-2 border-t border-white/[0.06]">
          <span>Left vertical axis: AI score (0 to 4) · Right vertical axis: market percentage (0% to 100%)</span>
          <span>Points connected on the curve: {chartData.length} 5-minute intervals</span>
        </div>
      </div>

      {/* Column & Metric Selector (User customizable view) */}
      <div className="bg-[#181a1e]/90 border border-[rgba(190,190,200,0.18)] rounded-2xl p-4 space-y-3">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 border-b border-white/[0.08] pb-3">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="w-4 h-4 text-[#6aa9d8]" />
            <span className="text-sm font-semibold text-white">Table columns</span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-[#6aa9d8]/15 text-[#6aa9d8] font-bold">
              {selectedColIds.length} active
            </span>
          </div>

          {/* Quick Presets */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-[#9a9ca3] mr-1">Presets:</span>
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

        {/* Columns grouped by model; click a group title to toggle the whole group */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-6 gap-y-3">
          {[
            ...COLUMN_GROUPS,
            // Safety net: any column not listed above still shows up.
            ...(() => {
              const known = new Set(COLUMN_GROUPS.flatMap((g) => g.cols.map(([id]) => id)));
              const rest = ALL_COLUMNS.filter((c) => !known.has(c.id));
              return rest.length
                ? [{ id: "other", title: "Other", dot: "#73757c", cols: rest.map((c): [string, string] => [c.id, c.shortLabel]) }]
                : [];
            })(),
          ].map((group) => {
            const ids = group.cols.map(([id]) => id);
            const onCount = ids.filter((id) => selectedColIds.includes(id)).length;
            return (
              <div key={group.id} className="flex flex-wrap items-center gap-1.5">
                <button
                  onClick={() => toggleColumnGroup(ids)}
                  title={`Toggle all ${group.title} columns`}
                  className="flex items-center gap-1.5 w-[112px] shrink-0 text-left text-[11px] font-semibold text-[#bdbdb8] hover:text-white transition-colors"
                >
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: group.dot }} />
                  <span className="truncate">{group.title}</span>
                  <span className="text-[10px] font-normal text-[#73757c] tabular-nums">
                    {onCount}/{ids.length}
                  </span>
                </button>
                {group.cols.map(([id, label]) => {
                  const isSelected = selectedColIds.includes(id);
                  return (
                    <button
                      key={id}
                      onClick={() => toggleColumn(id)}
                      className={`flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-md border transition-all ${
                        isSelected
                          ? "bg-[#6b86d6]/25 border-[#8ea4e8] text-white"
                          : "bg-white/[0.03] border-white/[0.07] text-[#9a9ca3] hover:text-[#bdbdb8] hover:bg-white/[0.06]"
                      }`}
                    >
                      <span
                        className={`w-3 h-3 rounded flex items-center justify-center ${
                          isSelected ? "bg-[#6aa9d8] text-black" : "border border-white/20"
                        }`}
                      >
                        {isSelected && <Check className="w-2 h-2 stroke-[3]" />}
                      </span>
                      <span>{label}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {/* Field filters: ranges and conditions on any field, applied before the direction/signal filters below */}
      <FieldFilterPanel
        fields={filterFields}
        groups={fieldFilters}
        onChange={setFieldFilters}
        quickFieldIds={quickFilterFieldIds}
        matched={baseFilteredData.length}
        total={windowData.length}
        anchorRef={filterPanelRef}
      />

      {/* Filter & Search Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-[#181a1e]/70 p-3 rounded-xl border border-[rgba(190,190,200,0.12)]">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 text-xs text-[#9a9ca3]">
            <Filter className="w-3.5 h-3.5 text-[#6aa9d8]" />
            <span>Direction filter:</span>
          </div>
          <button
            onClick={() => setDirFilter("ALL")}
            className={`text-xs px-2.5 py-1 rounded-md transition-all ${
              dirFilter === "ALL"
                ? "bg-white/[0.15] text-white font-medium"
                : "text-[#9a9ca3] hover:text-white"
            }`}
          >
            All ({data.length})
          </button>
          <button
            onClick={() => setDirFilter("UP")}
            className={`text-xs px-2.5 py-1 rounded-md transition-all ${
              dirFilter === "UP"
                ? "bg-[#5fbf9a]/20 text-[#5fbf9a] font-semibold"
                : "text-[#9a9ca3] hover:text-[#5fbf9a]"
            }`}
          >
            UP only ({stats.upCount})
          </button>
          <button
            onClick={() => setDirFilter("DOWN")}
            className={`text-xs px-2.5 py-1 rounded-md transition-all ${
              dirFilter === "DOWN"
                ? "bg-[#e5787f]/20 text-[#e5787f] font-semibold"
                : "text-[#9a9ca3] hover:text-[#e5787f]"
            }`}
          >
            DOWN only ({stats.downCount})
          </button>

          <div className="h-4 w-[1px] bg-white/10 mx-0.5 hidden sm:block" />

          <button
            onClick={() => setDirFilter("CONSENSUS_3_UP")}
            className={`text-xs px-2.5 py-1 rounded-md transition-all flex items-center gap-1.5 ${
              dirFilter === "CONSENSUS_3_UP"
                ? "bg-[#5fbf9a]/25 text-[#5fbf9a] font-semibold border border-[#5fbf9a]/50 shadow-sm"
                : "text-[#9a9ca3] hover:text-[#5fbf9a]"
            }`}
            title="Only snapshots where all 3 models (Jev + Kev + Span) gave a full 3/3 UP"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-[#5fbf9a]" />
            <span>3/3 UP ({stats.consensusUp3Count})</span>
          </button>

          <button
            onClick={() => setDirFilter("CONSENSUS_3_DOWN")}
            className={`text-xs px-2.5 py-1 rounded-md transition-all flex items-center gap-1.5 ${
              dirFilter === "CONSENSUS_3_DOWN"
                ? "bg-[#e5787f]/25 text-[#e5787f] font-semibold border border-[#e5787f]/50 shadow-sm"
                : "text-[#9a9ca3] hover:text-[#e5787f]"
            }`}
            title="Only snapshots where all 3 models (Jev + Kev + Span) gave a full 3/3 DOWN"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-[#e5787f]" />
            <span>3/3 DOWN ({stats.consensusDown3Count})</span>
          </button>

          <button
            onClick={() => setDirFilter("CONSENSUS_3_3")}
            className={`text-xs px-2.5 py-1 rounded-md transition-all flex items-center gap-1.5 ${
              dirFilter === "CONSENSUS_3_3"
                ? "bg-[#a795d6]/25 text-[#a795d6] font-semibold border border-[#a795d6]/50 shadow-sm"
                : "text-[#9a9ca3] hover:text-[#a795d6]"
            }`}
            title="Any decisive 3-of-3 consensus (UP or DOWN)"
          >
            <span>⚡ Any 3/3 ({stats.consensusFull3Count})</span>
          </button>

          <div className="h-4 w-[1px] bg-white/10 mx-0.5 hidden sm:block" />
          <button
            onClick={() => setDirFilter("SIGNALS")}
            title={`Show all snapshots with a signal (${stats.rawSignalSnapshots} 5-minute snapshots)`}
            className={`text-xs px-2.5 py-1 rounded-md transition-all ${
              dirFilter === "SIGNALS"
                ? "bg-[#6aa9d8]/20 text-[#6aa9d8] font-semibold border border-[#6aa9d8]/40"
                : "text-[#9a9ca3] hover:text-[#6aa9d8]"
            }`}
          >
            🎯 All signals ({stats.rawSignalSnapshots})
          </button>
          <button
            onClick={() => setDirFilter("FIRST_HOURLY_SIGNAL")}
            title="Only the first signal issued each hour (removes repeat signals in the same direction within that hour)"
            className={`text-xs px-2.5 py-1 rounded-md transition-all flex items-center gap-1.5 ${
              dirFilter === "FIRST_HOURLY_SIGNAL"
                ? "bg-amber-500/25 text-amber-300 font-semibold border border-amber-500/50 shadow-sm"
                : "text-[#9a9ca3] hover:text-amber-300"
            }`}
          >
            <Zap className="w-3 h-3 text-amber-400" />
            <span>⚡ First signal each hour ({stats.signalCount})</span>
          </button>
          <button
            onClick={() => setDirFilter("WINS")}
            title={`${stats.winCount} winning hourly candles`}
            className={`text-xs px-2.5 py-1 rounded-md transition-all ${
              dirFilter === "WINS"
                ? "bg-emerald-500/25 text-emerald-300 font-semibold border border-emerald-500/40"
                : "text-[#9a9ca3] hover:text-emerald-400"
            }`}
          >
            🏆 Wins ({stats.winCount})
          </button>
          <button
            onClick={() => setDirFilter("LOSSES")}
            title={`${stats.lossCount} losing hourly candles`}
            className={`text-xs px-2.5 py-1 rounded-md transition-all ${
              dirFilter === "LOSSES"
                ? "bg-rose-500/25 text-rose-300 font-semibold border border-rose-500/40"
                : "text-[#9a9ca3] hover:text-rose-400"
            }`}
          >
            ❌ Losses ({stats.lossCount})
          </button>
          {stats.winRate != null && (
            <div
              className="flex items-center gap-1.5 px-3 py-1 rounded-md bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs font-bold"
              title={`${stats.winCount} wins out of ${stats.winCount + stats.lossCount} closed hourly candles (${stats.rawSignalSnapshots} snapshots total)`}
            >
              <span>Hourly win rate:</span>
              <span className="font-mono text-sm">{stats.winRate}%</span>
              {stats.pendingCount > 0 && (
                <span className="text-[10px] text-amber-300 font-normal mr-1">
                  ({stats.pendingCount} live)
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
            title="Hide repeat signals in the same direction within the same hour (only the first snapshot with a signal each hour is shown)"
          >
            <input
              type="checkbox"
              checked={onlyFirstHourlySignal}
              onChange={(e) => setOnlyFirstHourlySignal(e.target.checked)}
              className="rounded border-white/20 bg-[#181a1e] text-[#6aa9d8] focus:ring-0 focus:ring-offset-0 cursor-pointer w-3.5 h-3.5"
            />
            <span className="flex items-center gap-1">
              <Zap className="w-3 h-3 text-amber-400" />
              <span>First signal of hour only (hide same-direction repeats)</span>
            </span>
          </label>
          {sortConfig && (
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#6aa9d8]/15 border border-[#6aa9d8]/30 text-[#6aa9d8] text-xs font-medium animate-in fade-in">
              <span>
                Sort:{" "}
                {sortConfig.key === "time"
                  ? "Time"
                  : ALL_COLUMNS.find((c) => c.id === sortConfig.key)?.label || sortConfig.key}{" "}
                ({sortConfig.dir === "desc" ? "descending ↓" : "ascending ↑"})
              </span>
              <button
                onClick={() => setSortConfig(null)}
                className="hover:text-white mr-1 text-sm font-bold transition-colors"
                title="Clear sorting and return to the default time order"
              >
                ✕
              </button>
            </div>
          )}

          <div className="relative">
            <Search className="w-3.5 h-3.5 text-[#73757c] absolute right-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search by time, hour or score..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-white/[0.05] border border-white/[0.1] rounded-lg pr-8 pl-3 py-1 text-xs text-white placeholder-[#73757c] focus:outline-none focus:border-[#6aa9d8] w-52"
            />
          </div>

          <button
            onClick={exportCsv}
            disabled={sortedData.length === 0}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] text-xs text-[#bdbdb8] border border-white/[0.08] transition-all disabled:opacity-50"
            title="Download CSV export"
          >
            <Download className="w-3 h-3 text-[#6aa9d8]" />
            <span className="hidden sm:inline">CSV</span>
          </button>

          <button
            onClick={exportPdf}
            disabled={sortedData.length === 0}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#6aa9d8]/15 hover:bg-[#6aa9d8]/25 text-xs text-[#6aa9d8] border border-[#6aa9d8]/30 transition-all disabled:opacity-50 font-medium"
            title="Print / download PDF export"
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
            <span>Loading Jev historical files...</span>
          </div>
        ) : error ? (
          <div className="p-8 text-center text-xs text-[#e5787f]">{error}</div>
        ) : sortedData.length === 0 ? (
          <div className="p-12 text-center text-xs text-[#9a9ca3]">
            No data matches the selected time window or filters.
          </div>
        ) : (
          <div className="overflow-x-auto max-h-[650px] overflow-y-auto">
            <table className="w-full text-right text-xs border-collapse">
              <thead className="sticky top-0 z-10 bg-[#181a1e] text-[#9a9ca3] border-b border-white/[0.1] text-[11px] tracking-wider">
                <tr>
                  <th className="py-3.5 px-4 font-semibold text-center w-14">No.</th>
                  <th
                    onClick={() => handleSort("time")}
                    className="py-3.5 px-4 font-semibold cursor-pointer select-none hover:text-white transition-colors group"
                    title="Click to sort by time and date"
                  >
                    <div className="flex items-center gap-1.5">
                      <span>Date & time (ET)</span>
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
                        title={`Click to sort by ${col.label}`}
                      >
                        <div className="flex items-center gap-1.5">
                          <span>{col.label}</span>
                          {filterFieldMap.has(col.id) && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                addFieldFilter(col.id);
                              }}
                              className="p-0.5 rounded hover:bg-white/[0.08]"
                              title={filteredFieldIds.has(col.id) ? `Filtered. Add another condition on ${col.label}` : `Filter on ${col.label}`}
                            >
                              <Filter
                                className={`w-3 h-3 ${
                                  filteredFieldIds.has(col.id) ? "text-[#d97757]" : "text-[#73757c] opacity-40 group-hover:opacity-100"
                                }`}
                              />
                            </button>
                          )}
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
                  <th className="py-3.5 px-4 font-semibold text-center">Actions</th>
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
                          View
                        </button>
                        <a
                          href={withHistorySet(`/api/jev/history?file=${row.filename}`)}
                          target="_blank"
                          rel="noreferrer"
                          className="p-1 rounded bg-white/[0.06] hover:bg-white/[0.12] text-[#9a9ca3] hover:text-white transition-colors"
                          title="Download JSON file"
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
              Show 100 more rows ({Math.min(visibleRowsCount, sortedData.length)} of {sortedData.length})
            </button>
            <button
              type="button"
              onClick={() => setVisibleRowsCount(sortedData.length)}
              className="px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] text-[#9a9ca3] text-xs font-medium transition-colors"
            >
              Show all ({sortedData.length})
            </button>
          </div>
        )}

        <div className="bg-[#181a1e]/90 border-t border-white/[0.08] px-4 py-2.5 flex items-center justify-between text-[11px] text-[#9a9ca3]">
          <span>Showing {Math.min(visibleRowsCount, sortedData.length)} of {filteredData.length} snapshot files (in the selected window)</span>
          <span>Files path on the server: <code className="text-[#6aa9d8]">/jev/history/</code></span>
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
                  Full file content: <b className="font-mono text-[#6aa9d8]">{selectedFileForModal}</b>
                </span>
              </div>
              <div className="flex items-center gap-2">
                <a
                  href={withHistorySet(`/api/jev/history?file=${selectedFileForModal}`)}
                  target="_blank"
                  rel="noreferrer"
                  className="px-2.5 py-1 rounded bg-white/[0.08] hover:bg-white/[0.15] text-[11px] text-[#bdbdb8] transition-colors"
                >
                  Direct download
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
                  Reloading JSON file...
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
