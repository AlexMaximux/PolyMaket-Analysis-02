"use client";

import { useCallback, useEffect, useState } from "react";
import { FlaskConical, Save } from "lucide-react";
import type { PublicSetting, SettingKey } from "@/lib/settings";
import { btn, card, input } from "./format";
import { CollapsibleSection } from "./CollapsibleSection";

type Kind = "secret" | "text" | "int" | "num" | "coins" | "flags" | "bool" | "select";
interface Field {
  label: string;
  kind: Kind;
  hint?: string;
  flags?: Record<string, string>;
  options?: string[];
  /** Only shown when this returns true, given a getter for other fields' current values. */
  showIf?: (current: (key: SettingKey) => unknown) => boolean;
}

const FIELDS: Record<SettingKey, Field> = {
  "openrouter.apiKey": { label: "API key", kind: "secret" },
  "jev.telegramToken": { label: "Bot token", kind: "secret", hint: "Default target for Jev signal alerts" },
  "jev.telegramChat": { label: "Chat ID", kind: "text" },
  "watchdog.telegramToken": { label: "Bot token", kind: "secret", hint: "Sends a message when a worker or the BTC prediction records stall" },
  "watchdog.telegramChat": { label: "Chat ID", kind: "text" },
  "jev.coins": { label: "Coins", kind: "coins" },
  "jev.models": {
    label: "Models",
    kind: "flags",
    flags: { jev: "Jev", kev: "Kev-4b", span: "Span-01", solar: "Solar-Decide (extra filter, not a consensus vote)", tev: "Tev-4b (extra, not a consensus vote)", mercury: "Mercury-Decide (extra, free, not a consensus vote)", liquid: "Liquid-D1 (extra, not a consensus vote)" },
    hint: "Each enabled model is one paid OpenRouter call per coin per record",
  },
  "jev.recordIntervalSec": { label: "Record every (s)", kind: "int", hint: "30–3600" },
  "jev.snapshotIntervalSec": { label: "Snapshot refresh (s)", kind: "int", hint: "10–600" },
  "alerts.intervalSec": { label: "Alert evaluation (s)", kind: "int", hint: "30–3600" },
  "supervisor.autostart": {
    label: "Start with supervisor",
    kind: "flags",
    flags: { alerts: "alerts", jev: "jev", bot: "bot (never autostarts by default)" },
    hint: "Applies next time the supervisor starts",
  },
  "bot.forwardEnabled": { label: "Execute frozen forward signals", kind: "bool", hint: "Uses the strategy chosen below (cloud-analysis has its forward test). Only fresh BTC 1H signals after activation; fixed bot stake. Start the bot worker. Browser need not stay open." },
  "bot.forwardStrategy": { label: "Strategy", kind: "select", options: ["s5", "v2"], hint: "s5 = Frozen strategy 1 + Optimised: UP score > 3.25 at 90–100%, DOWN score < 0.75 at 0–98%, minute 30–55. v2 = Frozen strategy 1: score > 3.5 / < 0.5 at 90%+, minute 32+. Both: BTC, Jev + Kev + Span agree, first signal of the hour. Changing it re-arms the bridge: only signals after the change trade, and an hour already bought is never bought again." },
  "bot.autoRedeem": { label: "Auto-redeem wins", kind: "bool", hint: "Checks finalized real BTC 1H winners every minute while the bot worker runs. It remains active when buying is disabled or in simulation. Deposit Wallet redemption is gasless." },
  "bot.redeemMaxGasPol": { label: "Maximum gas per redeem (POL)", kind: "num", hint: "Transactions above this fee cap are not sent. Default: 0.10 POL." },
  "bot.enabled": { label: "Enabled (kill switch)", kind: "bool", hint: "Off by default. While off, every buy signal — Telegram or API — is refused before any market is even looked up." },
  "bot.simulationMode": { label: "Simulation mode", kind: "bool", hint: "On = paper trading, no funds move. Turning this off enables real orders with real money on the next trade." },
  "bot.walletType": { label: "Wallet type", kind: "select", options: ["EOA", "POLY_PROXY", "POLY_GNOSIS_SAFE", "DEPOSIT_WALLET"] },
  "bot.proxyAddress": {
    label: "Polymarket wallet address",
    kind: "text",
    hint: "For your account, enter the B address shown by Polymarket. The test verifies that private-key address A owns it.",
    showIf: current => current("bot.walletType") !== "EOA",
  },
  "bot.privateKey": { label: "Wallet private key", kind: "secret", hint: "Signs locally; the private key is never sent to Polymarket. Stored encrypted on this computer." },
  "bot.builderApiKey": { label: "Builder API key", kind: "secret", hint: "Created automatically by Wallet test for gasless Deposit Wallet actions. Stored encrypted." },
  "bot.builderSecret": { label: "Builder secret", kind: "secret", hint: "Created automatically; leave empty to keep the saved value." },
  "bot.builderPassphrase": { label: "Builder passphrase", kind: "secret", hint: "Created automatically; leave empty to keep the saved value." },
  "bot.rpcUrl": { label: "Polygon RPC URL", kind: "text", hint: "Optional — defaults to a public Polygon RPC" },
  "bot.maxBudget": { label: "Total budget cap ($)", kind: "num" },
  "bot.orderPriceMode": { label: "Order price", kind: "select", options: ["slippage", "market"], hint: "slippage: pay at most the best ask + the slippage below. market: take the best available prices up to 0.99 (fills almost always, but can pay far above the signal price)." },
  "bot.slippageCents": { label: "Slippage (¢)", kind: "int", hint: "0–20. Used when Order price is slippage: the order is cancelled instead of filled above best ask + this many cents." },
  "bot.maxAttempts": { label: "Buy attempts", kind: "int", hint: "1–10. If the order is not filled (price moved, book too thin), try again up to this many times, each time at the fresh market price. Ambiguous results are never retried, to avoid buying twice." },
  "bot.perTradeAmount": { label: "Per-trade amount ($)", kind: "num", hint: "Fixed amount for each BTC 1H buy. Polymarket normally requires at least 5 shares; use $5 or more to cover that minimum at any valid price." },
  "bot.telegramToken": { label: "Bot token", kind: "secret", hint: "Separate bot from the Jev alert bot above — e.g. @tornbalancebot" },
  "bot.telegramChatId": { label: "Private user/chat ID", kind: "text" },
};

const GROUPS: Array<{ title: string; keys: SettingKey[]; test?: string; danger?: (current: (key: SettingKey) => unknown) => boolean }> = [
  { title: "OpenRouter", keys: ["openrouter.apiKey"], test: "openrouter" },
  { title: "Jev Telegram", keys: ["jev.telegramToken", "jev.telegramChat"], test: "telegram" },
  { title: "Heartbeat alerts", keys: ["watchdog.telegramToken", "watchdog.telegramChat"] },
  { title: "Jev collector", keys: ["jev.coins", "jev.models", "jev.recordIntervalSec", "jev.snapshotIntervalSec"] },
  { title: "Intervals", keys: ["alerts.intervalSec"] },
  { title: "Supervisor", keys: ["supervisor.autostart"] },
  {
    title: "Trading Bot — Wallet & Risk",
    keys: ["bot.enabled", "bot.simulationMode", "bot.walletType", "bot.proxyAddress", "bot.privateKey", "bot.rpcUrl", "bot.maxBudget", "bot.perTradeAmount", "bot.orderPriceMode", "bot.slippageCents", "bot.maxAttempts"],
    test: "bot",
    danger: current => current("bot.enabled") === true && current("bot.simulationMode") === false,
  },
  { title: "Trading Bot — Forward test", keys: ["bot.forwardEnabled", "bot.forwardStrategy"] },
  { title: "Trading Bot — Redemption", keys: ["bot.autoRedeem", "bot.redeemMaxGasPol", "bot.builderApiKey", "bot.builderSecret", "bot.builderPassphrase"] },
  { title: "Trading Bot — Telegram", keys: ["bot.telegramToken", "bot.telegramChatId"], test: "bot-telegram" },
];

export function SettingsPanel({ notify }: { notify: (ok: boolean, msg: string) => void }) {
  const [settings, setSettings] = useState<Record<SettingKey, PublicSetting> | null>(null);
  const [coins, setCoins] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Partial<Record<SettingKey, unknown>>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    () =>
      fetch("/api/settings", { cache: "no-store" })
        .then(r => r.json())
        .then(d => {
          setSettings(d.settings);
          setCoins(d.coins);
        }),
    []
  );
  useEffect(() => {
    load().catch(() => notify(false, "Could not load settings"));
  }, [load, notify]);

  if (!settings) return <section className={`${card} p-5 text-sm text-[#73757c]`}>Loading settings…</section>;

  const current = (key: SettingKey): unknown => {
    if (key in drafts) return drafts[key];
    const s = settings[key];
    return s.secret ? "" : s.value;
  };
  const setDraft = (key: SettingKey, value: unknown) => setDrafts(d => ({ ...d, [key]: value }));

  const save = async (title: string, keys: SettingKey[]) => {
    const changes = Object.fromEntries(keys.filter(k => k in drafts).map(k => [k, drafts[k]]));
    if (!Object.keys(changes).length) return notify(true, "Nothing changed");
    setBusy(`save:${title}`);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changes }),
      });
      const d = await res.json();
      if (!res.ok) {
        setErrors(e => ({ ...e, ...d.errors }));
        return notify(false, "Not saved — fix the highlighted fields");
      }
      setErrors(e => Object.fromEntries(Object.entries(e).filter(([k]) => !keys.includes(k as SettingKey))));
      setDrafts(dr => Object.fromEntries(Object.entries(dr).filter(([k]) => !keys.includes(k as SettingKey))));
      await load();
      const parts = ["Saved."];
      if (d.restarted.length) parts.push(`Restarted: ${d.restarted.join(", ")}.`);
      if (d.pending.length) parts.push(`Restart ${d.pending.join(", ")} to apply${d.supervisor ? "" : " (supervisor not running)"}.`);
      notify(true, parts.join(" "));
    } catch {
      notify(false, "Save failed");
    } finally {
      setBusy(null);
    }
  };

  const test = async (target: string) => {
    setBusy(`test:${target}`);
    try {
      const d = await fetch("/api/settings/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target }),
      }).then(r => r.json());
      notify(!!d.ok, d.message);
    } catch {
      notify(false, "Test failed");
    } finally {
      setBusy(null);
    }
  };

  const renderField = (key: SettingKey) => {
    const f = FIELDS[key];
    if (f.showIf && !f.showIf(current)) return null;
    const s = settings[key];
    const value = current(key);
    const err = errors[key];
    let control: React.ReactNode;
    if (f.kind === "secret" && s.secret) {
      control = (
        <input
          type="password"
          autoComplete="off"
          className={input}
          value={String(value ?? "")}
          placeholder={s.set ? `set ${s.masked ?? ""} (${s.source === "env" ? ".env.local" : "saved"}) — leave empty to keep` : "not set"}
          onChange={e => setDraft(key, e.target.value)}
        />
      );
    } else if (f.kind === "text") {
      control = <input className={input} value={String(value ?? "")} onChange={e => setDraft(key, e.target.value)} />;
    } else if (f.kind === "int" || f.kind === "num") {
      control = (
        <input className={`${input} max-w-[8rem] tabular-nums`} inputMode="decimal" value={String(value ?? "")} onChange={e => setDraft(key, e.target.value)} />
      );
    } else if (f.kind === "select") {
      control = (
        <select className={input} value={String(value ?? f.options?.[0] ?? "")} onChange={e => setDraft(key, e.target.value)}>
          {(f.options ?? []).map(o => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    } else if (f.kind === "bool") {
      const on = !!value;
      control = (
        <label className="flex items-center gap-2 text-xs text-[#bdbdb8] cursor-pointer">
          <input type="checkbox" className="accent-[#6aa9d8] w-4 h-4" checked={on} onChange={e => setDraft(key, e.target.checked)} />
          <span className={on ? "text-[#5fbf9a]" : "text-[#9a9ca3]"}>{on ? "On" : "Off"}</span>
        </label>
      );
    } else if (f.kind === "coins") {
      const picked = new Set((value as string[]) ?? []);
      control = (
        <div className="flex flex-wrap gap-3">
          {coins.map(c => (
            <label key={c} className="flex items-center gap-1.5 text-xs text-[#bdbdb8] cursor-pointer uppercase">
              <input
                type="checkbox"
                className="accent-[#6aa9d8]"
                checked={picked.has(c)}
                onChange={e => {
                  const next = new Set(picked);
                  if (e.target.checked) next.add(c);
                  else next.delete(c);
                  setDraft(key, coins.filter(x => next.has(x)));
                }}
              />
              {c}
            </label>
          ))}
        </div>
      );
    } else {
      const flags = (value as Record<string, boolean>) ?? {};
      control = (
        <div className="flex flex-wrap gap-3">
          {Object.entries(f.flags ?? {}).map(([k, label]) => (
            <label key={k} className="flex items-center gap-1.5 text-xs text-[#bdbdb8] cursor-pointer">
              <input
                type="checkbox"
                className="accent-[#6aa9d8]"
                checked={!!flags[k]}
                onChange={e => setDraft(key, { ...flags, [k]: e.target.checked })}
              />
              {label}
            </label>
          ))}
        </div>
      );
    }
    return (
      <div key={key}>
        <label className="block text-[11px] font-medium text-[#9a9ca3] mb-1.5">
          {f.label}
          {!s.secret && s.source !== "db" && (
            <span className="text-[#73757c] font-normal"> · {s.source === "env" ? "from .env.local" : "default"}</span>
          )}
        </label>
        {control}
        {err ? (
          <p className="text-[11px] text-[#e5787f] mt-1">{err}</p>
        ) : (
          f.hint && <p className="text-[11px] text-[#73757c] mt-1">{f.hint}</p>
        )}
        {key === "bot.simulationMode" && value === false && (
          <p className="text-[11px] text-[#e5787f] mt-1.5 font-medium">
            ⚠️ Live mode: the next buy signal spends real money from the configured wallet.
          </p>
        )}
      </div>
    );
  };

  return (
    <CollapsibleSection title="Settings">
      <div className="p-5 pt-3 grid md:grid-cols-2 gap-3">
        {GROUPS.map(g => {
          const isDanger = g.danger?.(current);
          return (
            <div
              key={g.title}
              className={`${card} p-5 ${isDanger ? "border-[#e5787f]/40 bg-[#e5787f]/[0.03]" : ""}`}
            >
              <div className="flex items-center justify-between mb-4 gap-2">
                <h3 className="text-sm text-[#e8e8e4] flex items-center gap-2">
                  {g.title}
                  {isDanger && (
                    <span className="text-[10px] px-2 py-0.5 rounded-full border border-[#e5787f]/40 bg-[#e5787f]/10 text-[#e5787f]">
                      LIVE — real money
                    </span>
                  )}
                </h3>
                <div className="flex gap-2">
                  {g.test && (
                    <button className={btn} disabled={busy === `test:${g.test}`} onClick={() => test(g.test!)} title="Uses the saved values">
                      <FlaskConical className="w-3.5 h-3.5" /> Test saved
                    </button>
                  )}
                  <button className={btn} disabled={busy === `save:${g.title}`} onClick={() => save(g.title, g.keys)}>
                    <Save className="w-3.5 h-3.5" /> Save
                  </button>
                </div>
              </div>
              <div className="space-y-4">{g.keys.map(renderField)}</div>
            </div>
          );
        })}
      </div>
    </CollapsibleSection>
  );
}
