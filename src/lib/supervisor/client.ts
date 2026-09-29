import fs from 'fs';
import { SUPERVISOR_PORT, TOKEN_FILE } from './config';

export interface SupervisorResponse<T = any> {
  ok: boolean;
  status: number;
  body: T;
}

/** Call the local supervisor. Returns null when it is not running or does not answer. */
export async function supervisorRequest<T = any>(pathname: string, method: 'GET' | 'POST' = 'GET'): Promise<SupervisorResponse<T> | null> {
  let token: string;
  try {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    return null;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${SUPERVISOR_PORT}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
      // stop waits up to 10s for a graceful exit
      signal: AbortSignal.timeout(method === 'POST' ? 15_000 : 2_000),
    });
    return { ok: res.ok, status: res.status, body: (await res.json().catch(() => null)) as T };
  } catch {
    return null;
  }
}
