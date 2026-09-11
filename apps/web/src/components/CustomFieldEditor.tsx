'use client';

import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import { CUSTOM_FIELD_KINDS, type CustomFieldDef, type CustomFieldKind } from '@ticketing/shared';
import { buttonGhost, cardTight, input, inputSm, label as labelClass, labelInline, mutedText, select as selectStyle } from '@/lib/styles';
import { VisibilityRuleEditor, type VisibilityTarget } from '@/components/VisibilityRuleEditor';

const KIND_LABELS: Record<CustomFieldKind, string> = {
  text: 'Text',
  textarea: 'Long text',
  email: 'Email',
  phone: 'Phone number',
  number: 'Number',
  checkbox: 'Checkbox',
  dropdown: 'Dropdown',
};

function slugify(label: string): string {
  return label.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'field';
}

function withUniqueId(id: string, existingIds: string[]): string {
  if (!existingIds.includes(id)) return id;
  let suffix = 2;
  while (existingIds.includes(`${id}-${suffix}`)) suffix += 1;
  return `${id}-${suffix}`;
}

/** A fresh field of the given kind, with a default label and (for dropdown) one starter option. */
export function newCustomField(kind: CustomFieldKind, existingIds: string[]): CustomFieldDef {
  const label = KIND_LABELS[kind];
  const id = withUniqueId(slugify(label), existingIds);
  const base = { id, label, required: false };
  if (kind === 'dropdown') {
    return { ...base, kind, required: true, options: [{ value: 'option-1', label: 'Option 1' }], defaultValue: 'option-1' };
  }
  if (kind === 'checkbox') return { ...base, kind };
  return { ...base, kind };
}

interface CustomFieldEditorProps {
  field: CustomFieldDef;
  visibilityTargets: VisibilityTarget[];
  canMoveUp: boolean;
  canMoveDown: boolean;
  onChange: (field: CustomFieldDef) => void;
  onRemove: () => void;
  onMove: (direction: 'up' | 'down') => void;
}

export function CustomFieldEditor({
  field,
  visibilityTargets,
  canMoveUp,
  canMoveDown,
  onChange,
  onRemove,
  onMove,
}: CustomFieldEditorProps) {
  function changeKind(kind: CustomFieldKind) {
    const base = { id: field.id, label: field.label, required: field.required, placeholder: field.placeholder };
    if (kind === 'dropdown') {
      onChange({ ...base, kind, required: true, options: [{ value: 'option-1', label: 'Option 1' }], defaultValue: 'option-1' });
      return;
    }
    onChange({ ...base, kind });
  }

  return (
    <div className={`${cardTight} flex flex-col gap-3`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-1 flex-wrap gap-2">
          <label className={labelClass}>
            Label
            <input
              className={input}
              value={field.label}
              onChange={(e) => onChange({ ...field, label: e.target.value })}
            />
          </label>
          <label className={labelClass}>
            Field type
            <select className={selectStyle} value={field.kind} onChange={(e) => changeKind(e.target.value as CustomFieldKind)}>
              {CUSTOM_FIELD_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {KIND_LABELS[kind]}
                </option>
              ))}
            </select>
          </label>
          {field.kind !== 'dropdown' && (
            <label className={labelInline}>
              <input
                type="checkbox"
                checked={field.required}
                onChange={(e) => onChange({ ...field, required: e.target.checked })}
                className="h-4 w-4 rounded border-border accent-accent"
              />
              Required
            </label>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" className={buttonGhost} disabled={!canMoveUp} onClick={() => onMove('up')} aria-label="Move up">
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
          <button type="button" className={buttonGhost} disabled={!canMoveDown} onClick={() => onMove('down')} aria-label="Move down">
            <ArrowDown className="h-3.5 w-3.5" />
          </button>
          <button type="button" className={`${buttonGhost} hover:text-danger`} onClick={onRemove} aria-label="Remove field">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {(field.kind === 'text' || field.kind === 'textarea' || field.kind === 'email' || field.kind === 'phone' || field.kind === 'number') && (
        <label className={labelClass}>
          Placeholder (optional)
          <input
            className={input}
            value={field.placeholder ?? ''}
            onChange={(e) => onChange({ ...field, placeholder: e.target.value || undefined })}
          />
        </label>
      )}

      {field.kind === 'dropdown' && (
        <DropdownOptionsEditor field={field} onChange={onChange} />
      )}

      <div className={labelClass}>
        Visibility
        <VisibilityRuleEditor rule={field.visibility} onChange={(visibility) => onChange({ ...field, visibility })} targets={visibilityTargets} />
        {!field.visibility && <span className={mutedText}>Always shown once its group is picked.</span>}
      </div>
    </div>
  );
}

function DropdownOptionsEditor({
  field,
  onChange,
}: {
  field: Extract<CustomFieldDef, { kind: 'dropdown' }>;
  onChange: (field: CustomFieldDef) => void;
}) {
  function removeOption(index: number) {
    const options = field.options.filter((_, i) => i !== index);
    const defaultValue = options.some((o) => o.value === field.defaultValue) ? field.defaultValue : (options[0]?.value ?? '');
    onChange({ ...field, options, defaultValue });
  }

  function addOption() {
    const value = withUniqueId('option', field.options.map((o) => o.value));
    onChange({ ...field, options: [...field.options, { value, label: `Option ${field.options.length + 1}` }] });
  }

  return (
    <div className={labelClass}>
      Options (first/default is pre-selected -- dropdowns are never left blank)
      <div className="flex flex-col gap-1.5">
        {field.options.map((option, index) => (
          <div key={index} className="flex items-center gap-1.5">
            <input
              type="radio"
              name={`${field.id}-default`}
              checked={field.defaultValue === option.value}
              onChange={() => onChange({ ...field, defaultValue: option.value })}
              aria-label={`Make "${option.label}" the default`}
            />
            <input
              className={inputSm}
              value={option.label}
              placeholder="Option label"
              onChange={(e) => {
                const otherValues = field.options.filter((_, i) => i !== index).map((o) => o.value);
                const nextValue = withUniqueId(slugify(e.target.value), otherValues);
                const options = field.options.map((o, i) => (i === index ? { value: nextValue, label: e.target.value } : o));
                const defaultValue = field.defaultValue === option.value ? nextValue : field.defaultValue;
                onChange({ ...field, options, defaultValue });
              }}
            />
            <button
              type="button"
              className="text-text-tertiary hover:text-danger"
              onClick={() => removeOption(index)}
              disabled={field.options.length <= 1}
              aria-label="Remove option"
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <button type="button" className={`${buttonGhost} w-fit`} onClick={addOption}>
        + Add option
      </button>
    </div>
  );
}
