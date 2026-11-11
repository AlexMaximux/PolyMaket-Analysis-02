import { describe, it, expect } from 'vitest';
import { claudeEdge, consensusClass, snapshotFilterFields, tfmEdge, tradeFilterFields, type FilterableRow } from '@/lib/snapshotFilterFields';
import type { Trade } from '@/lib/signalAnalysis';

const row = (over: Partial<FilterableRow> & Record<string, unknown> = {}): FilterableRow =>
  ({ coin: 'btc', et_time: '2026-10-02 10:47:23 ET', ...over }) as FilterableRow;

describe('snapshot filter fields', () => {
  const fields = snapshotFilterFields<FilterableRow>((r) => r, ['BTC']);
  const get = (id: string, r: FilterableRow) => fields.find((f) => f.id === id)!.get(r);

  it('have unique ids, on both pages', () => {
    for (const list of [fields, tradeFilterFields()]) {
      const ids = list.map((f) => f.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
  it('read time, coin and any model field by its column id', () => {
    const r = row({ kev_score_confidence: 91, fair_claude: 2.94 });
    expect([get('minute', r), get('hour', r), get('coin', r)]).toEqual([47, 10, 'BTC']);
    expect([get('kev_score_confidence', r), get('fair_claude', r)]).toEqual([91, 2.94]);
  });
  it('derive the Claude edge, the consensus reading and the spot move', () => {
    expect(claudeEdge(row({ fair_claude: 62.5, up_1h_num: 55 }))).toBe(7.5);
    expect(claudeEdge(row({ fair_claude: 62.5 }))).toBeNull();
    expect(consensusClass(row({ direction: 'UP', kev_direction: 'UP', span_direction: null }))).toBe('FULL_UP');
    expect(consensusClass(row({ direction: 'UP', kev_direction: 'DOWN', span_direction: 'DOWN' }))).toBe('LEAN_DOWN');
    expect(consensusClass(row())).toBeNull();
    expect(get('spot_vs_ptb', row({ spot_price: 101, price_to_beat: 100 }))).toBe(1);
  });
  it('derive the TimesFM edge from its probability and the 1H price', () => {
    expect(tfmEdge(row({ tfm_prob_up: 62.5, up_1h_num: 55 }))).toBe(7.5);
    expect(tfmEdge(row({ tfm_prob_up: 62.5 }))).toBeNull();
    expect(tfmEdge(row({ up_1h_num: 55 }))).toBeNull();
    expect(get('tfm_edge', row({ tfm_prob_up: 62.5, up_1h_num: 55 }))).toBe(7.5);
  });
  it('offer the TimesFM group, read by column id', () => {
    for (const id of ['tfm_direction', 'tfm_score', 'tfm_prob_up', 'tfm_confidence', 'tfm_edge', 'tfm_edge_15m', 'tfm_edge_5m', 'tfm_up_15m', 'tfm_up_5m', 'tfm_ret_1h']) {
      expect(fields.find((f) => f.id === id)?.group, id).toBe('TimesFM');
    }
    const r = row({ tfm_score: 3.25, tfm_up_5m: 61, up_5m_num: 50, tfm_up_15m: 58, up_15m_num: 60, tfm_ret_1h: 0.12 });
    expect([get('tfm_score', r), get('tfm_up_5m', r), get('tfm_ret_1h', r)]).toEqual([3.25, 61, 0.12]);
    expect([get('tfm_edge_5m', r), get('tfm_edge_15m', r), get('tfm_edge', r)]).toEqual([11, -2, null]);
    expect(fields.find((f) => f.id === 'tfm_ret_1h')?.unit).toBe('%');
  });
  it('list the TimesFM fair value after the Claude one', () => {
    const ids = fields.map((f) => f.id);
    expect(ids).toContain('fair_tfm');
    expect(ids.indexOf('fair_tfm')).toBe(ids.indexOf('fair_claude') + 1);
    expect(fields.find((f) => f.id === 'fair_tfm')?.group).toBe('Fair value');
    expect(get('fair_tfm', row({ fair_tfm: 81.3 }))).toBe(81.3);
  });
  it('give a trade the TimesFM probability of the side bought and its edge', () => {
    const tf = tradeFilterFields();
    const trade = (dir: 'UP' | 'DOWN', quote: number | null, tfm_prob_up: number | null) =>
      ({ dir, quote, row: row({ tfm_prob_up }) }) as unknown as Trade;
    const tget = (id: string, t: Trade) => tf.find((f) => f.id === id)!.get(t);
    expect(tget('trade_tfm_prob', trade('DOWN', 0.7, 20))).toBe(80);
    expect(tget('trade_tfm_edge', trade('DOWN', 0.7, 20))).toBe(10);
    expect(tget('trade_tfm_prob', trade('UP', 0.55, 62.5))).toBe(62.5);
    expect(tget('trade_tfm_edge', trade('UP', 0.55, 62.5))).toBe(7.5);
    expect(tget('trade_tfm_edge', trade('UP', null, 62.5))).toBeNull();
    expect(tget('trade_tfm_prob', trade('UP', 0.55, null))).toBeNull();
    expect(tget('trade_tfm_edge', trade('UP', 0.55, null))).toBeNull();
  });
  it('put the page lead fields after the time fields', () => {
    const lead = { id: 'x', label: 'X', group: 'Signal', kind: 'number' as const, get: () => 1 };
    expect(snapshotFilterFields<FilterableRow>((r) => r, [], [lead]).map((f) => f.id).slice(0, 3)).toEqual(['minute', 'hour', 'x']);
  });
});
