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
    applySettingChanges({ 'openrouter.apiKey': 'sk-test-0123456789', 'jev.models': { jev: false, kev: false, span: true, solar: false, tev: false, mercury: false, liquid: false } }, db);
    const r = await callMultiModelDecisions({ coin: 'btc', coin_label: 'Bitcoin', cards: {}, fair_values: {} });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(r.jev).toBeNull();
    expect(r.kev).toBeNull();
    const [, init] = (global.fetch as any).mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer sk-test-0123456789');
  });

  it('can be limited to some models: only those that are both enabled and asked for are called', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ model: 'typesafe/jev-1.13', answers: { one_hour_score: { score: 3.9, confidence: 0.9 }, one_hour_direction: { choice: 'UP', confidence: 0.9 } } }), { status: 200 }));
    applySettingChanges({ 'openrouter.apiKey': 'sk-test-0123456789', 'jev.models': { jev: true, kev: true, span: true, solar: true, tev: true, mercury: true, liquid: true } }, db);
    const r = await callMultiModelDecisions({ coin: 'btc', coin_label: 'Bitcoin', cards: {}, fair_values: {} }, undefined, ['jev']);
    expect((global.fetch as any).mock.calls).toHaveLength(1);
    expect(JSON.parse((global.fetch as any).mock.calls[0][1].body).model).toBe('typesafe/jev-1.13');
    expect(r.jev).toMatchObject({ direction: 'UP', score: 3.9 });
    expect(r.kev).toBeNull();
    expect(r.consensus).toMatchObject({ total_models: 1, direction: 'UP' });
  });

  it('shows Span the Claude fair value when the snapshot has one, and leaves its prompt unchanged when it does not', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ answers: { will_close_up: { noul: 0.2 }, will_close_down: { noul: 0.1 } } }), { status: 200 }));
    applySettingChanges({ 'openrouter.apiKey': 'sk-test-0123456789', 'jev.models': { jev: false, kev: false, span: true, solar: false, tev: false, mercury: false, liquid: false } }, db);
    const state = (call: number) => JSON.parse(JSON.parse((global.fetch as any).mock.calls[call][1].body).state).fair_value_model;
    await callMultiModelDecisions({ coin: 'btc', coin_label: 'Bitcoin', cards: {}, fair_values: { model_15m: 0.8, model_5m: 0.7 } });
    await callMultiModelDecisions({ coin: 'btc', coin_label: 'Bitcoin', cards: {}, fair_values: { model_15m: 0.8, model_5m: 0.7, claude: 0.8123 } });
    expect(state(0)).toEqual({ model_15m: '80.0%', model_5m: '70.0%' });
    expect(state(1)).toEqual({ model_15m: '80.0%', model_5m: '70.0%', claude: '81.2%' });
  });

  it('records Tev, Mercury and Liquid with the same shape as Kev, without counting them as consensus votes', async () => {
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
    applySettingChanges({ 'openrouter.apiKey': 'sk-test-0123456789', 'jev.models': { jev: false, kev: false, span: false, solar: false, tev: true, mercury: true, liquid: true } }, db);
    const r = await callMultiModelDecisions({ coin: 'btc', coin_label: 'Bitcoin', cards: {}, fair_values: {} });
    const called = (global.fetch as any).mock.calls.map(([, init]: [string, { body: string }]) => JSON.parse(init.body).model);
    expect(called.sort()).toEqual(['inception/mercury-decide:free', 'liquid/d1', 'togethercomputer/tev1-4b-experimental']);
    expect(r.tev).toMatchObject({ direction: 'UP', score: 3.2, prob_up: 90 });
    expect(r.mercury).toMatchObject({ direction: 'UP', score: 3.2, prob_up: 90 });
    expect(r.liquid).toMatchObject({ direction: 'UP', score: 3.2, prob_up: 90 });
    expect(r.consensus.total_models).toBe(0);
  });
});
