import { NextResponse } from 'next/server';
import { handleApiError } from '@/lib/api-errors';
import { requireInternalSecret } from '@/lib/internal-auth';
import { deliverPendingTicketExports } from '@/server/ticketExportDelivery';

/** Polled by an external cron every few minutes (documented in deploy config, not this
 * repo) -- delivers queued TicketExportJob rows to Notion/Google Sheets directly, no bot
 * process needed for either. Mirrors cleanup-attachments/sync-authentik's shape. */
export async function POST(request: Request) {
  try {
    requireInternalSecret(request);
    const result = await deliverPendingTicketExports();
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return handleApiError(error);
  }
}
