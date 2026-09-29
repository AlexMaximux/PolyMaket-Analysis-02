import { backoffDelay, recordCrash, STABLE_RESET_MS } from './policy';
import type { LogBuffer } from './logs';

export type WorkerState = 'stopped' | 'starting' | 'running' | 'restarting' | 'crashed' | 'external';

export interface ChildLike {
  pid?: number;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  once(event: 'exit' | 'error', listener: (...args: any[]) => void): unknown;
  kill(signal: NodeJS.Signals): void;
}

export interface WorkerSpec {
  name: string;
  command: string;
  args: string[];
  controllable: boolean;
}

export interface WorkerStatus {
  name: string;
  state: WorkerState;
  pid: number | null;
  startedAt: number | null;
  restarts: number;
  lastExitCode: number | null;
  lastError: string | null;
  controllable: boolean;
  externalPid: number | null;
}

export interface WorkerDeps {
  spawn: (command: string, args: string[]) => ChildLike;
  logs: LogBuffer;
  /** pid of a copy already running outside the supervisor, or null */
  detectExternal?: () => number | null;
  stopGraceMs?: number;
}

const EXTERNAL_RECHECK_MS = 10_000;

/** One supervised child process: start/stop/restart, crash backoff, crash-loop cut-off. */
export class Worker {
  private state: WorkerState = 'stopped';
  private child: ChildLike | null = null;
  private startedAt: number | null = null;
  private restarts = 0;
  private attempt = 0;
  private crashes: number[] = [];
  private lastExitCode: number | null = null;
  private lastError: string | null = null;
  private externalPid: number | null = null;
  private lastExternalCheck = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;
  private exitWaiters: Array<() => void> = [];

  constructor(readonly spec: WorkerSpec, private readonly deps: WorkerDeps) {}

  get logs(): LogBuffer {
    return this.deps.logs;
  }

  status(): WorkerStatus {
    if (this.state === 'external' && Date.now() - this.lastExternalCheck >= EXTERNAL_RECHECK_MS) {
      this.lastExternalCheck = Date.now();
      const pid = this.deps.detectExternal?.() ?? null;
      if (pid) this.externalPid = pid;
      else {
        this.state = 'stopped';
        this.externalPid = null;
        this.sys('outside copy is gone; press Start to run it here');
      }
    }
    return {
      name: this.spec.name,
      state: this.state,
      pid: this.child?.pid ?? null,
      startedAt: this.startedAt,
      restarts: this.restarts,
      lastExitCode: this.lastExitCode,
      lastError: this.lastError,
      controllable: this.spec.controllable,
      externalPid: this.externalPid,
    };
  }

  start(): WorkerStatus {
    if (this.state === 'running' || this.state === 'starting' || this.state === 'restarting') return this.status();
    this.crashes = [];
    this.attempt = 0;
    this.spawnNow();
    return this.status();
  }

  async stop(): Promise<WorkerStatus> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // never signal a process the supervisor did not start
    if (this.state === 'external') return this.status();
    const child = this.child;
    if (!child) {
      this.state = 'stopped';
      return this.status();
    }
    this.stopping = true;
    const exited = new Promise<void>(r => this.exitWaiters.push(r));
    child.kill('SIGTERM');
    const grace = this.deps.stopGraceMs ?? 10_000;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      exited.then(() => 'exited' as const),
      new Promise<'timeout'>(r => {
        graceTimer = setTimeout(() => r('timeout'), grace);
      }),
    ]);
    clearTimeout(graceTimer);
    if (outcome === 'timeout') {
      this.sys(`did not exit within ${grace / 1000}s; sending SIGKILL`);
      child.kill('SIGKILL');
      await Promise.race([exited, new Promise(r => setTimeout(r, 2_000))]);
    }
    return this.status();
  }

  async restart(): Promise<WorkerStatus> {
    await this.stop();
    if (this.state === 'external') return this.status();
    this.state = 'stopped';
    return this.start();
  }

  private sys(msg: string) {
    this.deps.logs.push('sys', `[supervisor] ${msg}\n`);
  }

  private spawnNow() {
    this.timer = null;
    const ext = this.deps.detectExternal?.() ?? null;
    this.lastExternalCheck = Date.now();
    if (ext) {
      this.state = 'external';
      this.externalPid = ext;
      this.sys(`already running outside the supervisor (pid ${ext}); not starting a second copy`);
      return;
    }
    this.externalPid = null;
    this.state = 'starting';
    this.stopping = false;
    let child: ChildLike;
    try {
      child = this.deps.spawn(this.spec.command, this.spec.args);
    } catch (err) {
      this.onExit(null, (err as Error).message);
      return;
    }
    this.child = child;
    this.startedAt = Date.now();
    child.stdout?.on('data', (d: Buffer | string) => this.deps.logs.push('out', String(d)));
    child.stderr?.on('data', (d: Buffer | string) => {
      const text = String(d);
      this.deps.logs.push('err', text);
      const last = text.trim().split('\n').pop();
      if (last) this.lastError = last.slice(0, 300);
    });
    let settled = false;
    const done = (code: number | null, errText?: string) => {
      if (settled) return;
      settled = true;
      this.onExit(code, errText);
    };
    child.once('exit', (code: number | null) => done(code));
    child.once('error', (err: Error) => done(null, err.message));
    if (this.child === child) {
      this.state = 'running';
      this.sys(`started (pid ${child.pid ?? '?'})`);
    }
  }

  private onExit(code: number | null, errText?: string) {
    const ranFor = this.startedAt ? Date.now() - this.startedAt : 0;
    this.child = null;
    this.startedAt = null;
    this.lastExitCode = code;
    if (errText) this.lastError = errText.slice(0, 300);
    const waiters = this.exitWaiters;
    this.exitWaiters = [];
    waiters.forEach(w => w());

    if (this.stopping) {
      this.stopping = false;
      this.state = 'stopped';
      this.sys(`stopped (exit ${code ?? 'signal'})`);
      return;
    }

    this.sys(`exited unexpectedly (code ${code ?? 'signal'})`);
    if (ranFor >= STABLE_RESET_MS) this.attempt = 0;
    const { history, crashLoop } = recordCrash(this.crashes, Date.now());
    this.crashes = history;
    if (crashLoop) {
      this.state = 'crashed';
      this.sys('crashed 5 times in 5 minutes; not restarting until started manually');
      return;
    }
    const delay = backoffDelay(this.attempt++);
    this.state = 'restarting';
    this.restarts++;
    this.sys(`restarting in ${delay / 1000}s`);
    this.timer = setTimeout(() => this.spawnNow(), delay);
  }
}
