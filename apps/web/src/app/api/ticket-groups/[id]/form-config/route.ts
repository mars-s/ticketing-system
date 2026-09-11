import { NextResponse } from 'next/server';
import { updateGroupFormConfigSchema } from '@ticketing/shared';
import { handleApiError } from '@/lib/api-errors';
import { ForbiddenError } from '@/lib/errors';
import { requireSession } from '@/lib/session';
import { isTicketGroupMember, updateTicketGroupFormConfig } from '@/server/ticketGroups';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/** Group members may edit their own group's create-ticket form config; admins may edit
 * any group's. Neither name, Authentik links, nor channels are reachable through this
 * route -- those stay admin-only via PUT /api/ticket-groups/[id]. */
export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const session = await requireSession();
    const { id } = await params;

    if (session.user.role !== 'admin' && !(await isTicketGroupMember(session.user.id, id))) {
      throw new ForbiddenError();
    }

    const body = updateGroupFormConfigSchema.parse(await request.json());
    const group = await updateTicketGroupFormConfig(id, body.formConfig, session.user.id);
    return NextResponse.json({ success: true, data: group });
  } catch (error) {
    return handleApiError(error);
  }
}
