import { z } from 'zod';

/**
 * A TicketGroup's customizable create-ticket form. `title` and the group picker
 * ("Send to") are intentionally NOT configurable here -- every group's form always
 * shows and requires them, enforced by their absence from this shape rather than by
 * a runtime check. See docs/ticket-group-custom-fields-plan.md.
 */
export const STANDARD_FIELD_KEYS = ['description', 'priority', 'type', 'cc', 'attachments'] as const;
export type StandardFieldKey = (typeof STANDARD_FIELD_KEYS)[number];

/** Standard fields whose removal (shown: false) still needs a real value on the ticket,
 * so they require a configured `defaultValue`. `cc` and `attachments` are fine left empty. */
const STANDARD_FIELDS_REQUIRING_DEFAULT: readonly StandardFieldKey[] = ['description', 'priority', 'type'];

export const CUSTOM_FIELD_KINDS = ['text', 'textarea', 'email', 'phone', 'number', 'checkbox', 'dropdown'] as const;
export type CustomFieldKind = (typeof CUSTOM_FIELD_KINDS)[number];

export const CONDITION_OPS = ['eq', 'neq', 'in', 'notIn', 'isTrue', 'isFalse'] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

export interface FieldCondition {
  /** A StandardFieldKey that can carry a value ('priority' | 'type') or an earlier
   * custom field's id. Enforced by groupFormConfigSchema, not by this type. */
  fieldId: string;
  op: ConditionOp;
  value?: string | string[];
}

export type VisibilityRule =
  | { kind: 'condition'; condition: FieldCondition }
  | { kind: 'and'; rules: VisibilityRule[] }
  | { kind: 'or'; rules: VisibilityRule[] }
  | { kind: 'not'; rule: VisibilityRule };

export interface StandardFieldConfig {
  shown: boolean;
  /** Only meaningful when shown === true. */
  required: boolean;
  /** Required when shown === false for description/priority/type. */
  defaultValue?: string;
}

interface CustomFieldBase {
  id: string;
  label: string;
  required: boolean;
  placeholder?: string;
  /** References only standard fields or custom fields strictly earlier in the
   * group's customFields array -- guarantees single-pass evaluation, no cycles. */
  visibility?: VisibilityRule;
}

export type CustomFieldDef =
  | (CustomFieldBase & { kind: 'text' | 'textarea' | 'email' | 'phone' | 'number' })
  | (CustomFieldBase & { kind: 'checkbox' })
  | (CustomFieldBase & {
      kind: 'dropdown';
      required: true;
      options: { value: string; label: string }[];
      /** Must be one of options[].value. A dropdown is never left unselected. */
      defaultValue: string;
    });

export interface GroupFormConfig {
  standardFields: Partial<Record<StandardFieldKey, StandardFieldConfig>>;
  customFields: CustomFieldDef[];
}

export const DEFAULT_GROUP_FORM_CONFIG: GroupFormConfig = { standardFields: {}, customFields: [] };

// ---------------------------------------------------------------------------
// Zod validation
// ---------------------------------------------------------------------------

const fieldConditionSchema: z.ZodType<FieldCondition> = z.object({
  fieldId: z.string().min(1),
  op: z.enum(CONDITION_OPS),
  value: z.union([z.string(), z.array(z.string())]).optional(),
});

const visibilityRuleSchema: z.ZodType<VisibilityRule> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('condition'), condition: fieldConditionSchema }),
    z.object({ kind: z.literal('and'), rules: z.array(visibilityRuleSchema).min(1) }),
    z.object({ kind: z.literal('or'), rules: z.array(visibilityRuleSchema).min(1) }),
    z.object({ kind: z.literal('not'), rule: visibilityRuleSchema }),
  ]),
);

const FIELD_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

const standardFieldConfigSchema = z.object({
  shown: z.boolean(),
  required: z.boolean(),
  defaultValue: z.string().max(4000).optional(),
});

const customFieldBaseSchema = {
  id: z.string().min(1).max(60).regex(FIELD_ID_PATTERN, 'Field id must be lowercase, digits, and hyphens'),
  label: z.string().min(1).max(120),
  required: z.boolean(),
  placeholder: z.string().max(200).optional(),
  visibility: visibilityRuleSchema.optional(),
};

const customFieldSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.enum(['text', 'textarea', 'email', 'phone', 'number']), ...customFieldBaseSchema }),
  z.object({ kind: z.literal('checkbox'), ...customFieldBaseSchema }),
  z.object({
    kind: z.literal('dropdown'),
    ...customFieldBaseSchema,
    required: z.literal(true),
    options: z
      .array(z.object({ value: z.string().min(1).max(100), label: z.string().min(1).max(120) }))
      .min(1, 'A dropdown needs at least one option'),
    defaultValue: z.string().min(1),
  }),
]);

/** Every fieldId a rule references, recursively. */
function referencedFieldIds(rule: VisibilityRule): string[] {
  switch (rule.kind) {
    case 'condition':
      return [rule.condition.fieldId];
    case 'not':
      return referencedFieldIds(rule.rule);
    case 'and':
    case 'or':
      return rule.rules.flatMap(referencedFieldIds);
  }
}

const VALUE_BEARING_STANDARD_FIELDS: readonly string[] = ['priority', 'type'];

export const groupFormConfigSchema = z
  .object({
    standardFields: z.record(z.enum(STANDARD_FIELD_KEYS), standardFieldConfigSchema).default({}),
    customFields: z.array(customFieldSchema).default([]),
  })
  .superRefine((config, ctx) => {
    for (const key of STANDARD_FIELDS_REQUIRING_DEFAULT) {
      const field = config.standardFields[key];
      if (field && !field.shown && !field.defaultValue) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `"${key}" is hidden but has no default value -- tickets still need one`,
          path: ['standardFields', key, 'defaultValue'],
        });
      }
    }

    const seenIds = new Set<string>();
    config.customFields.forEach((field, index) => {
      if (seenIds.has(field.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate field id "${field.id}"`,
          path: ['customFields', index, 'id'],
        });
      }
      seenIds.add(field.id);

      if (field.kind === 'dropdown' && !field.options.some((o) => o.value === field.defaultValue)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Default value must be one of the dropdown options',
          path: ['customFields', index, 'defaultValue'],
        });
      }

      if (!field.visibility) return;
      const earlierIds = new Set(config.customFields.slice(0, index).map((f) => f.id));
      for (const refId of referencedFieldIds(field.visibility)) {
        if (VALUE_BEARING_STANDARD_FIELDS.includes(refId) || earlierIds.has(refId)) continue;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Visibility rule references "${refId}", which must be "priority", "type", or an earlier custom field`,
          path: ['customFields', index, 'visibility'],
        });
      }
    });
  });

export type GroupFormConfigInput = z.infer<typeof groupFormConfigSchema>;
