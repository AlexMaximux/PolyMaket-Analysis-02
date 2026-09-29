import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());

import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import { initializeDb } from '../src/lib/db';
import { getSetting, WORKER_NAMES } from '../src/lib/settings';
import { LogBuffer } from '../src/lib/supervisor/logs';
import { Worker, type ChildLike, type WorkerSpec } from '../src/lib/supervisor/worker';
import { createControlHandler } from '../src/lib/supervisor/control';
import { sendTelegram } from '../src/lib/alerts';
import { collectChecks, watchdogStep } from '../src/lib/watchdog';
import { SUPERVISOR_PORT, TOKEN_FILE, WEB_PORT } from '../src/lib/supervisor/config';

/**
 * Runs the web app and the background workers, restarts crashed workers, keeps logs in logs/<name>.log,
 * and serves the control API used by /control. A worker that is already running outside the supervisor
 * (launchd, another terminal, the IDE) is reported as "external" and not started twice.
 *
 * Env: PMP_PORT (web, default 8000), SUPERVISOR_PORT (default 8001),
 *      SUPERVISOR_AUTOSTART=comma list to override the autostart settings (e.g. "web,backfill").
 */

const ROOT = fs.realpathSync(process.cwd());
const bin = (name: string) => path.join(ROOT, 'node_modules', '.bin', name);
const childEnv = { ...process.env, PMP_BASE_URL: process.env.PMP_BASE_URL || `http://127.0.0.1:${WEB_PORT}` };

const isProd = process.env.NODE_ENV === 'production' || fs.existsSync(path.join(ROOT, '.next', 'BUILD_ID'));
const specs: WorkerSpec[] = [
  { name: 'web', command: bin('next'), args: [isProd ? 'start' : 'dev', '-H', '0.0.0.0', '-p', String(WEB_PORT)], controllable: false },
  ...WORKER_NAMES.map(name => ({ name, command: bin('tsx'), args: [`scripts/${name}.ts`], controllable: true })),
];

function spawnChild(command: string, args: string[]): ChildLike {
  // own process group, so stop() also reaches the grandchildren (tsx → node, next → next-server)
  const child = spawn(command, args, { cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  return {
    pid: child.pid,
    stdout: child.stdout,
    stderr: child.stderr,
    once: (event, listener) => child.once(event, listener),
    kill: signal => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    },
  };
}

function run(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

function cwdOf(pid: number): string | null {
  const line = run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
    .split('\n')
    .find(l => l.startsWith('n'));
  return line ? line.slice(1) : null;
}

function detectExternalFor(name: string): () => number | null {
  if (name === 'web') {
    return () => {
      const pid = parseInt(run('lsof', ['-nP', `-iTCP:${WEB_PORT}`, '-sTCP:LISTEN', '-t']).split('\n')[0], 10);
      return pid > 0 ? pid : null;
    };
  }
  const needle = `scripts/${name}.ts`;
  return () => {
    for (const line of run('ps', ['-axo', 'pid=,command=']).split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const command = m[2];
      if (pid === process.pid || !command.includes(needle)) continue;
      if (command.includes(path.join(ROOT, needle)) || cwdOf(pid) === ROOT) return pid;
    }
    return null;
  };
}

function autostartNames(): Set<string> {
  const override = process.env.SUPERVISOR_AUTOSTART;
  if (override !== undefined) return new Set(override.split(',').map(s => s.trim()).filter(Boolean));
  const flags = getSetting('supervisor.autostart');
  return new Set(['web', ...WORKER_NAMES.filter(n => flags[n])]);
}

async function main() {
  initializeDb();
  const token = crypto.randomBytes(32).toString('hex');
  const workers = new Map<string, Worker>();
  for (const spec of specs) {
    workers.set(
      spec.name,
      new Worker(spec, {
        spawn: spawnChild,
        logs: new LogBuffer({ file: path.join(ROOT, 'logs', `${spec.name}.log`) }),
        detectExternal: detectExternalFor(spec.name),
      })
    );
  }

  const server = http.createServer(createControlHandler({ workers, token, startedAt: Date.now() }));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(SUPERVISOR_PORT, '127.0.0.1', () => resolve());
  });
  fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  console.log(`[supervisor] control API on http://127.0.0.1:${SUPERVISOR_PORT} — dashboard: http://127.0.0.1:${WEB_PORT}/control`);

  const autostart = autostartNames();
  for (const [name, w] of workers) {
    if (!autostart.has(name)) {
      console.log(`[supervisor] ${name}: autostart off`);
      continue;
    }
    const s = w.start();
    console.log(`[supervisor] ${name}: ${s.state}${s.externalPid ? ` (already running outside the supervisor, pid ${s.externalPid})` : ''}`);
  }

  // Telegram alert when a worker or the prediction records stall; silent until a token + chat are set.
  const WATCHDOG_INTERVAL_MS = 60_000, WATCHDOG_GRACE_MS = 3 * 60_000;
  const startedAt = Date.now();
  let down = new Set<string>();
  const watchdog = setInterval(async () => {
    try {
      if (Date.now() - startedAt < WATCHDOG_GRACE_MS) return;
      const token = getSetting('watchdog.telegramToken'), chat = getSetting('watchdog.telegramChat');
      if (!token || !chat) return;
      const step = watchdogStep(collectChecks(), down);
      down = step.down;
      for (const m of step.messages) await sendTelegram(token, chat, m);
    } catch (err) {
      console.error('[supervisor] watchdog error:', err);
    }
  }, WATCHDOG_INTERVAL_MS);
  watchdog.unref();

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[supervisor] stopping workers…');
    await Promise.all([...workers.values()].map(w => w.stop()));
    server.close();
    try {
      fs.unlinkSync(TOKEN_FILE);
    } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('[supervisor] failed to start:', err);
  process.exit(1);
});
