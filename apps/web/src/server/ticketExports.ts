import { Prisma, prisma } from '@ticketing/db';
import {
  TICKET_EXPORT_TARGETS,
  type GroupExportConfig,
  type TicketExportSnapshot,
  type TicketExportTarget,
} from '@ticketing/shared';

interface SnapshotTicket {
  id: string;
  incidentNumber: string;
  title: string;
  status: string;
  priority: string;
  type: string;
  customFieldValues: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
  assignees: { name: string }[];
}

/** Pure: maps a ticket + its group name to the target-agnostic shape stored on the outbox
 * row and sent to whichever API(s) the group has enabled. */
export function buildTicketExportSnapshot(
  ticket: SnapshotTicket,
  groupName: string,
  baseUrl: string,
): TicketExportSnapshot {
  return {
    incidentNumber: ticket.incidentNumber,
    title: ticket.title,
    status: ticket.status,
    priority: ticket.priority,
    type: ticket.type,
    groupName,
    assigneeNames: ticket.assignees.map((a) => a.name),
    customFieldValues: (ticket.customFieldValues as Record<string, string | boolean> | null) ?? null,
    ticketUrl: `${baseUrl}/t/${ticket.id}`,
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
  };
}

function enabledTargets(exportConfig: GroupExportConfig): TicketExportTarget[] {
  return TICKET_EXPORT_TARGETS.filter((target) =>
    target === 'notion' ? exportConfig.notion !== undefined : exportConfig.googleSheets !== undefined,
  );
}

/** Enqueues one TicketExportJob per target the ticket's group has enabled. No-ops if the
 * group has no group, or export is off/unconfigured for it. Called inline with the ticket
 * create/update transaction (see server/tickets.ts) -- writing the outbox row can never fail
 * the user-facing request since it's a plain insert, no outbound network call here. */
export async function enqueueTicketExportJobs(
  ticket: SnapshotTicket,
  group: { id: string; name: string; exportConfig: Prisma.JsonValue | null } | null,
  baseUrl: string,
): Promise<void> {
  if (!group?.exportConfig) return;
  const exportConfig = group.exportConfig as unknown as GroupExportConfig;
  const targets = enabledTargets(exportConfig);
  if (targets.length === 0) return;

  const snapshot = buildTicketExportSnapshot(ticket, group.name, baseUrl);
  await prisma.ticketExportJob.createMany({
    data: targets.map((target) => ({
      ticketId: ticket.id,
      groupId: group.id,
      target,
      payload: snapshot as unknown as Prisma.InputJsonValue,
    })),
  });
}
