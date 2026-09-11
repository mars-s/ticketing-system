import { describe, expect, it } from 'vitest';
import { groupFormConfigSchema } from './fieldConfig';

describe('groupFormConfigSchema', () => {
  it('accepts the empty/default config', () => {
    expect(groupFormConfigSchema.parse({})).toEqual({ standardFields: {}, customFields: [] });
  });

  it('accepts a hidden standard field that carries a default value', () => {
    const result = groupFormConfigSchema.parse({
      standardFields: { priority: { shown: false, required: false, defaultValue: 'high' } },
    });
    expect(result.standardFields.priority?.defaultValue).toBe('high');
  });

  it('rejects a hidden description/priority/type field with no default value', () => {
    expect(() =>
      groupFormConfigSchema.parse({ standardFields: { priority: { shown: false, required: false } } }),
    ).toThrow();
  });

  it('does not require a default value for a hidden cc/attachments field', () => {
    expect(() =>
      groupFormConfigSchema.parse({ standardFields: { cc: { shown: false, required: false } } }),
    ).not.toThrow();
  });

  it('rejects a dropdown whose default value is not one of its options', () => {
    expect(() =>
      groupFormConfigSchema.parse({
        customFields: [
          {
            id: 'category',
            kind: 'dropdown',
            label: 'Category',
            required: true,
            options: [{ value: 'a', label: 'A' }],
            defaultValue: 'not-an-option',
          },
        ],
      }),
    ).toThrow();
  });

  it('rejects a dropdown with no options', () => {
    expect(() =>
      groupFormConfigSchema.parse({
        customFields: [
          { id: 'category', kind: 'dropdown', label: 'Category', required: true, options: [], defaultValue: 'a' },
        ],
      }),
    ).toThrow();
  });

  it('rejects duplicate custom field ids', () => {
    expect(() =>
      groupFormConfigSchema.parse({
        customFields: [
          { id: 'phone', kind: 'text', label: 'Phone', required: false },
          { id: 'phone', kind: 'text', label: 'Phone again', required: false },
        ],
      }),
    ).toThrow();
  });

  it('accepts a visibility rule referencing an earlier custom field', () => {
    expect(() =>
      groupFormConfigSchema.parse({
        customFields: [
          { id: 'ticket-a', kind: 'checkbox', label: 'Type a ticket', required: false },
          {
            id: 'ticket-a-text',
            kind: 'text',
            label: 'Ticket details',
            required: true,
            visibility: { kind: 'condition', condition: { fieldId: 'ticket-a', op: 'isTrue' } },
          },
        ],
      }),
    ).not.toThrow();
  });

  it('rejects a visibility rule referencing a later or unknown custom field', () => {
    expect(() =>
      groupFormConfigSchema.parse({
        customFields: [
          {
            id: 'first',
            kind: 'text',
            label: 'First',
            required: false,
            visibility: { kind: 'condition', condition: { fieldId: 'second', op: 'eq', value: 'x' } },
          },
          { id: 'second', kind: 'text', label: 'Second', required: false },
        ],
      }),
    ).toThrow();

    expect(() =>
      groupFormConfigSchema.parse({
        customFields: [
          {
            id: 'first',
            kind: 'text',
            label: 'First',
            required: false,
            visibility: { kind: 'condition', condition: { fieldId: 'nonexistent', op: 'eq', value: 'x' } },
          },
        ],
      }),
    ).toThrow();
  });

  it('accepts a visibility rule referencing the standard priority/type fields', () => {
    expect(() =>
      groupFormConfigSchema.parse({
        customFields: [
          {
            id: 'urgent-note',
            kind: 'text',
            label: 'Urgent note',
            required: false,
            visibility: { kind: 'condition', condition: { fieldId: 'priority', op: 'eq', value: 'urgent' } },
          },
        ],
      }),
    ).not.toThrow();
  });
});
