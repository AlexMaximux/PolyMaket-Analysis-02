"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Bot } from "lucide-react";
import { card } from "./format";
import type { BotStatus } from "@/lib/bot/types";

const money = (n: number) => `$${n.toFixed(2)}`;

export function BotStatusStrip() {
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [checkMessage, setCheckMessage] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    const load = () =>
      fetch("/api/bot/trade", { cache: "no-store" })
        .then(r => r.json())
        .then(d => {
          if (stop) return;
          if (d.error) setError(d.error);
          else {
            setStatus(d);
            setError(null);
          }
        })
        .catch(() => {});
    load();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 10_000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);

  if (error) {
    return (
      <section className={`${card} px-5 py-3 flex items-center gap-2 text-sm text-[#e5787f]`}>
        <AlertTriangle className="w-4 h-4" /> Trading bot status unavailable: {error}
      </section>
    );
  }
  if (!status) return null;

  const live = status.enabled && !status.simulationMode;
  return (
    <section className={`${card} px-5 py-3 ${live ? "border-[#e5787f]/40 bg-[#e5787f]/[0.03]" : ""}`}>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex items-center gap-2 w-40">
          <Bot className="w-4 h-4 text-[#9fb4ee]" />
          <span className="text-sm text-[#e8e8e4]">Trading Bot</span>
        </div>
        <span
          className={`text-[10px] px-2 py-0.5 rounded-full border ${
            status.enabled ? "bg-[#5fbf9a]/10 text-[#5fbf9a] border-[#5fbf9a]/30" : "bg-white/[0.04] text-[#9a9ca3] border-[rgba(190,190,200,0.15)]"
          }`}
        >
          {status.enabled ? "ENABLED" : "DISABLED (kill switch off)"}
        </span>
        <span
          className={`text-[10px] px-2 py-0.5 rounded-full border ${
            status.simulationMode
              ? "bg-[#d4b063]/10 text-[#d4b063] border-[#d4b063]/30"
              : "bg-[#e5787f]/10 text-[#e5787f] border-[#e5787f]/30"
          }`}
        >
          {status.simulationMode ? "SIMULATION" : "LIVE — real money"}
        </span>
        <span className="text-xs text-[#9a9ca3] tabular-nums">
          Wallet:{" "}
          {status.walletAddress ? (
            <span className="font-mono text-[#bdbdb8]" title={status.walletAddress}>
              {status.walletAddress.slice(0, 6)}…{status.walletAddress.slice(-4)}
            </span>
          ) : (
            <span className="text-[#e5787f]">not configured</span>
          )}
        </span>
        <span className="text-xs text-[#9a9ca3] tabular-nums">
          Wallet balance:{" "}
          {status.walletConnection === "CONNECTED" && status.walletBalanceUsd != null ? (
            <span className="text-[#5fbf9a] font-medium">{money(status.walletBalanceUsd)} USDC · CONNECTED</span>
          ) : status.walletConnection === "ERROR" ? (
            <span className="text-[#e5787f]">connection check failed</span>
          ) : (
            <span className="text-[#e5787f]">not configured</span>
          )}
        </span>
        <span className="text-xs text-[#9a9ca3] tabular-nums">
          Spent: <span className="text-[#e8e8e4]">{money(status.totalSpent)}</span> / {money(status.maxTotalBudget)}
          <span className="text-[#73757c]"> · {money(status.perTradeAmount)}/trade</span>
        </span>
        {status.activeMarket && (
          <>
            <span className="text-xs text-[#9a9ca3] truncate max-w-[260px]" title={status.activeMarket.title}>
              Market: <span className="text-[#bdbdb8]">{status.activeMarket.title}</span>
            </span>
            {status.activeMarket.minimumOrderSize && status.activeMarket.bestAskUp && status.activeMarket.bestAskDown &&
              status.perTradeAmount + 0.000001 < status.activeMarket.minimumOrderSize * Math.max(status.activeMarket.bestAskUp, status.activeMarket.bestAskDown) && (
              <span className="text-xs text-[#d4b063]">
                Stake too low: {money(status.perTradeAmount)} · current minimum UP {money(status.activeMarket.minimumOrderSize * status.activeMarket.bestAskUp)} / DOWN {money(status.activeMarket.minimumOrderSize * status.activeMarket.bestAskDown)}
              </span>
            )}
          </>
        )}
      </div>
      {status.geo?.checked && (status.geo.apiBlocked ?? status.geo.blocked) && (
        <div className="mt-3 rounded border border-[#e5787f]/40 bg-[#e5787f]/10 px-3 py-2 text-xs text-[#ef9da2]">
          New buys restricted by Polymarket API for this server location: {status.geo.country || "unknown"}{status.geo.region ? ` / ${status.geo.region}` : ""}. New buys are stopped before signing.
        </div>
      )}
      {status.geo?.checked && status.geo.blocked && status.geo.apiBlocked === false && (
        <div className="mt-3 rounded border border-[#d4b063]/40 bg-[#d4b063]/10 px-3 py-2 text-xs text-[#e7c87e]">
          Website restricted in {status.geo.country}; trading API is unrestricted by location according to Polymarket documentation. Orders remain subject to CLOB validation.
        </div>
      )}
      {status.geo && !status.geo.checked && (
        <div className="mt-3 rounded border border-[#d4b063]/40 bg-[#d4b063]/10 px-3 py-2 text-xs text-[#e7c87e]">
          Polymarket location check is unavailable. Live buys are stopped until the server location can be verified.
        </div>
      )}
      {status.forward && <div className="mt-2 text-xs text-[#9a9ca3]">
        Frozen forward {status.forward.strategy}: {status.forward.enabled ? "ON" : "OFF"} · Last scan: {status.forward.lastScan ? new Date(status.forward.lastScan).toLocaleString() : "Waiting for bot worker"}
        {status.forward.lastError && <div>{status.forward.lastError}</div>}
        {status.notifications && <div>Telegram pending: {status.notifications.pending} · Awaiting retry: {status.notifications.failed}</div>}
      </div>}
      {status.redemption && (
        <div className="mt-2 pt-2 border-t border-white/[0.06] text-xs text-[#9a9ca3] space-y-1">
          <div>Auto-redeem: {status.redemption.active ? "ON" : "PAUSED"} · Received {money(status.redemption.totalRedeemed)} {status.redemption.collateral}{status.redemption.gasless ? " · Gasless" : ` · Gas cap ${status.redemption.maxGasPol} POL`}</div>
          <div className="text-[11px]">Last scan: {status.redemption.lastScan ? new Date(status.redemption.lastScan).toLocaleString() : "Waiting for bot worker"}</div>
          {status.redemption.lastError && <div className="text-[#d4b063]">{status.redemption.lastError}</div>}
          {status.redemption.recent.slice(0, 3).map(r => <div key={r.id}>
            {r.state} · {r.payout ? `${r.payout} ${status.redemption.collateral}` : r.slug}
            {r.tx_hash && <a className="ml-2 underline" href={`https://polygonscan.com/tx/${r.tx_hash}`} target="_blank" rel="noreferrer">Transaction</a>}
            {r.error && <span className="ml-2 text-[#d4b063]">{r.error}</span>}
          </div>)}
        </div>
      )}
      {status.pendingRequests?.map(r => (
        <div key={r.requestId} className="mt-2 text-xs text-[#d4b063]">
          {r.state}: {r.requestId} · Reserved {money(status.reservedBudget)}
          <button type="button" disabled={checking === r.requestId} className="ml-3 rounded border border-[#d4b063]/40 bg-[#d4b063]/10 px-2 py-1 text-[#e7c87e] hover:bg-[#d4b063]/20 disabled:cursor-wait disabled:opacity-60" onClick={async () => {
            setChecking(r.requestId);
            setCheckMessage(null);
            try {
              const response = await fetch('/api/bot/reconcile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: r.requestId }) });
              const result = await response.json();
              if (!response.ok) { setCheckMessage(result.error || 'Could not check order. No new order sent.'); return; }
              setCheckMessage(result.status === 'FILLED' ? 'Order filled and recorded.' : result.status === 'FAILED' ? (result.error || 'No trade occurred; reserved budget released.') : 'Order is still being verified. No new order was sent.');
              const current = await fetch('/api/bot/trade', { cache: 'no-store' });
              if (current.ok) setStatus(await current.json());
            } catch { setCheckMessage('Could not check order. No new order was sent.'); }
            finally { setChecking(null); }
          }}>{checking === r.requestId ? 'Checking…' : 'Check order status'}</button>
        </div>
      ))}
      {checkMessage && <div className="mt-2 text-xs text-[#bdbdb8]">{checkMessage}</div>}
      {status.recentTrades.length > 0 && (
        <div className="mt-2 pt-2 border-t border-white/[0.06] text-[11px] text-[#73757c] space-x-3">
          {status.recentTrades.slice(0, 3).map(t => (
            <span key={t.id} className="tabular-nums">
              {t.status === "FILLED" ? "✅" : t.status === "SIMULATED" ? "🟡" : "❌"} {t.symbol}/{t.outcome} {money(t.amount_usd)}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
