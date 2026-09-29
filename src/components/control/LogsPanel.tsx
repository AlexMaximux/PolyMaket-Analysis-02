"use client";

import { useEffect, useRef, useState } from "react";
import { Download, Eraser, Pause, Play } from "lucide-react";
import { btn } from "./format";
import { CollapsibleSection } from "./CollapsibleSection";
import type { LogLine } from "./types";

const NAMES = ["bot", "web", "alerts", "jev"];

export function LogsPanel({ supervisorUp }: { supervisorUp: boolean }) {
  const [name, setName] = useState("bot");
  const [lines, setLines] = useState<LogLine[]>([]);
  const [paused, setPaused] = useState(false);
  const [clearedAt, setClearedAt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const pick = (n: string) => {
    setName(n);
    setLines([]);
    setClearedAt(0);
  };

  useEffect(() => {
    if (!supervisorUp || paused) return;
    let stop = false;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch(`/api/control/logs/${name}?tail=200`, { cache: "no-store" });
        const d = await res.json();
        if (stop) return;
        if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
        setLines(d.lines || []);
        setError(null);
      } catch (e) {
        if (!stop) setError((e as Error).message);
      }
    };
    load();
    const id = setInterval(load, 3000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [name, paused, supervisorUp]);

  useEffect(() => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const download = async () => {
    const res = await fetch(`/api/control/logs/${name}?tail=500`, { cache: "no-store" });
    const d = await res.json();
    const text = (d.lines || []).map((l: LogLine) => `${new Date(l.t).toISOString()} [${l.stream}] ${l.text}`).join("\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const shown = lines.filter(l => l.t > clearedAt);
  return (
    <CollapsibleSection
      title="Logs"
      right={
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-1">
            {NAMES.map(n => (
              <button
                key={n}
                onClick={() => pick(n)}
                className={`px-2.5 py-1 rounded-md text-xs font-mono transition-colors ${n === name ? "bg-white/[0.10] text-[#e8e8e4]" : "text-[#9a9ca3] hover:bg-white/[0.05]"}`}
              >
                {n}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <button className={btn} disabled={!supervisorUp} onClick={() => setPaused(p => !p)}>
              {paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />} {paused ? "Resume" : "Pause"}
            </button>
            <button className={btn} disabled={!supervisorUp} onClick={() => setClearedAt(Date.now())}>
              <Eraser className="w-3.5 h-3.5" /> Clear view
            </button>
            <button className={btn} disabled={!supervisorUp} onClick={download}>
              <Download className="w-3.5 h-3.5" /> Download
            </button>
          </div>
        </div>
      }
    >
      <div ref={boxRef} className="h-80 overflow-auto px-5 py-3 font-mono text-[12px] leading-5 bg-black/20">
        {!supervisorUp ? (
          <p className="text-[#73757c]">Logs are available while the supervisor is running.</p>
        ) : error ? (
          <p className="text-[#e5787f]">{error}</p>
        ) : shown.length === 0 ? (
          <p className="text-[#73757c]">No output yet.</p>
        ) : (
          shown.map((l, i) => (
            <div
              key={`${l.t}-${i}`}
              className={`whitespace-pre-wrap break-all ${l.stream === "err" ? "text-[#e5787f]" : l.stream === "sys" ? "text-[#9fb4ee]" : "text-[#bdbdb8]"}`}
            >
              <span className="text-[#73757c]">{new Date(l.t).toLocaleTimeString()} </span>
              {l.text}
            </div>
          ))
        )}
      </div>
    </CollapsibleSection>
  );
}
