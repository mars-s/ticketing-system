'use client';

import { useState } from 'react';
import {
  DEFAULT_GROUP_FORM_CONFIG,
  STANDARD_FIELD_KEYS,
  TICKET_PRIORITIES,
  TICKET_TYPES,
  type CustomFieldDef,
  type CustomFieldKind,
  type GroupFormConfig,
  type StandardFieldConfig,
  type StandardFieldKey,
} from '@ticketing/shared';
import {
  buttonGhost,
  buttonPrimary,
  buttonSecondary,
  card,
  errorText,
  input,
  label as labelClass,
  labelInline,
  mutedText,
  select as selectStyle,
} from '@/lib/styles';
import { CustomFieldEditor, newCustomField } from '@/components/CustomFieldEditor';
import type { VisibilityTarget } from '@/components/VisibilityRuleEditor';
import { DynamicTicketFields, type CustomFieldValues } from '@/components/DynamicTicketFields';

const STANDARD_FIELD_LABELS: Record<StandardFieldKey, string> = {
  description: 'Description',
  priority: 'Priority',
  type: 'Type',
  cc: 'CC',
  attachments: 'Attachments',
};

/** description/priority/type need a real default value when hidden (the ticket still
 * needs one); cc/attachments are fine left empty -- mirrors groupFormConfigSchema. */
const NEEDS_DEFAULT_WHEN_HIDDEN: readonly StandardFieldKey[] = ['description', 'priority', 'type'];

function defaultStandardConfig(): StandardFieldConfig {
  return { shown: true, required: true };
}

/** Pulls the actual Zod validation message out of handleApiError's
 * `{ error: 'Invalid request', details: ZodError['flatten'] }` body -- superRefine issues
 * on nested paths (e.g. customFields[0].defaultValue) land in `formErrors`, not
 * `fieldErrors`, so both need checking. Falls back to the generic `error` string. */
function errorMessageFromResponse(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const { error, details } = body as { error?: string; details?: { formErrors?: string[]; fieldErrors?: Record<string, string[]> } };
  const formErrors = details?.formErrors ?? [];
  const fieldErrors = Object.values(details?.fieldErrors ?? {}).flat();
  const messages = [...formErrors, ...fieldErrors];
  if (messages.length > 0) return messages.join('; ');
  return error ?? null;
}

interface TicketGroupFieldsEditorProps {
  groupId: string;
  groupName: string;
  initialFormConfig: GroupFormConfig | null;
}

export function TicketGroupFieldsEditor({ groupId, groupName, initialFormConfig }: TicketGroupFieldsEditorProps) {
  const [formConfig, setFormConfig] = useState<GroupFormConfig>(initialFormConfig ?? DEFAULT_GROUP_FORM_CONFIG);
  const [previewValues, setPreviewValues] = useState<CustomFieldValues>({});
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  function standardConfig(key: StandardFieldKey): StandardFieldConfig {
    return formConfig.standardFields[key] ?? defaultStandardConfig();
  }

  function updateStandard(key: StandardFieldKey, patch: Partial<StandardFieldConfig>) {
    setFormConfig((prev) => ({
      ...prev,
      standardFields: { ...prev.standardFields, [key]: { ...standardConfig(key), ...patch } },
    }));
  }

  function addCustomField(kind: CustomFieldKind) {
    const field = newCustomField(kind, formConfig.customFields.map((f) => f.id));
    setFormConfig((prev) => ({ ...prev, customFields: [...prev.customFields, field] }));
  }

  function updateCustomField(index: number, field: CustomFieldDef) {
    setFormConfig((prev) => ({
      ...prev,
      customFields: prev.customFields.map((f, i) => (i === index ? field : f)),
    }));
  }

  function removeCustomField(index: number) {
    const removedId = formConfig.customFields[index]?.id;
    setFormConfig((prev) => ({
      ...prev,
      // Drop the field and any visibility rule elsewhere that referenced it -- otherwise
      // save would fail validation on a dangling reference.
      customFields: prev.customFields
        .filter((_, i) => i !== index)
        .map((f) => (f.visibility && referencesField(f.visibility, removedId) ? { ...f, visibility: undefined } : f)),
    }));
  }

  function moveCustomField(index: number, direction: 'up' | 'down') {
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    setFormConfig((prev) => {
      const fields = [...prev.customFields];
      const [moved] = fields.splice(index, 1);
      if (!moved) return prev;
      fields.splice(targetIndex, 0, moved);
      // A field can only be conditioned on an earlier one -- reordering past a field it
      // depends on (or that depends on it) would create a forward reference, so drop
      // visibility rules that no longer point strictly backward.
      const idIndex = new Map(fields.map((f, i) => [f.id, i]));
      return {
        ...prev,
        customFields: fields.map((f, i) =>
          f.visibility && !visibilityRefersOnlyBefore(f.visibility, i, idIndex) ? { ...f, visibility: undefined } : f,
        ),
      };
    });
  }

  async function handleSave() {
    setIsSaving(true);
    setError(null);
    const res = await fetch(`/api/ticket-groups/${groupId}/form-config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ formConfig }),
    });
    setIsSaving(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(errorMessageFromResponse(body) ?? 'Failed to save');
      return;
    }
    setSavedAt(new Date());
  }

  async function handleResetToDefault() {
    setIsSaving(true);
    setError(null);
    const res = await fetch(`/api/ticket-groups/${groupId}/form-config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ formConfig: null }),
    });
    setIsSaving(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(errorMessageFromResponse(body) ?? 'Failed to reset');
      return;
    }
    setFormConfig(DEFAULT_GROUP_FORM_CONFIG);
    setSavedAt(new Date());
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-sm font-semibold text-text">Create-ticket form for &ldquo;{groupName}&rdquo;</h2>
        <button type="button" className={buttonSecondary} onClick={handleResetToDefault} disabled={isSaving}>
          Reset to default
        </button>
      </div>

      <section className={`${card} flex flex-col gap-3`}>
        <h3 className="text-sm font-semibold text-text">Standard fields</h3>
        <p className={mutedText}>Title and &ldquo;Department&rdquo; always appear and are always required, directly below Title.</p>
        {STANDARD_FIELD_KEYS.map((key) => {
          const cfg = standardConfig(key);
          const needsDefault = NEEDS_DEFAULT_WHEN_HIDDEN.includes(key);
          return (
            <div key={key} className="flex flex-wrap items-center gap-3 border-t border-border pt-3 first:border-t-0 first:pt-0">
              <span className="w-28 shrink-0 text-sm font-medium text-text">{STANDARD_FIELD_LABELS[key]}</span>
              <label className={labelInline}>
                <input
                  type="checkbox"
                  checked={cfg.shown}
                  onChange={(e) => updateStandard(key, { shown: e.target.checked })}
                  className="h-4 w-4 rounded border-border accent-accent"
                />
                Shown
              </label>
              {cfg.shown && (
                <label className={labelInline}>
                  <input
                    type="checkbox"
                    checked={cfg.required}
                    onChange={(e) => updateStandard(key, { required: e.target.checked })}
                    className="h-4 w-4 rounded border-border accent-accent"
                  />
                  Required
                </label>
              )}
              {!cfg.shown && needsDefault && (
                <StandardFieldDefaultInput
                  fieldKey={key}
                  value={cfg.defaultValue ?? ''}
                  onChange={(defaultValue) => updateStandard(key, { defaultValue })}
                />
              )}
            </div>
          );
        })}
      </section>

      <section className={`${card} flex flex-col gap-3`}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text">Custom fields</h3>
          <AddFieldMenu onAdd={addCustomField} />
        </div>
        {formConfig.customFields.length === 0 && <p className={mutedText}>No custom fields yet.</p>}
        {formConfig.customFields.map((field, index) => (
          <CustomFieldEditor
            key={field.id}
            field={field}
            visibilityTargets={earlierTargets(formConfig.customFields, index)}
            canMoveUp={index > 0}
            canMoveDown={index < formConfig.customFields.length - 1}
            onChange={(next) => updateCustomField(index, next)}
            onRemove={() => removeCustomField(index)}
            onMove={(direction) => moveCustomField(index, direction)}
          />
        ))}
      </section>

      <section className={`${card} flex flex-col gap-3`}>
        <h3 className="text-sm font-semibold text-text">Live preview</h3>
        <p className={mutedText}>What a requester sees once they pick &ldquo;{groupName}&rdquo; as the destination.</p>
        <DynamicTicketFields
          fields={formConfig.customFields}
          values={previewValues}
          standardValues={{ priority: 'normal', type: 'other' }}
          onChange={(id, value) => setPreviewValues((prev) => ({ ...prev, [id]: value }))}
        />
      </section>

      <div className="flex items-center gap-3">
        <button type="button" className={buttonPrimary} onClick={handleSave} disabled={isSaving}>
          {isSaving ? 'Saving…' : 'Save changes'}
        </button>
        {savedAt && <span className={mutedText}>Saved</span>}
        {error && <p className={errorText}>{error}</p>}
      </div>
    </div>
  );
}

function earlierTargets(fields: CustomFieldDef[], index: number): VisibilityTarget[] {
  const standard: VisibilityTarget[] = [
    { id: 'priority', label: 'Priority', kind: 'dropdown', options: TICKET_PRIORITIES.map((p) => ({ value: p, label: p })) },
    { id: 'type', label: 'Type', kind: 'dropdown', options: TICKET_TYPES.map((t) => ({ value: t, label: t })) },
  ];
  const earlierCustom: VisibilityTarget[] = fields.slice(0, index).map((f) => ({
    id: f.id,
    label: f.label,
    kind: f.kind === 'checkbox' ? 'checkbox' : f.kind === 'dropdown' ? 'dropdown' : 'value',
    options: f.kind === 'dropdown' ? f.options : undefined,
  }));
  return [...standard, ...earlierCustom];
}

function referencesField(rule: NonNullable<CustomFieldDef['visibility']>, fieldId: string | undefined): boolean {
  if (!fieldId) return false;
  if (rule.kind === 'condition') return rule.condition.fieldId === fieldId;
  if (rule.kind === 'not') return referencesField(rule.rule, fieldId);
  return rule.rules.some((r) => referencesField(r, fieldId));
}

function visibilityRefersOnlyBefore(
  rule: NonNullable<CustomFieldDef['visibility']>,
  index: number,
  idIndex: Map<string, number>,
): boolean {
  if (rule.kind === 'condition') {
    if (rule.condition.fieldId === 'priority' || rule.condition.fieldId === 'type') return true;
    const refIndex = idIndex.get(rule.condition.fieldId);
    return refIndex !== undefined && refIndex < index;
  }
  if (rule.kind === 'not') return visibilityRefersOnlyBefore(rule.rule, index, idIndex);
  return rule.rules.every((r) => visibilityRefersOnlyBefore(r, index, idIndex));
}

function StandardFieldDefaultInput({
  fieldKey,
  value,
  onChange,
}: {
  fieldKey: StandardFieldKey;
  value: string;
  onChange: (value: string) => void;
}) {
  if (fieldKey === 'priority') {
    return (
      <label className={labelClass}>
        Default value
        <select className={selectStyle} value={value || TICKET_PRIORITIES[0]} onChange={(e) => onChange(e.target.value)}>
          {TICKET_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (fieldKey === 'type') {
    return (
      <label className={labelClass}>
        Default value
        <select className={selectStyle} value={value || TICKET_TYPES[0]} onChange={(e) => onChange(e.target.value)}>
          {TICKET_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label className={`${labelClass} flex-1`}>
      Default value (used since requesters won&apos;t be asked)
      <input className={input} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function AddFieldMenu({ onAdd }: { onAdd: (kind: CustomFieldKind) => void }) {
  const [kind, setKind] = useState<CustomFieldKind>('text');
  const KIND_OPTIONS: { value: CustomFieldKind; label: string }[] = [
    { value: 'text', label: 'Text' },
    { value: 'textarea', label: 'Long text' },
    { value: 'email', label: 'Email' },
    { value: 'phone', label: 'Phone number' },
    { value: 'number', label: 'Number' },
    { value: 'checkbox', label: 'Checkbox' },
    { value: 'dropdown', label: 'Dropdown' },
  ];
  return (
    <div className="flex items-center gap-1.5">
      <select className={selectStyle} value={kind} onChange={(e) => setKind(e.target.value as CustomFieldKind)}>
        {KIND_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <button type="button" className={buttonGhost} onClick={() => onAdd(kind)}>
        + Add field
      </button>
    </div>
  );
}
