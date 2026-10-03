import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDb } from '../src/lib/db';
import { getSetting, publicSettings, applySettingChanges } from '../src/lib/settings';

const KEY = 'sk-or-v1-0123456789abcdefWXYZ';
const TG = '123456789:AAHfakeTokenValueForTests_abcd';

describe('settings', () => {
  let db: Database.Database;
  const envBackup = { ...process.env };
  beforeEach(() => {
    db = new Database(':memory:');
    initializeDb(db);
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.JEV_TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
  });
  afterEach(() => {
    process.env = { ...envBackup };
  });

  it('resolves db, then env, then default', () => {
    expect(getSetting('alerts.intervalSec', db)).toBe(60);
    expect(getSetting('openrouter.apiKey', db)).toBe('');
    process.env.OPENROUTER_API_KEY = 'from-env';
    expect(getSetting('openrouter.apiKey', db)).toBe('from-env');
    expect(applySettingChanges({ 'openrouter.apiKey': KEY, 'alerts.intervalSec': 90 }, db).ok).toBe(true);
    expect(getSetting('openrouter.apiKey', db)).toBe(KEY);
    expect(getSetting('alerts.intervalSec', db)).toBe(90);
  });

  it('falls back to the default when a stored value is corrupt or out of range', () => {
    getSetting('alerts.intervalSec', db); // creates the table
    db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('alerts.intervalSec', '1', 0)`).run();
    expect(getSetting('alerts.intervalSec', db)).toBe(60);
    db.prepare(`UPDATE settings SET value = '{not json' WHERE key = 'alerts.intervalSec'`).run();
    expect(getSetting('alerts.intervalSec', db)).toBe(60);
  });

  it('validates boundaries and saves nothing when any change is invalid', () => {
    const r = applySettingChanges({ 'alerts.intervalSec': 29, 'jev.recordIntervalSec': 120 }, db);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors)).toEqual(['alerts.intervalSec']);
    expect(getSetting('alerts.intervalSec', db)).toBe(60);
    expect(getSetting('jev.recordIntervalSec', db)).toBe(300);
    expect(applySettingChanges({ 'alerts.intervalSec': 30 }, db).ok).toBe(true);
    expect(applySettingChanges({ 'jev.coins': [] }, db).ok).toBe(false);
    expect(applySettingChanges({ 'jev.coins': ['btc', 'zzz'] }, db).ok).toBe(false);
    expect(applySettingChanges({ 'jev.models': { jev: false, kev: false, span: false, solar: false, tev: false, mercury: false, liquid: false } }, db).ok).toBe(false);
    expect(applySettingChanges({ 'jev.telegramToken': 'nope' }, db).ok).toBe(false);
    expect(applySettingChanges({ 'nope.key': 1 }, db).ok).toBe(false);
  });

  it('keeps coins in canonical order without duplicates', () => {
    applySettingChanges({ 'jev.coins': ['SOL', 'btc', 'sol'] }, db);
    expect(getSetting('jev.coins', db)).toEqual(['btc', 'sol']);
  });

  it('never exposes secret values', () => {
    applySettingChanges({ 'openrouter.apiKey': KEY, 'jev.telegramToken': TG, 'jev.telegramChat': '42' }, db);
    const pub = publicSettings(db);
    const text = JSON.stringify(pub);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(TG);
    expect(pub['openrouter.apiKey']).toEqual({ secret: true, set: true, masked: '…WXYZ', source: 'db' });
    expect(pub['jev.telegramChat']).toEqual({ secret: false, value: '42', source: 'db' });
  });

  it('treats an empty secret as keep-current', () => {
    applySettingChanges({ 'openrouter.apiKey': KEY }, db);
    const r = applySettingChanges({ 'openrouter.apiKey': '' }, db);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.restarts).toEqual([]);
    expect(getSetting('openrouter.apiKey', db)).toBe(KEY);
  });

  it('reports which workers must restart', () => {
    const r = applySettingChanges(
      { 'alerts.intervalSec': 120, 'jev.coins': ['btc'], 'supervisor.autostart': { alerts: true, jev: true, bot: false } },
      db
    );
    expect(r).toEqual({ ok: true, restarts: ['alerts', 'jev'] });
  });

});
