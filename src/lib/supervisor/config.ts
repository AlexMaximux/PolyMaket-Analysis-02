import path from 'path';

export const WEB_PORT = Number(process.env.PMP_PORT || 8000);
export const SUPERVISOR_PORT = Number(process.env.SUPERVISOR_PORT || 8001);
/** Random token written by the supervisor at startup; only local processes that can read it may call the control API. */
export const TOKEN_FILE = path.join(process.cwd(), '.supervisor-token');
