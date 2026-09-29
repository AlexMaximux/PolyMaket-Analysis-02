import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { AddressInfo } from 'net';
import { Worker, type ChildLike } from '../src/lib/supervisor/worker';
import { LogBuffer } from '../src/lib/supervisor/logs';
import { createControlHandler } from '../src/lib/supervisor/control';

function fakeSpawn(): ChildLike {
  const c = Object.assign(new EventEmitter(), {
    pid: 777,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill(sig: string) {
      c.emit('exit', null, sig);
    },
  });
  return c;
}

describe('supervisor control API', () => {
  let server: http.Server;
  let base = '';
  const token = 't0k3n';
  const auth = { Authorization: `Bearer ${token}` };

  beforeAll(async () => {
    const mk = (name: string, controllable: boolean) =>
      new Worker({ name, command: 'x', args: [], controllable }, { spawn: fakeSpawn, logs: new LogBuffer() });
    const workers = new Map([
      ['web', mk('web', false)],
      ['crawl', mk('crawl', true)],
    ]);
    workers.get('crawl')!.logs.push('out', 'hello\n');
    server = http.createServer(createControlHandler({ workers, token, startedAt: 1 }));
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>(r => server.close(() => r())));

  it('rejects requests without the token', async () => {
    expect((await fetch(`${base}/status`)).status).toBe(401);
    expect((await fetch(`${base}/status`, { headers: { Authorization: 'Bearer wrong!' } })).status).toBe(401);
  });
  it('reports status', async () => {
    const body = await (await fetch(`${base}/status`, { headers: auth })).json();
    expect(body.supervisor.startedAt).toBe(1);
    expect(body.workers.map((w: any) => w.name)).toEqual(['web', 'crawl']);
  });
  it('starts and stops a controllable worker', async () => {
    let r = await fetch(`${base}/workers/crawl/start`, { method: 'POST', headers: auth });
    expect((await r.json()).state).toBe('running');
    r = await fetch(`${base}/workers/crawl/stop`, { method: 'POST', headers: auth });
    expect((await r.json()).state).toBe('stopped');
  });
  it('refuses to control the web app and unknown workers', async () => {
    expect((await fetch(`${base}/workers/web/stop`, { method: 'POST', headers: auth })).status).toBe(409);
    expect((await fetch(`${base}/workers/nope/stop`, { method: 'POST', headers: auth })).status).toBe(404);
    expect((await fetch(`${base}/workers/crawl/explode`, { method: 'POST', headers: auth })).status).toBe(404);
  });
  it('returns log tails capped at 500', async () => {
    const body = await (await fetch(`${base}/workers/crawl/logs?tail=9999`, { headers: auth })).json();
    expect(body.lines.some((l: any) => l.text === 'hello')).toBe(true);
  });
});
