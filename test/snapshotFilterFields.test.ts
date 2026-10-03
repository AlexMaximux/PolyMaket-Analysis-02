import { describe, it, expect } from 'vitest';
import { claudeEdge, consensusClass, snapshotFilterFields, tradeFilterFields, type FilterableRow } from '@/lib/snapshotFilterFields';

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
  it('put the page lead fields after the time fields', () => {
    const lead = { id: 'x', label: 'X', group: 'Signal', kind: 'number' as const, get: () => 1 };
    expect(snapshotFilterFields<FilterableRow>((r) => r, [], [lead]).map((f) => f.id).slice(0, 3)).toEqual(['minute', 'hour', 'x']);
  });
});
