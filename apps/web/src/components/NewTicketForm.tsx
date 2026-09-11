'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import {
  DEFAULT_GROUP_FORM_CONFIG,
  TICKET_PRIORITIES,
  TICKET_TYPES,
  type GroupFormConfig,
  type TicketPriority,
  type TicketType,
} from '@ticketing/shared';
import { buttonGhost, buttonPrimary, card, errorText, input, label, mutedText, select as selectStyle } from '@/lib/styles';
import { uploadAttachment } from '@/lib/uploadAttachment';
import { OptionDropdown } from '@/components/OptionDropdown';
import { DynamicTicketFields, type CustomFieldValues } from '@/components/DynamicTicketFields';
import { PRIORITY_CONFIG } from '@/lib/ticketPriority';
import { TYPE_CONFIG } from '@/lib/ticketType';

interface CcCandidate {
  id: string;
  name: string;
}

interface TicketGroupOption {
  id: string;
  name: string;
  formConfig: GroupFormConfig | null;
}

const CC_SEARCH_DEBOUNCE_MS = 250;
const CC_MIN_QUERY_LENGTH = 2;

export function NewTicketForm() {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TicketPriority>('normal');
  const [type, setType] = useState<TicketType>('other');
  const [groups, setGroups] = useState<TicketGroupOption[]>([]);
  const [groupId, setGroupId] = useState('');
  const [customFieldValues, setCustomFieldValues] = useState<CustomFieldValues>({});

  const [ccQuery, setCcQuery] = useState('');
  const [ccResults, setCcResults] = useState<CcCandidate[]>([]);
  const [selectedCc, setSelectedCc] = useState<CcCandidate[]>([]);

  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/ticket-groups')
      .then((res) => (res.ok ? res.json() : { data: [] }))
      .then((body) => setGroups(body.data ?? []))
      .catch(() => setGroups([]));
  }, []);

  useEffect(() => {
    if (ccQuery.trim().length < CC_MIN_QUERY_LENGTH) {
      setCcResults([]);
      return;
    }
    const handle = setTimeout(() => {
      fetch(`/api/users/cc-candidates?q=${encodeURIComponent(ccQuery.trim())}`)
        .then((res) => (res.ok ? res.json() : { data: [] }))
        .then((body) => setCcResults(body.data ?? []))
        .catch(() => setCcResults([]));
    }, CC_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [ccQuery]);

  const selectedGroup = groups.find((g) => g.id === groupId);
  const formConfig = selectedGroup?.formConfig ?? DEFAULT_GROUP_FORM_CONFIG;
  const standard = formConfig.standardFields;
  const showDescription = standard.description?.shown ?? true;
  const requireDescription = standard.description?.required ?? true;
  const showPriority = standard.priority?.shown ?? true;
  const showType = standard.type?.shown ?? true;
  const showCc = standard.cc?.shown ?? true;
  const showAttachments = standard.attachments?.shown ?? true;

  function handleGroupChange(nextGroupId: string) {
    setGroupId(nextGroupId);
    // Switching groups changes which custom fields exist entirely -- stale answers from
    // the previous group's fields would be meaningless (and the server drops them anyway).
    setCustomFieldValues({});
  }

  function setCustomFieldValue(fieldId: string, value: string | boolean) {
    setCustomFieldValues((prev) => ({ ...prev, [fieldId]: value }));
  }

  function addCcCandidate(candidate: CcCandidate) {
    setSelectedCc((prev) => (prev.some((c) => c.id === candidate.id) ? prev : [...prev, candidate]));
    setCcQuery('');
    setCcResults([]);
  }

  function removeCcCandidate(id: string) {
    setSelectedCc((prev) => prev.filter((c) => c.id !== id));
  }

  function addFiles(files: FileList | null) {
    if (!files) return;
    setPendingFiles((prev) => [...prev, ...Array.from(files)]);
  }

  function removeFile(index: number) {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);

    const res = await fetch('/api/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        description: showDescription ? description : undefined,
        priority: showPriority ? priority : undefined,
        type: showType ? type : undefined,
        groupId: groupId || null,
        ccUserIds: showCc ? selectedCc.map((c) => c.id) : [],
        customFieldValues,
      }),
    });

    if (!res.ok) {
      const body = await res.json();
      setError(body.error ?? 'Failed to create ticket');
      setIsSubmitting(false);
      return;
    }

    const { data } = await res.json();

    if (showAttachments) {
      try {
        for (const file of pendingFiles) {
          await uploadAttachment(data.id, file);
        }
      } catch {
        // Ticket was created successfully; attachment upload failures shouldn't block navigation.
      }
    }

    router.push(`/t/${data.id}`);
  }

  return (
    <form onSubmit={handleSubmit} className={`${card} flex flex-col gap-4`}>
      <input
        className={input}
        placeholder="Title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        required
      />

      {showDescription && (
        <textarea
          className={input}
          placeholder="Describe the issue"
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          required={requireDescription}
        />
      )}

      {(showPriority || showType) && (
        <div className="flex flex-wrap gap-3">
          {showPriority && (
            <label className={`${label} flex-1`}>
              Priority
              <OptionDropdown value={priority} options={TICKET_PRIORITIES} config={PRIORITY_CONFIG} onChange={setPriority} />
            </label>
          )}
          {showType && (
            <label className={`${label} flex-1`}>
              Type
              <OptionDropdown value={type} options={TICKET_TYPES} config={TYPE_CONFIG} onChange={setType} />
            </label>
          )}
        </div>
      )}

      <label className={label}>
        Send to
        <select className={selectStyle} value={groupId} onChange={(e) => handleGroupChange(e.target.value)}>
          <option value="">Not sure (goes to admins)</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      </label>

      <DynamicTicketFields
        fields={formConfig.customFields}
        values={customFieldValues}
        standardValues={{ priority, type }}
        onChange={setCustomFieldValue}
      />

      {showCc && (
        <div className={label}>
          CC (search by name)
          <div className="relative">
            <input
              className={input}
              placeholder="Search people…"
              value={ccQuery}
              onChange={(e) => setCcQuery(e.target.value)}
            />
            {ccResults.length > 0 && (
              <ul className="absolute z-10 mt-1 w-full rounded-md border border-border bg-panel shadow-lg">
                {ccResults.map((candidate) => (
                  <li key={candidate.id}>
                    <button
                      type="button"
                      onClick={() => addCcCandidate(candidate)}
                      className="block w-full px-3 py-2 text-left text-sm text-text hover:bg-elevated"
                    >
                      {candidate.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {selectedCc.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              {selectedCc.map((candidate) => (
                <span
                  key={candidate.id}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs font-medium text-text-secondary"
                >
                  {candidate.name}
                  <button
                    type="button"
                    onClick={() => removeCcCandidate(candidate.id)}
                    className="text-text-tertiary hover:text-text"
                    aria-label={`Remove ${candidate.name}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {showAttachments && (
        <div className={label}>
          Attachments
          <label className={`${buttonGhost} w-fit cursor-pointer border border-border`}>
            Add files
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                addFiles(e.target.files);
                if (fileInputRef.current) fileInputRef.current.value = '';
              }}
            />
          </label>
          {pendingFiles.length > 0 && (
            <ul className="flex flex-col gap-1">
              {pendingFiles.map((file, index) => (
                <li key={`${file.name}-${index}`} className="flex items-center justify-between text-sm text-text-secondary">
                  <span className="truncate">{file.name}</span>
                  <button
                    type="button"
                    onClick={() => removeFile(index)}
                    className="text-text-tertiary hover:text-text"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <p className={mutedText}>
        {showPriority || showType
          ? 'Priority, type, and assignee can be adjusted by an admin after submission.'
          : 'Assignee can be adjusted by an admin after submission.'}
      </p>

      {error && <p className={errorText}>{error}</p>}
      <button
        type="submit"
        disabled={isSubmitting}
        className={`${buttonPrimary} gap-1.5 self-start transition-all hover:-translate-y-0.5 active:translate-y-0`}
      >
        <Plus className="h-4 w-4" />
        {isSubmitting ? 'Creating…' : 'New ticket'}
      </button>
    </form>
  );
}
