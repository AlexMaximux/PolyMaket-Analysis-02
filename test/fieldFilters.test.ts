import { describe, it, expect } from 'vitest';
import {
  NONE,
  addCondition,
  addGroup,
  changeConditionField,
  compileFilters,
  countReadyConditions,
  describeFilters,
  isConditionReady,
  removeCondition,
  sanitizeFilterGroups,
  testCondition,
  updateCondition,
  type FilterCondition,
  type FilterField,
  type FilterGroup,
} from '../src/lib/fieldFilters';

type Row = { score?: number | null; minute?: number | null; dir?: string | null };

const FIELDS: FilterField<Row>[] = [
  { id: 'score', label: 'Jev score', group: 'Jev', kind: 'number', get: (r) => r.score },
  { id: 'minute', label: 'Minute', group: 'Time', kind: 'number', unit: ' min', get: (r) => r.minute },
  {
    id: 'dir', label: 'Jev direction', group: 'Jev', kind: 'choice', get: (r) => r.dir,
    choices: [{ value: 'UP', label: 'UP' }, { value: 'DOWN', label: 'DOWN' }, { value: NONE, label: 'none' }],
  },
];
const MAP = new Map(FIELDS.map((f) => [f.id, f]));

const cond = (over: Partial<FilterCondition>): FilterCondition => ({
  id: 'c', field: 'score', op: 'between', a: null, b: null, values: [], enabled: true, ...over,
});
const group = (...conditions: Partial<FilterCondition>[]): FilterGroup => ({
  id: `g${Math.random()}`, conditions: conditions.map((c, i) => cond({ id: `c${i}`, ...c })),
});

describe('testCondition', () => {
  it('between includes both bounds and takes them in either order', () => {
    expect(testCondition(45, cond({ a: 45, b: 56 }))).toBe(true);
    expect(testCondition(56, cond({ a: 56, b: 45 }))).toBe(true);
    expect(testCondition(57, cond({ a: 45, b: 56 }))).toBe(false);
  });
  it('outside keeps only values beyond the bounds', () => {
    const c = cond({ op: 'outside', a: 0.5, b: 3.5 });
    expect([0.4, 0.5, 2, 3.5, 3.6].map((v) => testCondition(v, c))).toEqual([true, false, false, false, true]);
  });
  it('compares with each operator', () => {
    expect(testCondition(3.5, cond({ op: 'gt', a: 3.5 }))).toBe(false);
    expect(testCondition(3.5, cond({ op: 'gte', a: 3.5 }))).toBe(true);
    expect(testCondition(0.5, cond({ op: 'lt', a: 0.5 }))).toBe(false);
    expect(testCondition(0.5, cond({ op: 'lte', a: 0.5 }))).toBe(true);
    expect(testCondition(2.68, cond({ op: 'eq', a: 2.68 }))).toBe(true);
    expect(testCondition(2.68, cond({ op: 'neq', a: 2.68 }))).toBe(false);
  });
  it('a missing value fails comparisons and is found by "is empty"', () => {
    expect(testCondition(null, cond({ op: 'neq', a: 1 }))).toBe(false);
    expect(testCondition(undefined, cond({ op: 'lt', a: 1 }))).toBe(false);
    expect(testCondition(null, cond({ op: 'empty' }))).toBe(true);
    expect(testCondition(0, cond({ op: 'empty' }))).toBe(false);
    expect(testCondition(0, cond({ op: 'notEmpty' }))).toBe(true);
  });
  it('choices match by value, with a missing value counted as NONE', () => {
    expect(testCondition('UP', cond({ field: 'dir', op: 'in', values: ['UP'] }))).toBe(true);
    expect(testCondition(null, cond({ field: 'dir', op: 'in', values: [NONE] }))).toBe(true);
    expect(testCondition('DOWN', cond({ field: 'dir', op: 'notIn', values: ['UP', NONE] }))).toBe(true);
    expect(testCondition(null, cond({ field: 'dir', op: 'notIn', values: [NONE] }))).toBe(false);
  });
});

describe('isConditionReady', () => {
  it('skips conditions that are off, unfilled, or on an unknown field', () => {
    expect(isConditionReady(cond({ a: 1 }), MAP.get('score'))).toBe(false); // between needs both bounds
    expect(isConditionReady(cond({ a: 1, b: 2 }), MAP.get('score'))).toBe(true);
    expect(isConditionReady(cond({ a: 1, b: 2, enabled: false }), MAP.get('score'))).toBe(false);
    expect(isConditionReady(cond({ op: 'gt', a: 1 }), undefined)).toBe(false);
    expect(isConditionReady(cond({ op: 'empty' }), MAP.get('score'))).toBe(true);
    expect(isConditionReady(cond({ field: 'dir', op: 'in' }), MAP.get('dir'))).toBe(false);
    expect(isConditionReady(cond({ field: 'dir', op: 'gt', a: 1 }), MAP.get('dir'))).toBe(false); // number op on a choice field
  });
});

describe('compileFilters', () => {
  const rows: Row[] = [
    { score: 3.8, minute: 47, dir: 'UP' },
    { score: 3.8, minute: 20, dir: 'UP' },
    { score: 0.2, minute: 50, dir: 'DOWN' },
    { score: 2.0, minute: 50, dir: null },
  ];
  const run = (groups: FilterGroup[]) => {
    const fn = compileFilters(groups, MAP);
    return fn ? rows.filter(fn) : rows;
  };

  it('is null (no filtering) when nothing is applied', () => {
    expect(compileFilters([], MAP)).toBeNull();
    expect(compileFilters([group({ a: 1 })], MAP)).toBeNull();
  });
  it('ANDs conditions within a group', () => {
    expect(run([group({ op: 'outside', a: 0.5, b: 3.5 }, { field: 'minute', a: 45, b: 56 })])).toEqual([rows[0], rows[2]]);
  });
  it('ORs groups', () => {
    expect(run([group({ op: 'gt', a: 3.5 }, { field: 'minute', a: 45, b: 56 }), group({ field: 'dir', op: 'in', values: [NONE] })]))
      .toEqual([rows[0], rows[3]]);
  });
  it('ignores a group whose conditions are not filled in', () => {
    expect(run([group({ op: 'lt', a: 0.5 }), group({ op: 'gt' })])).toEqual([rows[2]]);
  });
});

describe('edits and descriptions', () => {
  it('adds, changes and removes conditions; an emptied group disappears', () => {
    let g = addCondition([], MAP.get('score')!);
    expect(g).toHaveLength(1);
    g = addCondition(g, MAP.get('minute')!);
    expect(g[0].conditions.map((c) => c.field)).toEqual(['score', 'minute']);
    g = addGroup(g, MAP.get('dir')!);
    expect(g).toHaveLength(2);
    g = updateCondition(g, g[0].id, g[0].conditions[0].id, { op: 'gt', a: 3.5 });
    g = updateCondition(g, g[0].id, g[0].conditions[1].id, { a: 45, b: 56 });
    expect(countReadyConditions(g, MAP)).toBe(2);
    expect(describeFilters(g, MAP)).toBe('Jev score > 3.5 and Minute 45–56 min');
    g = updateCondition(g, g[1].id, g[1].conditions[0].id, { values: ['DOWN'] });
    expect(describeFilters(g, MAP)).toBe('(Jev score > 3.5 and Minute 45–56 min) or Jev direction is DOWN');
    g = removeCondition(g, g[1].id, g[1].conditions[0].id);
    expect(g).toHaveLength(1);
  });
  it('keeps bounds when moving between numeric fields and resets otherwise', () => {
    let g = addCondition([], MAP.get('score')!);
    g = updateCondition(g, g[0].id, g[0].conditions[0].id, { op: 'gt', a: 3 });
    const kept = changeConditionField(g, g[0].id, g[0].conditions[0].id, MAP.get('score'), MAP.get('minute')!);
    expect(kept[0].conditions[0]).toMatchObject({ field: 'minute', op: 'gt', a: 3 });
    const reset = changeConditionField(g, g[0].id, g[0].conditions[0].id, MAP.get('score'), MAP.get('dir')!);
    expect(reset[0].conditions[0]).toMatchObject({ field: 'dir', op: 'in', a: null, values: [] });
    expect(reset[0].conditions[0].id).toBe(g[0].conditions[0].id);
  });
  it('sanitizes saved filters', () => {
    const saved = [
      { id: 'g1', conditions: [{ id: 'c1', field: 'score', op: 'gt', a: 3, b: 'x', values: 5, enabled: true }, { field: 'x', op: 'bogus' }] },
      { conditions: [] },
      'junk',
    ];
    expect(sanitizeFilterGroups(saved)).toEqual([
      { id: 'g1', conditions: [{ id: 'c1', field: 'score', op: 'gt', a: 3, b: null, values: [], enabled: true }] },
    ]);
    expect(sanitizeFilterGroups(null)).toEqual([]);
  });
});
