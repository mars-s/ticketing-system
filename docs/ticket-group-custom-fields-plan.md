**Status: implemented** (2026-09-11). All 10 rollout steps below are done, including tests.
Integration tests (`*.integration.test.ts`) need a running Postgres (`docker-compose up postgres`)
to execute — not available in this sandbox, so they're written but unrun here; run
`pnpm test:integration` (`scripts/test-integration.sh`) once DB is up. Also apply the new
migration (`packages/db/prisma/migrations/20260911000000_group_form_config`) via
`pnpm --filter db migrate:dev` / `migrate deploy`.

# Plan: group-configurable ticket-create fields

Goal: let each `TicketGroup` define its own create-ticket form — hide/require the
standard fields, add custom fields, and show/hide custom fields conditionally
based on other field values (checkbox, dropdown, etc). Group members edit their
own group's field config; admins edit any group's. `title` and `groupId`
("Department") always stay on the form, directly below `title`, and always required.

## 1. Data model

```prisma
model TicketGroup {
  // ...existing fields unchanged...
  /// Null = default form (all standard fields shown, no custom fields).
  /// Validated shape: GroupFormConfig (packages/shared/src/fieldConfig.ts).
  formConfig Json?
}

model Ticket {
  // ...existing fields unchanged...
  /// Answers to the group's custom fields at creation time, keyed by field id.
  /// Only fields visible per the group's rules at submit time are stored.
  customFieldValues Json?
}
```

Migration is additive/forward-only (both columns nullable, no backfill,
no `migrate reset` — see [[feedback_prod_migrations_no_wipe]]).

## 2. Shared config shape (`packages/shared/src/fieldConfig.ts`)

```ts
export type StandardFieldKey = 'description' | 'priority' | 'type' | 'cc' | 'attachments';
// title and groupId are NOT configurable -- always shown, always required.

export interface StandardFieldConfig {
  shown: boolean;
  required: boolean; // ignored (forced true) while shown === true is not guaranteed;
                      // only meaningful when shown === true
  /** Required when shown === false for description/priority/type (ticket still
   *  needs a real value). Not needed for cc/attachments (default = empty). */
  defaultValue?: string;
}

export type ConditionOp = 'eq' | 'neq' | 'in' | 'notIn' | 'isTrue' | 'isFalse';

export interface FieldCondition {
  /** Must be a StandardFieldKey ('priority' | 'type') or an earlier custom field's id. */
  fieldId: string;
  op: ConditionOp;
  value?: string | string[]; // omitted for isTrue/isFalse
}

export type VisibilityRule =
  | { kind: 'condition'; condition: FieldCondition }
  | { kind: 'and'; rules: VisibilityRule[] }
  | { kind: 'or'; rules: VisibilityRule[] }
  | { kind: 'not'; rule: VisibilityRule };

interface CustomFieldBase {
  id: string;        // slug, unique within the group, generated on add
  label: string;
  required: boolean;
  /** References only standard fields or custom fields earlier in the array
   *  (enforced at save time) -- guarantees single-pass evaluation, no cycles. */
  visibility?: VisibilityRule;
}

export type CustomFieldDef =
  | (CustomFieldBase & { kind: 'text' | 'textarea' | 'email' | 'phone' | 'number' })
  | (CustomFieldBase & { kind: 'checkbox' })
  | (CustomFieldBase & {
      kind: 'dropdown';
      required: true; // dropdowns are always required
      options: { value: string; label: string }[];
      defaultValue: string; // must be one of options[].value; never left unselected
    });

export interface GroupFormConfig {
  standardFields: Partial<Record<StandardFieldKey, StandardFieldConfig>>; // missing key = shown, no override
  customFields: CustomFieldDef[];
}
```

`groupFormConfigSchema` (zod, `superRefine`) enforces:
- custom field ids unique/slug-shaped
- dropdown `defaultValue` ∈ its own `options`
- `standardFields.description/priority/type` with `shown: false` must carry a `defaultValue`
- every `FieldCondition.fieldId` is `'priority' | 'type'` or the id of a *strictly earlier* custom field
- `and`/`or` non-empty, `not` well-formed

## 3. Visibility evaluator (`packages/shared/src/fieldVisibility.ts`)

One pure function, imported by both the client form and `createTicket()` server-side
so preview and validation can never drift:

```ts
export function evaluateVisibility(
  rule: VisibilityRule | undefined,
  values: Record<string, string | boolean | undefined>,
): boolean
```

Server-side rule: **never trust client-declared visibility.** On submit, re-evaluate
every custom field's visibility from the submitted standard+custom values; any field
that evaluates hidden has its submitted value discarded (not stored), any field that
evaluates visible must satisfy `required`.

## 4. Permissions

- Admins: edit everything on a group (name, Authentik links, channels, formConfig) — existing `requireAdmin()` gate, unchanged.
- Group members: may edit **only** `formConfig` on their own group(s). New helper:
  `isTicketGroupMember(userId, groupId)` in `server/ticketGroups.ts`.
- New route `PATCH /api/ticket-groups/[id]/form-config`:
  - `requireSession()`, then `session.user.role === 'admin' || await isTicketGroupMember(session.user.id, id)`, else 403.
  - body `{ formConfig: GroupFormConfig | null }` — `null` is the **"Reset to default"** action.
  - `updateTicketGroupFormConfig(groupId, formConfig, actorId)`: validate via `groupFormConfigSchema.nullable()`, `prisma.ticketGroup.update`, `writeAuditLog(actorId, 'ticket_group.form_config_update', ...)`.
- Existing `PUT /api/ticket-groups/[id]` stays admin-only; extend `ticketGroupSchema` to optionally accept `formConfig` too, so admins can also set it from the main group editor.
- `GET /api/ticket-groups` (any signed-in user) already returns full group rows — `formConfig` rides along for free, so the create-ticket form gets every group's config in one fetch.

## 5. `createTicket()` changes (`server/tickets.ts`)

`createTicketSchema` gains `customFieldValues: z.record(z.string(), z.union([z.string(), z.boolean()])).optional()`.

When `input.groupId` is set and the group has a non-null `formConfig`:
1. For each `standardFields[key]` with `shown === false` (description/priority/type): ignore whatever the client sent for that field, use `defaultValue` from config instead.
2. Re-run `evaluateVisibility` server-side for every custom field using the *effective* standard-field values (post-default) + submitted custom values.
3. Visible + required field missing → `AppError`. Dropdown value not in `options` → `AppError`.
4. Hidden field's submitted value is dropped, never written.
5. Persist the surviving `{fieldId: value}` map to `Ticket.customFieldValues`.

When `groupId` is null (the existing "unsure → admins" path) or the group's `formConfig` is null: behavior is exactly what exists today, untouched.

## 6. Create-ticket UI (`NewTicketForm.tsx`)

- Groups fetch already happens; each group now carries `formConfig`.
- On `groupId` change, resolve `config = selectedGroup?.formConfig ?? DEFAULT_CONFIG` (`DEFAULT_CONFIG` = all standard fields shown, no custom fields) and reset any previously-entered custom field values.
- Render order becomes: **Title** (always) → **Department** (always) → Description (if shown) → Priority/Type row (each if shown) → *Additional details* block (custom fields, only once a group is picked, in config array order, each gated by `evaluateVisibility(field.visibility, liveFormValues)`) → CC (if shown) → Attachments (if shown).
- One field-kind renderer per `CustomFieldDef.kind` (`TextField`, `TextareaField`, `CheckboxField`, `DropdownField`), each controlled off a single `customFieldValues` state object keyed by field id, defaults pre-filled for dropdowns.
- Submit sends `customFieldValues` alongside the existing payload; only currently-visible fields are included (mirrors server-side drop, avoids sending stale hidden answers).

## 7. Group field-config editor (new)

New component `TicketGroupFieldsEditor.tsx`:
- Standard-field toggles: shown/required checkboxes per key; a default-value input appears only when `shown` is turned off for description/priority/type.
- Custom field builder: add/remove/reorder; per field — kind select, label, required toggle (locked **on** and hidden for `dropdown`), options editor + default-option picker for `dropdown`, a visibility-rule builder (AND/OR/NOT tree) that can only reference standard fields or **earlier** custom fields in the list (dropdown of valid targets, so cycles are structurally impossible).
- Live preview pane reusing the same field renderers + `evaluateVisibility` as `NewTicketForm`, so editors see exactly what requesters will see.
- **"Reset to default"** button → `PATCH` with `{ formConfig: null }`.
- Save → `PATCH .../form-config`.

Reachable two ways:
- Admins: "Edit fields →" link added to each row in `TicketGroupsManager.tsx` (existing `/admin/ticket-groups` page).
- Group members: new page `/groups/[id]/fields`, gated server-side by `isTicketGroupMember` OR admin (redirect otherwise); linked from a new "My groups" entry in `AppHeader` populated via `listTicketGroupsForUser(session.user.id)` (already exists in `server/ticketGroups.ts`).

## 8. Ticket detail page

Render `customFieldValues` as label:value pairs, resolving labels from the group's
*current* `formConfig` (not a snapshot). If a field id from an old ticket no longer
exists in the live config (renamed/removed since), fall back to showing the raw id.
This tradeoff (labels can drift after the fact) is called out explicitly rather than
solved with config snapshotting, to keep the model simple — revisit only if it proves
confusing in practice.

## 9. Tests

- `packages/shared`: `fieldVisibility` evaluator (and/or/not/condition × eq/neq/in/notIn/isTrue/isFalse); `groupFormConfigSchema` (dropdown default-in-options, hidden-standard-field-needs-default, forward-reference-only visibility rules, duplicate id rejection).
- `server/tickets.test`: group defaults applied for hidden standard fields; missing required visible custom field rejected; hidden field's client-sent value silently dropped even when the client claims it's visible; invalid dropdown value rejected; `groupId: null` path fully unchanged.
- `server/ticketGroups.test`: non-member/non-admin gets 403 on `PATCH .../form-config`; member can edit own group only; admin can edit any group; reset-to-default clears to `null`.
- Playwright: pick a group with a checkbox-gated field and a dropdown-gated field → toggle/select → field appears/disappears live → submit → ticket detail shows the stored value.

## 10. Rollout order

1. Migration (`formConfig`, `customFieldValues` columns).
2. `packages/shared`: types, `groupFormConfigSchema`, `evaluateVisibility`, schema/evaluator unit tests.
3. `server/ticketGroups.ts`: `isTicketGroupMember`, `updateTicketGroupFormConfig`; `PATCH /api/ticket-groups/[id]/form-config`.
4. `server/tickets.ts`: `createTicket()` server-side validation/default-application; tests.
5. `NewTicketForm.tsx` rework (dynamic rendering + live visibility).
6. `TicketGroupFieldsEditor.tsx` + admin link + `/groups/[id]/fields` member page + `AppHeader` "My groups" entry.
7. Ticket detail page rendering of `customFieldValues`.
8. Playwright e2e pass.
