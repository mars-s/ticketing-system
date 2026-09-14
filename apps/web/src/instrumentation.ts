import { registerOTel } from '@vercel/otel';
import { RedactQueryStringSpanProcessor } from '@/lib/otelRedactingSpanProcessor';

const CLEANUP_INTERVAL_MS = 1000 * 60 * 60 * 24;
const PENDING_ESCALATION_CHECK_INTERVAL_MS = 1000 * 60 * 60; // hourly
const SLA_BREACH_CHECK_INTERVAL_MS = 1000 * 60 * 60; // hourly
const OCR_SWEEP_INTERVAL_MS = 1000 * 60 * 5; // every 5 minutes -- feeds search freshness
const ACTIVE_STATUS_REMINDER_CHECK_INTERVAL_MS = 1000 * 60 * 60; // hourly
const UNASSIGNED_BACKLOG_CHECK_INTERVAL_MS = 1000 * 60 * 60; // hourly (gated to 9am inside the sweep)
const DISCORD_ID_REFRESH_INTERVAL_MS = 1000 * 60 * 60; // hourly, decoupled from the 15-min Authentik sync

/**
 * Runs once per server process on boot (Next.js instrumentation hook). Single-process
 * assumption -- same tradeoff already accepted by the SSE pub/sub in ticket-events.ts.
 * If this ever scales to multiple web replicas, move these to an external cron hitting
 * dedicated /api/internal/* endpoints instead.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // Redacting processor runs first in the chain so every later processor --
  // including @vercel/otel's own OTLP-exporting one -- only ever sees
  // query-string-stripped URLs. See otelRedactingSpanProcessor.ts for why.
  registerOTel({
    serviceName: 'ticketing-web',
    traceExporter: 'auto',
    spanProcessors: [new RedactQueryStringSpanProcessor(), 'auto'],
  });

  const { cleanupExpiredAttachments } = await import('@/server/attachments');
  const { queuePendingEscalationDms, queueSlaBreachAlerts, queueActiveStatusReminders, queueUnassignedBacklogAlert } =
    await import('@/server/notifications');
  const { processPendingAttachmentOcr } = await import('@/server/ocr');
  const { refreshDiscordIdsFromDirectory } = await import('@/lib/authentikSync');
  const { env } = await import('@/lib/env');
  const { logger } = await import('@/lib/logger');

  async function runCleanup(): Promise<void> {
    try {
      await cleanupExpiredAttachments();
    } catch (error) {
      logger.error('Attachment cleanup failed', error);
    }
  }

  async function runPendingEscalationCheck(): Promise<void> {
    try {
      await queuePendingEscalationDms(env.publicAppUrl);
    } catch (error) {
      logger.error('Pending-ticket escalation DM sweep failed', error);
    }
  }

  async function runSlaBreachCheck(): Promise<void> {
    try {
      await queueSlaBreachAlerts(env.publicAppUrl);
    } catch (error) {
      logger.error('SLA breach alert sweep failed', error);
    }
  }

  async function runOcrSweep(): Promise<void> {
    try {
      await processPendingAttachmentOcr();
    } catch (error) {
      logger.error('Attachment OCR sweep failed', error);
    }
  }

  async function runActiveStatusReminderCheck(): Promise<void> {
    try {
      await queueActiveStatusReminders(env.publicAppUrl);
    } catch (error) {
      logger.error('Active-status assignee reminder sweep failed', error);
    }
  }

  async function runUnassignedBacklogCheck(): Promise<void> {
    try {
      await queueUnassignedBacklogAlert(env.publicAppUrl);
    } catch (error) {
      logger.error('Unassigned-backlog channel alert sweep failed', error);
    }
  }

  async function runDiscordIdRefresh(): Promise<void> {
    try {
      await refreshDiscordIdsFromDirectory();
    } catch (error) {
      logger.error('directory-service discordId refresh sweep failed', error);
    }
  }

  void runCleanup();
  void runPendingEscalationCheck();
  void runSlaBreachCheck();
  void runOcrSweep();
  void runActiveStatusReminderCheck();
  void runUnassignedBacklogCheck();
  void runDiscordIdRefresh();
  setInterval(() => void runCleanup(), CLEANUP_INTERVAL_MS);
  setInterval(() => void runPendingEscalationCheck(), PENDING_ESCALATION_CHECK_INTERVAL_MS);
  setInterval(() => void runSlaBreachCheck(), SLA_BREACH_CHECK_INTERVAL_MS);
  setInterval(() => void runOcrSweep(), OCR_SWEEP_INTERVAL_MS);
  setInterval(() => void runActiveStatusReminderCheck(), ACTIVE_STATUS_REMINDER_CHECK_INTERVAL_MS);
  setInterval(() => void runUnassignedBacklogCheck(), UNASSIGNED_BACKLOG_CHECK_INTERVAL_MS);
  setInterval(() => void runDiscordIdRefresh(), DISCORD_ID_REFRESH_INTERVAL_MS);
}
