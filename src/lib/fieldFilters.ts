/**
 * Field filters for the analysis table: conditions on any field of a row, numeric or categorical.
 *
 * Conditions sit in groups. A group passes when every condition in it passes (AND); the filter passes when any
 * group passes (OR). So "(Jev score > 3.5 and minute 45-56) or (Kev score > 3.5)" is two groups.
 *
 * A condition that is switched off or not filled in yet (a "between" with one bound missing, a choice with nothing
 * picked) is skipped, and a filter with no usable condition lets every row through, so a half-typed value never
 * empties the table. A row without the field's value fails every numeric comparison; "is empty" finds those rows.
 */

export type NumberOp = "between" | "outside" | "gt" | "gte" | "lt" | "lte" | "eq" | "neq" | "notEmpty" | "empty";
export type ChoiceOp = "in" | "notIn";
export type FilterOp = NumberOp | ChoiceOp;

export const NUMBER_OPS: { value: NumberOp; label: string }[] = [
  { value: "between", label: "between" },
  { value: "outside", label: "outside" },
  { value: "gt", label: ">" },
  { value: "gte", label: "≥" },
  { value: "lt", label: "<" },
  { value: "lte", label: "≤" },
  { value: "eq", label: "=" },
  { value: "neq", label: "≠" },
  { value: "notEmpty", label: "has a value" },
  { value: "empty", label: "is empty" },
];

export const CHOICE_OPS: { value: ChoiceOp; label: string }[] = [
  { value: "in", label: "is any of" },
  { value: "notIn", label: "is none of" },
];

/** Value a categorical field takes when the row has none (a model that did not answer, a market still open). */
export const NONE = "none";

export interface FilterFieldMeta {
  id: string;
  label: string;
  group: string; // heading in the field picker
  kind: "number" | "choice";
  unit?: string; // shown after the inputs: "%", "¢", "min"
  choices?: { value: string; label: string }[]; // kind "choice"; NONE stands for "no value"
}

export interface FilterField<R> extends FilterFieldMeta {
  get: (row: R) => number | string | null | undefined;
}

export interface FilterCondition {
  id: string;
  field: string;
  op: FilterOp;
  a: number | null; // the value, or one bound of between/outside
  b: number | null; // the other bound of between/outside
  values: string[]; // choice ops
  enabled: boolean;
}

export interface FilterGroup {
  id: string;
  conditions: FilterCondition[];
}

const isNumberOp = (op: unknown): op is NumberOp => NUMBER_OPS.some((o) => o.value === op);
const isChoiceOp = (op: unknown): op is ChoiceOp => CHOICE_OPS.some((o) => o.value === op);
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const needsTwo = (op: FilterOp) => op === "between" || op === "outside";
const needsNone = (op: FilterOp) => op === "empty" || op === "notEmpty";

// Keys only need to be unique on this page. crypto.randomUUID is missing on plain-HTTP origins, so it is not used.
let idCounter = 0;
export const newFilterId = () => `f${Date.now().toString(36)}${(idCounter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function defaultOp(kind: FilterFieldMeta["kind"]): FilterOp {
  return kind === "number" ? "between" : "in";
}

export function newCondition(field: FilterFieldMeta): FilterCondition {
  return { id: newFilterId(), field: field.id, op: defaultOp(field.kind), a: null, b: null, values: [], enabled: true };
}

/** True when the condition is applied: switched on, its field exists, the operator fits the field and the values are filled in. */
export function isConditionReady(c: FilterCondition, field: FilterFieldMeta | undefined): boolean {
  if (!c.enabled || !field) return false;
  if (field.kind === "choice") return isChoiceOp(c.op) && c.values.length > 0;
  if (!isNumberOp(c.op)) return false;
  if (needsNone(c.op)) return true;
  return isNum(c.a) && (!needsTwo(c.op) || isNum(c.b));
}

/** Whether one field value passes one condition. Between and outside take their bounds in either order; between includes both. */
export function testCondition(value: number | string | null | undefined, c: FilterCondition): boolean {
  if (isChoiceOp(c.op)) {
    const v = value == null || value === "" ? NONE : String(value);
    return c.values.includes(v) === (c.op === "in");
  }
  const n = typeof value === "number" ? value : value == null || value === "" ? NaN : Number(value);
  const has = Number.isFinite(n);
  if (c.op === "empty") return !has;
  if (c.op === "notEmpty") return has;
  if (!has || !isNum(c.a)) return false;
  const a = c.a;
  const lo = isNum(c.b) ? Math.min(a, c.b) : a;
  const hi = isNum(c.b) ? Math.max(a, c.b) : a;
  switch (c.op) {
    case "between": return n >= lo && n <= hi;
    case "outside": return n < lo || n > hi;
    case "gt": return n > a;
    case "gte": return n >= a;
    case "lt": return n < a;
    case "lte": return n <= a;
    case "eq": return Math.abs(n - a) < 1e-9;
    case "neq": return Math.abs(n - a) >= 1e-9;
    default: return false;
  }
}

/** The filter as one row test, or null when no condition is applied (every row passes). */
export function compileFilters<R>(groups: FilterGroup[], fields: ReadonlyMap<string, FilterField<R>>): ((row: R) => boolean) | null {
  const ready = groups
    .map((g) =>
      g.conditions
        .filter((c) => isConditionReady(c, fields.get(c.field)))
        .map((c) => ({ c, get: fields.get(c.field)!.get })))
    .filter((g) => g.length > 0);
  if (!ready.length) return null;
  return (row) => ready.some((g) => g.every(({ c, get }) => testCondition(get(row), c)));
}

export function countReadyConditions(groups: FilterGroup[], fields: ReadonlyMap<string, FilterFieldMeta>): number {
  return groups.reduce((n, g) => n + g.conditions.filter((c) => isConditionReady(c, fields.get(c.field))).length, 0);
}

const fmt = (x: number | null) => (x == null ? "?" : String(x));

export function describeCondition(c: FilterCondition, field: FilterFieldMeta): string {
  const u = field.unit ?? "";
  if (field.kind === "choice") {
    const names = c.values.map((v) => field.choices?.find((ch) => ch.value === v)?.label ?? v);
    return `${field.label} ${c.op === "notIn" ? "is not" : "is"} ${names.join(" or ")}`;
  }
  const lo = isNum(c.a) && isNum(c.b) ? Math.min(c.a, c.b) : c.a;
  const hi = isNum(c.a) && isNum(c.b) ? Math.max(c.a, c.b) : c.b;
  switch (c.op) {
    case "between": return `${field.label} ${fmt(lo)}–${fmt(hi)}${u}`;
    case "outside": return `${field.label} outside ${fmt(lo)}–${fmt(hi)}${u}`;
    case "empty": return `${field.label} is empty`;
    case "notEmpty": return `${field.label} has a value`;
    default: return `${field.label} ${NUMBER_OPS.find((o) => o.value === c.op)?.label ?? c.op} ${fmt(c.a)}${u}`;
  }
}

/** The applied conditions in words, e.g. "(Jev score > 3.5 and Minute 45–56) or Kev score > 3.5". Empty when nothing is applied. */
export function describeFilters(groups: FilterGroup[], fields: ReadonlyMap<string, FilterFieldMeta>): string {
  const parts = groups
    .map((g) => g.conditions.filter((c) => isConditionReady(c, fields.get(c.field))).map((c) => describeCondition(c, fields.get(c.field)!)))
    .filter((g) => g.length > 0);
  return parts.map((g) => (parts.length > 1 && g.length > 1 ? `(${g.join(" and ")})` : g.join(" and "))).join(" or ");
}

// ---------- edits (all return a new array) ----------

/** Adds a condition on `field` to the given group, or to the last group (made if there is none). */
export function addCondition(groups: FilterGroup[], field: FilterFieldMeta, groupId?: string): FilterGroup[] {
  const c = newCondition(field);
  if (!groups.length) return [{ id: newFilterId(), conditions: [c] }];
  const target = groupId ?? groups[groups.length - 1].id;
  return groups.map((g) => (g.id === target ? { ...g, conditions: [...g.conditions, c] } : g));
}

/** Adds a new OR group holding one condition on `field`. */
export function addGroup(groups: FilterGroup[], field: FilterFieldMeta): FilterGroup[] {
  return [...groups, { id: newFilterId(), conditions: [newCondition(field)] }];
}

export function updateCondition(groups: FilterGroup[], groupId: string, conditionId: string, patch: Partial<FilterCondition>): FilterGroup[] {
  return groups.map((g) =>
    g.id === groupId ? { ...g, conditions: g.conditions.map((c) => (c.id === conditionId ? { ...c, ...patch, id: c.id } : c)) } : g);
}

/** Points a condition at another field. Bounds carry over between two numeric fields; anything else starts fresh. */
export function changeConditionField(groups: FilterGroup[], groupId: string, conditionId: string, from: FilterFieldMeta | undefined, to: FilterFieldMeta): FilterGroup[] {
  const sameNumeric = from?.kind === "number" && to.kind === "number";
  return groups.map((g) =>
    g.id === groupId
      ? {
          ...g,
          conditions: g.conditions.map((c) =>
            c.id !== conditionId ? c : sameNumeric ? { ...c, field: to.id } : { ...newCondition(to), id: c.id, enabled: c.enabled }),
        }
      : g);
}

/** Removes a condition; a group left empty is removed too. */
export function removeCondition(groups: FilterGroup[], groupId: string, conditionId: string): FilterGroup[] {
  return groups
    .map((g) => (g.id === groupId ? { ...g, conditions: g.conditions.filter((c) => c.id !== conditionId) } : g))
    .filter((g) => g.conditions.length > 0);
}

export function removeGroup(groups: FilterGroup[], groupId: string): FilterGroup[] {
  return groups.filter((g) => g.id !== groupId);
}

/** Saved filters read back from browser storage: keeps only well-formed groups and conditions. */
export function sanitizeFilterGroups(raw: unknown): FilterGroup[] {
  if (!Array.isArray(raw)) return [];
  const out: FilterGroup[] = [];
  for (const g of raw) {
    if (!g || typeof g !== "object" || !Array.isArray((g as FilterGroup).conditions)) continue;
    const conditions: FilterCondition[] = [];
    for (const c of (g as FilterGroup).conditions) {
      if (!c || typeof c !== "object" || typeof c.field !== "string" || !(isNumberOp(c.op) || isChoiceOp(c.op))) continue;
      conditions.push({
        id: typeof c.id === "string" && c.id ? c.id : newFilterId(),
        field: c.field,
        op: c.op,
        a: isNum(c.a) ? c.a : null,
        b: isNum(c.b) ? c.b : null,
        values: Array.isArray(c.values) ? c.values.filter((v): v is string => typeof v === "string") : [],
        enabled: c.enabled !== false,
      });
    }
    if (conditions.length) out.push({ id: typeof (g as FilterGroup).id === "string" && (g as FilterGroup).id ? (g as FilterGroup).id : newFilterId(), conditions });
  }
  return out;
}
