"use client";

import { Play, RotateCw, Square } from "lucide-react";
import { heartbeatFreshness } from "@/lib/staleness";
import { btn, formatDuration } from "./format";
import { CollapsibleSection } from "./CollapsibleSection";
import type { StatusPayload, WorkerState } from "./types";

const STATE_STYLE: Record<WorkerState, string> = {
  running: "bg-[#5fbf9a]/10 text-[#5fbf9a] border-[#5fbf9a]/30",
  starting: "bg-[#d4b063]/10 text-[#d4b063] border-[#d4b063]/30",
  restarting: "bg-[#d4b063]/10 text-[#d4b063] border-[#d4b063]/30",
  crashed: "bg-[#e5787f]/10 text-[#e5787f] border-[#e5787f]/30",
  stopped: "bg-white/[0.04] text-[#9a9ca3] border-[rgba(190,190,200,0.15)]",
  external: "bg-[#9fb4ee]/10 text-[#9fb4ee] border-[#9fb4ee]/30",
  unknown: "bg-white/[0.04] text-[#73757c] border-[rgba(190,190,200,0.15)]",
};

const FRESH_STYLE = { fresh: "text-[#5fbf9a]", stale: "text-[#d4b063]", dead: "text-[#e5787f]", none: "text-[#73757c]" };

const DESCRIPTIONS: Record<string, string> = {
  web: "Dashboard server (status only)",
  alerts: "Records Up/Down ticks, evaluates alert rules, sends Telegram",
  jev: "Snapshots + Jev/Kev/Span model calls",
  bot: "Telegram trade listener + order execution",
};

export function WorkersPanel({
  status,
  busy,
  onAction,
}: {
  status: StatusPayload | null;
  busy: string | null;
  onAction: (name: string, action: "start" | "stop" | "restart") => void;
}) {
  const supervisorUp = !!status?.supervisor;
  const now = status?.now ?? 0;
  return (
    <CollapsibleSection
      title="Workers"
      right={
        status?.supervisor && (
          <span className="text-[11px] text-[#73757c]">
            supervisor pid {status.supervisor.pid} · up {formatDuration(now - status.supervisor.startedAt)}
          </span>
        )
      }
    >
      <div className="divide-y divide-white/[0.06]">
        {(status?.workers ?? []).map(w => {
          const fresh = heartbeatFreshness(w.heartbeat?.last_ok_at, w.intervalSec, now);
          const lastOkAgo = w.heartbeat?.last_ok_at ? formatDuration(now - w.heartbeat.last_ok_at * 1000) : null;
          const isBusy = !!busy?.startsWith(`${w.name}:`);
          const canStart = supervisorUp && w.controllable && ["stopped", "crashed", "external"].includes(w.state);
          const canStop = supervisorUp && w.controllable && ["running", "starting", "restarting"].includes(w.state);
          const canRestart = supervisorUp && w.controllable && w.state !== "external" && w.state !== "unknown";
          const errorLine = w.lastError || w.heartbeat?.last_error;
          return (
            <div key={w.name} className="px-5 py-3 flex flex-wrap items-center gap-x-6 gap-y-2">
              <div className="w-44">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm text-[#e8e8e4]">{w.name}</span>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full border ${STATE_STYLE[w.state]}`}>{w.state}</span>
                </div>
                <p className="text-[11px] text-[#73757c] mt-0.5">{DESCRIPTIONS[w.name]}</p>
              </div>
              <div className="flex-1 min-w-[220px] text-xs text-[#9a9ca3] tabular-nums space-y-0.5">
                {w.state === "external" ? (
                  <p>Running outside the supervisor (pid {w.externalPid}). Stop that copy first to manage it here.</p>
                ) : (
                  <p>
                    {w.pid ? `pid ${w.pid}` : "no process"}
                    {w.startedAt ? ` · up ${formatDuration(now - w.startedAt)}` : ""}
                    {w.restarts ? ` · ${w.restarts} restart${w.restarts === 1 ? "" : "s"}` : ""}
                    {w.lastExitCode != null ? ` · last exit ${w.lastExitCode}` : ""}
                  </p>
                )}
                {w.intervalSec != null && (
                  <p className={FRESH_STYLE[fresh]}>
                    {lastOkAgo ? `last good cycle ${lastOkAgo} ago` : "no successful cycle recorded yet"}
                    <span className="text-[#73757c]"> · every {w.intervalSec}s</span>
                  </p>
                )}
                {errorLine && (
                  <p className="text-[#e5787f]/90 truncate max-w-[560px]" title={errorLine}>
                    {errorLine}
                  </p>
                )}
              </div>
              {w.controllable && (
                <div className="flex gap-2">
                  <button className={btn} disabled={!canStart || isBusy} onClick={() => onAction(w.name, "start")}>
                    <Play className="w-3.5 h-3.5" /> Start
                  </button>
                  <button className={btn} disabled={!canStop || isBusy} onClick={() => onAction(w.name, "stop")}>
                    <Square className="w-3.5 h-3.5" /> Stop
                  </button>
                  <button className={btn} disabled={!canRestart || isBusy} onClick={() => onAction(w.name, "restart")}>
                    <RotateCw className={`w-3.5 h-3.5 ${isBusy ? "animate-spin" : ""}`} /> Restart
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </CollapsibleSection>
  );
}
