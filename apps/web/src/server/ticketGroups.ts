import { Prisma, prisma } from '@ticketing/db';
import type { GroupFormConfig, TicketGroupInput } from '@ticketing/shared';
import { AppError } from '@/lib/errors';
import { writeAuditLog } from '@/server/audit';

/** GroupFormConfig is a plain-JSON-compatible shape, but its discriminated unions
 * (VisibilityRule, CustomFieldDef) don't structurally satisfy Prisma's InputJsonObject
 * index signature -- this cast is the sanctioned boundary between the two. */
function toJsonInput(config: GroupFormConfig | null | undefined): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return config == null ? Prisma.JsonNull : (config as unknown as Prisma.InputJsonValue);
}

export async function listTicketGroups() {
  return prisma.ticketGroup.findMany({ orderBy: { name: 'asc' } });
}

/** Groups the given user belongs to, via their live Authentik-derived membership. */
export async function listTicketGroupsForUser(userId: string) {
  return prisma.ticketGroup.findMany({
    where: { members: { some: { id: userId } } },
    orderBy: { name: 'asc' },
  });
}

export async function getTicketGroupOr404(groupId: string) {
  const group = await prisma.ticketGroup.findUnique({ where: { id: groupId } });
  if (!group) throw new AppError('Group not found');
  return group;
}

/** Used to gate PATCH .../form-config: group members may edit their own group's form
 * config even though only admins may touch the rest of the group (name, Authentik
 * links, channels). Admins should short-circuit this check rather than call it. */
export async function isTicketGroupMember(userId: string, groupId: string): Promise<boolean> {
  const group = await prisma.ticketGroup.findFirst({
    where: { id: groupId, members: { some: { id: userId } } },
    select: { id: true },
  });
  return group !== null;
}

/** Callers must gate this behind requireAdmin() OR isTicketGroupMember(). `formConfig:
 * null` resets the group to the default create-ticket form. */
export async function updateTicketGroupFormConfig(
  groupId: string,
  formConfig: GroupFormConfig | null,
  actorId: string,
) {
  await getTicketGroupOr404(groupId);
  const group = await prisma.ticketGroup.update({
    where: { id: groupId },
    data: { formConfig: toJsonInput(formConfig) },
  });
  await writeAuditLog(actorId, 'ticket_group.form_config_update', 'TicketGroup', groupId, {
    reset: formConfig === null,
  });
  return group;
}

async function assertUniqueName(name: string, excludeId?: string): Promise<void> {
  const existing = await prisma.ticketGroup.findUnique({ where: { name } });
  if (existing && existing.id !== excludeId) throw new AppError('A group with that name already exists');
}

/** Callers must gate this behind requireAdmin(). */
export async function createTicketGroup(input: TicketGroupInput, actorId: string) {
  await assertUniqueName(input.name);
  const group = await prisma.ticketGroup.create({
    data: {
      name: input.name,
      authentikGroupNames: input.authentikGroupNames,
      announcementChannelId: input.announcementChannelId,
      unassignedBacklogChannelId: input.unassignedBacklogChannelId,
      formConfig: toJsonInput(input.formConfig),
    },
  });
  await syncMembersForGroup(group.id, input.authentikGroupNames);
  await writeAuditLog(actorId, 'ticket_group.create', 'TicketGroup', group.id, { ...input } as Prisma.InputJsonValue);
  return group;
}

/** Callers must gate this behind requireAdmin(). Leaves formConfig untouched unless the
 * caller explicitly included it -- this route isn't how group members reset/save theirs,
 * so an admin editing name/channels here must never clobber an existing form config. */
export async function updateTicketGroup(groupId: string, input: TicketGroupInput, actorId: string) {
  await assertUniqueName(input.name, groupId);
  const group = await prisma.ticketGroup.update({
    where: { id: groupId },
    data: {
      name: input.name,
      authentikGroupNames: input.authentikGroupNames,
      announcementChannelId: input.announcementChannelId,
      unassignedBacklogChannelId: input.unassignedBacklogChannelId,
      ...(input.formConfig !== undefined ? { formConfig: toJsonInput(input.formConfig) } : {}),
    },
  });
  await syncMembersForGroup(group.id, input.authentikGroupNames);
  await writeAuditLog(actorId, 'ticket_group.update', 'TicketGroup', group.id, { ...input } as Prisma.InputJsonValue);
  return group;
}

/** Callers must gate this behind requireAdmin(). Blocked if any ticket still references the group. */
export async function deleteTicketGroup(groupId: string, actorId: string) {
  const ticketCount = await prisma.ticket.count({ where: { groupId } });
  if (ticketCount > 0) {
    throw new AppError(`Cannot delete: ${ticketCount} ticket(s) are still assigned to this group. Reassign them first.`);
  }
  const group = await prisma.ticketGroup.delete({ where: { id: groupId } });
  await writeAuditLog(actorId, 'ticket_group.delete', 'TicketGroup', groupId, { name: group.name });
}

/** Recomputes one group's members from the current User.authentikGroups snapshot (immediate feedback on save, ahead of the next sync cycle). */
async function syncMembersForGroup(groupId: string, authentikGroupNames: string[]): Promise<void> {
  const users = await prisma.user.findMany({
    where: { isDiscordPlaceholder: false, authentikGroups: { hasSome: authentikGroupNames } },
    select: { id: true },
  });
  await prisma.ticketGroup.update({
    where: { id: groupId },
    data: { members: { set: users.map((u) => ({ id: u.id })) } },
  });
}
