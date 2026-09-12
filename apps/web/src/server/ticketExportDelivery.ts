import { prisma } from '@ticketing/db';
import type { GroupExportConfig, TicketExportSnapshot, TicketExportTarget } from '@ticketing/shared';
import { AppError } from '@/lib/errors';
import { sendToGoogleSheets, sendToNotion } from '@/server/ticketExportSenders';

/** Jobs stuck at this many failed attempts stop being retried by the poller -- surfaced as
 * "last error" in the group export UI instead (see TicketGroupExportEditor). */
const MAX_ATTEMPTS = 5;
const DEFAULT_POLL_LIMIT = 50;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

async function sendToTarget(target: TicketExportTarget, config: GroupExportConfig, snapshot: TicketExportSnapshot): Promise<void> {
  const { env } = await import('@/lib/env');

  if (target === 'notion') {
    if (!config.notion) throw new AppError('Notion export is not configured for this group');
    if (!env.notionIntegrationToken) throw new AppError('NOTION_INTEGRATION_TOKEN is not set');
    await sendToNotion(env.notionIntegrationToken, config.notion, snapshot);
    return;
  }

  if (!config.googleSheets) throw new AppError('Google Sheets export is not configured for this group');
  if (!env.googleServiceAccountJson) throw new AppError('GOOGLE_SERVICE_ACCOUNT_JSON is not set');
  await sendToGoogleSheets(env.googleServiceAccountJson, config.googleSheets, snapshot);
}

export interface DeliveryResult {
  sent: number;
  failed: number;
}

/** Delivers the oldest pending (unsent, under the attempt ceiling) export jobs. Called from
 * POST /api/internal/ticket-exports/pending, polled by an external cron every few minutes --
 * see docs/ticket-group-external-export-plan.md section 4. Each job's group is re-read fresh
 * (not trusted from enqueue time) so a group that disabled/reconfigured export after
 * enqueueing doesn't get a stale delivery. */
export async function deliverPendingTicketExports(limit = DEFAULT_POLL_LIMIT): Promise<DeliveryResult> {
  const jobs = await prisma.ticketExportJob.findMany({
    where: { sentAt: null, attempts: { lt: MAX_ATTEMPTS } },
    orderBy: { createdAt: 'asc' },
    take: limit,
    include: { group: true },
  });

  let sent = 0;
  let failed = 0;

  for (const job of jobs) {
    try {
      const exportConfig = job.group.exportConfig as unknown as GroupExportConfig | null;
      if (!exportConfig) throw new AppError('Export was turned off for this group after this job was queued');
      await sendToTarget(job.target, exportConfig, job.payload as unknown as TicketExportSnapshot);
      await prisma.ticketExportJob.update({ where: { id: job.id }, data: { sentAt: new Date() } });
      sent++;
    } catch (error) {
      await prisma.ticketExportJob.update({
        where: { id: job.id },
        data: { attempts: { increment: 1 }, lastError: getErrorMessage(error) },
      });
      failed++;
    }
  }

  return { sent, failed };
}

/** Synchronous single-target send for the "Send a test row" button -- bypasses the outbox
 * so the user gets a pass/fail answer immediately instead of waiting for the next poll. */
export async function sendTicketExportTestRow(
  target: TicketExportTarget,
  exportConfig: GroupExportConfig,
  snapshot: TicketExportSnapshot,
): Promise<void> {
  await sendToTarget(target, exportConfig, snapshot);
}
