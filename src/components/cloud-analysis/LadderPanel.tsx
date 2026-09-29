"use client";

import { useMemo, useRef, useState } from "react";
import {
  DEFAULT_LADDER_CONFIG,
  buildLadderTrades,
  computeLadderMetrics,
  optimizeLadder,
  type LadderConfig,
  type LadderRung,
  type OptimizerResult,
} from "@/lib/ladderBacktest";
import { MIN_RESOLVED_FOR_VERDICT, type SnapshotRow, type Trade } from "@/lib/signalAnalysis";

const pct = (x: number | null | undefined, d = 1) => (x == null || isNaN(x) ? "—" : `${(x * 100).toFixed(d)}%`);
const money = (x: number | null | undefined) =>
  x == null || isNaN(x) ? "—" : `${x < 0 ? "−" : x > 0 ? "+" : ""}$${Math.abs(x).toFixed(2)}`;

const cardCls = "rounded-2xl border border-white/[0.08] bg-[#181a1e]/80 p-4";
const inputCls =
  "w-full bg-[#0f1013] text-[#e8e8e4] border border-white/[0.12] rounded-lg px-2 py-1.5 text-[12px] font-mono focus:outline-none focus:border-[#8ea4e8]";
const btnCls =
  "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium border border-white/[0.12] bg-white/[0.04] text-[#e8e8e4] hover:bg-white/[0.08] disabled:opacity-50 disabled:cursor-not-allowed";
const kpiCls = "rounded-xl border border-white/[0.07] bg-[#131418] px-3 py-2.5";

export function LadderPanel({
  rows,
  baseTrades,
  stake,
  effectiveSplit,
}: {
  rows: SnapshotRow[];
  baseTrades: Trade[];
  stake: number;
  effectiveSplit: string | null;
}) {
  const [config, setConfig] = useState<LadderConfig>(DEFAULT_LADDER_CONFIG);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<OptimizerResult | null>(null);
  const cancelRef = useRef(false);

  const ladderTrades = useMemo(() => buildLadderTrades(baseTrades, rows, config, stake), [baseTrades, rows, config, stake]);
  const metrics = useMemo(() => computeLadderMetrics(ladderTrades), [ladderTrades]);

  const setRung = (i: number, patch: Partial<LadderRung>) =>
    setConfig((p) => ({ rungs: p.rungs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)) }));

  const runOptimizer = async () => {
    if (!effectiveSplit) return;
    setRunning(true);
    setProgress(0);
    cancelRef.current = false;
    const r = await optimizeLadder(baseTrades, rows, stake, effectiveSplit, config, {}, () => cancelRef.current);
    setResult(r);
    setProgress(r.triedCount);
    setRunning(false);
  };

  const overfitWarning =
    result &&
    result.trainMetrics.roi != null &&
    result.holdoutMetrics.roi != null &&
    result.holdoutMetrics.roi < result.trainMetrics.roi - 0.1;
  // train resolved below the optimizer's own minimum means no candidate could ever have won, so
  // whatever config comes back was never actually compared against anything
  const notEnoughTrainData = result && result.trainMetrics.resolved < MIN_RESOLVED_FOR_VERDICT;

  return (
    <section className={cardCls}>
      <div className="mb-3">
        <h2 className="text-[14px] font-semibold text-[#e8e8e4]">Ladder backtest</h2>
        <p className="text-[12px] text-[#9a9ca3] mt-0.5">
          Base order (1x) at the signal price, plus extra orders further down if the price actually gets there.
        </p>
      </div>

      <div className="grid sm:grid-cols-3 gap-2 mb-3">
        {config.rungs.map((r, i) => (
          <div key={i} className={`${kpiCls} space-y-1.5`}>
            <div className="text-[11px] text-[#9a9ca3]">Rung {i + 1}</div>
            <label className="block text-[10px] text-[#73757c]">
              Distance (¢ below entry)
              <input
                type="number"
                className={`${inputCls} mt-0.5`}
                value={r.distanceCents}
                min={0}
                onChange={(e) => setRung(i, { distanceCents: Math.max(0, parseFloat(e.target.value) || 0) })}
              />
            </label>
            <label className="block text-[10px] text-[#73757c]">
              Size (x base stake)
              <input
                type="number"
                className={`${inputCls} mt-0.5`}
                value={r.sizeMultiplier}
                step={0.05}
                min={0}
                onChange={(e) => setRung(i, { sizeMultiplier: Math.max(0, parseFloat(e.target.value) || 0) })}
              />
            </label>
            <div className="text-[11px] text-[#73757c]">filled in {pct(metrics.fillRateByRung[i] ?? null, 0)} of trades</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
        <div className={kpiCls}>
          <div className="text-[11px] text-[#9a9ca3]">Trades</div>
          <div className="text-[18px] font-semibold font-mono mt-0.5 text-[#e8e8e4]">{metrics.trades}</div>
        </div>
        <div className={kpiCls}>
          <div className="text-[11px] text-[#9a9ca3]">Win rate</div>
          <div className="text-[18px] font-semibold font-mono mt-0.5 text-[#e8e8e4]">{pct(metrics.winRate)}</div>
        </div>
        <div className={kpiCls}>
          <div className="text-[11px] text-[#9a9ca3]">ROI</div>
          <div className="text-[18px] font-semibold font-mono mt-0.5 text-[#e8e8e4]">{pct(metrics.roi)}</div>
        </div>
        <div className={kpiCls}>
          <div className="text-[11px] text-[#9a9ca3]">P&amp;L</div>
          <div className="text-[18px] font-semibold font-mono mt-0.5 text-[#e8e8e4]">{money(metrics.pnl)}</div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button type="button" className={btnCls} disabled={running || !effectiveSplit} onClick={runOptimizer}>
          {running ? `Searching… (${progress})` : "Optimize"}
        </button>
        {running && (
          <button
            type="button"
            className={btnCls}
            onClick={() => {
              cancelRef.current = true;
            }}
          >
            Cancel
          </button>
        )}
        {!effectiveSplit && <span className="text-[11px] text-[#73757c]">Pick a walk-forward split date above first.</span>}
      </div>

      {result && notEnoughTrainData && (
        <div className="mt-3 pt-3 border-t border-white/[0.06] text-[11px] text-[#d4b063]">
          Not enough train trades ({result.trainMetrics.resolved} &lt; {MIN_RESOLVED_FOR_VERDICT}) — kept your current settings, nothing was actually
          compared. Pick an earlier split date or widen the filters above.
        </div>
      )}
      {result && !notEnoughTrainData && (
        <div className="mt-3 pt-3 border-t border-white/[0.06] space-y-2">
          <div className="text-[11px] text-[#9a9ca3]">
            Best of {result.triedCount} tried{result.cancelled ? " (cancelled early)" : ""}: train ROI {pct(result.trainMetrics.roi)}, holdout ROI{" "}
            {pct(result.holdoutMetrics.roi)}
            {overfitWarning && <span className="text-[#e5787f]"> — holdout is much worse than train, likely overfit.</span>}
          </div>
          <div className="text-[11px] text-[#73757c] font-mono">
            {result.config.rungs.map((r, i) => `rung${i + 1}: ${r.distanceCents}¢ @ ${r.sizeMultiplier}x`).join(" · ")}
          </div>
          <button type="button" className={btnCls} onClick={() => setConfig(result.config)}>
            Apply this config
          </button>
        </div>
      )}
    </section>
  );
}
