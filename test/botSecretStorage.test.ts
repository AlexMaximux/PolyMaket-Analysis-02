import { it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applySettingChanges, getSetting } from '../src/lib/settings';
const KEY = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
let dir: string, db: Database.Database;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'pulse-secret-')); db = new Database(path.join(dir, 'test.db')); });
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
it('encrypts at rest with a private key file and decrypts after reopening the database', () => {
  expect(applySettingChanges({ 'bot.privateKey': KEY }, db).ok).toBe(true);
  const stored = (db.prepare("SELECT value FROM settings WHERE key='bot.privateKey'").get() as { value: string }).value;
  expect(stored).not.toContain(KEY); expect(stored).toContain('bot-secret-v1:');
  expect(statSync(db.name + '.bot-key').mode & 0o777).toBe(0o600);
  db.close(); db = new Database(path.join(dir, 'test.db'));
  expect(getSetting('bot.privateKey', db)).toBe(`0x${KEY}`);
});
it('migrates a legacy plaintext setting on read', () => {
  getSetting('bot.enabled', db);
  db.prepare('INSERT INTO settings(key,value,updated_at) VALUES (?,?,0)').run('bot.privateKey', JSON.stringify(KEY));
  expect(getSetting('bot.privateKey', db)).toBe(`0x${KEY}`);
  expect(JSON.stringify(db.prepare('SELECT value FROM settings').all())).not.toContain(KEY);
});
it('fails closed when the encryption key is missing, without generating a new one', () => {
  applySettingChanges({ 'bot.privateKey': KEY }, db);
  rmSync(db.name + '.bot-key');
  expect(() => getSetting('bot.privateKey', db)).toThrow(/missing/);
  expect(existsSync(db.name + '.bot-key')).toBe(false);
});
it('never falls back to defaults for corrupted trading settings', () => {
  getSetting('bot.enabled', db);
  db.prepare('INSERT INTO settings(key,value,updated_at) VALUES (?,?,0)').run('bot.perTradeAmount', 'broken');
  expect(() => getSetting('bot.perTradeAmount', db)).toThrow();
});
it('rejects a zero private key and group Telegram IDs', () => {
  expect(applySettingChanges({ 'bot.privateKey': '0'.repeat(64) }, db).ok).toBe(false);
  expect(applySettingChanges({ 'bot.telegramChatId': '-10012345678' }, db).ok).toBe(false);
});
