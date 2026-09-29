import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

const PREFIX = 'bot-secret-v1:';
const memoryKeys = new WeakMap<Database.Database, Buffer>();
function keyFor(db: Database.Database): Buffer {
  if (db.name === ':memory:') {
    let key = memoryKeys.get(db);
    if (!key) { key = randomBytes(32); memoryKeys.set(db, key); }
    return key;
  }
  const keyPath = `${path.resolve(db.name)}.bot-key`;
  if (!existsSync(keyPath)) {
    try {
      const fd = openSync(keyPath, 'wx', 0o600);
      try { writeFileSync(fd, randomBytes(32)); fsyncSync(fd); } finally { closeSync(fd); }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  chmodSync(keyPath, 0o600);
  const key = readFileSync(keyPath);
  if (key.length !== 32) throw new Error('Bot encryption key is invalid');
  return key;
}
export function encryptBotSecret(value: string, db: Database.Database): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(db), iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}
export function decryptBotSecret(value: string, db: Database.Database): string {
  if (!value.startsWith(PREFIX)) return value;
  // Do not silently generate a replacement key for an existing encrypted secret.
  if (db.name !== ':memory:' && !existsSync(`${path.resolve(db.name)}.bot-key`)) throw new Error('Bot encryption key is missing; restore it from your private backup');
  const data = Buffer.from(value.slice(PREFIX.length), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', keyFor(db), data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
}
export function isEncryptedBotSecret(value: string): boolean { return value.startsWith(PREFIX); }
