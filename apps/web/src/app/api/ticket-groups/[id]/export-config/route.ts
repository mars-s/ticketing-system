import { NextResponse } from 'next/server';
import { updateGroupExportConfigSchema } from '@ticketing/shared';
import { handleApiError } from '@/lib/api-errors';
import { ForbiddenError } from '@/lib/errors';
import { requireSession } from '@/lib/session';
import { isTicketGroupMember, updateTicketGroupExportConfig } from '@/server/ticketGroups';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/** Group members may edit their own group's export config; admins may edit any group's --
 * same gate as PATCH .../form-config. */
export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const session = await requireSession();
    const { id } = await params;

    if (session.user.role !== 'admin' && !(await isTicketGroupMember(session.user.id, id))) {
      throw new ForbiddenError();
    }

    const body = updateGroupExportConfigSchema.parse(await request.json());
    const group = await updateTicketGroupExportConfig(id, body.exportConfig, session.user.id);
    return NextResponse.json({ success: true, data: group });
  } catch (error) {
    return handleApiError(error);
  }
}
