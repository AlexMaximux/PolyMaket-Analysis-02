"use client";

import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { card } from "./format";

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

// Collapse state persists per section (keyed by title) across reloads, same convention as
// /cloud-analysis's own collapsible cards.
export function CollapsibleSection({
  title,
  subtitle,
  right,
  defaultOpen = true,
  children,
  className = "",
}: {
  title: string;
  subtitle?: React.ReactNode;
  right?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  const storageKey = `control_section_open_${slugify(title)}`;
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    // deferred to a microtask, not called synchronously in the effect body, so the server
    // render and first client render still match before this restores the saved state
    Promise.resolve().then(() => {
      try {
        const saved = localStorage.getItem(storageKey);
        if (saved != null) setOpen(saved === "1");
      } catch {}
    });
  }, [storageKey]);

  const toggle = () =>
    setOpen(o => {
      const next = !o;
      try {
        localStorage.setItem(storageKey, next ? "1" : "0");
      } catch {}
      return next;
    });

  return (
    <section className={`${card} overflow-hidden ${className}`}>
      <div className={`px-5 py-3 flex flex-wrap items-center gap-3 ${open ? "border-b border-white/[0.06]" : ""}`}>
        <button type="button" onClick={toggle} className="flex items-start gap-1.5 mr-2 text-left min-w-0">
          <ChevronRight className={`w-3.5 h-3.5 mt-0.5 shrink-0 text-[#73757c] transition-transform ${open ? "rotate-90" : ""}`} />
          <span className="min-w-0">
            <h2 className="text-sm font-medium text-[#e8e8e4]">{title}</h2>
            {subtitle && open && <p className="text-[11px] text-[#73757c] mt-0.5">{subtitle}</p>}
          </span>
        </button>
        {open && right}
      </div>
      {open && children}
    </section>
  );
}
