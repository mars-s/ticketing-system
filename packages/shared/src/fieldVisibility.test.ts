import { describe, expect, it } from 'vitest';
import { evaluateVisibility } from './fieldVisibility';
import type { VisibilityRule } from './fieldConfig';

describe('evaluateVisibility', () => {
  it('is visible when there is no rule', () => {
    expect(evaluateVisibility(undefined, {})).toBe(true);
  });

  it('evaluates isTrue/isFalse against a checkbox value', () => {
    const isTrue: VisibilityRule = { kind: 'condition', condition: { fieldId: 'wants-callback', op: 'isTrue' } };
    expect(evaluateVisibility(isTrue, { 'wants-callback': true })).toBe(true);
    expect(evaluateVisibility(isTrue, { 'wants-callback': false })).toBe(false);
    expect(evaluateVisibility(isTrue, {})).toBe(false);

    const isFalse: VisibilityRule = { kind: 'condition', condition: { fieldId: 'wants-callback', op: 'isFalse' } };
    expect(evaluateVisibility(isFalse, { 'wants-callback': false })).toBe(true);
    expect(evaluateVisibility(isFalse, {})).toBe(true);
  });

  it('evaluates eq/neq against a dropdown value', () => {
    const rule: VisibilityRule = { kind: 'condition', condition: { fieldId: 'category', op: 'eq', value: 'a' } };
    expect(evaluateVisibility(rule, { category: 'a' })).toBe(true);
    expect(evaluateVisibility(rule, { category: 'b' })).toBe(false);

    const neq: VisibilityRule = { kind: 'condition', condition: { fieldId: 'category', op: 'neq', value: 'a' } };
    expect(evaluateVisibility(neq, { category: 'b' })).toBe(true);
  });

  it('evaluates in/notIn against a set of dropdown values', () => {
    const inRule: VisibilityRule = {
      kind: 'condition',
      condition: { fieldId: 'category', op: 'in', value: ['a', 'c'] },
    };
    expect(evaluateVisibility(inRule, { category: 'a' })).toBe(true);
    expect(evaluateVisibility(inRule, { category: 'b' })).toBe(false);

    const notInRule: VisibilityRule = {
      kind: 'condition',
      condition: { fieldId: 'category', op: 'notIn', value: ['a', 'c'] },
    };
    expect(evaluateVisibility(notInRule, { category: 'b' })).toBe(true);
    expect(evaluateVisibility(notInRule, { category: 'a' })).toBe(false);
  });

  it('combines conditions with and/or/not', () => {
    const rule: VisibilityRule = {
      kind: 'and',
      rules: [
        { kind: 'condition', condition: { fieldId: 'category', op: 'eq', value: 'c' } },
        {
          kind: 'or',
          rules: [
            { kind: 'condition', condition: { fieldId: 'urgent', op: 'isTrue' } },
            { kind: 'condition', condition: { fieldId: 'priority', op: 'eq', value: 'high' } },
          ],
        },
      ],
    };
    expect(evaluateVisibility(rule, { category: 'c', urgent: true })).toBe(true);
    expect(evaluateVisibility(rule, { category: 'c', priority: 'high' })).toBe(true);
    expect(evaluateVisibility(rule, { category: 'c', urgent: false, priority: 'low' })).toBe(false);
    expect(evaluateVisibility(rule, { category: 'b', urgent: true })).toBe(false);

    const not: VisibilityRule = {
      kind: 'not',
      rule: { kind: 'condition', condition: { fieldId: 'category', op: 'eq', value: 'c' } },
    };
    expect(evaluateVisibility(not, { category: 'c' })).toBe(false);
    expect(evaluateVisibility(not, { category: 'b' })).toBe(true);
  });

  it('reproduces the a/b/c dropdown example: a shows fieldA, b shows fieldB, c shows both', () => {
    const showsA: VisibilityRule = { kind: 'condition', condition: { fieldId: 'category', op: 'in', value: ['a', 'c'] } };
    const showsB: VisibilityRule = { kind: 'condition', condition: { fieldId: 'category', op: 'in', value: ['b', 'c'] } };

    expect(evaluateVisibility(showsA, { category: 'a' })).toBe(true);
    expect(evaluateVisibility(showsB, { category: 'a' })).toBe(false);

    expect(evaluateVisibility(showsA, { category: 'b' })).toBe(false);
    expect(evaluateVisibility(showsB, { category: 'b' })).toBe(true);

    expect(evaluateVisibility(showsA, { category: 'c' })).toBe(true);
    expect(evaluateVisibility(showsB, { category: 'c' })).toBe(true);
  });
});
