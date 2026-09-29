import type { Heartbeat } from '@/lib/heartbeat';

export type WorkerState = 'stopped' | 'starting' | 'running' | 'restarting' | 'crashed' | 'external' | 'unknown';

export interface WorkerRow {
  name: string;
  state: WorkerState;
  controllable: boolean;
  pid?: number | null;
  startedAt?: number | null;
  restarts?: number;
  lastExitCode?: number | null;
  lastError?: string | null;
  externalPid?: number | null;
  heartbeat: Heartbeat | null;
  intervalSec: number | null;
}

export interface StatusPayload {
  supervisor: { pid: number; startedAt: number } | null;
  workers: WorkerRow[];
  now: number;
}

export interface LogLine {
  t: number;
  stream: 'out' | 'err' | 'sys';
  text: string;
}
