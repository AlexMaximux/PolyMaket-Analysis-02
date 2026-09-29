"use client";

import { useEffect, useState } from "react";
import { card, formatBytes } from "./format";

interface Health {
  dbBytes: number;
  walBytes: number;
  jevBytes: number;
  openrouter: { usage: number | null; limit: number | null; remaining: number | null } | null;
  openrouterError: string | null;
}

function Dot({ ok }: { ok: boolean | null }) {
  const color = ok == null ? "bg-[#73757c]" : ok ? "bg-[#5fbf9a]" : "bg-[#e5787f]";
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${color} mr-1.5 align-middle`} />;
}

export function HealthStrip() {
  const [h, setH] = useState<Health | null>(null);
  useEffect(() => {
    let stop = false;
    const load = () =>
      fetch("/api/control/health", { cache: "no-store" })
        .then(r => r.json())
        .then(d => {
          if (!stop) setH(d);
        })
        .catch(() => {});
    load();
    const id = setInterval(load, 30_000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);

  const credit = h?.openrouter
    ? h.openrouter.remaining != null
      ? `$${h.openrouter.remaining.toFixed(2)} left`
      : h.openrouter.usage != null
      ? `$${h.openrouter.usage.toFixed(2)} used · no limit`
      : "key ok"
    : h?.openrouterError || "—";
  const openrouterOk = h ? !!h.openrouter : null;

  const items = [
    { label: "Database", value: h ? formatBytes(h.dbBytes) : "—", dot: null },
    { label: "WAL", value: h ? formatBytes(h.walBytes) : "—", dot: null },
    { label: "jev/ files", value: h ? formatBytes(h.jevBytes) : "—", dot: null },
    { label: "OpenRouter API", value: credit, dot: openrouterOk },
  ];
  return (
    <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {items.map(i => (
        <div key={i.label} className={`${card} px-4 py-3`}>
          <p className="text-[11px] uppercase tracking-wide text-[#73757c]">{i.label}</p>
          <p className="text-sm text-[#e8e8e4] tabular-nums mt-1 truncate" title={i.value}>
            {i.dot != null && <Dot ok={i.dot} />}
            {i.value}
          </p>
        </div>
      ))}
    </section>
  );
}
