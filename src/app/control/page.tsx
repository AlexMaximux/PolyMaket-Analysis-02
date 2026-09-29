"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { WorkersPanel } from "@/components/control/WorkersPanel";
import { LogsPanel } from "@/components/control/LogsPanel";
import { HealthStrip } from "@/components/control/HealthStrip";
import { BotStatusStrip } from "@/components/control/BotStatusStrip";
import { SettingsPanel } from "@/components/control/SettingsPanel";
import { AlertBotsPanel } from "@/components/control/AlertBotsPanel";
import type { StatusPayload } from "@/components/control/types";

export default function ControlPage() {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

  const notify = useCallback((ok: boolean, msg: string) => {
    setToast({ ok, msg });
    setTimeout(() => setToast(t => (t?.msg === msg ? null : t)), 6000);
  }, []);

  // a failed poll keeps the last status; the next poll retries
  const fetchStatus = () =>
    fetch("/api/control/status", { cache: "no-store" })
      .then(r => r.json() as Promise<StatusPayload>)
      .catch(() => null);

  useEffect(() => {
    let stop = false;
    const poll = () =>
      fetchStatus().then(d => {
        if (d && !stop) setStatus(d);
      });
    poll();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") poll();
    }, 3000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);

  const onAction = async (name: string, action: "start" | "stop" | "restart") => {
    setBusy(`${name}:${action}`);
    try {
      const res = await fetch(`/api/control/workers/${name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const d = await res.json();
      if (!res.ok) notify(false, d.error || `${action} failed`);
      else notify(true, `${name}: ${d.state}`);
      const fresh = await fetchStatus();
      if (fresh) setStatus(fresh);
    } catch {
      notify(false, `${action} failed`);
    } finally {
      setBusy(null);
    }
  };

  const supervisorUp = !!status?.supervisor;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-[#e8e8e4]">Control</h1>
        <p className="text-sm text-[#9a9ca3] mt-1">Workers, logs and settings. Local access only unless ALLOW_REMOTE_ACCESS is set.</p>
      </div>

      {status && !supervisorUp && (
        <div className="flex items-start gap-3 rounded-2xl border border-[#d4b063]/30 bg-[#d4b063]/10 px-5 py-3 text-sm text-[#e8d9ae]">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <div>
            Supervisor not running — start it with <code className="font-mono">npm run supervisor</code> to control workers and see logs.
            Settings can still be saved; restart workers manually to apply them.
          </div>
        </div>
      )}

      <HealthStrip />
      <BotStatusStrip />
      <WorkersPanel status={status} busy={busy} onAction={onAction} />
      <LogsPanel supervisorUp={supervisorUp} />
      <AlertBotsPanel notify={notify} />
      <SettingsPanel notify={notify} />

      {toast && (
        <div
          role="status"
          className={`fixed bottom-5 right-5 max-w-md rounded-xl border px-4 py-3 text-sm shadow-lg ${
            toast.ok ? "border-[#5fbf9a]/30 bg-[#16241f] text-[#b9e5d3]" : "border-[#e5787f]/30 bg-[#2a1719] text-[#f1b9be]"
          }`}
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
}
