'use client';

import { evaluateVisibility, type CustomFieldDef, type FieldValues } from '@ticketing/shared';
import { input, label, labelInline, select as selectStyle } from '@/lib/styles';

export type CustomFieldValues = Record<string, string | boolean>;

interface DynamicTicketFieldsProps {
  fields: CustomFieldDef[];
  values: CustomFieldValues;
  /** Standard-field values (priority/type) a visibility rule may reference, alongside
   * whatever's in `values`. Keep in sync with resolveTicketFormFields on the server. */
  standardValues?: FieldValues;
  onChange: (fieldId: string, value: string | boolean) => void;
}

/**
 * Renders a group's custom create-ticket fields, showing only the ones whose visibility
 * rule currently evaluates true. Used both live in NewTicketForm and as the preview pane
 * in TicketGroupFieldsEditor, so requesters and editors always see the same thing.
 */
export function DynamicTicketFields({ fields, values, standardValues, onChange }: DynamicTicketFieldsProps) {
  const liveValues: FieldValues = { ...standardValues, ...values };
  const visibleFields = fields.filter((field) => evaluateVisibility(field.visibility, liveValues));

  if (visibleFields.length === 0) return null;

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-elevated/40 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">Additional details</p>
      {visibleFields.map((field) => (
        <CustomFieldInput key={field.id} field={field} value={values[field.id]} onChange={onChange} />
      ))}
    </div>
  );
}

interface CustomFieldInputProps {
  field: CustomFieldDef;
  value: string | boolean | undefined;
  onChange: (fieldId: string, value: string | boolean) => void;
}

function CustomFieldInput({ field, value, onChange }: CustomFieldInputProps) {
  const requiredMark = field.required ? <span className="text-danger"> *</span> : null;

  if (field.kind === 'checkbox') {
    return (
      <label className={labelInline}>
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(field.id, e.target.checked)}
          className="h-4 w-4 rounded border-border accent-accent"
        />
        {field.label}
        {requiredMark}
      </label>
    );
  }

  if (field.kind === 'dropdown') {
    return (
      <label className={label}>
        {field.label}
        {requiredMark}
        <select
          className={selectStyle}
          value={typeof value === 'string' ? value : field.defaultValue}
          onChange={(e) => onChange(field.id, e.target.value)}
        >
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (field.kind === 'textarea') {
    return (
      <label className={label}>
        {field.label}
        {requiredMark}
        <textarea
          className={input}
          rows={3}
          placeholder={field.placeholder}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(field.id, e.target.value)}
        />
      </label>
    );
  }

  const inputType = field.kind === 'email' ? 'email' : field.kind === 'phone' ? 'tel' : field.kind === 'number' ? 'number' : 'text';
  return (
    <label className={label}>
      {field.label}
      {requiredMark}
      <input
        type={inputType}
        className={input}
        placeholder={field.placeholder}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(field.id, e.target.value)}
      />
    </label>
  );
}
