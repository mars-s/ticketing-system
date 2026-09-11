'use client';

import type { ConditionOp, FieldCondition, VisibilityRule } from '@ticketing/shared';
import { buttonGhost, input, inputSm, mutedText, select as selectStyle } from '@/lib/styles';

export interface VisibilityTarget {
  id: string;
  label: string;
  /** 'checkbox' targets only offer isTrue/isFalse; 'dropdown' offers eq/neq/in/notIn with
   * a real option picker; everything else (free text fields, or the standard priority/type
   * fields) offers eq/neq/in/notIn against typed-in values. */
  kind: 'checkbox' | 'dropdown' | 'value';
  options?: { value: string; label: string }[];
}

const VALUE_OPS: ConditionOp[] = ['eq', 'neq', 'in', 'notIn'];
const CHECKBOX_OPS: ConditionOp[] = ['isTrue', 'isFalse'];

const OP_LABELS: Record<ConditionOp, string> = {
  eq: 'is',
  neq: 'is not',
  in: 'is one of',
  notIn: 'is not one of',
  isTrue: 'is checked',
  isFalse: 'is not checked',
};

/**
 * Flat AND/OR condition-list builder -- covers every case in docs/ticket-group-custom-fields-plan.md
 * (checkbox-gated field, dropdown-value-gated field, multi-condition gating) with a UI simple
 * enough for a non-engineer group admin to use. The underlying VisibilityRule type supports
 * arbitrary AND/OR/NOT nesting (evaluateVisibility handles it); this editor just doesn't expose
 * nesting deeper than one level, so a hand-authored config can be more elaborate than anything
 * built here -- that's a deliberate scope cut, not an evaluator limitation.
 */
export function VisibilityRuleEditor({
  rule,
  onChange,
  targets,
}: {
  rule: VisibilityRule | undefined;
  onChange: (rule: VisibilityRule | undefined) => void;
  targets: VisibilityTarget[];
}) {
  if (targets.length === 0) {
    return <p className={mutedText}>No earlier fields to gate on yet -- add one above first.</p>;
  }

  if (!rule) {
    return (
      <button
        type="button"
        className={buttonGhost}
        onClick={() => onChange(conditionRule(defaultCondition(targets)))}
      >
        + Only show when…
      </button>
    );
  }

  const { combinator, conditions } = flatten(rule);

  function updateCondition(index: number, next: FieldCondition) {
    const updated = conditions.map((c, i) => (i === index ? next : c));
    onChange(buildRule(combinator, updated));
  }

  function removeCondition(index: number) {
    const updated = conditions.filter((_, i) => i !== index);
    if (updated.length === 0) {
      onChange(undefined);
      return;
    }
    onChange(buildRule(combinator, updated));
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-2.5">
      {conditions.map((condition, index) => (
        <div key={index} className="flex flex-wrap items-center gap-1.5">
          {index > 0 && (
            <button
              type="button"
              className={`${inputSm} px-2 font-medium`}
              onClick={() => onChange(buildRule(combinator === 'and' ? 'or' : 'and', conditions))}
              title="Toggle between requiring all conditions (AND) or any (OR)"
            >
              {combinator.toUpperCase()}
            </button>
          )}
          <ConditionEditor condition={condition} targets={targets} onChange={(c) => updateCondition(index, c)} />
          <button
            type="button"
            className="text-text-tertiary hover:text-danger"
            onClick={() => removeCondition(index)}
            aria-label="Remove condition"
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className={`${buttonGhost} w-fit`}
        onClick={() => onChange(buildRule(combinator, [...conditions, defaultCondition(targets)]))}
      >
        + Add condition
      </button>
    </div>
  );
}

function ConditionEditor({
  condition,
  targets,
  onChange,
}: {
  condition: FieldCondition;
  targets: VisibilityTarget[];
  onChange: (condition: FieldCondition) => void;
}) {
  const target = targets.find((t) => t.id === condition.fieldId) ?? targets[0]!;
  const ops = target.kind === 'checkbox' ? CHECKBOX_OPS : VALUE_OPS;

  function handleTargetChange(fieldId: string) {
    const nextTarget = targets.find((t) => t.id === fieldId) ?? targets[0]!;
    onChange(defaultCondition(targets, nextTarget));
  }

  return (
    <>
      <select
        className={selectStyle}
        value={target.id}
        onChange={(e) => handleTargetChange(e.target.value)}
      >
        {targets.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </select>
      <select
        className={selectStyle}
        value={condition.op}
        onChange={(e) => onChange({ ...condition, op: e.target.value as ConditionOp })}
      >
        {ops.map((op) => (
          <option key={op} value={op}>
            {OP_LABELS[op]}
          </option>
        ))}
      </select>
      {target.kind !== 'checkbox' && (
        <ValueInput condition={condition} target={target} onChange={onChange} />
      )}
    </>
  );
}

function ValueInput({
  condition,
  target,
  onChange,
}: {
  condition: FieldCondition;
  target: VisibilityTarget;
  onChange: (condition: FieldCondition) => void;
}) {
  const isMulti = condition.op === 'in' || condition.op === 'notIn';

  if (target.kind === 'dropdown' && target.options) {
    if (isMulti) {
      const selected = Array.isArray(condition.value) ? condition.value : [];
      return (
        <div className="flex flex-wrap gap-1">
          {target.options.map((option) => {
            const active = selected.includes(option.value);
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={active}
                className={`rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors ${
                  active ? 'border-accent bg-accent-soft text-accent' : 'border-border text-text-secondary hover:border-border-strong'
                }`}
                onClick={() =>
                  onChange({
                    ...condition,
                    value: active ? selected.filter((v) => v !== option.value) : [...selected, option.value],
                  })
                }
              >
                {option.label}
              </button>
            );
          })}
        </div>
      );
    }
    return (
      <select
        className={selectStyle}
        value={typeof condition.value === 'string' ? condition.value : ''}
        onChange={(e) => onChange({ ...condition, value: e.target.value })}
      >
        {target.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }

  if (isMulti) {
    const raw = Array.isArray(condition.value) ? condition.value.join(', ') : '';
    return (
      <input
        className={inputSm}
        placeholder="value1, value2"
        value={raw}
        onChange={(e) =>
          onChange({ ...condition, value: e.target.value.split(',').map((v) => v.trim()).filter(Boolean) })
        }
      />
    );
  }

  return (
    <input
      className={inputSm}
      placeholder="value"
      value={typeof condition.value === 'string' ? condition.value : ''}
      onChange={(e) => onChange({ ...condition, value: e.target.value })}
    />
  );
}

function defaultCondition(targets: VisibilityTarget[], target: VisibilityTarget = targets[0]!): FieldCondition {
  if (target.kind === 'checkbox') return { fieldId: target.id, op: 'isTrue' };
  const firstOption = target.options?.[0]?.value;
  return { fieldId: target.id, op: 'eq', value: firstOption ?? '' };
}

function conditionRule(condition: FieldCondition): VisibilityRule {
  return { kind: 'condition', condition };
}

function buildRule(combinator: 'and' | 'or', conditions: FieldCondition[]): VisibilityRule {
  if (conditions.length === 1) return conditionRule(conditions[0]!);
  return { kind: combinator, rules: conditions.map(conditionRule) };
}

/** Reads a VisibilityRule back into the flat { combinator, conditions } shape this editor
 * works with. A rule built outside this editor (hand-authored, deeper nesting) collapses to
 * its top-level conditions on a best-effort basis -- editing it here flattens it on save. */
function flatten(rule: VisibilityRule): { combinator: 'and' | 'or'; conditions: FieldCondition[] } {
  if (rule.kind === 'condition') return { combinator: 'and', conditions: [rule.condition] };
  if (rule.kind === 'and' || rule.kind === 'or') {
    const conditions = rule.rules.map((r) => (r.kind === 'condition' ? r.condition : flatten(r).conditions[0]!));
    return { combinator: rule.kind, conditions };
  }
  // 'not' -- not representable in the flat editor; drop to its inner condition, uninverted.
  return flatten(rule.rule);
}
