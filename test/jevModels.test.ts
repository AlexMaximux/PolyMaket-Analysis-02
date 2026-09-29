import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as dbModule from '../src/lib/db';
import { applySettingChanges } from '../src/lib/settings';
import { callMultiModelDecisions } from '../src/lib/jevSnapshot';

describe('callMultiModelDecisions', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    dbModule.initializeDb(db);
    vi.spyOn(dbModule, 'getDb').mockReturnValue(db);
    global.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 400 }));
  });
  afterEach(() => vi.restoreAllMocks());

  it('makes no OpenRouter call for disabled models', async () => {
    applySettingChanges({ 'openrouter.apiKey': 'sk-test-0123456789', 'jev.models': { jev: false, kev: false, span: true, solar: false } }, db);
    const r = await callMultiModelDecisions({ coin: 'btc', coin_label: 'Bitcoin', cards: {}, fair_values: {} });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(r.jev).toBeNull();
    expect(r.kev).toBeNull();
    const [, init] = (global.fetch as any).mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer sk-test-0123456789');
  });
});
