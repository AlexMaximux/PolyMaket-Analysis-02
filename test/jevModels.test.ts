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
    applySettingChanges({ 'openrouter.apiKey': 'sk-test-0123456789', 'jev.models': { jev: false, kev: false, span: true, solar: false, tev: false, mercury: false } }, db);
    const r = await callMultiModelDecisions({ coin: 'btc', coin_label: 'Bitcoin', cards: {}, fair_values: {} });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(r.jev).toBeNull();
    expect(r.kev).toBeNull();
    const [, init] = (global.fetch as any).mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer sk-test-0123456789');
  });

  it('records Tev and Mercury with the same shape as Kev, without counting them as consensus votes', async () => {
    const answer = (model: string) => ({
      model,
      answers: {
        one_hour_score: { score: 3.2, confidence: 0.81 },
        one_hour_direction: { choice: 'UP', confidence: 0.9, probabilities: { UP: 0.9, DOWN: 0.1 } },
      },
      usage: { input_tokens: 10, cost: 0 },
    });
    global.fetch = vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
      const { model } = JSON.parse(init.body);
      return new Response(JSON.stringify(answer(model)), { status: 200 });
    });
    applySettingChanges({ 'openrouter.apiKey': 'sk-test-0123456789', 'jev.models': { jev: false, kev: false, span: false, solar: false, tev: true, mercury: true } }, db);
    const r = await callMultiModelDecisions({ coin: 'btc', coin_label: 'Bitcoin', cards: {}, fair_values: {} });
    const called = (global.fetch as any).mock.calls.map(([, init]: [string, { body: string }]) => JSON.parse(init.body).model);
    expect(called.sort()).toEqual(['inception/mercury-decide:free', 'togethercomputer/tev1-4b-experimental']);
    expect(r.tev).toMatchObject({ direction: 'UP', score: 3.2, prob_up: 90 });
    expect(r.mercury).toMatchObject({ direction: 'UP', score: 3.2, prob_up: 90 });
    expect(r.consensus.total_models).toBe(0);
  });
});
