import type { FieldCondition, VisibilityRule } from './fieldConfig';

export type FieldValues = Record<string, string | boolean | undefined>;

function evaluateCondition(condition: FieldCondition, values: FieldValues): boolean {
  const actual = values[condition.fieldId];
  switch (condition.op) {
    case 'isTrue':
      return actual === true;
    case 'isFalse':
      return actual !== true;
    case 'eq':
      return actual === condition.value;
    case 'neq':
      return actual !== condition.value;
    case 'in':
      return Array.isArray(condition.value) && typeof actual === 'string' && condition.value.includes(actual);
    case 'notIn':
      return !(Array.isArray(condition.value) && typeof actual === 'string' && condition.value.includes(actual));
  }
}

/**
 * No rule = always visible. Used identically client-side (live form preview) and
 * server-side (createTicket() re-validates from the submitted values, never trusting
 * client-declared visibility) -- see docs/ticket-group-custom-fields-plan.md.
 */
export function evaluateVisibility(rule: VisibilityRule | undefined, values: FieldValues): boolean {
  if (!rule) return true;
  switch (rule.kind) {
    case 'condition':
      return evaluateCondition(rule.condition, values);
    case 'and':
      return rule.rules.every((r) => evaluateVisibility(r, values));
    case 'or':
      return rule.rules.some((r) => evaluateVisibility(r, values));
    case 'not':
      return !evaluateVisibility(rule.rule, values);
  }
}
