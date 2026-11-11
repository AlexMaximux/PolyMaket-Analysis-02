import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { tfmHealth } from './client';
import { activeTfmModelKey, TFM_MODELS } from './config';

export type TfmServiceState = 'ready' | 'starting' | 'offline' | 'not-installed';

export interface TfmServiceDeps {
  health: () => Promise<{ ok: boolean }>;
  installed: () => boolean;
  spawnServer: () => void;
  now: () => number;
  autostart: boolean;
}

const RESTART_AFTER_MS = 90_000;

let lastStartAt: number | null = null;

/** tfm/.venv/bin/python and tfm/server.py both exist under the project root (process.cwd()). */
export function tfmInstalled(): boolean {
  const root = process.cwd();
  return fs.existsSync(path.join(root, 'tfm', '.venv', 'bin', 'python')) && fs.existsSync(path.join(root, 'tfm', 'server.py'));
}

/** Starts tfm/server.py detached, output appended to logs/tfm.log. Never throws. */
function spawnTfmServer(): void {
  try {
    const root = process.cwd();
    const logDir = path.join(root, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const fd = fs.openSync(path.join(logDir, 'tfm.log'), 'a');
    const child = spawn(path.join(root, 'tfm', '.venv', 'bin', 'python'), [path.join(root, 'tfm', 'server.py')], {
      cwd: root,
      detached: true,
      stdio: ['ignore', fd, fd],
      env: {
        ...process.env,
        TFM_MODEL: TFM_MODELS[activeTfmModelKey()],
      },
    });
    child.on('error', () => {});
    child.unref();
    fs.closeSync(fd);
  } catch {
    // a failed start just leaves the service offline
  }
}

const realDeps = (): TfmServiceDeps => ({
  health: () => tfmHealth(),
  installed: tfmInstalled,
  spawnServer: spawnTfmServer,
  now: () => Date.now(),
  autostart: process.env.TFM_AUTOSTART !== '0',
});

/**
 * Is the service usable? If it answers: 'ready'. If it is not installed: 'not-installed'. If autostart is off:
 * 'offline'. Otherwise it is started (once; again only after 90 s without an answer) and the state is 'starting'.
 */
export async function ensureTfmService(overrides: Partial<TfmServiceDeps> = {}): Promise<TfmServiceState> {
  const deps = { ...realDeps(), ...overrides };
  const h = await deps.health();
  if (h.ok) return 'ready';
  if (!deps.installed()) return 'not-installed';
  if (!deps.autostart) return 'offline';
  const now = deps.now();
  if (lastStartAt === null || now - lastStartAt > RESTART_AFTER_MS) {
    lastStartAt = now;
    deps.spawnServer();
  }
  return 'starting';
}

export function resetTfmServiceForTests(): void {
  lastStartAt = null;
}
