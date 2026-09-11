'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  buttonDanger,
  buttonGhost,
  buttonPrimary,
  card,
  cardTight,
  errorText,
  input,
  label,
  mutedText,
} from '@/lib/styles';

interface TicketGroup {
  id: string;
  name: string;
  authentikGroupNames: string[];
  announcementChannelId: string | null;
  unassignedBacklogChannelId: string | null;
}

interface FormState {
  id: string | null;
  name: string;
  authentikGroupNames: string[];
  announcementChannelId: string;
  unassignedBacklogChannelId: string;
}

const EMPTY_FORM: FormState = {
  id: null,
  name: '',
  authentikGroupNames: [],
  announcementChannelId: '',
  unassignedBacklogChannelId: '',
};

interface TicketGroupsManagerProps {
  initialGroups: TicketGroup[];
  authentikGroupNames: string[];
}

export function TicketGroupsManager({ initialGroups, authentikGroupNames }: TicketGroupsManagerProps) {
  const [groups, setGroups] = useState(initialGroups);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function editGroup(group: TicketGroup) {
    setForm({
      id: group.id,
      name: group.name,
      authentikGroupNames: group.authentikGroupNames,
      announcementChannelId: group.announcementChannelId ?? '',
      unassignedBacklogChannelId: group.unassignedBacklogChannelId ?? '',
    });
    setError(null);
  }

  function toggleAuthentikGroup(name: string) {
    setForm((prev) => ({
      ...prev,
      authentikGroupNames: prev.authentikGroupNames.includes(name)
        ? prev.authentikGroupNames.filter((n) => n !== name)
        : [...prev.authentikGroupNames, name],
    }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setIsSaving(true);
    setError(null);

    const payload = {
      name: form.name,
      authentikGroupNames: form.authentikGroupNames,
      announcementChannelId: form.announcementChannelId || null,
      unassignedBacklogChannelId: form.unassignedBacklogChannelId || null,
    };

    const res = await fetch(form.id ? `/api/ticket-groups/${form.id}` : '/api/ticket-groups', {
      method: form.id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    setIsSaving(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error ?? 'Failed to save group');
      return;
    }
    const body = await res.json();
    setGroups((prev) => {
      const withoutSaved = prev.filter((g) => g.id !== body.data.id);
      return [...withoutSaved, body.data].sort((a, b) => a.name.localeCompare(b.name));
    });
    setForm(EMPTY_FORM);
  }

  async function handleDelete(groupId: string) {
    setError(null);
    const res = await fetch(`/api/ticket-groups/${groupId}`, { method: 'DELETE' });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error ?? 'Failed to delete group');
      return;
    }
    setGroups((prev) => prev.filter((g) => g.id !== groupId));
    if (form.id === groupId) setForm(EMPTY_FORM);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        {groups.map((group, index) => (
          <div
            key={group.id}
            className={`${cardTight} flex animate-fade-in-up items-center justify-between gap-4`}
            style={{ animationDelay: `${Math.min(index, 8) * 30}ms` }}
          >
            <div>
              <p className="font-medium text-text">{group.name}</p>
              <p className={mutedText}>
                Authentik: {group.authentikGroupNames.join(', ') || 'none'}
                {' · '}
                Announce: {group.announcementChannelId ?? 'off'}
                {' · '}
                Backlog: {group.unassignedBacklogChannelId ?? 'off'}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Link href={`/groups/${group.id}/fields`} className={buttonGhost}>
                Edit fields
              </Link>
              <button type="button" className={buttonGhost} onClick={() => editGroup(group)}>
                Edit
              </button>
              <button type="button" className={buttonDanger} onClick={() => handleDelete(group.id)}>
                Delete
              </button>
            </div>
          </div>
        ))}
        {groups.length === 0 && <p className={mutedText}>No groups configured yet.</p>}
      </div>

      <form onSubmit={handleSubmit} className={`${card} flex flex-col gap-4`}>
        <h3 className="text-sm font-semibold text-text">{form.id ? 'Edit group' : 'New group'}</h3>

        <label className={label}>
          Name
          <input
            type="text"
            value={form.name}
            onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
            className={input}
            placeholder="e.g. Networking"
          />
        </label>

        <div className={label}>
          Linked Authentik groups
          <div className="flex flex-wrap gap-1.5 rounded-md border border-border p-2">
            {authentikGroupNames.map((name) => {
              const selected = form.authentikGroupNames.includes(name);
              return (
                <button
                  key={name}
                  type="button"
                  onClick={() => toggleAuthentikGroup(name)}
                  aria-pressed={selected}
                  className={
                    selected
                      ? 'rounded-full border border-accent bg-accent-soft px-3 py-1 text-xs font-medium text-accent transition-colors'
                      : 'rounded-full border border-border px-3 py-1 text-xs font-medium text-text-secondary transition-colors hover:border-border-strong hover:text-text'
                  }
                >
                  {name}
                </button>
              );
            })}
            {authentikGroupNames.length === 0 && <span className={mutedText}>No Authentik groups found.</span>}
          </div>
          <span className={mutedText}>
            Anyone in a linked Authentik group can see and edit tickets routed here, and can be assigned.
          </span>
        </div>

        <label className={label}>
          Announcement channel ID
          <input
            type="text"
            inputMode="numeric"
            value={form.announcementChannelId}
            onChange={(e) => setForm((prev) => ({ ...prev, announcementChannelId: e.target.value }))}
            placeholder="Discord channel ID (leave blank to disable)"
            className={input}
          />
          <span className={mutedText}>Posts when a ticket is routed to this group.</span>
        </label>

        <label className={label}>
          Unassigned-backlog channel ID
          <input
            type="text"
            inputMode="numeric"
            value={form.unassignedBacklogChannelId}
            onChange={(e) => setForm((prev) => ({ ...prev, unassignedBacklogChannelId: e.target.value }))}
            placeholder="Discord channel ID (leave blank to disable)"
            className={input}
          />
          <span className={mutedText}>
            Daily count of this group&apos;s unassigned tickets. Groups sharing the same channel ID get one
            combined count instead of separate messages.
          </span>
        </label>

        <div className="flex items-center gap-3">
          <button type="submit" disabled={isSaving} className={buttonPrimary}>
            {isSaving ? 'Saving…' : form.id ? 'Save changes' : 'Create group'}
          </button>
          {form.id && (
            <button type="button" className={buttonGhost} onClick={() => setForm(EMPTY_FORM)}>
              Cancel
            </button>
          )}
          {error && <p className={errorText}>{error}</p>}
        </div>
      </form>
    </div>
  );
}
