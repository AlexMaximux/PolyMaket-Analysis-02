import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDb } from '../src/lib/db';
import { getSetting, publicSettings, applySettingChanges, WORKER_NAMES } from '../src/lib/settings';

// Publicly known Hardhat/Foundry default test private key — not a secret, holds no funds. Used only
// to prove the wallet-config validator derives an address correctly.
const TEST_PRIVATE_KEY = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const TG_TOKEN = '123456789:AAHfakeTokenValueForTests_abcd';

describe('bot settings', () => {
  let db: Database.Database;
  const envBackup = { ...process.env };
  beforeEach(() => {
    db = new Database(':memory:');
    initializeDb(db);
    delete process.env.TRADER_TELEGRAM_BOT_TOKEN;
    delete process.env.TRADER_TELEGRAM_CHAT_ID;
  });
  afterEach(() => {
    process.env = { ...envBackup };
  });

  it("'bot' is a supervised worker, off by default", () => {
    expect(WORKER_NAMES).toContain('bot');
    expect(getSetting('supervisor.autostart', db).bot).toBe(false);
  });

  it('defaults to disabled, simulation on, EOA wallet, $100/$10 budget', () => {
    expect(getSetting('bot.enabled', db)).toBe(false);
    expect(getSetting('bot.simulationMode', db)).toBe(true);
    expect(getSetting('bot.walletType', db)).toBe('EOA');
    expect(getSetting('bot.maxBudget', db)).toBe(100);
    expect(getSetting('bot.perTradeAmount', db)).toBe(10);
  });

  it('accepts a valid private key (with or without 0x) and rejects a malformed one', () => {
    expect(applySettingChanges({ 'bot.privateKey': TEST_PRIVATE_KEY }, db).ok).toBe(true);
    expect(applySettingChanges({ 'bot.privateKey': `0x${TEST_PRIVATE_KEY}` }, db).ok).toBe(true);
    const bad = applySettingChanges({ 'bot.privateKey': '0xnothex' }, db);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors['bot.privateKey']).toBeTruthy();
  });

  it('rejects a per-trade amount larger than the total budget', () => {
    const r = applySettingChanges({ 'bot.maxBudget': 50, 'bot.perTradeAmount': 60 }, db);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors['bot.perTradeAmount']).toBeTruthy();
    expect(getSetting('bot.maxBudget', db)).toBe(100); // nothing saved
  });

  it('allows per-trade equal to the budget', () => {
    expect(applySettingChanges({ 'bot.maxBudget': 50, 'bot.perTradeAmount': 50 }, db).ok).toBe(true);
  });

  it('refuses to turn off simulation mode without a saved private key', () => {
    const r = applySettingChanges({ 'bot.simulationMode': false }, db);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors['bot.simulationMode']).toBeTruthy();
    expect(getSetting('bot.simulationMode', db)).toBe(true);
  });

  it('allows turning off simulation mode once a private key is saved (same call or earlier)', () => {
    expect(applySettingChanges({ 'bot.privateKey': TEST_PRIVATE_KEY, 'bot.simulationMode': false }, db).ok).toBe(true);
    expect(getSetting('bot.simulationMode', db)).toBe(false);

    // a later call with simulationMode alone should also succeed since the key is already saved
    applySettingChanges({ 'bot.simulationMode': true }, db);
    expect(applySettingChanges({ 'bot.simulationMode': false }, db).ok).toBe(true);
  });

  it('requires a proxy address when wallet type is POLY_PROXY', () => {
    const r = applySettingChanges({ 'bot.walletType': 'POLY_PROXY' }, db);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors['bot.proxyAddress']).toBeTruthy();

    expect(
      applySettingChanges({ 'bot.walletType': 'POLY_PROXY', 'bot.proxyAddress': TEST_ADDRESS }, db).ok
    ).toBe(true);
  });

  it('rejects a malformed proxy address', () => {
    const r = applySettingChanges({ 'bot.proxyAddress': 'not-an-address' }, db);
    expect(r.ok).toBe(false);
  });

  it('resolves the Telegram token/chat from TRADER_* env vars and restarts the bot worker on change', () => {
    process.env.TRADER_TELEGRAM_CHAT_ID = '999';
    expect(getSetting('bot.telegramChatId', db)).toBe('999');

    const r = applySettingChanges({ 'bot.telegramToken': TG_TOKEN }, db);
    expect(r).toEqual({ ok: true, restarts: ['bot'] });
  });

  it('reports which workers to restart when both bot and jev settings change', () => {
    const r = applySettingChanges({ 'bot.telegramToken': TG_TOKEN, 'jev.coins': ['btc'] }, db);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.restarts.sort()).toEqual(['bot', 'jev']);
  });

  it('never exposes the private key or telegram token in publicSettings', () => {
    applySettingChanges({ 'bot.privateKey': TEST_PRIVATE_KEY, 'bot.telegramToken': TG_TOKEN }, db);
    const pub = publicSettings(db);
    const text = JSON.stringify(pub);
    expect(text).not.toContain(TEST_PRIVATE_KEY);
    expect(text).not.toContain(TG_TOKEN);
    expect(pub['bot.privateKey']).toMatchObject({ secret: true, set: true });
  });

  it('does not require enabling settings that are simply unrelated', () => {
    // saving an unrelated key must not trip the bot cross-field checks
    expect(applySettingChanges({ 'alerts.intervalSec': 120 }, db).ok).toBe(true);
  });
});
