import crypto from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import type { Worker } from './worker';

export interface ControlContext {
  workers: Map<string, Worker>;
  token: string;
  startedAt: number;
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const got = Buffer.from(header || '');
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

/** HTTP handler for the supervisor control API (bound to 127.0.0.1 by scripts/supervisor.ts). */
export function createControlHandler(ctx: ControlContext) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (!tokenMatches(req.headers.authorization, ctx.token)) return send(401, { error: 'unauthorized' });

    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const [section, name, action] = url.pathname.split('/').filter(Boolean);
    try {
      if (req.method === 'GET' && section === 'status' && !name) {
        return send(200, {
          supervisor: { pid: process.pid, startedAt: ctx.startedAt },
          workers: [...ctx.workers.values()].map(w => w.status()),
        });
      }
      if (section === 'workers' && name) {
        const w = ctx.workers.get(name);
        if (!w) return send(404, { error: 'unknown worker' });
        if (req.method === 'GET' && action === 'logs') {
          const tail = Math.min(Math.max(parseInt(url.searchParams.get('tail') || '200') || 200, 1), 500);
          return send(200, { lines: w.logs.tail(tail) });
        }
        if (req.method === 'POST' && (action === 'start' || action === 'stop' || action === 'restart')) {
          if (!w.spec.controllable) return send(409, { error: `${name} cannot be controlled from the dashboard` });
          const status = action === 'start' ? w.start() : action === 'stop' ? await w.stop() : await w.restart();
          return send(200, status);
        }
      }
      return send(404, { error: 'not found' });
    } catch (e) {
      return send(500, { error: (e as Error).message });
    }
  };
}
