"use client";

import { useCallback, useEffect, useState } from "react";
import { FlaskConical, Save } from "lucide-react";
import { btn, card, input } from "./format";
import { CollapsibleSection } from "./CollapsibleSection";

interface AlertRow {
  id: number;
  name: string;
  alert_type: string;
  enabled: number;
  telegram_chat: string;
  telegram_token_masked: string | null;
}

const TYPE_LABEL: Record<string, string> = {
  updown: "UP/DOWN signal",
  jev: "UP/DOWN signal",
};

export function AlertBotsPanel({ notify }: { notify: (ok: boolean, msg: string) => void }) {
  const [alerts, setAlerts] = useState<AlertRow[] | null>(null);
  const [tokenDrafts, setTokenDrafts] = useState<Record<number, string>>({});
  const [chatDrafts, setChatDrafts] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<number, string>>({});

  const load = useCallback(
    () =>
      fetch("/api/alerts", { cache: "no-store" })
        .then(r => r.json())
        .then(d => setAlerts(d.alerts || [])),
    []
  );
  useEffect(() => {
    load().catch(() => notify(false, "Could not load alert rules"));
  }, [load, notify]);

  const save = async (a: AlertRow) => {
    const telegramToken = tokenDrafts[a.id] ?? "";
    const telegramChat = chatDrafts[a.id] ?? a.telegram_chat;
    setBusy(`save:${a.id}`);
    setErrors(e => ({ ...e, [a.id]: "" }));
    try {
      const res = await fetch(`/api/alerts/${a.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update", telegramToken, telegramChat }),
      });
      const d = await res.json();
      if (!res.ok) {
        setErrors(e => ({ ...e, [a.id]: d.error || "save failed" }));
        return notify(false, `${a.name}: not saved`);
      }
      setTokenDrafts(t => ({ ...t, [a.id]: "" }));
      await load();
      notify(true, `${a.name}: saved`);
    } catch {
      notify(false, `${a.name}: save failed`);
    } finally {
      setBusy(null);
    }
  };

  const test = async (a: AlertRow) => {
    setBusy(`test:${a.id}`);
    try {
      const d = await fetch(`/api/alerts/${a.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test" }),
      }).then(r => r.json());
      notify(!!d.ok, d.ok ? `${a.name}: test message sent` : `${a.name}: Telegram rejected the message`);
    } catch {
      notify(false, `${a.name}: test failed`);
    } finally {
      setBusy(null);
    }
  };

  if (!alerts) return <section className={`${card} p-5 text-sm text-[#73757c]`}>Loading alert rules…</section>;
  if (alerts.length === 0) {
    return (
      <section className={`${card} p-5 text-sm text-[#73757c]`}>
        No alert rules yet — create one on the <a href="/alerts" className="text-[#9fb4ee] hover:underline">Alerts</a> page first.
      </section>
    );
  }

  return (
    <CollapsibleSection
      title="Alert Rules — Telegram"
      subtitle={
        <>
          Each rule below sends through its own bot. Create, pause or delete rules on the{" "}
          <a href="/alerts" className="text-[#9fb4ee] hover:underline">Alerts</a> page — this only edits which bot/chat each one uses.
        </>
      }
    >
      <div className="divide-y divide-white/[0.06]">
        {alerts.map(a => (
          <div key={a.id} className="p-5 grid md:grid-cols-[180px_1fr_1fr_auto] gap-4 items-start">
            <div>
              <p className="text-sm text-[#e8e8e4]">{a.name}</p>
              <p className="text-[11px] text-[#73757c] mt-0.5">
                {TYPE_LABEL[a.alert_type] || a.alert_type} · {a.enabled ? <span className="text-[#5fbf9a]">active</span> : <span>paused</span>}
              </p>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-[#9a9ca3] mb-1.5">Bot token</label>
              <input
                type="password"
                autoComplete="off"
                className={input}
                value={tokenDrafts[a.id] ?? ""}
                placeholder={a.telegram_token_masked ? `set ${a.telegram_token_masked} — leave empty to keep` : "not set"}
                onChange={e => setTokenDrafts(t => ({ ...t, [a.id]: e.target.value }))}
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-[#9a9ca3] mb-1.5">Chat ID</label>
              <input
                className={input}
                value={chatDrafts[a.id] ?? a.telegram_chat}
                onChange={e => setChatDrafts(t => ({ ...t, [a.id]: e.target.value }))}
              />
            </div>
            <div className="flex gap-2 md:pt-6">
              <button className={btn} disabled={busy === `test:${a.id}`} onClick={() => test(a)}>
                <FlaskConical className="w-3.5 h-3.5" /> Test
              </button>
              <button className={btn} disabled={busy === `save:${a.id}`} onClick={() => save(a)}>
                <Save className="w-3.5 h-3.5" /> Save
              </button>
            </div>
            {errors[a.id] && <p className="text-[11px] text-[#e5787f] md:col-span-4">{errors[a.id]}</p>}
          </div>
        ))}
      </div>
    </CollapsibleSection>
  );
}
