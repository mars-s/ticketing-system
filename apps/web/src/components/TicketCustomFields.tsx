import type { GroupFormConfig } from '@ticketing/shared';
import { cardTight, mutedText } from '@/lib/styles';

interface TicketCustomFieldsProps {
  values: Record<string, string | boolean> | null;
  /** The group's *current* formConfig -- labels are resolved live, not from a snapshot
   * taken at ticket creation, so a later rename shows the new label immediately and a
   * later removal falls back to the raw field id. See docs/ticket-group-custom-fields-plan.md. */
  formConfig: GroupFormConfig | null;
}

export function TicketCustomFields({ values, formConfig }: TicketCustomFieldsProps) {
  if (!values || Object.keys(values).length === 0) return null;

  const fieldsById = new Map((formConfig?.customFields ?? []).map((f) => [f.id, f]));

  return (
    <div className={`${cardTight} mb-6 flex flex-col gap-2`}>
      <p className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">Additional details</p>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
        {Object.entries(values).map(([fieldId, value]) => {
          const field = fieldsById.get(fieldId);
          const label = field?.label ?? `${fieldId} (removed field)`;
          const displayValue =
            typeof value === 'boolean'
              ? value
                ? 'Yes'
                : 'No'
              : (field?.kind === 'dropdown' ? field.options.find((o) => o.value === value)?.label : undefined) ?? value;
          return (
            <div key={fieldId}>
              <dt className={mutedText}>{label}</dt>
              <dd className="text-sm text-text">{displayValue}</dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}
