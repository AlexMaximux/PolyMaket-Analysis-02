"use client";

import { useEffect, useState } from "react";
import type { TfmLiveResponse, TfmTrackPoint } from "@/lib/tfm/live";
import { probAtOrAbove } from "@/lib/tfm/math";
import { TFM_MIN_CONTEXT, type TfmWindowKey } from "@/lib/tfm/types";

const TFM_COLOR = "#5ad1e6";
const EDGE_BAND = 0.03;

interface FairModel { fairUp?: number | null }
interface MarketLive { live?: number | null }
/** The part of the page's /api/updown answer this tab reads. */
interface UpdownData {
  m1h?: MarketLive | null;
  m15?: MarketLive | null;
  m5?: MarketLive | null;
  modelClaude?: FairModel | null;
  modelA?: FairModel | null;
}

const WINDOWS: { key: TfmWindowKey; label: string; open: string; color: string; marketKey: "m1h" | "m15" | "m5" }[] = [
  { key: "h1", label: "1H", open: "1H open", color: "#e5787f", marketKey: "m1h" },
  { key: "m15", label: "15m", open: "15m open", color: "#6aa9d8", marketKey: "m15" },
  { key: "m5", label: "5m", open: "5m open", color: "#d4b063", marketKey: "m5" },
];

const cardCls = "bg-white/[0.08] border border-[rgba(190,190,200,0.15)] rounded-2xl p-5 shadow-sm";
const boxCls = "bg-[#181a1e]/80 rounded-xl p-3 border border-[rgba(190,190,200,0.13)]";

function cents(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? "—" : (v * 100).toFixed(1) + "¢";
}

function fmtPrice(v: number | null | undefined, decimals?: number): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const d = decimals ?? (Math.abs(v) >= 100 ? 2 : Math.abs(v) >= 1 ? 4 : 5);
  return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

function fmtClock(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function edgeColor(edge: number | null): string {
  if (edge == null) return "text-[#73757c]";
  return edge > EDGE_BAND ? "text-[#5fbf9a]" : edge < -EDGE_BAND ? "text-[#e5787f]" : "text-[#bdbdb8]";
}

function StatusLine({
  resp,
  fetchErr,
  loading,
  refreshSec,
  onRefreshSecChange,
  onRefreshNow,
  lastUpdatedMs,
  nextFetchAtMs,
  nowMs,
}: {
  resp: TfmLiveResponse | null;
  fetchErr: string | null;
  loading: boolean;
  refreshSec: number;
  onRefreshSecChange: (sec: number) => void;
  onRefreshNow: () => void;
  lastUpdatedMs: number | null;
  nextFetchAtMs: number;
  nowMs: number;
}) {
  const state = resp?.service.state;
  const dot =
    state === "ready" ? { c: "#5fbf9a", t: "ready" }
    : state === "starting" ? { c: "#d4b063", t: "starting" }
    : state === "offline" ? { c: "#e5787f", t: "offline" }
    : state === "not-installed" ? { c: "#e5787f", t: "not installed" }
    : { c: "#73757c", t: loading ? "connecting" : "no answer" };

  const is25 = resp?.service.model?.includes("2.5");
  const modelName = is25 ? "TimesFM 2.5 (200M)" : "TimesFM 3.0";

  const nextInSec = Math.max(0, Math.ceil((nextFetchAtMs - nowMs) / 1000));
  const lastUpdatedStr = lastUpdatedMs
    ? new Date(lastUpdatedMs).toLocaleTimeString("en-GB", { hour12: false })
    : null;

  return (
    <div className={cardCls}>
      <div className="flex flex-wrap items-center justify-between gap-y-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span className="font-medium" style={{ color: TFM_COLOR }}>{modelName}</span>
          <span className="inline-flex items-center gap-1.5 text-[#bdbdb8]">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: dot.c }} /> {dot.t}
          </span>
          {resp?.service.ok && resp.service.latencyMs != null && (
            <span className="text-[#9a9ca3] tabular-nums">latency {resp.service.latencyMs} ms</span>
          )}
          {resp?.context != null && <span className="text-[#9a9ca3] tabular-nums">context {resp.context} min</span>}
          {lastUpdatedStr && (
            <span className="text-[#9a9ca3] tabular-nums">
              updated {lastUpdatedStr} · next in {nextInSec}s
            </span>
          )}
        </div>

        <div className="flex items-center gap-3 text-xs">
          <div className="flex items-center gap-1.5 text-[#9a9ca3]">
            <span>Refresh every:</span>
            <button
              onClick={() => onRefreshSecChange(30)}
              className={`px-1.5 py-0.5 rounded transition-colors ${
                refreshSec === 30 ? "bg-white/[0.12] text-[#e8e8e4] font-medium" : "hover:text-[#e8e8e4]"
              }`}
            >
              30 s
            </button>
            <span>/</span>
            <button
              onClick={() => onRefreshSecChange(60)}
              className={`px-1.5 py-0.5 rounded transition-colors ${
                refreshSec === 60 ? "bg-white/[0.12] text-[#e8e8e4] font-medium" : "hover:text-[#e8e8e4]"
              }`}
            >
              1 min
            </button>
          </div>
          <button
            onClick={onRefreshNow}
            className="px-2.5 py-1 text-xs font-medium rounded-lg bg-white/[0.08] hover:bg-white/[0.15] text-[#e8e8e4] border border-[rgba(190,190,200,0.15)] transition-colors active:scale-95"
          >
            Refresh now
          </button>
        </div>
      </div>

      {state === "starting" && (
        <p className="text-xs text-[#d4b063] mt-2">Loading the model, about 20 seconds</p>
      )}
      {state === "offline" && (
        <p className="text-xs text-[#9a9ca3] mt-2">
          The forecast service is not running. Start it with <code className="text-[#e8e8e4] bg-white/[0.08] rounded px-1.5 py-0.5">npm run tfm</code>
        </p>
      )}
      {state === "not-installed" && (
        <p className="text-xs text-[#9a9ca3] mt-2">
          The forecast service is not installed. Run <code className="text-[#e8e8e4] bg-white/[0.08] rounded px-1.5 py-0.5">npm run tfm:setup</code>
          {" "}then <code className="text-[#e8e8e4] bg-white/[0.08] rounded px-1.5 py-0.5">npm run tfm</code>
        </p>
      )}
      {resp && state === "ready" && resp.windows == null && (
        <p className="text-xs text-[#9a9ca3] mt-2">
          Not enough price history yet to forecast ({resp.context ?? 0} of {TFM_MIN_CONTEXT} one-minute prices needed).
        </p>
      )}
      {fetchErr && <p className="text-xs text-[#e5787f] mt-2">{fetchErr}</p>}
    </div>
  );
}

function WindowCard({
  label, color, win, nowMs, last, market, extra,
}: {
  label: string;
  color: string;
  win: NonNullable<TfmLiveResponse["windows"]>[TfmWindowKey] | undefined;
  nowMs: number;
  last: number | null;
  market: number | null;
  extra?: { label: string; value: number | null | undefined }[];
}) {
  const edge = win && market != null ? win.probUp - market : null;
  return (
    <div className={cardCls}>
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-medium" style={{ color }}>{label} window</p>
        <p className="text-xs text-[#9a9ca3] tabular-nums">
          {win ? <>ends in <b className="text-[#e8e8e4] font-semibold">{fmtClock(win.endSec - nowMs / 1000)}</b></> : "—"}
        </p>
      </div>
      <div className={boxCls}>
        <p className="text-[10px] text-[#73757c] mb-1">TimesFM P(Up)</p>
        <p className="text-3xl font-bold tabular-nums" style={{ color: win ? TFM_COLOR : "#73757c" }}>{win ? cents(win.probUp) : "—"}</p>
      </div>
      <div className="grid grid-cols-2 gap-3 mt-3">
        <div className={boxCls}>
          <p className="text-[10px] text-[#73757c] mb-1">Market price (Up)</p>
          <p className="text-xl font-bold text-white tabular-nums">{cents(market)}</p>
        </div>
        <div className={`${boxCls} ${edge != null && Math.abs(edge) > EDGE_BAND ? (edge > 0 ? "!border-[#5fbf9a]/40" : "!border-[#e5787f]/40") : ""}`}>
          <p className="text-[10px] text-[#73757c] mb-1">Edge (TFM − market)</p>
          <p className={`text-xl font-bold tabular-nums ${edgeColor(edge)}`}>
            {edge == null ? "—" : (edge > 0 ? "+" : "") + (edge * 100).toFixed(1) + "¢"}
          </p>
        </div>
      </div>
      <table className="w-full text-left text-xs mt-3">
        <tbody className="divide-y divide-[rgba(190,190,200,0.10)] text-[#bdbdb8] tabular-nums">
          <tr><td className="py-1.5 pr-3 text-[#9a9ca3]">Price to beat</td><td className="py-1.5 text-right">{win ? fmtPrice(win.open) : "—"}</td></tr>
          <tr><td className="py-1.5 pr-3 text-[#9a9ca3]">Current price</td><td className="py-1.5 text-right">{fmtPrice(last)}</td></tr>
          <tr><td className="py-1.5 pr-3 text-[#9a9ca3]">Forecast close (median)</td><td className="py-1.5 text-right">{win ? fmtPrice(win.median) : "—"}</td></tr>
          <tr><td className="py-1.5 pr-3 text-[#9a9ca3]">10–90% range</td><td className="py-1.5 text-right">{win ? `${fmtPrice(win.q10)} – ${fmtPrice(win.q90)}` : "—"}</td></tr>
          {extra?.map(e => (
            <tr key={e.label}><td className="py-1.5 pr-3 text-[#9a9ca3]">{e.label}</td><td className="py-1.5 text-right">{cents(e.value)}</td></tr>
          ))}
        </tbody>
      </table>
      {!win && <p className="text-[10px] text-[#73757c] mt-2">The open price of this window is not known yet.</p>}
    </div>
  );
}

function HourTrackChart({
  track,
  nowMs,
  marketSamples,
}: {
  track: TfmTrackPoint[];
  nowMs: number;
  marketSamples: { t: number; price: number }[];
}) {
  if (!track || track.length === 0) {
    return (
      <div className={cardCls}>
        <p className="text-xs text-[#9a9ca3] font-medium mb-3">P(Up) during this hour</p>
        <p className="text-xs text-[#73757c] py-4">No forecast points recorded yet during this hour.</p>
      </div>
    );
  }

  const W = 720;
  const H = 240;
  const ML = 56;
  const MR = 16;
  const MT = 18;
  const MB = 28;

  const hourStartMs = Math.floor(nowMs / 3600_000) * 3600_000;
  const hourEndMs = hourStartMs + 3600_000;
  const hourStartSec = hourStartMs / 1000;
  const hourEndSec = hourEndMs / 1000;

  const px = (tSec: number) => ML + Math.max(0, Math.min(1, (tSec - hourStartSec) / 3600)) * (W - ML - MR);
  const py = (centsVal: number) => MT + (1 - Math.max(0, Math.min(100, centsVal)) / 100) * (H - MT - MB);

  const yTicks = [0, 25, 50, 75, 100];
  const xTicks = [0, 15, 30, 45, 60];

  const line = (pts: { x: number; y: number }[]) =>
    pts.map((p, i) => `${i ? "L" : "M"}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join("");

  const h1Pts = track
    .filter(pt => pt.h1 != null)
    .map(pt => ({ x: pt.t, y: pt.h1! * 100 }));

  const m15StartSec = (Math.floor(nowMs / 900_000) * 900_000) / 1000;
  const m15EndSec = m15StartSec + 900;
  const m15Pts = track
    .filter(pt => pt.m15 != null && pt.t >= m15StartSec && pt.t <= m15EndSec)
    .map(pt => ({ x: pt.t, y: pt.m15! * 100 }));

  const m5StartSec = (Math.floor(nowMs / 300_000) * 300_000) / 1000;
  const m5EndSec = m5StartSec + 300;
  const m5Pts = track
    .filter(pt => pt.m5 != null && pt.t >= m5StartSec && pt.t <= m5EndSec)
    .map(pt => ({ x: pt.t, y: pt.m5! * 100 }));

  const marketPts = marketSamples
    .filter(s => s.t >= hourStartSec && s.t <= hourEndSec && s.price != null && Number.isFinite(s.price))
    .map(s => ({ x: s.t, y: s.price * 100 }));

  const nowSec = nowMs / 1000;

  return (
    <div className={cardCls}>
      <p className="text-xs text-[#9a9ca3] font-medium mb-3">P(Up) during this hour</p>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto min-w-[560px]" role="img" aria-label="Hour track chart">
          {yTicks.map(t => (
            <g key={t}>
              <line x1={ML} x2={W - MR} y1={py(t)} y2={py(t)} stroke="rgba(190,190,200,0.10)" />
              <text x={ML - 8} y={py(t) + 4} textAnchor="end" fontSize="11" fill="#73757c">{t}¢</text>
            </g>
          ))}
          {xTicks.map(m => {
            const tSec = hourStartSec + m * 60;
            return (
              <text key={m} x={px(tSec)} y={H - 8} textAnchor="middle" fontSize="11" fill="#73757c">
                {m === 0 ? ":00" : `:${String(m).padStart(2, "0")}`}
              </text>
            );
          })}

          {/* 50% midpoint line */}
          <line x1={ML} x2={W - MR} y1={py(50)} y2={py(50)} stroke="rgba(190,190,200,0.20)" strokeDasharray="3 3" />

          {/* Now vertical line */}
          <line x1={px(nowSec)} x2={px(nowSec)} y1={MT} y2={H - MB} stroke="rgba(190,190,200,0.45)" strokeDasharray="2 3" />
          <text x={px(nowSec)} y={MT - 4} textAnchor="middle" fontSize="10" fill="#e8e8e4">now</text>

          {/* 1H market price sampled while tab is open */}
          {marketPts.length > 1 && (
            <path d={line(marketPts)} fill="none" stroke="#9a9ca3" strokeWidth="1.5" strokeLinejoin="round" />
          )}
          {marketPts.length === 1 && (
            <circle cx={px(marketPts[0].x)} cy={py(marketPts[0].y)} r="2.5" fill="#9a9ca3" />
          )}

          {/* 15m P(Up) inside current window */}
          {m15Pts.length > 1 && (
            <path d={line(m15Pts)} fill="none" stroke="#6aa9d8" strokeWidth="1.5" strokeDasharray="4 3" strokeLinejoin="round" />
          )}
          {m15Pts.length === 1 && (
            <circle cx={px(m15Pts[0].x)} cy={py(m15Pts[0].y)} r="2.5" fill="#6aa9d8" />
          )}

          {/* 5m P(Up) inside current window */}
          {m5Pts.length > 1 && (
            <path d={line(m5Pts)} fill="none" stroke="#d4b063" strokeWidth="1.5" strokeDasharray="3 3" strokeLinejoin="round" />
          )}
          {m5Pts.length === 1 && (
            <circle cx={px(m5Pts[0].x)} cy={py(m5Pts[0].y)} r="2.5" fill="#d4b063" />
          )}

          {/* TimesFM 1H P(Up) solid line */}
          {h1Pts.length > 1 && (
            <path d={line(h1Pts)} fill="none" stroke={TFM_COLOR} strokeWidth="2" strokeLinejoin="round" />
          )}
          {h1Pts.length === 1 && (
            <circle cx={px(h1Pts[0].x)} cy={py(h1Pts[0].y)} r="3" fill={TFM_COLOR} />
          )}
          {h1Pts.length > 0 && (
            <circle cx={px(h1Pts[h1Pts.length - 1].x)} cy={py(h1Pts[h1Pts.length - 1].y)} r="3" fill={TFM_COLOR} />
          )}
        </svg>

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-[#9a9ca3] mt-2">
          <span><span className="inline-block w-3 h-0.5 align-middle mr-1" style={{ background: TFM_COLOR }} />TimesFM 1H P(Up)</span>
          <span><span className="inline-block w-3 h-0.5 align-middle mr-1 border-b border-dashed border-[#6aa9d8]" />TimesFM 15m (current window)</span>
          <span><span className="inline-block w-3 h-0.5 align-middle mr-1 border-b border-dashed border-[#d4b063]" />TimesFM 5m (current window)</span>
          <span><span className="inline-block w-3 h-0.5 align-middle mr-1 bg-[#9a9ca3]" />market (sampled while this tab is open)</span>
        </div>
      </div>
    </div>
  );
}

const labelRow = (n: number) => n * 11;

const W = 720;
const H = 340;
const ML = 72;
const MR = 16;
const MT = 18;
const MB = 28;

function FanChart({ resp }: { resp: TfmLiveResponse }) {
  const { history, path, last, windows } = resp;
  if (!history || !path || history.length < 2 || path.length === 0 || last == null) return null;

  // x: minutes from the moment of the forecast (-60 .. +60), y: price
  const histPts = history.map((v, i) => ({ x: i - (history.length - 1), y: v }));
  const steps = [{ x: 0, lo10: last, lo30: last, med: last, hi70: last, hi90: last }].concat(
    path.map(p => ({ x: p.step, lo10: p.q[0], lo30: p.q[2], med: p.q[4], hi70: p.q[6], hi90: p.q[8] })),
  );
  const opens = WINDOWS.map(w => ({ ...w, win: windows?.[w.key] ?? null })).filter(w => w.win);

  const ys: number[] = [...history, ...steps.flatMap(s => [s.lo10, s.hi90]), ...opens.map(o => o.win!.open)];
  let yMin = Math.min(...ys);
  let yMax = Math.max(...ys);
  if (!(yMax > yMin)) { yMin = last * 0.999; yMax = last * 1.001; }
  const pad = (yMax - yMin) * 0.06;
  yMin -= pad;
  yMax += pad;

  const px = (x: number) => ML + ((x + 60) / 120) * (W - ML - MR);
  const py = (y: number) => MT + (1 - (y - yMin) / (yMax - yMin)) * (H - MT - MB);
  const span = yMax - yMin;
  const dec = Math.max(0, Math.min(8, 1 - Math.floor(Math.log10(span / 4))));
  const yTicks = Array.from({ length: 5 }, (_, i) => yMin + (span * (i + 0.5)) / 5);
  const xTicks = [-60, -45, -30, -15, 0, 15, 30, 45, 60];

  const line = (pts: { x: number; y: number }[]) => pts.map((p, i) => `${i ? "L" : "M"}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join("");
  const band = (hi: (s: (typeof steps)[number]) => number, lo: (s: (typeof steps)[number]) => number) =>
    steps.map((s, i) => `${i ? "L" : "M"}${px(s.x).toFixed(1)},${py(hi(s)).toFixed(1)}`).join("") +
    [...steps].reverse().map(s => `L${px(s.x).toFixed(1)},${py(lo(s)).toFixed(1)}`).join("") + "Z";

  const ends = WINDOWS.map((w, idx) => ({ ...w, idx, win: windows?.[w.key] ?? null }))
    .filter(w => w.win)
    .map(w => ({ ...w, x: (w.win!.endSec - resp.serverTime) / 60 }))
    .filter(w => w.x > 0 && w.x <= 60);

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto min-w-[560px]" role="img" aria-label="TimesFM forecast fan chart">
        {yTicks.map((t, i) => (
          <g key={i}>
            <line x1={ML} x2={W - MR} y1={py(t)} y2={py(t)} stroke="rgba(190,190,200,0.10)" />
            <text x={ML - 8} y={py(t) + 4} textAnchor="end" fontSize="11" fill="#73757c">{fmtPrice(t, dec)}</text>
          </g>
        ))}
        {xTicks.map(t => (
          <text key={t} x={px(t)} y={H - 8} textAnchor="middle" fontSize="11" fill={t === 0 ? "#e8e8e4" : "#73757c"}>
            {t === 0 ? "now" : (t > 0 ? "+" : "") + t + "m"}
          </text>
        ))}
        <line x1={px(0)} x2={px(0)} y1={MT} y2={H - MB} stroke="rgba(190,190,200,0.45)" strokeDasharray="2 3" />

        <path d={band(s => s.hi90, s => s.lo10)} fill={TFM_COLOR} fillOpacity="0.12" />
        <path d={band(s => s.hi70, s => s.lo30)} fill={TFM_COLOR} fillOpacity="0.24" />

        {opens.map((o, i) => (
          <g key={o.key}>
            <line x1={ML} x2={W - MR} y1={py(o.win!.open)} y2={py(o.win!.open)} stroke={o.color} strokeOpacity="0.8" strokeDasharray="5 4" />
            <text x={ML + 4} y={py(o.win!.open) - 3 - labelRow(opens.slice(0, i).filter(p => Math.abs(py(p.win!.open) - py(o.win!.open)) < 11).length)} fontSize="10" fill={o.color}>{o.open}</text>
          </g>
        ))}
        {ends.map(e => (
          <g key={e.key}>
            <line x1={px(e.x)} x2={px(e.x)} y1={MT} y2={H - MB} stroke={e.color} strokeOpacity="0.55" />
            <text x={px(e.x) + 3} y={MT + 9 + e.idx * 11} fontSize="10" fill={e.color}>{e.label} end</text>
          </g>
        ))}

        <path d={line(histPts)} fill="none" stroke="#bdbdb8" strokeWidth="1.5" strokeLinejoin="round" />
        <path d={line(steps.map(s => ({ x: s.x, y: s.med })))} fill="none" stroke={TFM_COLOR} strokeWidth="2" strokeLinejoin="round" />
        <circle cx={px(0)} cy={py(last)} r="3" fill="#e8e8e4" />
      </svg>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-[#9a9ca3] mt-2">
        <span><span className="inline-block w-3 h-0.5 align-middle mr-1 bg-[#bdbdb8]" />price, last 60 min</span>
        <span><span className="inline-block w-3 h-0.5 align-middle mr-1" style={{ background: TFM_COLOR }} />forecast median</span>
        <span><span className="inline-block w-3 h-2 align-middle mr-1 rounded-sm" style={{ background: TFM_COLOR, opacity: 0.24 }} />30–70%</span>
        <span><span className="inline-block w-3 h-2 align-middle mr-1 rounded-sm" style={{ background: TFM_COLOR, opacity: 0.12 }} />10–90%</span>
      </div>
    </div>
  );
}

function HorizonTable({ resp }: { resp: TfmLiveResponse }) {
  const { path, last } = resp;
  if (!path || last == null) return null;
  const rows = [5, 15, 60]
    .map(step => path.find(p => p.step === step))
    .filter((p): p is NonNullable<typeof p> => !!p && p.q.length >= 9);
  if (rows.length === 0) return null;
  return (
    <div className={cardCls}>
      <p className="text-xs text-[#9a9ca3] font-medium mb-3">Horizons from now</p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs whitespace-nowrap">
          <thead>
            <tr className="text-[10px] text-[#73757c]">
              <th className="py-1.5 pr-4 font-normal">Horizon</th>
              <th className="py-1.5 pr-4 font-normal text-right">Median</th>
              <th className="py-1.5 pr-4 font-normal text-right">10%</th>
              <th className="py-1.5 pr-4 font-normal text-right">90%</th>
              <th className="py-1.5 pr-4 font-normal text-right">Median move</th>
              <th className="py-1.5 font-normal text-right">P(above current price)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[rgba(190,190,200,0.10)] text-[#bdbdb8] tabular-nums">
            {rows.map(p => {
              const median = p.q[4];
              const move = (median / last - 1) * 100;
              return (
                <tr key={p.step}>
                  <td className="py-1.5 pr-4 text-[#e8e8e4]">+{p.step} min</td>
                  <td className="py-1.5 pr-4 text-right">{fmtPrice(median)}</td>
                  <td className="py-1.5 pr-4 text-right">{fmtPrice(p.q[0])}</td>
                  <td className="py-1.5 pr-4 text-right">{fmtPrice(p.q[8])}</td>
                  <td className="py-1.5 pr-4 text-right">{(move > 0 ? "+" : "") + move.toFixed(3)}%</td>
                  <td className="py-1.5 text-right" style={{ color: TFM_COLOR }}>{cents(probAtOrAbove(last, last, p.q))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function TfmForecastTab({ coin, data }: { coin: string; data: UpdownData | null }) {
  const [resp, setResp] = useState<TfmLiveResponse | null>(null);
  const [fetchErr, setFetchErr] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const [refreshSec, setRefreshSec] = useState<number>(() => {
    try {
      const v = localStorage.getItem("tfm-refresh-sec");
      if (v === "60") return 60;
    } catch {}
    return 30;
  });
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [lastUpdatedMs, setLastUpdatedMs] = useState<number | null>(null);
  const [nextFetchAtMs, setNextFetchAtMs] = useState<number>(() => Date.now() + 30_000);

  const [marketSamples, setMarketSamples] = useState<{ t: number; price: number }[]>([]);
  const currentHour = Math.floor(nowMs / 3600_000);
  const [prevCoin, setPrevCoin] = useState(coin);
  const [prevHour, setPrevHour] = useState(currentHour);

  if (coin !== prevCoin) {
    setPrevCoin(coin);
    setMarketSamples([]);
  }
  if (currentHour !== prevHour) {
    setPrevHour(currentHour);
    setMarketSamples([]);
  }

  const handleRefreshSecChange = (sec: number) => {
    setRefreshSec(sec);
    try {
      localStorage.setItem("tfm-refresh-sec", String(sec));
    } catch {}
  };

  const handleRefreshNow = () => {
    setRefreshTrigger(n => n + 1);
  };

  const livePrice = data?.m1h?.live;

  // countdowns tick once a second from the browser clock, sampling live price
  useEffect(() => {
    const id = setInterval(() => {
      setNowMs(Date.now());
      if (livePrice != null && Number.isFinite(livePrice)) {
        const t = Math.floor(Date.now() / 1000);
        setMarketSamples(prev => {
          if (prev.length > 0 && prev[prev.length - 1].t === t) return prev;
          return [...prev, { t, price: livePrice }].slice(-360);
        });
      }
    }, 1000);
    return () => clearInterval(id);
  }, [livePrice]);

  // poll the forecast: every refreshSec (30 s / 60 s), every 3 s while the model is still loading; restarts on coin or refresh trigger
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ctrl = new AbortController();

    const run = async () => {
      let nextMs = refreshSec * 1000;
      try {
        const r = await fetch(`/api/updown/tfm?coin=${encodeURIComponent(coin)}`, {
          cache: "no-store",
          signal: ctrl.signal,
        });
        const j = (await r.json()) as TfmLiveResponse;
        if (stopped) return;
        if (!j || !j.service) throw new Error(`bad answer (HTTP ${r.status})`);
        setResp(j);
        setFetchErr(null);
        setLastUpdatedMs(Date.now());
        if (j.service.state === "starting") nextMs = 3000;
      } catch (e) {
        if (stopped) return;
        setFetchErr(`Could not read the forecast: ${e instanceof Error ? e.message : "request failed"}`);
      }
      if (!stopped) {
        setNextFetchAtMs(Date.now() + nextMs);
        timer = setTimeout(run, nextMs);
      }
    };

    void run();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      ctrl.abort();
    };
  }, [coin, refreshSec, refreshTrigger]);

  // an answer for another coin is not shown while the new one loads
  const cur = resp && resp.coin === coin ? resp : null;
  const windows = cur?.windows ?? null;

  return (
    <div className="space-y-4">
      <StatusLine
        resp={cur}
        fetchErr={fetchErr}
        loading={!fetchErr && !cur}
        refreshSec={refreshSec}
        onRefreshSecChange={handleRefreshSecChange}
        onRefreshNow={handleRefreshNow}
        lastUpdatedMs={lastUpdatedMs}
        nextFetchAtMs={nextFetchAtMs}
        nowMs={nowMs}
      />

      {cur && windows && (
        <>
          <div className="grid md:grid-cols-3 gap-4">
            {WINDOWS.map(w => (
              <WindowCard
                key={w.key}
                label={w.label}
                color={w.color}
                win={windows[w.key]}
                nowMs={nowMs}
                last={cur.last}
                market={data?.[w.marketKey]?.live ?? null}
                extra={w.key === "h1" ? [
                  { label: "Claude fair value (Up)", value: data?.modelClaude?.fairUp },
                  { label: "Model A fair value (Up)", value: data?.modelA?.fairUp },
                ] : undefined}
              />
            ))}
          </div>

          <HourTrackChart track={cur.track} nowMs={nowMs} marketSamples={marketSamples} />

          <div className={cardCls}>
            <p className="text-xs text-[#9a9ca3] font-medium mb-3">Price path: last 60 minutes and the next 60</p>
            <FanChart resp={cur} />
          </div>

          <HorizonTable resp={cur} />
        </>
      )}

      <p className="text-[11px] text-[#73757c] leading-relaxed">
        TimesFM is a general time-series model. Its edge against the market is not validated.
      </p>
    </div>
  );
}
