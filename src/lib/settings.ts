import { privateKeyToAccount } from 'viem/accounts';
import { encryptBotSecret, decryptBotSecret, isEncryptedBotSecret } from './bot/secretStorage';
import type Database from 'better-sqlite3';
import { getDb } from './db';
import { JEV_COINS, isJevCoin, type JevCoin } from './coins';
import { isHttpUrl, isPrivateKeyFormat, normalizePrivateKey, isEthAddress } from './validate';
import { maskSecret } from './secrets';

/**
 * Editable settings for the workers and the web app (managed on /control).
 * Lookup order: stored value (settings table) → env var → default.
 * Workers read settings once at startup; saving a setting restarts the workers listed in `restarts`.
 */

export type WorkerName = 'alerts' | 'jev' | 'bot';
export const WORKER_NAMES: WorkerName[] = ['alerts', 'jev', 'bot'];

export type BotWalletType = 'EOA' | 'POLY_PROXY' | 'POLY_GNOSIS_SAFE' | 'DEPOSIT_WALLET';
// Frozen strategies the forward bridge can trade (BOT_STRATEGIES in lib/bot/forward): v2 = Frozen strategy 1,
// s5 = Frozen strategy 1 + Optimised.
export type BotForwardStrategy = 'v2' | 's5';
const WALLET_TYPES: BotWalletType[] = ['EOA', 'POLY_PROXY', 'POLY_GNOSIS_SAFE', 'DEPOSIT_WALLET'];

export interface Settings {
  'openrouter.apiKey': string;
  'jev.telegramToken': string;
  'jev.telegramChat': string;
  'watchdog.telegramToken': string;
  'watchdog.telegramChat': string;
  'jev.coins': JevCoin[];
  'jev.models': { jev: boolean; kev: boolean; span: boolean; solar: boolean; tev: boolean; mercury: boolean; liquid: boolean };
  'jev.recordIntervalSec': number;
  'jev.snapshotIntervalSec': number;
  'alerts.intervalSec': number;
  'supervisor.autostart': Record<WorkerName, boolean>;
  'bot.forwardEnabled': boolean;
  'bot.forwardStrategy': BotForwardStrategy;
  'bot.enabled': boolean;
  'bot.autoRedeem': boolean;
  'bot.redeemMaxGasPol': number;
  'bot.simulationMode': boolean;
  'bot.walletType': BotWalletType;
  'bot.privateKey': string;
  'bot.builderApiKey': string;
  'bot.builderSecret': string;
  'bot.builderPassphrase': string;
  'bot.proxyAddress': string;
  'bot.rpcUrl': string;
  'bot.maxBudget': number;
  'bot.perTradeAmount': number;
  'bot.orderPriceMode': 'slippage' | 'market';
  'bot.slippageCents': number;
  'bot.maxAttempts': number;
  'bot.telegramToken': string;
  'bot.telegramChatId': string;
}
export type SettingKey = keyof Settings;
export type SettingSource = 'db' | 'env' | 'default';

export class SettingError extends Error {}

interface SettingDef<T> {
  secret?: boolean;
  env?: string[];
  default: T;
  parse: (v: unknown) => T;
  restarts: WorkerName[];
}

const TELEGRAM_TOKEN_RE = /^\d+:[A-Za-z0-9_-]{20,}$/;

const requiredString = (label: string) => (v: unknown): string => {
  if (typeof v !== 'string' || !v.trim()) throw new SettingError(`${label} is required`);
  return v.trim();
};

const intRange = (min: number, max: number) => (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) throw new SettingError(`must be a whole number from ${min} to ${max}`);
  return n;
};

const numRange = (min: number, max: number) => (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < min || n > max) throw new SettingError(`must be a number from ${min} to ${max}`);
  return Number(n.toFixed(2));
};

const bool = (v: unknown): boolean => {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new SettingError('must be true or false');
};

const flags = <K extends string>(keys: readonly K[], atLeastOne: boolean) => (v: unknown): Record<K, boolean> => {
  if (!v || typeof v !== 'object') throw new SettingError('expected on/off flags');
  const out = {} as Record<K, boolean>;
  for (const k of keys) {
    const b = (v as Record<string, unknown>)[k];
    if (typeof b !== 'boolean') throw new SettingError(`${k} must be on or off`);
    out[k] = b;
  }
  if (atLeastOne && !keys.some(k => out[k])) throw new SettingError('enable at least one');
  return out;
};

export const SETTINGS: { [K in SettingKey]: SettingDef<Settings[K]> } = {
  'openrouter.apiKey': { secret: true, env: ['OPENROUTER_API_KEY'], default: '', parse: requiredString('API key'), restarts: ['jev'] },
  'jev.telegramToken': {
    secret: true,
    env: ['JEV_TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN'],
    default: '',
    parse: v => {
      const s = requiredString('Bot token')(v);
      if (!TELEGRAM_TOKEN_RE.test(s)) throw new SettingError('bot token looks invalid (expected 123456:ABC…)');
      return s;
    },
    restarts: ['jev'],
  },
  'jev.telegramChat': { env: ['JEV_TELEGRAM_CHAT_ID', 'TELEGRAM_CHAT_ID'], default: '', parse: requiredString('Chat ID'), restarts: ['jev'] },
  'watchdog.telegramToken': {
    secret: true,
    env: ['WATCHDOG_TELEGRAM_BOT_TOKEN'],
    default: '',
    parse: v => {
      const s = requiredString('Bot token')(v);
      if (!TELEGRAM_TOKEN_RE.test(s)) throw new SettingError('bot token looks invalid (expected 123456:ABC…)');
      return s;
    },
    restarts: [],
  },
  'watchdog.telegramChat': { env: ['WATCHDOG_TELEGRAM_CHAT_ID'], default: '', parse: requiredString('Chat ID'), restarts: [] },
  'jev.coins': {
    default: [...JEV_COINS],
    parse: v => {
      if (!Array.isArray(v) || v.length === 0) throw new SettingError('pick at least one coin');
      const picked = v.map(c => String(c).toLowerCase());
      for (const c of picked) if (!isJevCoin(c)) throw new SettingError(`unknown coin: ${c}`);
      return JEV_COINS.filter(c => picked.includes(c));
    },
    restarts: ['jev'],
  },
  // A value saved before Solar, Tev, Mercury or Liquid existed has no such key: treat it as on instead of discarding the setting.
  'jev.models': {
    default: { jev: true, kev: true, span: true, solar: true, tev: true, mercury: true, liquid: true },
    parse: v => flags(['jev', 'kev', 'span', 'solar', 'tev', 'mercury', 'liquid'] as const, true)(v && typeof v === 'object' ? { solar: true, tev: true, mercury: true, liquid: true, ...v } : v),
    restarts: ['jev'],
  },
  'jev.recordIntervalSec': { default: 300, parse: intRange(30, 3600), restarts: ['jev'] },
  'jev.snapshotIntervalSec': { default: 30, parse: intRange(10, 600), restarts: ['jev'] },
  'alerts.intervalSec': { default: 60, parse: intRange(30, 3600), restarts: ['alerts'] },
  'supervisor.autostart': {
    // the trading bot never autostarts — it must be turned on deliberately, every time
    default: { alerts: true, jev: true, bot: false },
    parse: flags(WORKER_NAMES, false),
    restarts: [],
  },
  'bot.autoRedeem': { default: true, parse: bool, restarts: [] },
  'bot.redeemMaxGasPol': { default: 0.1, parse: numRange(0.01, 10), restarts: [] },
  'bot.forwardEnabled': { default: false, parse: bool, restarts: [] },
  // Which frozen strategy the forward bridge trades. Changing it re-arms the bridge, like switching it on.
  'bot.forwardStrategy': {
    default: 's5',
    parse: v => {
      if (v !== 'v2' && v !== 's5') throw new SettingError('must be v2 or s5');
      return v;
    },
    restarts: [],
  },
  'bot.enabled': { default: false, parse: bool, restarts: [] },
  'bot.simulationMode': { default: true, parse: bool, restarts: [] },
  'bot.walletType': {
    default: 'EOA',
    parse: v => {
      let s = String(v).toUpperCase();
      if (s === 'PROXY') s = 'POLY_PROXY';
      if (s === 'DEPOSIT') s = 'DEPOSIT_WALLET';
      if (s === 'SAFE' || s === 'GNOSIS') s = 'POLY_GNOSIS_SAFE';
      if (!WALLET_TYPES.includes(s as BotWalletType)) throw new SettingError(`must be one of ${WALLET_TYPES.join(', ')}`);
      return s as BotWalletType;
    },
    restarts: [],
  },
  'bot.privateKey': {
    secret: true,
    default: '',
    parse: v => {
      const s = requiredString('Private key')(v);
      if (!isPrivateKeyFormat(s)) throw new SettingError('must be 64 hex characters, with or without 0x');
      const normalized = normalizePrivateKey(s);
      try { privateKeyToAccount(normalized as `0x${string}`); } catch { throw new SettingError('invalid private key'); }
      return normalized;
    },
    restarts: [],
  },
  'bot.builderApiKey': { secret: true, default: '', parse: requiredString('Builder API key'), restarts: [] },
  'bot.builderSecret': { secret: true, default: '', parse: requiredString('Builder secret'), restarts: [] },
  'bot.builderPassphrase': { secret: true, default: '', parse: requiredString('Builder passphrase'), restarts: [] },
  'bot.proxyAddress': {
    default: '',
    parse: v => {
      const s = String(v ?? '').trim();
      if (s && !isEthAddress(s)) throw new SettingError('must be a valid 0x address');
      return s;
    },
    restarts: [],
  },
  'bot.rpcUrl': {
    default: '',
    parse: v => {
      const s = String(v ?? '').trim();
      if (s && !isHttpUrl(s)) throw new SettingError('must be an http:// or https:// URL');
      return s;
    },
    restarts: [],
  },
  'bot.maxBudget': { default: 100, parse: numRange(1, 100_000), restarts: [] },
  'bot.perTradeAmount': { default: 10, parse: numRange(1, 100_000), restarts: [] },
  // How the buy order is priced: best ask + slippage (a hard worst price), or market (sweep the book up to 0.99).
  'bot.orderPriceMode': {
    default: 'slippage',
    parse: v => {
      if (v !== 'slippage' && v !== 'market') throw new SettingError('must be slippage or market');
      return v;
    },
    restarts: [],
  },
  'bot.slippageCents': { default: 2, parse: intRange(0, 20), restarts: [] },
  // Buy attempts per signal. Each retry re-reads the book and signs a fresh order; only a definite non-fill is retried.
  'bot.maxAttempts': { default: 3, parse: intRange(1, 10), restarts: [] },
  'bot.telegramToken': {
    secret: true,
    env: ['TRADER_TELEGRAM_BOT_TOKEN', 'POLYMARKET_BOT_TELEGRAM_TOKEN', 'JEV_TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN'],
    default: '',
    parse: v => {
      const s = requiredString('Bot token')(v);
      if (!TELEGRAM_TOKEN_RE.test(s)) throw new SettingError('bot token looks invalid (expected 123456:ABC…)');
      return s;
    },
    restarts: ['bot'],
  },
  'bot.telegramChatId': {
    env: ['TRADER_TELEGRAM_CHAT_ID', 'JEV_TELEGRAM_CHAT_ID', 'TELEGRAM_CHAT_ID'],
    default: '',
    parse: v => {
      const id = requiredString('Chat ID')(v);
      if (!/^[1-9][0-9]*$/.test(id)) throw new SettingError('use your private Telegram user/chat ID, not a group');
      return id;
    },
    restarts: ['bot'],
  },
};

const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];
const ENCRYPTED_BOT_SECRETS = new Set<SettingKey>([
  'bot.privateKey', 'bot.telegramToken', 'bot.builderApiKey', 'bot.builderSecret', 'bot.builderPassphrase',
]);

const prepared = new WeakSet<Database.Database>();
function ensureTables(db: Database.Database) {
  if (prepared.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  prepared.add(db);
}

function resolve<K extends SettingKey>(key: K, db: Database.Database): { value: Settings[K]; source: SettingSource } {
  const def = SETTINGS[key] as SettingDef<Settings[K]>;
  ensureTables(db);
  let stored: unknown = undefined;
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
  if (row) {
    try {
      stored = JSON.parse(row.value);
    } catch {
      if (key.startsWith('bot.')) throw new SettingError(`unreadable saved setting: ${key}`);
      console.warn(`[settings] ignoring unreadable stored value for ${key}`);
    }
  }
  if (ENCRYPTED_BOT_SECRETS.has(key) && typeof stored === 'string' && stored) {
    const plaintext = decryptBotSecret(stored, db);
    if (!isEncryptedBotSecret(stored)) {
      db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(JSON.stringify(encryptBotSecret(plaintext, db)), key);
    }
    stored = plaintext;
  }
  if (stored !== undefined && stored !== null) {
    try {
      return { value: def.parse(stored), source: 'db' };
    } catch (e) {
      console.warn(`[settings] ignoring invalid stored value for ${key}: ${(e as Error).message}`);
    }
  }
  for (const name of def.env ?? []) {
    const v = process.env[name];
    if (v && v.trim()) return { value: key.startsWith('bot.') ? def.parse(v.trim()) : v.trim() as Settings[K], source: 'env' };
  }
  return { value: structuredClone(def.default), source: 'default' };
}

export function getSetting<K extends SettingKey>(key: K, db: Database.Database = getDb()): Settings[K] {
  return resolve(key, db).value;
}

export type PublicSetting =
  | { secret: false; value: unknown; source: SettingSource }
  | { secret: true; set: boolean; masked: string | null; source: SettingSource };

/** Settings as sent to the browser: secrets are reduced to set/unset + last 4 characters. */
export function publicSettings(db: Database.Database = getDb()): Record<SettingKey, PublicSetting> {
  const out = {} as Record<SettingKey, PublicSetting>;
  for (const key of SETTING_KEYS) {
    const { value, source } = resolve(key, db);
    if (SETTINGS[key].secret) {
      const s = String(value || '');
      out[key] = { secret: true, set: s.length > 0, masked: maskSecret(s), source };
    } else {
      out[key] = { secret: false, value, source };
    }
  }
  return out;
}

export type ApplyResult = { ok: true; restarts: WorkerName[] } | { ok: false; errors: Record<string, string> };

/** Validate and save changes all-or-nothing. An empty value for a secret means "keep current". */
export function applySettingChanges(changes: Record<string, unknown>, db: Database.Database = getDb()): ApplyResult {
  ensureTables(db);
  const errors: Record<string, string> = {};
  const parsed: Array<[SettingKey, unknown]> = [];
  for (const [key, raw] of Object.entries(changes)) {
    if (!(key in SETTINGS)) {
      errors[key] = 'unknown setting';
      continue;
    }
    const k = key as SettingKey;
    const def = SETTINGS[k];
    if (def.secret && (raw === '' || raw === null || raw === undefined)) continue;
    try {
      parsed.push([k, def.parse(raw)]);
    } catch (e) {
      errors[key] = e instanceof SettingError ? e.message : 'invalid value';
    }
  }
  if (Object.keys(errors).length) return { ok: false, errors };

  const botKeys = parsed.filter(([k]) => k.startsWith('bot.'));
  if (botKeys.length) {
    const merged = <K extends SettingKey>(key: K): Settings[K] => {
      const found = botKeys.find(([k]) => k === key) as [K, Settings[K]] | undefined;
      return found ? found[1] : getSetting(key, db);
    };
    const maxBudget = merged('bot.maxBudget');
    const perTrade = merged('bot.perTradeAmount');
    if (perTrade > maxBudget) {
      return { ok: false, errors: { 'bot.perTradeAmount': 'per-trade amount cannot exceed the total budget' } };
    }
    if (merged('bot.simulationMode') === false && !merged('bot.privateKey')) {
      return { ok: false, errors: { 'bot.simulationMode': 'save a wallet private key before turning off simulation mode' } };
    }
    if (merged('bot.walletType') !== 'EOA' && !merged('bot.proxyAddress')) {
      return { ok: false, errors: { 'bot.proxyAddress': 'proxy, Safe and Deposit Wallet accounts require the Polymarket wallet address' } };
    }
    const builder = [merged('bot.builderApiKey'), merged('bot.builderSecret'), merged('bot.builderPassphrase')];
    if (builder.some(Boolean) && !builder.every(Boolean)) {
      return { ok: false, errors: { 'bot.builderApiKey': 'builder key, secret and passphrase must be saved together' } };
    }
  }

  const rearmForward = parsed.some(([k, v]) => ['bot.forwardEnabled', 'bot.forwardStrategy', 'bot.enabled', 'bot.simulationMode'].includes(k) && getSetting(k, db) !== v);
  const now = Math.floor(Date.now() / 1000);
  db.transaction(() => {
    if (rearmForward) {
      db.exec('CREATE TABLE IF NOT EXISTS bot_forward_gate (id INTEGER PRIMARY KEY, armed_at INTEGER NOT NULL)');
      db.prepare('INSERT INTO bot_forward_gate VALUES(1,?) ON CONFLICT(id) DO UPDATE SET armed_at=excluded.armed_at').run(Date.now());
    }
    const upsert = db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    );
    for (const [k, v] of parsed) {
      const value = ENCRYPTED_BOT_SECRETS.has(k) ? encryptBotSecret(String(v), db) : v;
      upsert.run(k, JSON.stringify(value), now);
    }
  })();

  const affected = new Set(parsed.flatMap(([k]) => SETTINGS[k].restarts));
  return { ok: true, restarts: WORKER_NAMES.filter(w => affected.has(w)) };
}
