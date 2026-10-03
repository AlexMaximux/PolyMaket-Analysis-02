"use client";

import { Fragment, useMemo, type Ref } from "react";
import { Filter, Plus, X } from "lucide-react";
import {
  CHOICE_OPS,
  NUMBER_OPS,
  addCondition,
  addGroup,
  changeConditionField,
  countReadyConditions,
  describeFilters,
  isConditionReady,
  removeCondition,
  removeGroup,
  updateCondition,
  type FilterCondition,
  type FilterFieldMeta,
  type FilterGroup,
  type FilterOp,
} from "@/lib/fieldFilters";

const inputCls =
  "bg-[#0f1013] text-white border border-white/[0.15] rounded px-2 py-1 text-xs focus:outline-none focus:border-[#6aa9d8]";
const btnCls =
  "inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border bg-white/[0.04] border-white/[0.08] text-[#9a9ca3] hover:text-white hover:bg-white/[0.08] transition-all";

function NumInput({ value, onChange, label }: { value: number | null; onChange: (v: number | null) => void; label: string }) {
  return (
    <input
      type="number"
      step="any"
      inputMode="decimal"
      aria-label={label}
      className={`${inputCls} w-24 font-mono tabular-nums`}
      value={value ?? ""}
      onChange={(e) => {
        const n = e.target.value === "" ? NaN : Number(e.target.value);
        onChange(Number.isFinite(n) ? n : null);
      }}
    />
  );
}

/**
 * Builder for field filters: conditions on any field, ANDed inside a group, groups ORed (see lib/fieldFilters).
 * Quick-add chips offer the page's most useful fields first (on the Jev page, its visible columns).
 * `countText` replaces the default "N of M snapshots pass" when the page counts something else.
 */
export function FieldFilterPanel({
  fields,
  groups,
  onChange,
  quickFieldIds,
  matched,
  total,
  countText,
  hint,
  anchorRef,
}: {
  fields: FilterFieldMeta[];
  groups: FilterGroup[];
  onChange: (groups: FilterGroup[]) => void;
  quickFieldIds: string[];
  matched?: number;
  total?: number;
  countText?: string;
  hint?: string;
  anchorRef?: Ref<HTMLDivElement>;
}) {
  const byId = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields]);
  const sections = useMemo(() => {
    const out = new Map<string, FilterFieldMeta[]>();
    for (const f of fields) out.set(f.group, [...(out.get(f.group) ?? []), f]);
    return [...out.entries()];
  }, [fields]);
  const quick = quickFieldIds.map((id) => byId.get(id)).filter((f): f is FilterFieldMeta => !!f);
  const active = countReadyConditions(groups, byId);
  const summary = describeFilters(groups, byId);
  const fallbackField = quick[0] ?? fields[0];

  const patch = (groupId: string, c: FilterCondition, p: Partial<FilterCondition>) => onChange(updateCondition(groups, groupId, c.id, p));

  return (
    <div ref={anchorRef} className="bg-[#181a1e]/90 border border-[rgba(190,190,200,0.18)] rounded-2xl p-4 space-y-3 scroll-mt-4">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 border-b border-white/[0.08] pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <Filter className="w-4 h-4 text-[#6aa9d8]" />
          <span className="text-sm font-semibold text-white">Field filters</span>
          <span
            className={`text-xs px-2 py-0.5 rounded-full font-bold ${
              active ? "bg-[#d97757]/15 text-[#d97757]" : "bg-white/[0.06] text-[#73757c]"
            }`}
          >
            {active} active
          </span>
          <span className="text-xs text-[#9a9ca3]">
            {countText ?? (active ? `${matched} of ${total} snapshots pass` : `${total} snapshots, no field filter`)}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {fallbackField && (
            <button type="button" className={btnCls} onClick={() => onChange(addCondition(groups, fallbackField))}>
              <Plus className="w-3 h-3" /> Add condition
            </button>
          )}
          {fallbackField && groups.length > 0 && (
            <button
              type="button"
              className={btnCls}
              onClick={() => onChange(addGroup(groups, fallbackField))}
              title="Add an alternative: a row passes if it matches this group OR any other group"
            >
              <Plus className="w-3 h-3" /> OR group
            </button>
          )}
          {groups.length > 0 && (
            <button
              type="button"
              className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border bg-white/[0.04] border-white/[0.08] text-[#9a9ca3] hover:text-[#e5787f] hover:bg-white/[0.08] transition-all"
              onClick={() => onChange([])}
            >
              <X className="w-3 h-3" /> Clear all
            </button>
          )}
        </div>
      </div>

      {hint && <p className="text-[11px] text-[#73757c]">{hint}</p>}

      {quick.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-[#9a9ca3] mr-1">Filter on:</span>
          {quick.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => onChange(addCondition(groups, f))}
              className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border bg-white/[0.03] border-white/[0.07] text-[#bdbdb8] hover:text-white hover:bg-white/[0.06] transition-all"
              title={`Add a condition on ${f.label}`}
            >
              <Plus className="w-2.5 h-2.5 text-[#6aa9d8]" />
              {f.label}
            </button>
          ))}
        </div>
      )}

      {groups.length === 0 ? (
        <p className="text-[11px] text-[#73757c]">
          No field filter. Pick a field above, or Add condition for any field, and set a range, e.g. Jev score outside 0.5
          to 3.5, Minute of hour between 45 and 56, or Fair Claude ≥ 60. Conditions in one group must all match; add an OR
          group for an alternative.
        </p>
      ) : (
        <div className="space-y-2">
          {groups.map((g, gi) => (
            <Fragment key={g.id}>
              {gi > 0 && (
                <div className="flex items-center gap-2 text-[10px] font-bold text-[#d97757]">
                  <div className="h-px flex-1 bg-[#d97757]/30" />
                  OR
                  <div className="h-px flex-1 bg-[#d97757]/30" />
                </div>
              )}
              <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-2.5 space-y-2">
                <div className="flex items-center justify-between text-[11px] text-[#73757c]">
                  <span>{groups.length > 1 ? `Group ${gi + 1}: all of these must match` : "All of these must match"}</span>
                  {groups.length > 1 && (
                    <button type="button" className="hover:text-[#e5787f] transition-colors" onClick={() => onChange(removeGroup(groups, g.id))}>
                      Remove group
                    </button>
                  )}
                </div>

                {g.conditions.map((c, ci) => {
                  const field = byId.get(c.field);
                  const ready = isConditionReady(c, field);
                  const ops = field?.kind === "choice" ? CHOICE_OPS : NUMBER_OPS;
                  const twoBounds = c.op === "between" || c.op === "outside";
                  const noValue = c.op === "empty" || c.op === "notEmpty";
                  return (
                    <div key={c.id} className={`flex flex-wrap items-center gap-1.5 ${c.enabled ? "" : "opacity-50"}`}>
                      <span className="w-8 text-[10px] font-bold text-[#73757c] text-right">{ci === 0 ? "IF" : "AND"}</span>
                      <input
                        type="checkbox"
                        checked={c.enabled}
                        onChange={(e) => patch(g.id, c, { enabled: e.target.checked })}
                        className="accent-[#6aa9d8] w-3.5 h-3.5 cursor-pointer"
                        title="Switch this condition on or off"
                      />
                      <select
                        value={field ? c.field : ""}
                        onChange={(e) => {
                          const to = byId.get(e.target.value);
                          if (to) onChange(changeConditionField(groups, g.id, c.id, field, to));
                        }}
                        className={`${inputCls} max-w-[220px]`}
                        aria-label="Field"
                      >
                        {!field && <option value="">Unknown field ({c.field})</option>}
                        {sections.map(([section, fs]) => (
                          <optgroup key={section} label={section}>
                            {fs.map((f) => (
                              <option key={f.id} value={f.id}>
                                {f.label}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                      <select
                        value={c.op}
                        onChange={(e) => patch(g.id, c, { op: e.target.value as FilterOp })}
                        className={inputCls}
                        aria-label="Operator"
                      >
                        {ops.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>

                      {field?.kind === "number" && !noValue && (
                        <>
                          <NumInput value={c.a} onChange={(v) => patch(g.id, c, { a: v })} label={twoBounds ? "From" : "Value"} />
                          {twoBounds && (
                            <>
                              <span className="text-[11px] text-[#73757c]">and</span>
                              <NumInput value={c.b} onChange={(v) => patch(g.id, c, { b: v })} label="To" />
                            </>
                          )}
                          {field.unit && <span className="text-[11px] text-[#73757c]">{field.unit.trim()}</span>}
                        </>
                      )}

                      {field?.kind === "choice" &&
                        (field.choices ?? []).map((ch) => {
                          const on = c.values.includes(ch.value);
                          return (
                            <button
                              key={ch.value}
                              type="button"
                              onClick={() =>
                                patch(g.id, c, { values: on ? c.values.filter((v) => v !== ch.value) : [...c.values, ch.value] })
                              }
                              className={`text-[11px] px-2 py-0.5 rounded-md border transition-all ${
                                on
                                  ? "bg-[#6b86d6]/25 border-[#8ea4e8] text-white"
                                  : "bg-white/[0.03] border-white/[0.07] text-[#9a9ca3] hover:text-white"
                              }`}
                            >
                              {ch.label}
                            </button>
                          );
                        })}

                      {c.enabled && !ready && field && (
                        <span className="text-[10px] text-amber-300/80">not applied until filled in</span>
                      )}
                      <button
                        type="button"
                        onClick={() => onChange(removeCondition(groups, g.id, c.id))}
                        className="ml-auto p-1 rounded text-[#73757c] hover:text-[#e5787f] hover:bg-white/[0.06] transition-colors"
                        title="Remove this condition"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                })}

                {fallbackField && (
                  <button
                    type="button"
                    onClick={() => onChange(addCondition(groups, fallbackField, g.id))}
                    className="ml-10 inline-flex items-center gap-1 text-[11px] text-[#6aa9d8] hover:text-white transition-colors"
                  >
                    <Plus className="w-3 h-3" /> AND condition
                  </button>
                )}
              </div>
            </Fragment>
          ))}
        </div>
      )}

      {summary && (
        <div className="text-[11px] text-[#9a9ca3] border-t border-white/[0.06] pt-2">
          <span className="text-[#73757c]">Showing rows where: </span>
          {summary}
        </div>
      )}
    </div>
  );
}
