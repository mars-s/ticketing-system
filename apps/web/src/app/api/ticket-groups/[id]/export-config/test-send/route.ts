import { NextResponse } from 'next/server';
import { testSendExportSchema, type GroupExportConfig, type TicketExportSnapshot } from '@ticketing/shared';
import { handleApiError } from '@/lib/api-errors';
import { AppError, ForbiddenError } from '@/lib/errors';
import { requireSession } from '@/lib/session';
import { getTicketGroupOr404, isTicketGroupMember } from '@/server/ticketGroups';
import { sendTicketExportTestRow } from '@/server/ticketExportDelivery';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/** Sends one synthetic row to the group's already-saved export target so a member/admin can
 * verify the database/spreadsheet id and sharing are right before relying on the poller --
 * bypasses the TicketExportJob outbox entirely (see sendTicketExportTestRow). */
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const session = await requireSession();
    const { id } = await params;

    if (session.user.role !== 'admin' && !(await isTicketGroupMember(session.user.id, id))) {
      throw new ForbiddenError();
    }

    const { target } = testSendExportSchema.parse(await request.json());
    const group = await getTicketGroupOr404(id);
    const exportConfig = group.exportConfig as unknown as GroupExportConfig | null;
    if (!exportConfig || (target === 'notion' ? !exportConfig.notion : !exportConfig.googleSheets)) {
      throw new AppError(`Save a ${target === 'notion' ? 'Notion' : 'Google Sheets'} config for this group before testing it`);
    }

    const { env } = await import('@/lib/env');
    const snapshot: TicketExportSnapshot = {
      incidentNumber: 'TEST-0000',
      title: 'Test row from the ticketing system',
      status: 'open',
      priority: 'normal',
      type: 'other',
      groupName: group.name,
      assigneeNames: [],
      customFieldValues: null,
      ticketUrl: `${env.publicAppUrl}/t/test`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await sendTicketExportTestRow(target, exportConfig, snapshot);
    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error);
  }
}
