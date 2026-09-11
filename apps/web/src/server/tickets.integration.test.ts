import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@ticketing/db';
import type { GroupFormConfig } from '@ticketing/shared';
import { resetDatabase, createTestUser } from '@/test/db';
import {
  addMessage,
  claimDiscordAccount,
  createTicket,
  createTicketFromDiscord,
  createTicketShareLink,
  getTicketMetrics,
  listTicketsForAdminQueue,
  listTicketsForUser,
  previewTicketShareLink,
  redeemTicketShareLink,
  resolveSearchTokensToFilters,
  updateTicket,
  verifyTicketToken,
} from './tickets';
import { createTicketGroup, updateTicketGroupFormConfig } from './ticketGroups';

const BASE_URL = 'https://tickets.test';

beforeEach(async () => {
  await resetDatabase();
});

describe('createTicket + listTicketsForUser', () => {
  it('only returns a user their own tickets, including when the user is an admin', async () => {
    const owner = await createTestUser({ name: 'Owner' });
    const otherUser = await createTestUser({ name: 'Other', email: 'other@test.local' });
    const admin = await createTestUser({ name: 'Admin', email: 'admin@test.local', role: 'admin' });

    await createTicket(owner.id, 'user', { title: 'Printer jam', description: 'x', priority: 'normal', type: 'other' });
    await createTicket(otherUser.id, 'user', { title: 'VPN down', description: 'y', priority: 'high', type: 'other' });
    await createTicket(admin.id, 'admin', { title: "Admin's own ticket", description: 'z', priority: 'normal', type: 'other' });

    const ownerView = await listTicketsForUser(owner.id);
    expect(ownerView).toHaveLength(1);
    expect(ownerView[0]?.title).toBe('Printer jam');

    // Admins only see tickets they submitted or are cc'd on here -- the admin queue page
    // (listTicketsForAdminQueue) is the only place that shows every ticket.
    const adminView = await listTicketsForUser(admin.id);
    expect(adminView).toHaveLength(1);
    expect(adminView[0]?.title).toBe("Admin's own ticket");
  });

  it('surfaces a ticket to its cc\'d watcher, and rejects ccing yourself', async () => {
    const owner = await createTestUser({ name: 'Owner' });
    const watcher = await createTestUser({ name: 'Watcher', email: 'watcher@test.local' });

    const ticket = await createTicket(owner.id, 'user', {
      title: 'Needs a second pair of eyes',
      description: 'x',
      priority: 'normal',
      type: 'bug',
      ccUserIds: [watcher.id],
    });
    expect(ticket.watchers.map((w) => w.id)).toEqual([watcher.id]);

    const watcherView = await listTicketsForUser(watcher.id);
    expect(watcherView.map((t) => t.id)).toEqual([ticket.id]);

    await expect(
      createTicket(owner.id, 'user', {
        title: 'Self cc',
        description: 'x',
        priority: 'normal',
        type: 'other',
        ccUserIds: [owner.id],
      }),
    ).rejects.toThrow('Cannot cc yourself');
  });

  it('rejects a regular user assigning a ticket at creation time', async () => {
    const owner = await createTestUser({ name: 'Owner' });
    const admin = await createTestUser({ name: 'Admin', email: 'assign-admin@test.local', role: 'admin' });

    await expect(
      createTicket(owner.id, 'user', {
        title: 'Self assign attempt',
        description: 'x',
        priority: 'normal',
        type: 'other',
        assigneeIds: [admin.id],
      }),
    ).rejects.toThrow('Only admins can assign a ticket at creation time');
  });

  it('allows an admin to self-assign at creation time', async () => {
    const admin = await createTestUser({ name: 'Admin', email: 'self-assign-admin@test.local', role: 'admin' });

    const ticket = await createTicket(admin.id, 'admin', {
      title: 'Self assigned',
      description: 'x',
      priority: 'normal',
      type: 'other',
      assigneeIds: [admin.id],
    });

    expect(ticket.assignees.map((a) => a.id)).toEqual([admin.id]);
  });
});

describe('createTicket with a group formConfig', () => {
  async function makeGroupWithConfig(formConfig: GroupFormConfig) {
    const admin = await createTestUser({ name: 'Admin', email: `admin-${Date.now()}-${Math.random()}@test.local`, role: 'admin' });
    const group = await createTicketGroup(
      { name: `Group ${Date.now()}-${Math.random()}`, authentikGroupNames: ['g'], announcementChannelId: null, unassignedBacklogChannelId: null },
      admin.id,
    );
    await updateTicketGroupFormConfig(group.id, formConfig, admin.id);
    return group;
  }

  it('applies the configured default when a standard field is hidden, ignoring any client-sent value', async () => {
    const owner = await createTestUser({ name: 'Owner' });
    const group = await makeGroupWithConfig({
      standardFields: { priority: { shown: false, required: false, defaultValue: 'urgent' } },
      customFields: [],
    });

    const ticket = await createTicket(owner.id, 'user', {
      title: 'Hidden priority',
      description: 'x',
      priority: 'low', // client can't override a hidden field
      groupId: group.id,
    });

    expect(ticket.priority).toBe('urgent');
  });

  it('rejects a missing required visible custom field', async () => {
    const owner = await createTestUser({ name: 'Owner' });
    const group = await makeGroupWithConfig({
      standardFields: {},
      customFields: [{ id: 'phone', kind: 'text', label: 'Phone number', required: true }],
    });

    await expect(
      createTicket(owner.id, 'user', { title: 'Missing phone', description: 'x', groupId: group.id }),
    ).rejects.toThrow('"Phone number" is required');
  });

  it('stores a visible custom field answer and never persists a hidden field even if the client sends one', async () => {
    const owner = await createTestUser({ name: 'Owner' });
    const group = await makeGroupWithConfig({
      standardFields: {},
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
    });

    // Checkbox unticked -- the dependent text field is hidden, so even though the client
    // sneaks a value in for it, it must not be persisted (server re-evaluates visibility).
    const ticket = await createTicket(owner.id, 'user', {
      title: 'Checkbox off',
      description: 'x',
      groupId: group.id,
      customFieldValues: { 'ticket-a': false, 'ticket-a-text': 'should be dropped' },
    });
    expect(ticket.customFieldValues).toEqual({ 'ticket-a': false });

    const ticket2 = await createTicket(owner.id, 'user', {
      title: 'Checkbox on',
      description: 'x',
      groupId: group.id,
      customFieldValues: { 'ticket-a': true, 'ticket-a-text': 'real details' },
    });
    expect(ticket2.customFieldValues).toEqual({ 'ticket-a': true, 'ticket-a-text': 'real details' });
  });

  it('falls back to a dropdown default value when the submitted value is not one of its options', async () => {
    const owner = await createTestUser({ name: 'Owner' });
    const group = await makeGroupWithConfig({
      standardFields: {},
      customFields: [
        {
          id: 'category',
          kind: 'dropdown',
          label: 'Category',
          required: true,
          options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
          defaultValue: 'a',
        },
      ],
    });

    const ticket = await createTicket(owner.id, 'user', {
      title: 'Bogus dropdown value',
      description: 'x',
      groupId: group.id,
      customFieldValues: { category: 'not-a-real-option' },
    });
    expect(ticket.customFieldValues).toEqual({ category: 'a' });
  });

  it('is unaffected when the group has no formConfig (default form, unchanged pre-groups behavior)', async () => {
    const owner = await createTestUser({ name: 'Owner' });
    const admin = await createTestUser({ name: 'Admin', email: 'plain-admin@test.local', role: 'admin' });
    const group = await createTicketGroup(
      { name: 'Plain group', authentikGroupNames: ['g'], announcementChannelId: null, unassignedBacklogChannelId: null },
      admin.id,
    );

    const ticket = await createTicket(owner.id, 'user', {
      title: 'No config',
      description: 'x',
      priority: 'high',
      type: 'bug',
      groupId: group.id,
    });

    expect(ticket.priority).toBe('high');
    expect(ticket.type).toBe('bug');
    expect(ticket.customFieldValues).toBeNull();
  });
});

/** createTicketFromDiscord returns a relative `path` (no origin); pull the `token` query param off it. */
function tokenFromPath(path: string): string {
  return new URLSearchParams(path.split('?')[1]).get('token')!;
}

describe('createTicketFromDiscord', () => {
  it('creates a Discord-only placeholder on first contact and issues a claim link, not a token link', async () => {
    const { ticket, path, isNewUser } = await createTicketFromDiscord({
      title: 'Discord ticket',
      description: 'help',
      priority: 'normal',
      type: 'other',
      discordUserId: 'discord-123',
      discordUsername: 'someuser',
    }, BASE_URL);

    expect(isNewUser).toBe(true);
    expect(path).toContain('/link-discord/claim?token=');

    const owner = await prisma.user.findUnique({ where: { id: ticket.createdById } });
    expect(owner?.discordId).toBe('discord-123');
    expect(owner?.isDiscordPlaceholder).toBe(true);
  });

  it('reuses the existing user when discordId is already linked, and issues a direct token link', async () => {
    const existing = await createTestUser({ name: 'Linked', discordId: 'discord-456' });

    const { ticket, path, isNewUser } = await createTicketFromDiscord({
      title: 'Second ticket',
      description: 'again',
      priority: 'normal',
      type: 'other',
      discordUserId: 'discord-456',
      discordUsername: 'someuser',
    }, BASE_URL);

    expect(isNewUser).toBe(false);
    expect(ticket.createdById).toBe(existing.id);
    expect(path).toContain(`/t/${ticket.id}?token=`);
    expect(await verifyTicketToken(ticket.id, tokenFromPath(path))).toBe(true);
  });

  it('rejects a token from a different linked-user ticket', async () => {
    const first = await createTestUser({ name: 'First', discordId: 'discord-a' });
    const second = await createTestUser({ name: 'Second', email: 'second@test.local', discordId: 'discord-b' });

    const ticketA = await createTicketFromDiscord({
      title: 'Ticket A',
      description: 'a',
      priority: 'normal',
      type: 'other',
      discordUserId: first.discordId!,
      discordUsername: 'a',
    }, BASE_URL);
    const ticketB = await createTicketFromDiscord({
      title: 'Ticket B',
      description: 'b',
      priority: 'normal',
      type: 'other',
      discordUserId: second.discordId!,
      discordUsername: 'b',
    }, BASE_URL);

    const tokenA = tokenFromPath(ticketA.path);
    expect(await verifyTicketToken(ticketB.ticket.id, tokenA)).toBe(false);
  });

  it('rejects an expired token for a linked user', async () => {
    const existing = await createTestUser({ name: 'Linked', discordId: 'discord-expiring' });
    const { ticket, path } = await createTicketFromDiscord({
      title: 'Expiring ticket',
      description: 'x',
      priority: 'normal',
      type: 'other',
      discordUserId: existing.discordId!,
      discordUsername: 'x',
    }, BASE_URL);

    await prisma.ticketAccessToken.updateMany({
      where: { ticketId: ticket.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    expect(await verifyTicketToken(ticket.id, tokenFromPath(path))).toBe(false);
  });

  it('refreshes the claim link to the newest ticket when the same unclaimed Discord user opens another ticket', async () => {
    const first = await createTicketFromDiscord({
      title: 'First',
      description: 'x',
      priority: 'normal',
      type: 'other',
      discordUserId: 'discord-repeat',
      discordUsername: 'repeat',
    }, BASE_URL);
    const second = await createTicketFromDiscord({
      title: 'Second',
      description: 'y',
      priority: 'normal',
      type: 'other',
      discordUserId: 'discord-repeat',
      discordUsername: 'repeat',
    }, BASE_URL);

    expect(second.ticket.createdById).toBe(first.ticket.createdById);
    expect(second.path).not.toBe(first.path);

    const claims = await prisma.discordClaim.findMany({ where: { placeholderUserId: first.ticket.createdById } });
    expect(claims).toHaveLength(1);
    expect(claims[0]?.ticketId).toBe(second.ticket.id);
  });
});

describe('claimDiscordAccount', () => {
  it('reassigns the placeholder’s ticket to the real user and links discordId', async () => {
    const realUser = await createTestUser({ name: 'Real', email: 'real@test.local' });
    const { ticket, path } = await createTicketFromDiscord({
      title: 'Discord ticket',
      description: 'help',
      priority: 'normal',
      type: 'other',
      discordUserId: 'discord-claim-1',
      discordUsername: 'someuser',
    }, BASE_URL);
    const placeholderId = ticket.createdById;

    const result = await claimDiscordAccount(tokenFromPath(path), realUser.id);
    expect(result.ticketId).toBe(ticket.id);

    const updatedTicket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(updatedTicket.createdById).toBe(realUser.id);

    const updatedRealUser = await prisma.user.findUniqueOrThrow({ where: { id: realUser.id } });
    expect(updatedRealUser.discordId).toBe('discord-claim-1');

    const placeholder = await prisma.user.findUnique({ where: { id: placeholderId } });
    expect(placeholder).toBeNull();
  });

  it('rejects an expired claim token', async () => {
    const realUser = await createTestUser({ name: 'Real', email: 'real2@test.local' });
    const { path } = await createTicketFromDiscord({
      title: 'Discord ticket',
      description: 'help',
      priority: 'normal',
      type: 'other',
      discordUserId: 'discord-claim-2',
      discordUsername: 'someuser',
    }, BASE_URL);

    await prisma.discordClaim.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    await expect(claimDiscordAccount(tokenFromPath(path), realUser.id)).rejects.toThrow('expired');
  });

  it('rejects claiming onto an account already linked to a different Discord user', async () => {
    const realUser = await createTestUser({
      name: 'Already linked',
      email: 'already@test.local',
      discordId: 'discord-someone-else',
    });
    const { path } = await createTicketFromDiscord({
      title: 'Discord ticket',
      description: 'help',
      priority: 'normal',
      type: 'other',
      discordUserId: 'discord-claim-3',
      discordUsername: 'someuser',
    }, BASE_URL);

    await expect(claimDiscordAccount(tokenFromPath(path), realUser.id)).rejects.toThrow(
      'already linked to a different Discord user',
    );
  });
});

describe('addMessage', () => {
  it('bumps the ticket updatedAt timestamp', async () => {
    const owner = await createTestUser();
    const ticket = await createTicket(owner.id, 'user', {
      title: 'Bump test',
      description: 'x',
      priority: 'normal',
      type: 'other',
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    await addMessage(ticket.id, owner.id, { body: 'reply', isInternalNote: false });

    const updated = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(updated.updatedAt.getTime()).toBeGreaterThan(ticket.updatedAt.getTime());
  });
});

describe('updateTicket', () => {
  it('updates status, priority, and assignee, and records an audit log entry', async () => {
    const owner = await createTestUser();
    const admin = await createTestUser({ name: 'Admin', email: 'admin2@test.local', role: 'admin' });
    const ticket = await createTicket(owner.id, 'user', {
      title: 'Assign me',
      description: 'x',
      priority: 'normal',
      type: 'other',
    });

    const updated = await updateTicket(
      ticket.id,
      { status: 'escalated', priority: 'urgent', assigneeIds: [admin.id] },
      admin.id,
    );

    expect(updated.status).toBe('escalated');
    expect(updated.priority).toBe('urgent');
    expect(updated.assignees.map((a) => a.id)).toEqual([admin.id]);

    // ticket.create was already logged when the ticket was set up above; this update adds a
    // second entry for the same ticket.
    const auditEntries = await prisma.auditLog.findMany({
      where: { targetId: ticket.id, action: 'ticket.update' },
    });
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0]?.action).toBe('ticket.update');
  });

  it('updates title and description', async () => {
    const owner = await createTestUser();
    const admin = await createTestUser({ name: 'Admin', email: 'admin-title@test.local', role: 'admin' });
    const ticket = await createTicket(owner.id, 'user', {
      title: 'Original title',
      description: 'Original description',
      priority: 'normal',
      type: 'other',
    });

    const updated = await updateTicket(
      ticket.id,
      { title: 'Renamed', description: 'Updated description' },
      admin.id,
    );

    expect(updated.title).toBe('Renamed');
    expect(updated.description).toBe('Updated description');
  });

  it('unassigns when assigneeIds is explicitly empty', async () => {
    const owner = await createTestUser();
    const admin = await createTestUser({ name: 'Admin', email: 'admin3@test.local', role: 'admin' });
    const ticket = await createTicket(owner.id, 'user', {
      title: 'Unassign me',
      description: 'x',
      priority: 'normal',
      type: 'other',
    });
    await updateTicket(ticket.id, { assigneeIds: [admin.id] }, admin.id);

    const unassigned = await updateTicket(ticket.id, { assigneeIds: [] }, admin.id);
    expect(unassigned.assignees).toEqual([]);
  });

  it('supports multiple assignees on the same ticket', async () => {
    const owner = await createTestUser();
    const adminA = await createTestUser({ name: 'Admin A', email: 'admina@test.local', role: 'admin' });
    const adminB = await createTestUser({ name: 'Admin B', email: 'adminb@test.local', role: 'admin' });
    const ticket = await createTicket(owner.id, 'user', {
      title: 'Pair up',
      description: 'x',
      priority: 'normal',
      type: 'other',
    });

    const updated = await updateTicket(ticket.id, { assigneeIds: [adminA.id, adminB.id] }, adminA.id);
    expect(updated.assignees.map((a) => a.id).sort()).toEqual([adminA.id, adminB.id].sort());
  });

  it('rejects assigning a ticket to a non-admin user', async () => {
    const owner = await createTestUser();
    const admin = await createTestUser({ name: 'Admin', email: 'admin4@test.local', role: 'admin' });
    const regularUser = await createTestUser({ name: 'Regular', email: 'regular@test.local' });
    const ticket = await createTicket(owner.id, 'user', {
      title: 'Bad assign',
      description: 'x',
      priority: 'normal',
      type: 'other',
    });

    await expect(
      updateTicket(ticket.id, { assigneeIds: [regularUser.id] }, admin.id),
    ).rejects.toThrow('Tickets can only be assigned to admins');
  });

  it('sets resolvedAt when status moves to resolved, and clears it on reopen', async () => {
    const owner = await createTestUser();
    const admin = await createTestUser({ name: 'Admin', email: 'admin5@test.local', role: 'admin' });
    const ticket = await createTicket(owner.id, 'user', {
      title: 'Resolve me',
      description: 'x',
      priority: 'normal',
      type: 'other',
    });

    const resolved = await updateTicket(ticket.id, { status: 'resolved' }, admin.id);
    expect(resolved.resolvedAt).not.toBeNull();

    const reopened = await updateTicket(ticket.id, { status: 'open' }, admin.id);
    expect(reopened.resolvedAt).toBeNull();
  });

  it('sets and clears the SLA due date', async () => {
    const owner = await createTestUser();
    const admin = await createTestUser({ name: 'Admin', email: 'admin6@test.local', role: 'admin' });
    const ticket = await createTicket(owner.id, 'user', {
      title: 'SLA test',
      description: 'x',
      priority: 'normal',
      type: 'other',
    });

    const dueAt = new Date(Date.now() + 1000 * 60 * 60).toISOString();
    const withSla = await updateTicket(ticket.id, { slaDueAt: dueAt }, admin.id);
    expect(withSla.slaDueAt?.toISOString()).toBe(dueAt);

    const cleared = await updateTicket(ticket.id, { slaDueAt: null }, admin.id);
    expect(cleared.slaDueAt).toBeNull();
  });

  it('sets and replaces tags', async () => {
    const owner = await createTestUser();
    const admin = await createTestUser({ name: 'Admin', email: 'admin7@test.local', role: 'admin' });
    const ticket = await createTicket(owner.id, 'user', {
      title: 'Tag test',
      description: 'x',
      priority: 'normal',
      type: 'other',
    });
    const tagA = await prisma.tag.create({ data: { name: 'bug', color: '#ff0000' } });
    const tagB = await prisma.tag.create({ data: { name: 'urgent', color: '#00ff00' } });

    const withTagA = await updateTicket(ticket.id, { tagIds: [tagA.id] }, admin.id);
    expect(withTagA.tags.map((t) => t.id)).toEqual([tagA.id]);

    const withTagB = await updateTicket(ticket.id, { tagIds: [tagB.id] }, admin.id);
    expect(withTagB.tags.map((t) => t.id)).toEqual([tagB.id]);
  });
});

describe('listTicketsForAdminQueue', () => {
  it('filters by status, priority, assignee, tag, and overdue-only', async () => {
    const owner = await createTestUser();
    const admin = await createTestUser({ name: 'Admin', email: 'queue-admin@test.local', role: 'admin' });
    const tag = await prisma.tag.create({ data: { name: 'network', color: '#123456' } });

    const overdueTicket = await createTicket(owner.id, 'user', {
      title: 'Overdue ticket',
      description: 'x',
      priority: 'urgent',
      type: 'other',
    });
    await updateTicket(
      overdueTicket.id,
      { assigneeIds: [admin.id], tagIds: [tag.id], slaDueAt: new Date(Date.now() - 1000).toISOString() },
      admin.id,
    );

    await createTicket(owner.id, 'user', { title: 'Fine ticket', description: 'x', priority: 'low', type: 'other' });

    const overdueResults = await listTicketsForAdminQueue({ overdueOnly: true });
    expect(overdueResults.map((t) => t.id)).toEqual([overdueTicket.id]);

    const byPriority = await listTicketsForAdminQueue({ priority: 'urgent' });
    expect(byPriority.map((t) => t.id)).toEqual([overdueTicket.id]);

    const byTag = await listTicketsForAdminQueue({ tagId: tag.id });
    expect(byTag.map((t) => t.id)).toEqual([overdueTicket.id]);

    const byAssignee = await listTicketsForAdminQueue({ assigneeId: admin.id });
    expect(byAssignee.map((t) => t.id)).toEqual([overdueTicket.id]);
  });

  it('filters by createdById, watcherId, and type', async () => {
    const owner = await createTestUser({ name: 'Submitter One' });
    const otherOwner = await createTestUser({ name: 'Submitter Two', email: 'other-owner@test.local' });
    const watcher = await createTestUser({ name: 'Watcher', email: 'watcher-queue@test.local' });

    const ccdTicket = await createTicket(owner.id, 'user', {
      title: 'CCd bug report',
      description: 'x',
      priority: 'normal',
      type: 'bug',
      ccUserIds: [watcher.id],
    });
    await createTicket(otherOwner.id, 'user', {
      title: 'Unrelated feature request',
      description: 'y',
      priority: 'normal',
      type: 'feature',
    });

    expect((await listTicketsForAdminQueue({ createdById: [owner.id] })).map((t) => t.id)).toEqual([ccdTicket.id]);
    expect((await listTicketsForAdminQueue({ watcherId: [watcher.id] })).map((t) => t.id)).toEqual([ccdTicket.id]);
    expect((await listTicketsForAdminQueue({ type: 'bug' })).map((t) => t.id)).toEqual([ccdTicket.id]);
  });

  it('full-text searches title, description, and message bodies, ranked by relevance', async () => {
    const owner = await createTestUser();
    const admin = await createTestUser({ name: 'Search Admin', email: 'search-admin@test.local', role: 'admin' });

    const titleMatch = await createTicket(owner.id, 'user', {
      title: 'Printer spontaneously combusted',
      description: 'no further detail',
      priority: 'normal',
      type: 'bug',
    });
    const descriptionMatch = await createTicket(owner.id, 'user', {
      title: 'Office equipment issue',
      description: 'the printer is spontaneously combusting again',
      priority: 'normal',
      type: 'bug',
    });
    const messageMatch = await createTicket(owner.id, 'user', {
      title: 'Follow-up needed',
      description: 'see thread',
      priority: 'normal',
      type: 'other',
    });
    await addMessage(messageMatch.id, admin.id, {
      body: 'Confirmed: the printer combusted spontaneously this morning',
      isInternalNote: false,
    });
    await createTicket(owner.id, 'user', {
      title: 'Totally unrelated',
      description: 'nothing to see here',
      priority: 'normal',
      type: 'other',
    });

    const results = await listTicketsForAdminQueue({ search: 'printer combusted' });
    const resultIds = results.map((t) => t.id);
    expect(resultIds).toEqual(expect.arrayContaining([titleMatch.id, descriptionMatch.id, messageMatch.id]));
    expect(resultIds).toHaveLength(3);
    // Title match should rank at or above description/message matches for the same terms.
    expect(resultIds[0]).toBe(titleMatch.id);
  });
});

describe('resolveSearchTokensToFilters', () => {
  it('resolves submitter/cced/assigned/tag tokens to ids and status/priority/type tokens directly', async () => {
    const submitter = await createTestUser({ name: 'Jane Submitter', email: 'jane-submitter@test.local' });
    const ccdUser = await createTestUser({ name: 'Casey Cc', email: 'casey-cc@test.local' });
    const assignee = await createTestUser({ name: 'Alex Assignee', email: 'alex-assignee@test.local', role: 'admin' });
    const tag = await prisma.tag.create({ data: { name: 'infra-token-test', color: '#654321' } });

    const filters = await resolveSearchTokensToFilters([
      { type: 'submitter', value: 'Jane Submitter' },
      { type: 'cced', value: 'Casey Cc' },
      { type: 'assigned', value: 'Alex Assignee' },
      { type: 'tag', value: 'infra-token-test' },
      { type: 'status', value: 'pending' },
      { type: 'priority', value: 'urgent' },
      { type: 'type', value: 'bug' },
      { type: 'status', value: 'not-a-real-status' },
    ]);

    expect(filters.createdById).toEqual([submitter.id]);
    expect(filters.watcherId).toEqual([ccdUser.id]);
    expect(filters.assigneeId).toEqual([assignee.id]);
    expect(filters.tagId).toEqual([tag.id]);
    expect(filters.status).toBe('pending');
    expect(filters.priority).toBe('urgent');
    expect(filters.type).toBe('bug');
  });

  it('feeds resolved token filters end-to-end into listTicketsForAdminQueue', async () => {
    const submitter = await createTestUser({ name: 'Token Owner', email: 'token-owner@test.local' });
    const otherOwner = await createTestUser({ name: 'Other Owner', email: 'other-owner-2@test.local' });

    const matching = await createTicket(submitter.id, 'user', {
      title: 'Matches by submitter token',
      description: 'x',
      priority: 'normal',
      type: 'other',
    });
    await createTicket(otherOwner.id, 'user', {
      title: 'Does not match',
      description: 'y',
      priority: 'normal',
      type: 'other',
    });

    const filters = await resolveSearchTokensToFilters([{ type: 'submitter', value: 'Token Owner' }]);
    const results = await listTicketsForAdminQueue(filters);
    expect(results.map((t) => t.id)).toEqual([matching.id]);
  });
});

describe('getTicketMetrics', () => {
  it('computes status counts, overdue count, and average resolution time', async () => {
    const owner = await createTestUser();
    const admin = await createTestUser({ name: 'Admin', email: 'metrics-admin@test.local', role: 'admin' });

    const openTicket = await createTicket(owner.id, 'user', { title: 'Open', description: 'x', priority: 'normal', type: 'other' });
    await updateTicket(openTicket.id, { slaDueAt: new Date(Date.now() - 1000).toISOString() }, admin.id);

    const resolvedTicket = await createTicket(owner.id, 'user', {
      title: 'Resolved',
      description: 'x',
      priority: 'high',
      type: 'other',
    });
    await updateTicket(resolvedTicket.id, { status: 'resolved' }, admin.id);

    const metrics = await getTicketMetrics();
    expect(metrics.totalOpen).toBe(1);
    expect(metrics.totalResolved).toBe(1);
    expect(metrics.overdueCount).toBe(1);
    expect(metrics.avgResolutionMs).not.toBeNull();
    expect(metrics.byPriority.normal).toBe(1);
    expect(metrics.byPriority.high).toBe(1);
  });
});

describe('ticket share links', () => {
  it('CCs the redeeming user as a watcher and is reusable for a second person', async () => {
    const owner = await createTestUser();
    const friend = await createTestUser({ name: 'Friend', email: 'friend@test.local' });
    const other = await createTestUser({ name: 'Other', email: 'other-cc@test.local' });

    const ticket = await createTicket(owner.id, 'user', {
      title: 'Shared ticket',
      description: 'x',
      priority: 'normal',
      type: 'other',
    });

    const { path } = await createTicketShareLink(ticket.id, owner.id);
    const token = tokenFromPath(path);

    expect(await previewTicketShareLink(token, ticket.id)).toEqual({ ticketTitle: ticket.title });

    await redeemTicketShareLink(token, ticket.id, friend.id);
    let updated = await prisma.ticket.findUniqueOrThrow({
      where: { id: ticket.id },
      include: { watchers: true },
    });
    expect(updated.watchers.map((w) => w.id)).toEqual([friend.id]);

    await redeemTicketShareLink(token, ticket.id, other.id);
    updated = await prisma.ticket.findUniqueOrThrow({
      where: { id: ticket.id },
      include: { watchers: true },
    });
    expect(updated.watchers.map((w) => w.id).sort()).toEqual([friend.id, other.id].sort());
  });

  it('is a no-op when the redeeming user already has access', async () => {
    const owner = await createTestUser();
    const ticket = await createTicket(owner.id, 'user', {
      title: 'Own ticket',
      description: 'x',
      priority: 'normal',
      type: 'other',
    });

    const { path } = await createTicketShareLink(ticket.id, owner.id);
    await redeemTicketShareLink(tokenFromPath(path), ticket.id, owner.id);

    const updated = await prisma.ticket.findUniqueOrThrow({
      where: { id: ticket.id },
      include: { watchers: true },
    });
    expect(updated.watchers).toHaveLength(0);
  });

  it('rejects an expired or mismatched-ticket token', async () => {
    const owner = await createTestUser();
    const friend = await createTestUser({ name: 'Friend', email: 'friend2@test.local' });

    const ticketA = await createTicket(owner.id, 'user', {
      title: 'A',
      description: 'x',
      priority: 'normal',
      type: 'other',
    });
    const ticketB = await createTicket(owner.id, 'user', {
      title: 'B',
      description: 'x',
      priority: 'normal',
      type: 'other',
    });

    const { path } = await createTicketShareLink(ticketA.id, owner.id);
    const token = tokenFromPath(path);

    expect(await previewTicketShareLink(token, ticketB.id)).toBeNull();
    await expect(redeemTicketShareLink(token, ticketB.id, friend.id)).rejects.toThrow();
  });
});
