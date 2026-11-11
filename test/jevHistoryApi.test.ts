import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('@/lib/marketResolver', () => ({
  updateMarketResolutions: vi.fn().mockResolvedValue(undefined),
  getResolutionsMap: () => ({ 'btc-hour-a': 'UP', 'btc-hour-b': 'DOWN' }),
}));

import { GET } from '@/app/api/jev/history/route';
import { updateMarketResolutions } from '@/lib/marketResolver';

const rec = (slug: string, time: string, extra: Record<string, unknown> = {}) => ({
  et_time: `2026-10-02 ${time} ET`, current_time_et: time, timestamp: `2026-10-02T1${time[1]}:${time.slice(3, 5)}:00.000Z`, coin: 'BTC',
  cards: { '1h': { slug, up: 0.8 } },
  fair_values: { model_15m: 0.8, model_5m: 0.7, base_no_drift: 0.79, joint_solve: null },
  prediction: { score: 3.8, direction: 'UP', score_confidence: 0.95 },
  predictions: { jev: { score: 3.8, direction: 'UP', score_confidence: 0.95 }, kev: { direction: 'UP' }, span: { direction: 'UP' } },
  ...extra,
});

const get = async (qs = '') => {
  const res = await GET(new Request(`http://x/api/jev/history${qs}`));
  return { res, json: res.headers.get('content-type')?.includes('json') ? await res.json() : null, text: res.headers.get('content-type')?.includes('json') ? null : await res.text() };
};

describe('/api/jev/history', () => {
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-api-'));
    fs.mkdirSync(path.join(root, 'jev', 'history'), { recursive: true });
    fs.mkdirSync(path.join(root, 'jev', 'cl'), { recursive: true });
    const w = (d: string, f: string, o: unknown) => fs.writeFileSync(path.join(root, 'jev', d, f), JSON.stringify(o));
    w('history', 'btc_updown_2026-10-02_10-00-00_ET.json', rec('btc-hour-a', '10:00:00'));
    // CL: one answered (new inputs gave a DOWN call), one not asked yet, one ETH
    w('cl', 'CL-btc_updown_2026-10-02_10-00-00_ET.json', rec('btc-hour-a', '10:00:00', {
      fair_values: { model_15m: 0.8, model_5m: 0.7, base_no_drift: 0.79, joint_solve: null, claude: 0.8123 },
      prediction: { score: 0.4, direction: 'DOWN', score_confidence: 0.9 },
      predictions: { jev: { score: 0.4, direction: 'DOWN', score_confidence: 0.9 }, kev: { direction: 'DOWN' }, span: { direction: 'DOWN' } },
    }));
    w('cl', 'CL-btc_updown_2026-10-02_11-00-00_ET.json', rec('btc-hour-b', '11:00:00', { prediction: null, predictions: null, fair_values: { claude: 0.5 } }));
    w('cl', 'CL-eth_updown_2026-10-02_10-00-00_ET.json', rec('btc-hour-a', '10:00:00', { coin: 'ETH', fair_values: { claude: 0.6 } }));
    // TimesFM forecast for the BTC snapshot only (the ETH one has none)
    fs.mkdirSync(path.join(root, 'jev', 'tfm'), { recursive: true });
    fs.writeFileSync(path.join(root, 'jev', 'tfm', 'forecasts-timesfm-3.0.jsonl'), JSON.stringify({
      file: 'btc_updown_2026-10-02_10-00-00_ET.json', coin: 'BTC', ts: '2026-10-02T14:00:00.000Z', model: 'm', context: 1024, last: 100,
      h1: { open: 99, minutesLeft: 20, probUp: 0.8126, median: 100.05, q10: 99.5, q90: 100.6 }, m15: null, m5: null, source: 'backfill',
    }) + '\n');
    vi.spyOn(process, 'cwd').mockReturnValue(root);
  });
  afterAll(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('default: only the original records, exactly as before', async () => {
    const { json } = await get();
    expect(json.files.map((f: { filename: string }) => f.filename)).toEqual(['btc_updown_2026-10-02_10-00-00_ET.json']);
    expect(json.files[0].direction).toBe('UP');
    expect(json.files[0].fair_claude).toBeNull();
  });

  it('set=cl: the CL records that have answers, with the new answers, the Claude fair value and the market outcome', async () => {
    const { json } = await get('?set=cl');
    const names = json.files.map((f: { filename: string }) => f.filename).sort();
    expect(names).toEqual(['CL-btc_updown_2026-10-02_10-00-00_ET.json', 'CL-eth_updown_2026-10-02_10-00-00_ET.json']);
    const btc = json.files.find((f: { filename: string }) => f.filename.startsWith('CL-btc'));
    expect(btc.direction).toBe('DOWN');
    expect(btc.score).toBe(0.4);
    expect(btc.fair_claude).toBe(81.23);
    expect(btc.market_outcome).toBe('UP');
    expect(btc.coin).toBe('BTC');
  });

  it('set=cl leaves out records the models have not been asked about yet', async () => {
    const { json } = await get('?set=cl');
    expect(json.files.some((f: { filename: string }) => f.filename.includes('11-00-00'))).toBe(false);
  });

  it('set=cl&coin filters by coin using the CL- prefix', async () => {
    expect((await get('?set=cl&coin=btc')).json.files.map((f: { coin: string }) => f.coin)).toEqual(['BTC']);
    expect((await get('?set=cl&coin=sol')).json.files).toEqual([]);
  });

  it('view=lab omits only raw predictions and preserves flattened model, price, fair value and outcome fields', async () => {
    for (const query of ['', 'set=cl&coin=btc']) {
      const { json: full } = await get(query ? `?${query}` : '');
      const { json: lab } = await get(`?${query ? `${query}&` : ''}view=lab`);
      expect(lab.count).toBe(full.count);
      expect(full.files[0]).toHaveProperty('predictions');
      expect(lab.files[0]).not.toHaveProperty('predictions');
      expect(lab.files).toEqual(full.files.map(({ predictions, ...row }: { predictions: unknown; [key: string]: unknown }) => row));
      expect(lab.files[0]).toMatchObject({
        kev_direction: query ? 'DOWN' : 'UP', span_direction: query ? 'DOWN' : 'UP', up_1h_num: 80,
        fair_15m: 80, market_outcome: 'UP',
      });
    }
  });

  it('adds the TimesFM fields of the stored forecast to each row, matched by file name', async () => {
    const { json } = await get();
    expect(json.files[0]).toMatchObject({ tfm_prob_up: 81.3, tfm_direction: 'UP', tfm_score: 3.25, fair_tfm: 81.3 });
  });

  it('set=cl matches the forecast of the original file (CL- prefix removed); a snapshot without one has null fields', async () => {
    const { json } = await get('?set=cl');
    const btc = json.files.find((f: { filename: string }) => f.filename.startsWith('CL-btc'));
    const eth = json.files.find((f: { filename: string }) => f.filename.startsWith('CL-eth'));
    expect(btc).toMatchObject({ tfm_prob_up: 81.3, tfm_direction: 'UP', tfm_score: 3.25, fair_tfm: 81.3 });
    expect(eth.tfm_prob_up).toBeNull();
    expect(eth.fair_tfm).toBeNull();
  });

  it('view=lab keeps the TimesFM fields', async () => {
    const { json } = await get('?view=lab');
    expect(json.files[0].tfm_prob_up).toBe(81.3);
  });

  it('file= reads from the CL folder only when set=cl, and never escapes the folder', async () => {
    const name = 'CL-btc_updown_2026-10-02_10-00-00_ET.json';
    expect((await get(`?set=cl&file=${name}`)).json.prediction.direction).toBe('DOWN');
    expect((await get(`?set=cl&view=lab&file=${name}`)).json.predictions.jev.direction).toBe('DOWN');
    expect((await get(`?file=${name}`)).res.status).toBe(404);
    expect((await get(`?set=cl&file=../../../etc/passwd`)).res.status).toBe(404);
  });
});

describe('/api/jev/history without a TimesFM store', () => {
  let root: string;
  beforeAll(() => {
    // the first describe's vi.restoreAllMocks() also reset the mocked resolver
    vi.mocked(updateMarketResolutions).mockResolvedValue(undefined as never);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-api-notfm-'));
    fs.mkdirSync(path.join(root, 'jev', 'history'), { recursive: true });
    fs.writeFileSync(path.join(root, 'jev', 'history', 'btc_updown_2026-10-02_10-00-00_ET.json'), JSON.stringify(rec('btc-hour-a', '10:00:00')));
    vi.spyOn(process, 'cwd').mockReturnValue(root);
  });
  afterAll(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('answers 200 and gives every TimesFM field as null', async () => {
    const { res, json } = await get();
    expect(res.status).toBe(200);
    expect(json.files).toHaveLength(1);
    expect(json.files[0]).toMatchObject({
      tfm_direction: null, tfm_score: null, tfm_prob_up: null, tfm_score_confidence: null, tfm_direction_confidence: null,
      tfm_confidence: null, tfm_up_15m: null, tfm_up_5m: null, tfm_ret_1h: null, fair_tfm: null,
    });
  });
});
