"use client";
import { useCallback, useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Bell, Plus, Trash2, Play, Send, Power, CheckCircle2, XCircle } from "lucide-react";
import { btn, card, input } from "@/components/control/format";

interface AlertRule {
  id: number;
  name: string;
  alert_type: "updown" | "jev";
  enabled: number;
  telegram_chat: string;
  fired_count: number;
  last_fired_at: number | null;
  last_evaluated_at: number | null;
}

export default function AlertsPage() {
  const [alerts, setAlerts] = useState<AlertRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [chat, setChat] = useState("");
  const [alertType, setAlertType] = useState<"updown" | "jev">("jev");
  const [formError, setFormError] = useState("");

  const fetchAlerts = useCallback(async () => {
    const res = await fetch("/api/alerts", { cache: "no-store" });
    const data = await res.json();
    setAlerts(data.alerts || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchAlerts();
    const t = setInterval(fetchAlerts, 30000);
    return () => clearInterval(t);
  }, [fetchAlerts]);

  const notify = (ok: boolean, msg: string) => {
    setToast({ ok, msg });
    setTimeout(() => setToast(null), 5000);
  };

  const createAlert = async () => {
    setFormError("");
    const res = await fetch("/api/alerts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, alertType, telegramToken: token, telegramChat: chat }),
    });
    const data = await res.json();
    if (!res.ok) return setFormError(data.error || "failed to create");
    setName("");
    setToken("");
    setChat("");
    notify(true, "Alert rule created.");
    fetchAlerts();
  };

  const act = async (id: number, action: string) => {
    setBusy(`${id}:${action}`);
    try {
      const res = await fetch(`/api/alerts/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (action === "test") notify(!!data.ok, data.ok ? "Test message sent to Telegram" : "Telegram send failed — check token and chat ID");
      else if (action === "run") notify(true, data.matched > 0 ? (data.sent ? `Sent ${data.matched} signal(s)` : "Matched, but the Telegram send failed") : "No new signal right now");
      await fetchAlerts();
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-[#e8e8e4] flex items-center gap-2">
          <Bell className="w-5 h-5 text-[#9fb4ee]" /> Alerts
        </h1>
        <p className="text-sm text-[#9a9ca3] mt-1">
          Telegram alerts for Up/Down signals. <b>Jev</b> rules fire when the multi-model record qualifies; <b>Up/Down</b> rules fire when both fair values beat the executable price plus fee.
        </p>
      </div>

      {toast && (
        <div className={`rounded-xl border px-4 py-2 text-sm ${toast.ok ? "border-[#5fbf9a]/30 bg-[#16241f] text-[#b9e5d3]" : "border-[#e5787f]/30 bg-[#2a1719] text-[#f1b9be]"}`}>
          {toast.msg}
        </div>
      )}

      <div className={`${card} p-5 space-y-3`}>
        <p className="text-sm font-medium text-[#e8e8e4]">New rule</p>
        <div className="grid md:grid-cols-2 gap-3">
          <input className={input} placeholder="Name, e.g. BTC signals" value={name} onChange={e => setName(e.target.value)} />
          <select className={input} value={alertType} onChange={e => setAlertType(e.target.value as "updown" | "jev")}>
            <option value="jev">Jev multi-model signal</option>
            <option value="updown">Up/Down fair value vs price</option>
          </select>
          <input className={input} placeholder="Telegram bot token" value={token} onChange={e => setToken(e.target.value)} />
          <input className={input} placeholder="Telegram chat ID" value={chat} onChange={e => setChat(e.target.value)} />
        </div>
        {formError && <p className="text-xs text-[#e5787f]">{formError}</p>}
        <button className={btn} onClick={createAlert} disabled={!name || !token || !chat}>
          <Plus className="w-3.5 h-3.5" /> Create rule
        </button>
      </div>

      <div className="space-y-3">
        {loading ? (
          <p className="text-center text-[#73757c] p-8">Loading…</p>
        ) : alerts.length === 0 ? (
          <p className="text-center text-[#73757c] p-8">No alert rules yet — create one above.</p>
        ) : (
          alerts.map(a => (
            <div key={a.id} className={`${card} p-4 flex flex-wrap items-center gap-4`}>
              <div className="flex-1 min-w-[240px]">
                <div className="flex items-center gap-2">
                  {a.enabled ? <CheckCircle2 className="w-4 h-4 text-[#5fbf9a]" /> : <XCircle className="w-4 h-4 text-[#73757c]" />}
                  <span className="font-semibold text-[#e8e8e4]">{a.name}</span>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full border ${a.enabled ? "border-[#5fbf9a]/30 text-[#5fbf9a]" : "border-white/10 text-[#73757c]"}`}>
                    {a.enabled ? "ACTIVE" : "PAUSED"}
                  </span>
                </div>
                <p className="text-xs text-[#9a9ca3] mt-1.5">
                  {a.alert_type === "jev" ? "Jev + Kev + Span consensus signal" : "Up/Down fair value vs executable price"} · chat <span className="font-mono">{a.telegram_chat}</span>
                </p>
                <p className="text-[11px] text-[#73757c] mt-1">
                  {a.fired_count} sent
                  {a.last_fired_at && <> · last {formatDistanceToNow(new Date(a.last_fired_at * 1000), { addSuffix: true })}</>}
                  {a.last_evaluated_at && <> · evaluated {formatDistanceToNow(new Date(a.last_evaluated_at * 1000), { addSuffix: true })}</>}
                </p>
              </div>
              <div className="flex gap-2">
                <button className={btn} onClick={() => act(a.id, "test")} disabled={busy === `${a.id}:test`}>
                  <Send className="w-3.5 h-3.5" /> Test
                </button>
                {a.alert_type === "updown" && (
                  <button className={btn} onClick={() => act(a.id, "run")} disabled={busy === `${a.id}:run`}>
                    <Play className="w-3.5 h-3.5" /> Run now
                  </button>
                )}
                <button className={btn} onClick={() => act(a.id, a.enabled ? "disable" : "enable")}>
                  <Power className="w-3.5 h-3.5" /> {a.enabled ? "Pause" : "Resume"}
                </button>
                <button className={btn} onClick={() => act(a.id, "delete")}>
                  <Trash2 className="w-3.5 h-3.5 text-[#e5787f]" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
