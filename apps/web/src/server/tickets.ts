import { randomBytes, createHash } from 'node:crypto';
import { prisma, Prisma, type User } from '@ticketing/db';
import {
  CLOSE_REASON_LABELS,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_TYPES,
  evaluateVisibility,
  type CreateInternalTicketInput,
  type CreateMessageInput,
  type CreateTicketInput,
  type CustomFieldDef,
  type GroupFormConfig,
  type SearchToken,
  type TicketPriority,
  type TicketStatus,
  type TicketType,
  type UpdateTicketInput,
} from '@ticketing/shared';
import { AppError, NotFoundError } from '@/lib/errors';
import { writeAuditLog } from '@/server/audit';
import { recordTicketHistory, type TicketHistoryEntryInput } from '@/server/ticketHistory';
import {
  handleActiveStatusTransition,
  handlePendingTransition,
  notifyNewTicketChannel,
  notifyReply,
  notifyStatusChanged,
  notifyTicketCreated,
} from '@/server/notifications';
import { publishTicketMessage } from '@/server/ticket-events';
import { lookupDirectoryUserByDiscordUsername } from '@/lib/directoryService';

const TICKET_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const DISCORD_CLAIM_TTL_MS = 1000 * 60 * 30; // 30 minutes
const SHARE_LINK_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

export const RESOLVED_STATUSES: readonly TicketStatus[] = ['resolved', 'closed'];

export function isOverdue(ticket: { slaDueAt: Date | null; status: string }): boolean {
  if (!ticket.slaDueAt) return false;
  if (RESOLVED_STATUSES.includes(ticket.status as TicketStatus)) return false;
  return ticket.slaDueAt.getTime() < Date.now();
}

export interface TicketQueueFilters {
  status?: TicketStatus;
  priority?: TicketPriority;
  type?: TicketType;
  /** Array form supports multiple `assigned:`/`tag:` search tokens (OR'd together). */
  assigneeId?: string | string[];
  tagId?: string | string[];
  createdById?: string[];
  watcherId?: string[];
  overdueOnly?: boolean;
  /** Free text matched against title/description/message bodies/OCR'd attachment text. */
  search?: string;
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

const ACTIVE_STATUS_GROUPS: readonly TicketStatus[] = ['open', 'escalated', 'pending', 'in_progress'];

export function groupTicketsByStatus<T extends { status: string; createdAt: Date; updatedAt: Date }>(
  tickets: T[],
): { active: Record<(typeof ACTIVE_STATUS_GROUPS)[number], T[]>; closedOrResolved: T[] } {
  const active = ACTIVE_STATUS_GROUPS.reduce(
    (acc, status) => ({
      ...acc,
      [status]: tickets
        .filter((t) => t.status === status)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    }),
    {} as Record<(typeof ACTIVE_STATUS_GROUPS)[number], T[]>,
  );

  const closedOrResolved = tickets
    .filter((t) => RESOLVED_STATUSES.includes(t.status as TicketStatus))
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

  return { active, closedOrResolved };
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Atomically increments (creating if absent) the current year's row in
 * TicketIncidentCounter and returns the next "INC-YYYY-NNNNNN" ref. Must run inside
 * the same $transaction as the ticket create it backs, so a rolled-back ticket create
 * doesn't leave the counter incremented and a number burned.
 */
async function nextIncidentNumber(tx: Prisma.TransactionClient): Promise<string> {
  const year = new Date().getFullYear();
  const rows = await tx.$queryRaw<{ lastValue: number }[]>`
    INSERT INTO "ticket_incident_counters" ("year", "lastValue")
    VALUES (${year}, 1)
    ON CONFLICT ("year") DO UPDATE SET "lastValue" = "ticket_incident_counters"."lastValue" + 1
    RETURNING "lastValue"
  `;
  const row = rows[0];
  if (!row) throw new Error('Failed to allocate incident number');
  return `INC-${year}-${String(row.lastValue).padStart(6, '0')}`;
}

/**
 * Always scoped to tickets the user submitted or is cc'd on -- admins included. Admins reach
 * every ticket through listTicketsForAdminQueue (the separate admin queue page), never here.
 */
export async function listTicketsForUser(userId: string) {
  return prisma.ticket.findMany({
    where: { OR: [{ createdById: userId }, { watchers: { some: { id: userId } } }] },
    orderBy: { updatedAt: 'desc' },
    include: { createdBy: true, assignees: true, tags: true, watchers: true },
  });
}

/**
 * "Incoming" tab: every ticket routed to a group the user belongs to (regardless of who
 * created/CC'd it or is assigned) -- distinct from listTicketsForUser, which is scoped to
 * tickets the caller personally submitted or is CC'd on.
 */
export async function listTicketsForGroupQueue(userId: string) {
  return prisma.ticket.findMany({
    where: { group: { members: { some: { id: userId } } } },
    orderBy: { updatedAt: 'desc' },
    include: { createdBy: true, assignees: true, tags: true, watchers: true, group: true },
  });
}

/** Full admin queue: every ticket, with filters. Callers must gate this behind requireAdmin(). */
export async function listTicketsForAdminQueue(filters: TicketQueueFilters = {}) {
  const where: Prisma.TicketWhereInput = {};
  if (filters.status) where.status = filters.status;
  if (filters.priority) where.priority = filters.priority;
  if (filters.type) where.type = filters.type;

  const assigneeIds = toArray(filters.assigneeId);
  if (assigneeIds.length > 0) where.assignees = { some: { id: { in: assigneeIds } } };

  const tagIds = toArray(filters.tagId);
  if (tagIds.length > 0) where.tags = { some: { id: { in: tagIds } } };

  if (filters.createdById && filters.createdById.length > 0) {
    where.createdById = { in: filters.createdById };
  }
  if (filters.watcherId && filters.watcherId.length > 0) {
    where.watchers = { some: { id: { in: filters.watcherId } } };
  }

  if (filters.overdueOnly) {
    where.slaDueAt = { lt: new Date() };
    where.status = { notIn: [...RESOLVED_STATUSES] };
  }

  // Free text is matched via the search_vector column (title/description/message bodies/OCR'd
  // attachment text, maintained by Postgres triggers -- see the tickets_search_vector migration)
  // rather than a Prisma `where` clause, since ts_rank ordering has to win over updatedAt.
  let rankedIds: string[] | null = null;
  if (filters.search) {
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "tickets"
      WHERE "searchVector" @@ websearch_to_tsquery('english', ${filters.search})
      ORDER BY ts_rank("searchVector", websearch_to_tsquery('english', ${filters.search})) DESC
    `;
    rankedIds = rows.map((r) => r.id);
    if (rankedIds.length === 0) return [];
    where.id = { in: rankedIds };
  }

  const tickets = await prisma.ticket.findMany({
    where,
    orderBy: rankedIds ? undefined : { updatedAt: 'desc' },
    include: { createdBy: true, assignees: true, tags: true, watchers: true },
  });

  if (!rankedIds) return tickets;

  const rank = new Map(rankedIds.map((id, index) => [id, index]));
  return [...tickets].sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
}

/** Resolves a `submitter:`/`cced:` token value (name or email substring) to matching user ids. */
async function resolveUserIdsBySubstring(query: string): Promise<string[]> {
  const matches = await prisma.user.findMany({
    where: {
      OR: [
        { name: { contains: query, mode: 'insensitive' } },
        { email: { contains: query, mode: 'insensitive' } },
      ],
    },
    select: { id: true },
  });
  return matches.map((u) => u.id);
}

/** Resolves an `assigned:` token value to matching admin user ids (assignees are always admins). */
async function resolveAssigneeIdsBySubstring(query: string): Promise<string[]> {
  const matches = await prisma.user.findMany({
    where: { role: 'admin', name: { contains: query, mode: 'insensitive' } },
    select: { id: true },
  });
  return matches.map((u) => u.id);
}

/** Resolves a `tag:` token value to matching tag ids. */
async function resolveTagIdsByName(query: string): Promise<string[]> {
  const matches = await prisma.tag.findMany({
    where: { name: { contains: query, mode: 'insensitive' } },
    select: { id: true },
  });
  return matches.map((t) => t.id);
}

/**
 * Converts parsed `key:value` search tokens (see `parseSearchQuery` in @ticketing/shared) into
 * `TicketQueueFilters`, resolving name-ish tokens (submitter/cced/assigned/tag) to real ids.
 * Multiple tokens of the same type accumulate (OR'd via the `some.id.in` clauses above);
 * `status`/`priority`/`type` tokens must exactly match a known value or are silently ignored.
 */
export async function resolveSearchTokensToFilters(
  tokens: SearchToken[],
): Promise<Partial<TicketQueueFilters>> {
  const filters: Partial<TicketQueueFilters> = {};

  for (const token of tokens) {
    switch (token.type) {
      case 'submitter': {
        const ids = await resolveUserIdsBySubstring(token.value);
        filters.createdById = [...(filters.createdById ?? []), ...ids];
        break;
      }
      case 'cced': {
        const ids = await resolveUserIdsBySubstring(token.value);
        filters.watcherId = [...(filters.watcherId ?? []), ...ids];
        break;
      }
      case 'assigned': {
        const ids = await resolveAssigneeIdsBySubstring(token.value);
        filters.assigneeId = [...toArray(filters.assigneeId), ...ids];
        break;
      }
      case 'tag': {
        const ids = await resolveTagIdsByName(token.value);
        filters.tagId = [...toArray(filters.tagId), ...ids];
        break;
      }
      case 'status':
        if ((TICKET_STATUSES as readonly string[]).includes(token.value)) {
          filters.status = token.value as TicketStatus;
        }
        break;
      case 'priority':
        if ((TICKET_PRIORITIES as readonly string[]).includes(token.value)) {
          filters.priority = token.value as TicketPriority;
        }
        break;
      case 'type':
        if ((TICKET_TYPES as readonly string[]).includes(token.value)) {
          filters.type = token.value as TicketType;
        }
        break;
    }
  }

  return filters;
}

export async function getTicketOr404(ticketId: string) {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    include: {
      createdBy: true,
      assignees: true,
      tags: true,
      watchers: true,
      group: { include: { members: { select: { id: true } } } },
      attachments: { orderBy: { createdAt: 'asc' }, include: { uploadedBy: true } },
      messages: { orderBy: { createdAt: 'asc' }, include: { author: true } },
      history: { orderBy: { createdAt: 'desc' }, include: { actor: true } },
    },
  });
  if (!ticket) throw new NotFoundError('Ticket not found');
  return ticket;
}

interface TicketGroupContext {
  groupId?: string | null;
  group?: { members?: { id: string }[] } | null;
}

/** True if the user belongs to the TicketGroup this ticket is routed to. False for "unsure" (groupId null) tickets -- those are admin-only, same as before groups existed. */
export function isTicketGroupMember(ticket: TicketGroupContext, userId: string): boolean {
  if (!ticket.groupId || !ticket.group) return false;
  return (ticket.group.members ?? []).some((m) => m.id === userId);
}

export function canViewTicket(
  ticket: { createdById: string; assignees?: { id: string }[]; watchers?: { id: string }[] } & TicketGroupContext,
  user: { id: string; role: 'user' | 'admin' } | null,
): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return (
    ticket.createdById === user.id ||
    (ticket.assignees ?? []).some((a) => a.id === user.id) ||
    (ticket.watchers ?? []).some((w) => w.id === user.id) ||
    isTicketGroupMember(ticket, user.id)
  );
}

/** Group members may edit the ticket like an admin, except for internal notes (still admin-only -- gated separately, not here). */
export function canManageTicket(
  ticket: TicketGroupContext,
  user: { id: string; role: 'user' | 'admin' },
): boolean {
  return user.role === 'admin' || isTicketGroupMember(ticket, user.id);
}

export async function verifyTicketToken(ticketId: string, token: string): Promise<boolean> {
  const tokenHash = hashToken(token);
  const record = await prisma.ticketAccessToken.findUnique({ where: { tokenHash } });
  if (!record || record.ticketId !== ticketId) return false;
  if (record.expiresAt < new Date()) return false;
  return true;
}

/** Only the ticket's creator or an admin may mint a share link. */
export function canShareTicket(
  ticket: { createdById: string },
  user: { id: string; role: 'user' | 'admin' },
): boolean {
  return user.role === 'admin' || ticket.createdById === user.id;
}

/** Mints (or re-mints) a reusable "share ticket" invite link. Redeeming it CCs whoever opens
 * it -- see redeemTicketShareLink -- so it's intentionally not single-use. */
export async function createTicketShareLink(ticketId: string, createdById: string) {
  const rawToken = randomBytes(32).toString('hex');
  await prisma.ticketShareLink.create({
    data: {
      ticketId,
      createdById,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + SHARE_LINK_TTL_MS),
    },
  });
  return { path: `/t/${ticketId}/share?token=${rawToken}` };
}

/** Read-only lookup for the share-link redemption page. */
export async function previewTicketShareLink(token: string, ticketId: string) {
  const link = await prisma.ticketShareLink.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!link || link.ticketId !== ticketId || link.expiresAt < new Date()) return null;
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) return null;
  return { ticketTitle: ticket.title };
}

/** Adds the signed-in user as a watcher (CC) on the ticket a share link points to. Idempotent --
 * safe to call repeatedly for the same user (e.g. reopening the link) or for someone who
 * already has access (owner, assignee, admin), in which case it's a no-op. */
export async function redeemTicketShareLink(token: string, ticketId: string, userId: string) {
  const link = await prisma.ticketShareLink.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!link || link.ticketId !== ticketId || link.expiresAt < new Date()) {
    throw new AppError('This share link has expired. Ask the ticket owner to share it again.');
  }

  const ticket = await getTicketOr404(ticketId);
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new NotFoundError('User not found');

  const alreadyHasAccess = canViewTicket(ticket, { id: userId, role: user.role });
  if (!alreadyHasAccess) {
    await prisma.ticket.update({
      where: { id: ticketId },
      data: { watchers: { connect: { id: userId } } },
    });
    await writeAuditLog(userId, 'ticket.share_link_redeem', 'Ticket', ticketId, {});
  }

  return { ticketId };
}

const DEFAULT_TICKET_PRIORITY: TicketPriority = 'normal';
const DEFAULT_TICKET_TYPE: TicketType = 'other';

interface ResolvedTicketFormFields {
  description: string;
  priority: TicketPriority;
  type: TicketType;
  /** Null when the group has no custom fields configured (nothing to persist). */
  customFieldValues: Record<string, string | boolean> | null;
}

/**
 * Reconciles what the requester submitted against the routed group's formConfig
 * (null when there's no group, or the group uses the default form):
 * - a standard field the group hides never trusts the client's value -- the group's
 *   configured default is used instead
 * - a standard field the group shows is required/optional per that config, not the
 *   pre-groups defaults
 * - every custom field's visibility is re-evaluated from the *effective* values (never
 *   the client's claimed visibility); a field that evaluates hidden has its submitted
 *   value dropped entirely, never persisted
 */
interface ResolvedStandardFields {
  description: string;
  priority: TicketPriority;
  type: TicketType;
}

/** The description/priority/type portion of resolveTicketFormFields, split out so
 * createTicketFromDiscord can apply the same hidden-field/default-value/required
 * reconciliation without the custom-fields half (the Discord bot's /ticket form
 * doesn't render a group's custom fields -- known gap, see docs/ticket-group-custom-fields-plan.md). */
function resolveStandardTicketFields(
  input: Pick<CreateTicketInput, 'description' | 'priority' | 'type'>,
  formConfig: GroupFormConfig | null,
): ResolvedStandardFields {
  const standard = formConfig?.standardFields ?? {};

  function resolveStandard(
    key: 'description' | 'priority' | 'type',
    submitted: string | undefined,
    fallbackDefault: string,
    requiredByDefault: boolean,
  ): string {
    const cfg = standard[key];
    if (cfg && !cfg.shown) return cfg.defaultValue ?? fallbackDefault;

    if (submitted !== undefined && submitted !== '') return submitted;

    const required = cfg ? cfg.required : requiredByDefault;
    if (required) throw new AppError(`"${key}" is required`);
    return fallbackDefault;
  }

  return {
    description: resolveStandard('description', input.description, '', true),
    priority: resolveStandard('priority', input.priority, DEFAULT_TICKET_PRIORITY, false) as TicketPriority,
    type: resolveStandard('type', input.type, DEFAULT_TICKET_TYPE, false) as TicketType,
  };
}

function resolveTicketFormFields(input: CreateTicketInput, formConfig: GroupFormConfig | null): ResolvedTicketFormFields {
  const { description, priority, type } = resolveStandardTicketFields(input, formConfig);

  if (!formConfig || formConfig.customFields.length === 0) {
    return { description, priority, type, customFieldValues: null };
  }

  const submittedCustom = input.customFieldValues ?? {};
  // What visibility rules evaluate against: effective (post-default) standard values plus
  // whatever the requester answered, mirroring exactly what they saw on the form.
  const liveValues: Record<string, string | boolean | undefined> = { priority, type, ...submittedCustom };

  const customFieldValues: Record<string, string | boolean> = {};
  for (const field of formConfig.customFields as CustomFieldDef[]) {
    if (!evaluateVisibility(field.visibility, liveValues)) continue;

    const value = submittedCustom[field.id];

    if (field.kind === 'dropdown') {
      const isValidOption = typeof value === 'string' && field.options.some((o) => o.value === value);
      customFieldValues[field.id] = isValidOption ? (value as string) : field.defaultValue;
      continue;
    }

    if (field.kind === 'checkbox') {
      customFieldValues[field.id] = value === true;
      continue;
    }

    if (field.required && (value === undefined || value === '')) {
      throw new AppError(`"${field.label}" is required`);
    }
    if (typeof value === 'string' && value !== '') customFieldValues[field.id] = value;
  }

  return { description, priority, type, customFieldValues };
}

export async function createTicket(
  userId: string,
  actorRole: 'user' | 'admin',
  input: CreateTicketInput,
) {
  const ccUserIds = input.ccUserIds ?? [];
  if (ccUserIds.includes(userId)) {
    throw new AppError('Cannot cc yourself on a ticket');
  }
  if (ccUserIds.length > 0) {
    const ccUsers = await prisma.user.findMany({ where: { id: { in: ccUserIds } } });
    if (ccUsers.length !== ccUserIds.length) throw new AppError('One or more CC users not found');
  }

  // groupId null/undefined = "unsure" -- routed to admins only, unchanged from pre-groups behavior.
  let group: { id: string; members: { id: string }[]; formConfig: GroupFormConfig | null } | null = null;
  if (input.groupId) {
    const found = await prisma.ticketGroup.findUnique({
      where: { id: input.groupId },
      include: { members: { select: { id: true } } },
    });
    if (!found) throw new AppError('Group not found');
    group = { ...found, formConfig: found.formConfig as GroupFormConfig | null };
  }

  const { description, priority, type, customFieldValues } = resolveTicketFormFields(input, group?.formConfig ?? null);

  const assigneeIds = input.assigneeIds ?? [];
  if (assigneeIds.length > 0) {
    if (actorRole !== 'admin') {
      throw new AppError('Only admins can assign a ticket at creation time');
    }
    const groupMemberIds = new Set((group?.members ?? []).map((m) => m.id));
    const assignees = await prisma.user.findMany({ where: { id: { in: assigneeIds } } });
    const allValid =
      assignees.length === assigneeIds.length &&
      assignees.every((a) => a.role === 'admin' || groupMemberIds.has(a.id));
    if (!allValid) {
      throw new AppError('Tickets can only be assigned to admins or members of the ticket\'s group');
    }
  }

  const ticket = await prisma.$transaction(async (tx) => {
    const incidentNumber = await nextIncidentNumber(tx);
    return tx.ticket.create({
      data: {
        incidentNumber,
        title: input.title,
        description,
        priority,
        type,
        createdById: userId,
        groupId: group?.id,
        customFieldValues: customFieldValues ?? Prisma.JsonNull,
        watchers: ccUserIds.length > 0 ? { connect: ccUserIds.map((id) => ({ id })) } : undefined,
        assignees:
          assigneeIds.length > 0 ? { connect: assigneeIds.map((id) => ({ id })) } : undefined,
        // Ticket.status defaults to 'open', which is in the active-reminder status set --
        // stamp the clock at creation so the 24h assignee reminder sweep has a start point.
        activeSince: new Date(),
      },
      include: { watchers: true, assignees: true },
    });
  });

  await writeAuditLog(userId, 'ticket.create', 'Ticket', ticket.id, input as Prisma.InputJsonValue);
  // Deferred import: keeps env.ts's required-var validation out of the module load path for
  // pure-function unit tests that never call createTicket.
  const { env } = await import('@/lib/env');
  await notifyNewTicketChannel(ticket, env.publicAppUrl);

  return ticket;
}

/**
 * Resolves the ticketing-system owner for an incoming Discord ticket.
 *
 * Resolution order:
 * 1. Local `discordId` match (fast path -- already resolved by a prior call, either through
 *    this same lookup or the legacy claim flow).
 * 2. directory-service lookup by Discord username. directory-service is the source of truth
 *    for org-member Discord linkage (see hourly discordId refresh sweep), so a match here means
 *    a real org member even if they've never signed in to ticketing via Authentik before --
 *    upsert a real (non-placeholder) User by email, no claim step needed.
 * 3. No match anywhere (genuine outsider/guest, not an org member): fall back to the
 *    Discord-only placeholder + claim-on-first-login flow, unchanged from before.
 */
async function resolveDiscordTicketOwner(
  discordUserId: string,
  discordUsername: string,
): Promise<{ owner: User; isNewUser: boolean }> {
  const existingByDiscordId = await prisma.user.findUnique({ where: { discordId: discordUserId } });
  if (existingByDiscordId) return { owner: existingByDiscordId, isNewUser: false };

  const directoryUser = await lookupDirectoryUserByDiscordUsername(discordUsername);
  if (directoryUser) {
    const existingByEmail = await prisma.user.findUnique({ where: { email: directoryUser.email } });
    const owner = await prisma.user.upsert({
      where: { email: directoryUser.email },
      create: {
        email: directoryUser.email,
        name: directoryUser.name || discordUsername,
        emailVerified: true,
        discordId: discordUserId,
        isDiscordPlaceholder: false,
      },
      update: {
        discordId: discordUserId,
        isDiscordPlaceholder: false,
      },
    });
    return { owner, isNewUser: !existingByEmail };
  }

  const owner = await prisma.user.create({
    data: {
      email: `discord-${discordUserId}@placeholder.invalid`,
      name: discordUsername,
      discordId: discordUserId,
      emailVerified: false,
      isDiscordPlaceholder: true,
    },
  });
  return { owner, isNewUser: true };
}

/**
 * Creates a ticket from a Discord interaction. See resolveDiscordTicketOwner for owner
 * resolution. A placeholder owner (true outsider, not found anywhere) gets a claim link that,
 * once they sign in with Authentik, silently attaches their discordId to their real account
 * (see claimDiscordAccount). Everyone else gets a direct token URL -- no login required.
 */
export async function createTicketFromDiscord(input: CreateInternalTicketInput, baseUrl: string) {
  const { owner, isNewUser } = await resolveDiscordTicketOwner(input.discordUserId, input.discordUsername);

  // groupId null/undefined = "unsure" -- routed to admins only, same as createTicket().
  let groupFormConfig: GroupFormConfig | null = null;
  if (input.groupId) {
    const group = await prisma.ticketGroup.findUnique({ where: { id: input.groupId } });
    if (!group) throw new AppError('Group not found');
    groupFormConfig = group.formConfig as GroupFormConfig | null;
  }
  const { description, priority, type } = resolveStandardTicketFields(input, groupFormConfig);

  if (input.idempotencyKey) {
    const existing = await prisma.ticket.findUnique({
      where: { discordIdempotencyKey: input.idempotencyKey },
    });
    // A bot retry after a dropped response lands here -- ticket already exists, so mint a
    // fresh access link without repeating the audit log, channel announcement, or DM (those
    // already fired on the original successful create).
    if (existing) {
      const rawToken = randomBytes(32).toString('hex');
      await prisma.ticketAccessToken.create({
        data: {
          ticketId: existing.id,
          tokenHash: hashToken(rawToken),
          expiresAt: new Date(Date.now() + TICKET_TOKEN_TTL_MS),
        },
      });
      return { ticket: existing, path: `/t/${existing.id}?token=${rawToken}`, isNewUser: false };
    }
  }

  const ticket = await prisma.$transaction(async (tx) => {
    const incidentNumber = await nextIncidentNumber(tx);
    return tx.ticket.create({
      data: {
        incidentNumber,
        title: input.title,
        description,
        priority,
        type,
        createdById: owner.id,
        groupId: input.groupId ?? undefined,
        discordChannelId: input.discordChannelId,
        discordIdempotencyKey: input.idempotencyKey,
        // Ticket.status defaults to 'open', which is in the active-reminder status set --
        // stamp the clock at creation so the 24h assignee reminder sweep has a start point.
        activeSince: new Date(),
      },
    });
  });

  await writeAuditLog(null, 'ticket.create', 'Ticket', ticket.id, {
    source: 'discord',
    discordUserId: input.discordUserId,
  });
  await notifyNewTicketChannel(ticket, baseUrl);

  if (owner.isDiscordPlaceholder) {
    const rawClaimToken = randomBytes(32).toString('hex');
    await prisma.discordClaim.upsert({
      where: { placeholderUserId: owner.id },
      create: {
        placeholderUserId: owner.id,
        tokenHash: hashToken(rawClaimToken),
        ticketId: ticket.id,
        expiresAt: new Date(Date.now() + DISCORD_CLAIM_TTL_MS),
      },
      update: {
        tokenHash: hashToken(rawClaimToken),
        ticketId: ticket.id,
        expiresAt: new Date(Date.now() + DISCORD_CLAIM_TTL_MS),
      },
    });

    const claimPath = `/link-discord/claim?token=${rawClaimToken}`;
    await notifyTicketCreated(
      { id: ticket.id, incidentNumber: ticket.incidentNumber, title: ticket.title, createdBy: owner },
      `${baseUrl}${claimPath}`,
    );

    return {
      ticket,
      path: claimPath,
      isNewUser,
    };
  }

  const rawToken = randomBytes(32).toString('hex');
  await prisma.ticketAccessToken.create({
    data: {
      ticketId: ticket.id,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + TICKET_TOKEN_TTL_MS),
    },
  });

  const tokenPath = `/t/${ticket.id}?token=${rawToken}`;
  await notifyTicketCreated(
    { id: ticket.id, incidentNumber: ticket.incidentNumber, title: ticket.title, createdBy: owner },
    `${baseUrl}${tokenPath}`,
  );

  return {
    ticket,
    path: tokenPath,
    isNewUser,
  };
}

/**
 * Read-only lookup for the claim confirmation screen -- never mutates. Lets the signed-in user
 * see which Discord account they're about to link before claimDiscordAccount is ever called.
 */
export async function previewDiscordClaim(token: string) {
  const claim = await prisma.discordClaim.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { placeholderUser: true },
  });
  if (!claim || claim.expiresAt < new Date()) return null;

  const ticket = await prisma.ticket.findUnique({ where: { id: claim.ticketId } });
  return {
    discordUsername: claim.placeholderUser.name,
    ticketTitle: ticket?.title ?? 'your ticket',
  };
}

/**
 * Consumes a Discord claim token for the signed-in user: reassigns everything the placeholder
 * owned to the real account, sets discordId on the real account, and deletes the placeholder.
 * Safe to call again with the same token from the same real user (e.g. a duplicate redirect).
 *
 * Only call this from an explicit, user-confirmed POST/Server Action -- never from a page GET.
 * The claim token alone isn't proof of intent: anyone who has it (e.g. the Discord user it was
 * issued to) could get a signed-in victim to open it via a plain link and silently link their
 * own discordId onto the victim's account. The confirmation screen in the claim page is the
 * actual CSRF defense; this function just does the write once the user has agreed.
 */
export async function claimDiscordAccount(token: string, realUserId: string) {
  const tokenHash = hashToken(token);
  const claim = await prisma.discordClaim.findUnique({
    where: { tokenHash },
    include: { placeholderUser: true },
  });
  if (!claim || claim.expiresAt < new Date()) {
    throw new AppError('This link has expired. Open a new ticket from Discord to get a fresh one.');
  }

  const placeholder = claim.placeholderUser;
  if (placeholder.id === realUserId) {
    // Already claimed by this exact session (e.g. a page refresh); nothing left to do.
    await prisma.discordClaim.delete({ where: { id: claim.id } }).catch(() => {});
    return { ticketId: claim.ticketId };
  }

  const realUser = await prisma.user.findUnique({ where: { id: realUserId } });
  if (!realUser) throw new NotFoundError('User not found');

  if (realUser.discordId && realUser.discordId !== placeholder.discordId) {
    throw new AppError('Your account is already linked to a different Discord user');
  }

  // Reassign ownership and delete the placeholder before writing discordId onto realUser --
  // discordId is unique, so both rows can't hold the same value at once mid-transaction.
  await prisma.$transaction([
    prisma.ticket.updateMany({
      where: { createdById: placeholder.id },
      data: { createdById: realUserId },
    }),
    prisma.ticketMessage.updateMany({
      where: { authorId: placeholder.id },
      data: { authorId: realUserId },
    }),
    prisma.ticketAttachment.updateMany({
      where: { uploadedById: placeholder.id },
      data: { uploadedById: realUserId },
    }),
    prisma.user.delete({ where: { id: placeholder.id } }),
    prisma.user.update({
      where: { id: realUserId },
      data: { discordId: placeholder.discordId },
    }),
  ]);

  await writeAuditLog(realUserId, 'discord.claim', 'User', realUserId, {
    placeholderUserId: placeholder.id,
    discordId: placeholder.discordId,
  });

  return { ticketId: claim.ticketId };
}

export async function addMessage(ticketId: string, authorId: string, input: CreateMessageInput) {
  const message = await prisma.ticketMessage.create({
    data: {
      ticketId,
      authorId,
      body: input.body,
      isInternalNote: input.isInternalNote,
    },
    include: { author: true },
  });
  const ticket = await prisma.ticket.update({
    where: { id: ticketId },
    data: { updatedAt: new Date() },
    include: { watchers: true, assignees: true, createdBy: true },
  });

  // Internal notes are admin-only, so the ticket owner/watchers must never be notified of them.
  if (!input.isInternalNote) {
    // Deferred import: keeps env.ts's required-var validation out of the module load path for
    // pure-function unit tests that never call addMessage.
    const { env } = await import('@/lib/env');
    await notifyReply(ticket, authorId, env.publicAppUrl);
  }

  return message;
}

function buildResolutionSystemMessage(
  status: TicketStatus,
  closeReason: UpdateTicketInput['closeReason'],
  resolutionMessage: UpdateTicketInput['resolutionMessage'],
): string {
  if (status === 'closed') {
    const reasonLabel = closeReason ? CLOSE_REASON_LABELS[closeReason] : 'No reason given';
    return resolutionMessage
      ? `Ticket closed: ${reasonLabel}: ${resolutionMessage}`
      : `Ticket closed: ${reasonLabel}`;
  }
  return `Ticket resolved: ${resolutionMessage ?? 'No reason given'}`;
}

interface PreviousTicketState {
  status: TicketStatus;
  priority: TicketPriority;
  slaDueAt: Date | null;
  tags: { id: string; name: string }[];
  watchers: { id: string; name: string }[];
  groupId: string | null;
  group: { name: string } | null;
}

/** Diffs the pre-update ticket state against the patch (and the post-update relations, for
 * added tags/watchers' names) into flat TicketHistory rows -- one per discrete change. */
function buildTicketHistoryEntries(
  previous: PreviousTicketState,
  input: UpdateTicketInput,
  updated: { tags: { id: string; name: string }[]; watchers: { id: string; name: string }[]; group: { name: string } | null },
): TicketHistoryEntryInput[] {
  const entries: TicketHistoryEntryInput[] = [];

  if (input.status && input.status !== previous.status) {
    entries.push({ field: 'status', action: 'changed', fromValue: previous.status, toValue: input.status });
  }

  if (input.priority && input.priority !== previous.priority) {
    entries.push({ field: 'priority', action: 'changed', fromValue: previous.priority, toValue: input.priority });
  }

  if (input.slaDueAt !== undefined) {
    const nextSlaDueAt = input.slaDueAt ? new Date(input.slaDueAt) : null;
    const prevIso = previous.slaDueAt?.toISOString() ?? null;
    const nextIso = nextSlaDueAt?.toISOString() ?? null;
    if (prevIso !== nextIso) {
      entries.push({ field: 'sla', action: 'changed', fromValue: prevIso, toValue: nextIso });
    }
  }

  if (input.tagIds !== undefined) {
    const previousIds = new Set(previous.tags.map((t) => t.id));
    const nextIds = new Set(input.tagIds);
    for (const tag of updated.tags) {
      if (!previousIds.has(tag.id)) entries.push({ field: 'tag', action: 'added', toValue: tag.name });
    }
    for (const tag of previous.tags) {
      if (!nextIds.has(tag.id)) entries.push({ field: 'tag', action: 'removed', fromValue: tag.name });
    }
  }

  if (input.watcherIds !== undefined) {
    const previousIds = new Set(previous.watchers.map((w) => w.id));
    const nextIds = new Set(input.watcherIds);
    for (const watcher of updated.watchers) {
      if (!previousIds.has(watcher.id)) entries.push({ field: 'watcher', action: 'added', toValue: watcher.name });
    }
    for (const watcher of previous.watchers) {
      if (!nextIds.has(watcher.id)) entries.push({ field: 'watcher', action: 'removed', fromValue: watcher.name });
    }
  }

  if (input.groupId !== undefined && input.groupId !== previous.groupId) {
    const label = updated.group?.name ?? 'Unsure (admin only)';
    const fromLabel = previous.group?.name ?? 'Unsure (admin only)';
    entries.push({ field: 'group', action: 'changed', fromValue: fromLabel, toValue: label });
  }

  return entries;
}

export async function updateTicket(ticketId: string, input: UpdateTicketInput, actorId: string) {
  const previous = await prisma.ticket.findUnique({
    where: { id: ticketId },
    select: {
      status: true,
      priority: true,
      slaDueAt: true,
      groupId: true,
      group: { select: { name: true } },
      tags: { select: { id: true, name: true } },
      watchers: { select: { id: true, name: true } },
    },
  });
  if (!previous) throw new NotFoundError('Ticket not found');

  const data: Prisma.TicketUpdateInput = {};

  if (input.title !== undefined) data.title = input.title;
  if (input.description !== undefined) data.description = input.description;

  if (input.status) {
    data.status = input.status;
    data.resolvedAt = RESOLVED_STATUSES.includes(input.status) ? new Date() : null;
  }
  if (input.priority) data.priority = input.priority;
  if (input.type) data.type = input.type;

  if (input.groupId !== undefined) {
    if (input.groupId) {
      const group = await prisma.ticketGroup.findUnique({ where: { id: input.groupId } });
      if (!group) throw new AppError('Group not found');
    }
    data.group = input.groupId ? { connect: { id: input.groupId } } : { disconnect: true };
  }

  if (input.assigneeIds !== undefined) {
    if (input.assigneeIds.length > 0) {
      const targetGroupId = input.groupId !== undefined ? input.groupId : previous.groupId;
      const groupMemberIds = targetGroupId
        ? new Set(
            (
              await prisma.ticketGroup.findUnique({
                where: { id: targetGroupId },
                include: { members: { select: { id: true } } },
              })
            )?.members.map((m) => m.id) ?? [],
          )
        : new Set<string>();
      const assignees = await prisma.user.findMany({ where: { id: { in: input.assigneeIds } } });
      const allValid =
        assignees.length === input.assigneeIds.length &&
        assignees.every((a) => a.role === 'admin' || groupMemberIds.has(a.id));
      if (!allValid) {
        throw new AppError('Tickets can only be assigned to admins or members of the ticket\'s group');
      }
    }
    data.assignees = { set: input.assigneeIds.map((id) => ({ id })) };
  }

  if (input.slaDueAt !== undefined) {
    data.slaDueAt = input.slaDueAt ? new Date(input.slaDueAt) : null;
    // A new/pushed-out deadline invalidates any prior breach alert dedupe stamp.
    data.slaBreachNotifiedAt = null;
  }

  if (input.tagIds !== undefined) {
    data.tags = { set: input.tagIds.map((id) => ({ id })) };
  }

  if (input.watcherIds !== undefined) {
    data.watchers = { set: input.watcherIds.map((id) => ({ id })) };
  }

  const ticket = await prisma.ticket.update({
    where: { id: ticketId },
    data,
    include: { tags: true, assignees: true, createdBy: true, watchers: true, group: { select: { name: true } } },
  });

  await writeAuditLog(actorId, 'ticket.update', 'Ticket', ticketId, input as Prisma.InputJsonValue);
  await recordTicketHistory(ticketId, actorId, buildTicketHistoryEntries(previous, input, ticket));

  if (input.status && input.status !== previous.status) {
    if (RESOLVED_STATUSES.includes(input.status)) {
      const systemMessage = await prisma.ticketMessage.create({
        data: {
          ticketId,
          authorId: actorId,
          isSystemMessage: true,
          body: buildResolutionSystemMessage(input.status, input.closeReason, input.resolutionMessage),
        },
      });
      publishTicketMessage({ ticketId, messageId: systemMessage.id });
    } else if (RESOLVED_STATUSES.includes(previous.status as TicketStatus)) {
      const systemMessage = await prisma.ticketMessage.create({
        data: {
          ticketId,
          authorId: actorId,
          isSystemMessage: true,
          body: 'Ticket reopened',
        },
      });
      publishTicketMessage({ ticketId, messageId: systemMessage.id });
    }
    // Deferred import: keeps env.ts's required-var validation out of the module load path for
    // pure-function unit tests (canViewTicket, isOverdue) that never call updateTicket.
    const { env } = await import('@/lib/env');
    await notifyStatusChanged(ticket, input.status, actorId, env.publicAppUrl);
    await handlePendingTransition(ticket, previous.status, env.publicAppUrl);
    await handleActiveStatusTransition(ticketId, input.status);
  }

  return ticket;
}

export interface TicketMetrics {
  totalOpen: number;
  totalPending: number;
  totalEscalated: number;
  totalInProgress: number;
  totalResolved: number;
  totalClosed: number;
  overdueCount: number;
  avgResolutionMs: number | null;
  byPriority: Record<TicketPriority, number>;
}

/** Callers must gate this behind requireAdmin(). */
export async function getTicketMetrics(): Promise<TicketMetrics> {
  const [statusGroups, priorityGroups, overdueCount, resolvedTickets] = await Promise.all([
    prisma.ticket.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.ticket.groupBy({ by: ['priority'], _count: { _all: true } }),
    prisma.ticket.count({
      where: { slaDueAt: { lt: new Date() }, status: { notIn: [...RESOLVED_STATUSES] } },
    }),
    prisma.ticket.findMany({
      where: { resolvedAt: { not: null } },
      select: { createdAt: true, resolvedAt: true },
    }),
  ]);

  const statusCount = (status: TicketStatus) =>
    statusGroups.find((g) => g.status === status)?._count._all ?? 0;

  const byPriority = priorityGroups.reduce(
    (acc, g) => ({ ...acc, [g.priority]: g._count._all }),
    { low: 0, normal: 0, high: 0, urgent: 0 } as Record<TicketPriority, number>,
  );

  const resolutionDurations = resolvedTickets
    .filter((t): t is { createdAt: Date; resolvedAt: Date } => t.resolvedAt !== null)
    .map((t) => t.resolvedAt.getTime() - t.createdAt.getTime());
  const avgResolutionMs =
    resolutionDurations.length > 0
      ? resolutionDurations.reduce((a, b) => a + b, 0) / resolutionDurations.length
      : null;

  return {
    totalOpen: statusCount('open'),
    totalPending: statusCount('pending'),
    totalEscalated: statusCount('escalated'),
    totalInProgress: statusCount('in_progress'),
    totalResolved: statusCount('resolved'),
    totalClosed: statusCount('closed'),
    overdueCount,
    avgResolutionMs,
    byPriority,
  };
}
