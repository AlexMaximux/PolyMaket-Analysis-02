import { readHeartbeats } from './heartbeat';
import { getLatestHistoricalFile } from './jevSnapshot';
import { getSetting, type WorkerName } from './settings';

/**
 * Telegram alert when a background worker stops producing results. The supervisor runs this on a timer;
 * it sends one message when a check goes bad and one when it recovers, never a message per tick.
 */

export interface WatchCheck {
  id: string;
  label: string;
  /** seconds since the last good result; null = the worker has never reported (not watched) */
  ageSec: number | null;
  limitSec: number;
}

export interface WatchStep {
  messages: string[];
  down: Set<string>;
}

const fmtAge = (sec: number) => (sec >= 3600 ? `${(sec / 3600).toFixed(1)}h` : `${Math.round(sec / 60)}min`);

export function watchdogStep(checks: WatchCheck[], previouslyDown: Set<string>): WatchStep {
  const down = new Set<string>();
  const messages: string[] = [];
  for (const c of checks) {
    if (c.ageSec == null) continue;
    if (c.ageSec > c.limitSec) {
      down.add(c.id);
      if (!previouslyDown.has(c.id)) {
        messages.push(`🔴 <b>${c.label}</b> stalled — no result for ${fmtAge(c.ageSec)} (limit ${fmtAge(c.limitSec)}).`);
      }
    } else if (previouslyDown.has(c.id)) {
      messages.push(`🟢 <b>${c.label}</b> recovered.`);
    }
  }
  return { messages, down };
}

/** Limits are deliberately loose: a jev cycle includes three LLM calls, and a restart pauses everything. */
export function collectChecks(nowMs = Date.now(), autostart: Record<WorkerName, boolean> = getSetting('supervisor.autostart')): WatchCheck[] {
  const hb = readHeartbeats();
  const nowSec = nowMs / 1000;
  const age = (worker: string) => (hb[worker]?.last_ok_at ? nowSec - hb[worker].last_ok_at! : null);
  const checks: WatchCheck[] = [];
  const add = (worker: WorkerName, limitSec: number) => {
    if (autostart[worker]) checks.push({ id: worker, label: `${worker} worker`, ageSec: age(worker), limitSec });
  };
  add('alerts', Math.max(600, 10 * getSetting('alerts.intervalSec')));
  add('jev', 600);
  if (autostart.jev) {
    const latest = getLatestHistoricalFile('btc');
    checks.push({
      id: 'jev-records',
      label: 'BTC prediction records',
      ageSec: latest ? nowSec - latest.timestamp / 1000 : null,
      limitSec: Math.max(900, 3 * getSetting('jev.recordIntervalSec')),
    });
  }
  return checks;
}
