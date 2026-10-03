import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { askClFile, CL_MODELS } from '@/lib/clAsk';
import { buildClRecord, saveClRecord } from '@/lib/clSnapshot';

const FILE = 'btc_updown_2026-10-02_12-45-00_ET.json';
const CL = `CL-${FILE}`;

const snapshot = () => ({
  et_time: '2026-10-02 12:45:00 ET', date_et: '2026-10-02', current_time_et: '12:45:00 PM', current_time_et_24h: '12:45:00',
  timestamp: '2026-10-02T16:45:00.000Z', coin: 'BTC', coin_label: 'Bitcoin', spot_price: 86500, open_price: 86300, price_to_beat: 86300,
  cards: { '1h': { slug: 'bitcoin-up-or-down-october-2-2026-12pm-et', up: 0.78 } },
  fair_values: { model_15m: 0.8, model_5m: 0.81, base_no_drift: 0.79, joint_solve: null },
  model_inputs: { t: 45 }, books: { '1h': null }, claude_model: { version: 'v', fairUp: 0.8123, fairDown: 0.1877 },
});

const answer = (direction: 'UP' | 'DOWN', cost = 0.0001) => ({ direction, score: 3.4, score_confidence: 0.9, cost, raw_decision: { big: 'blob' } });
const multi = (over: Record<string, unknown> = {}) => {
  const jev = answer('UP', 0.00004);
  return {
    jev, kev: answer('UP', 0.00002), span: answer('DOWN', 0.000006), solar: null, tev: null, mercury: null, liquid: null,
    consensus: { direction: 'UP', up_votes: 2, down_votes: 1, total_models: 3, summary: '2/3 UP (1 DOWN)', agreement: 67 },
    primary: jev, ...over,
  };
};

describe('askClFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-ask-'));
    saveClRecord(snapshot(), FILE, dir);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const read = () => JSON.parse(fs.readFileSync(path.join(dir, CL), 'utf8'));

  it('sends the CL record (old fair values plus claude) to the models and stores their answers in the same shape as the original records', async () => {
    const ask = vi.fn().mockResolvedValue(multi());
    const res = await askClFile(CL, { dir, ask });
    expect(res.status).toBe('asked');
    expect(ask.mock.calls[0][0].fair_values).toEqual({ model_15m: 0.8, model_5m: 0.81, base_no_drift: 0.79, joint_solve: null, claude: 0.8123 });
    const saved = read();
    expect(Object.keys(saved.predictions)).toEqual(['jev', 'kev', 'span', 'solar', 'tev', 'mercury', 'liquid', 'consensus']);
    expect(saved.predictions.jev.direction).toBe('UP');
    expect(saved.predictions.span.direction).toBe('DOWN');
    expect(saved.predictions.kev).toBeNull(); // Kev was not one of the models asked for
    expect(saved.predictions.consensus.summary).toBe('1/2 UP (1 DOWN)');
    expect(saved.predictions.consensus.direction).toBe('SPLIT');
    expect(saved.prediction.direction).toBe('UP');
    expect(typeof saved.asked_at).toBe('string');
    expect(saved.inputs_variant).toBe('old+claude');
  });

  it('asks Jev and Span by default, and another set when told to', async () => {
    expect(CL_MODELS).toEqual(['jev', 'span']);
    const ask = vi.fn().mockResolvedValue(multi());
    await askClFile(CL, { dir, ask });
    expect(ask.mock.calls[0][1]).toEqual(['jev', 'span']);
    await askClFile(CL, { dir, ask, force: true, models: ['jev', 'kev'] });
    expect(ask.mock.calls[1][1]).toEqual(['jev', 'kev']);
  });

  it('asks only the models still missing, keeps the earlier answers and recomputes the consensus', async () => {
    await askClFile(CL, { dir, ask: vi.fn().mockResolvedValue(multi()), models: ['jev'] }); // Jev UP already stored
    expect(read().predictions.span).toBeNull();
    const askSpan = vi.fn().mockResolvedValue(multi({ jev: null, kev: null, span: answer('DOWN', 0.000006) }));
    const res = await askClFile(CL, { dir, ask: askSpan });
    expect(askSpan.mock.calls[0][1]).toEqual(['span']);
    expect(res).toMatchObject({ status: 'asked' });
    expect(res.cost).toBeCloseTo(0.000006, 9);
    const saved = read();
    expect(saved.predictions.jev.direction).toBe('UP');
    expect(saved.predictions.span.direction).toBe('DOWN');
    expect(saved.predictions.consensus).toMatchObject({ direction: 'SPLIT', total_models: 2, summary: '1/2 UP (1 DOWN)' });
    expect(saved.prediction.direction).toBe('UP');
  });

  it('keeps every other field of the CL record as it was', async () => {
    const before = read();
    await askClFile(CL, { dir, ask: vi.fn().mockResolvedValue(multi()) });
    const after = read();
    for (const k of Object.keys(before)) if (k !== 'prediction' && k !== 'predictions') expect(after[k]).toEqual(before[k]);
  });

  it('reports the money spent', async () => {
    const res = await askClFile(CL, { dir, ask: vi.fn().mockResolvedValue(multi()) });
    expect(res.cost).toBeCloseTo(0.000046, 9); // Jev + Span; the Kev answer in the mock was not asked for
  });

  it('does not ask again for a record that already has answers, unless forced', async () => {
    await askClFile(CL, { dir, ask: vi.fn().mockResolvedValue(multi()) });
    const ask = vi.fn().mockResolvedValue(multi({ jev: answer('DOWN'), primary: answer('DOWN') }));
    expect((await askClFile(CL, { dir, ask })).status).toBe('skipped-answered');
    expect(ask).not.toHaveBeenCalled();
    expect((await askClFile(CL, { dir, ask, force: true })).status).toBe('asked');
    expect(read().predictions.jev.direction).toBe('DOWN');
  });

  it('writes nothing when every model failed, so the record can be retried', async () => {
    const before = fs.readFileSync(path.join(dir, CL), 'utf8');
    const none = multi({ jev: null, kev: null, span: null, primary: null, consensus: { direction: null, total_models: 0 } });
    const res = await askClFile(CL, { dir, ask: vi.fn().mockResolvedValue(none) });
    expect(res.status).toBe('no-answers');
    expect(fs.readFileSync(path.join(dir, CL), 'utf8')).toBe(before);
  });

  it('reports a missing file and leaves no temp files behind', async () => {
    expect((await askClFile('CL-nope.json', { dir, ask: vi.fn() })).status).toBe('missing');
    await askClFile(CL, { dir, ask: vi.fn().mockResolvedValue(multi()) });
    expect(fs.readdirSync(dir)).toEqual([CL]);
  });

  it('what it sends is exactly what buildClRecord saved', async () => {
    const ask = vi.fn().mockResolvedValue(multi());
    await askClFile(CL, { dir, ask });
    expect(ask.mock.calls[0][0].claude_model).toEqual(buildClRecord(snapshot(), FILE)!.claude_model);
  });
});
