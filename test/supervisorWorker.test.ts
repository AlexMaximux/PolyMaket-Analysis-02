import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { Worker, type ChildLike } from '../src/lib/supervisor/worker';
import { LogBuffer } from '../src/lib/supervisor/logs';

class FakeChild extends EventEmitter implements ChildLike {
  static next = 100;
  pid = FakeChild.next++;
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: string[] = [];
  ignoreTerm = false;
  kill(signal: NodeJS.Signals) {
    this.signals.push(signal);
    if (signal === 'SIGTERM' && this.ignoreTerm) return;
    this.emit('exit', null, signal);
  }
  crash(code = 1) {
    this.emit('exit', code, null);
  }
}

function setup(opts: { external?: () => number | null } = {}) {
  const children: FakeChild[] = [];
  const spawn = vi.fn(() => {
    const c = new FakeChild();
    children.push(c);
    return c;
  });
  const w = new Worker(
    { name: 'crawl', command: 'tsx', args: ['scripts/crawl.ts'], controllable: true },
    { spawn, logs: new LogBuffer(), detectExternal: opts.external, stopGraceMs: 1000 }
  );
  return { w, spawn, children };
}

describe('Worker', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts and reports running with pid', () => {
    const { w, spawn } = setup();
    const s = w.start();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(s.state).toBe('running');
    expect(s.pid).toBeGreaterThanOrEqual(100);
  });

  it('restarts after an unexpected exit with backoff', () => {
    const { w, spawn, children } = setup();
    w.start();
    children[0].stderr.write('Error: boom\n');
    children[0].crash(1);
    expect(w.status().state).toBe('restarting');
    expect(w.status().lastExitCode).toBe(1);
    expect(w.status().lastError).toBe('Error: boom');
    vi.advanceTimersByTime(1999);
    expect(spawn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(w.status().state).toBe('running');
    expect(w.status().restarts).toBe(1);
    children[1].crash(1);
    vi.advanceTimersByTime(3999);
    expect(spawn).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(spawn).toHaveBeenCalledTimes(3);
  });

  it('stops without restarting', async () => {
    const { w, spawn, children } = setup();
    w.start();
    const s = await w.stop();
    expect(children[0].signals).toEqual(['SIGTERM']);
    expect(s.state).toBe('stopped');
    vi.advanceTimersByTime(120_000);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('escalates to SIGKILL after the grace period', async () => {
    const { w, children } = setup();
    w.start();
    children[0].ignoreTerm = true;
    const p = w.stop();
    await vi.advanceTimersByTimeAsync(1000);
    const s = await p;
    expect(children[0].signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(s.state).toBe('stopped');
  });

  it('gives up after 5 crashes in 5 minutes until started manually', () => {
    const { w, spawn, children } = setup();
    w.start();
    for (let i = 0; i < 5; i++) {
      children[children.length - 1].crash(1);
      vi.advanceTimersByTime(60_000);
    }
    expect(w.status().state).toBe('crashed');
    const calls = spawn.mock.calls.length;
    vi.advanceTimersByTime(600_000);
    expect(spawn.mock.calls.length).toBe(calls);
    w.start();
    expect(w.status().state).toBe('running');
  });

  it('treats a spawn failure as a crash', () => {
    const spawn = vi.fn((): ChildLike => {
      throw new Error('ENOENT tsx');
    });
    const w = new Worker({ name: 'x', command: 'nope', args: [], controllable: true }, { spawn, logs: new LogBuffer() });
    w.start();
    expect(w.status().state).toBe('restarting');
    expect(w.status().lastError).toBe('ENOENT tsx');
  });

  it('does not start a second copy when one runs outside the supervisor, and never kills it', async () => {
    const external = vi.fn((): number | null => 4242);
    const { w, spawn } = setup({ external });
    const s = w.start();
    expect(spawn).not.toHaveBeenCalled();
    expect(s.state).toBe('external');
    expect(s.externalPid).toBe(4242);
    expect((await w.stop()).state).toBe('external');
    expect((await w.restart()).state).toBe('external');
    external.mockReturnValue(null);
    vi.advanceTimersByTime(11_000);
    expect(w.status().state).toBe('stopped');
  });

  it('restart resets a crashed worker', async () => {
    const { w, children } = setup();
    w.start();
    for (let i = 0; i < 5; i++) {
      children[children.length - 1].crash(1);
      vi.advanceTimersByTime(60_000);
    }
    expect(w.status().state).toBe('crashed');
    expect((await w.restart()).state).toBe('running');
  });
});
