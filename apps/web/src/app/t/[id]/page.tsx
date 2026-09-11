import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import type { GroupFormConfig } from '@ticketing/shared';
import { getCurrentSession } from '@/lib/session';
import { canManageTicket, canViewTicket, getTicketOr404, isOverdue, verifyTicketToken } from '@/server/tickets';
import { markTicketNotificationsRead } from '@/server/notifications';
import { listTags } from '@/server/tags';
import { listTicketGroups } from '@/server/ticketGroups';
import { AppHeader } from '@/components/AppHeader';
import { TicketThread } from '@/components/TicketThread';
import { AdminTicketControls } from '@/components/AdminTicketControls';
import { TicketAttachments } from '@/components/TicketAttachments';
import { TicketHistoryTimeline } from '@/components/TicketHistoryTimeline';
import { TicketTitleEditor } from '@/components/TicketTitleEditor';
import { TicketCustomFields } from '@/components/TicketCustomFields';
import { CcEditor } from '@/components/CcEditor';
import { ShareTicketButton } from '@/components/ShareTicketButton';
import { backLink, badgeDanger, mutedText, page } from '@/lib/styles';
import { StatusPill } from '@/lib/ticketStatus';
import { PriorityPill } from '@/lib/ticketPriority';
import { TypePill } from '@/lib/ticketType';

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ token?: string }>;
}

export default async function TicketPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const { token } = await searchParams;

  const session = await getCurrentSession();
  const user = session
    ? { id: session.user.id, role: session.user.role as 'user' | 'admin' }
    : null;

  const hasTokenAccess = token ? await verifyTicketToken(id, token) : false;

  if (!user && !hasTokenAccess) {
    const originalPath = `/t/${id}${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    redirect(`/?callbackUrl=${encodeURIComponent(originalPath)}`);
  }

  const ticket = await getTicketOr404(id).catch(() => null);
  if (!ticket) notFound();

  if (!hasTokenAccess && !canViewTicket(ticket, user)) notFound();

  if (user) await markTicketNotificationsRead(id, user.id);

  const isAdmin = user?.role === 'admin';
  const isOwner = user?.id === ticket.createdById;
  const canManage = user ? canManageTicket(ticket, user) : false;
  const visibleMessages = isAdmin ? ticket.messages : ticket.messages.filter((m) => !m.isInternalNote);
  const overdue = isOverdue(ticket);
  const isClosed = ticket.status === 'closed';

  return (
    <>
      <AppHeader />
      <main className={page}>
      <Link href="/" className={`${backLink} mb-6`}>
        ← Back to tickets
      </Link>

      <p className={`mb-1 font-mono text-xs ${mutedText}`}>{ticket.incidentNumber}</p>

      <div className={`mb-6 flex items-start justify-between gap-4 ${isClosed ? 'opacity-60' : ''}`}>
        {canManage ? (
          <TicketTitleEditor
            ticketId={ticket.id}
            initialTitle={ticket.title}
            initialDescription={ticket.description}
          />
        ) : (
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-text">{ticket.title}</h1>
            <p className={`mt-1 ${mutedText}`}>{ticket.description}</p>
          </div>
        )}
        <div className="flex shrink-0 items-center gap-3">
          {(isAdmin || isOwner) && <ShareTicketButton ticketId={ticket.id} />}
          <StatusPill status={ticket.status} />
        </div>
      </div>

      <p className={`mb-3 ${mutedText} ${isClosed ? 'opacity-60' : ''}`}>
        Opened by {ticket.createdBy.name}
        {ticket.assignees.length > 0
          ? ` · assigned to ${ticket.assignees.map((a) => a.name).join(', ')}`
          : ' · unassigned'}
      </p>

      <div className={`mb-3 flex flex-wrap items-center gap-1.5 ${isClosed ? 'opacity-60' : ''}`}>
        <PriorityPill priority={ticket.priority} />
        <TypePill type={ticket.type} />
        {ticket.tags.map((tag) => (
          <span
            key={tag.id}
            className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium text-white"
            style={{ backgroundColor: tag.color }}
          >
            {tag.name}
          </span>
        ))}
      </div>

      <TicketCustomFields
        values={ticket.customFieldValues as Record<string, string | boolean> | null}
        formConfig={(ticket.group?.formConfig as GroupFormConfig | null) ?? null}
      />

      {!canManage && isOwner && (
        <div className="mb-3">
          <CcEditor
            ticketId={ticket.id}
            initialWatchers={ticket.watchers.map((w) => ({ id: w.id, name: w.name }))}
          />
        </div>
      )}
      {!canManage && !isOwner && ticket.watchers.length > 0 && (
        <p className={`mb-3 ${mutedText}`}>CC: {ticket.watchers.map((w) => w.name).join(', ')}</p>
      )}

      {ticket.slaDueAt && (
        <p className="mb-6 text-sm">
          {overdue ? (
            <span className={badgeDanger}>overdue</span>
          ) : (
            <span className="text-text-secondary">
              SLA due {new Date(ticket.slaDueAt).toLocaleString()}
            </span>
          )}
        </p>
      )}

      {canManage && (
        <AdminTicketControls
          ticketId={ticket.id}
          groupId={ticket.groupId}
          currentStatus={ticket.status}
          currentPriority={ticket.priority}
          currentType={ticket.type}
          currentAssignees={ticket.assignees.map((a) => ({ id: a.id, name: a.name }))}
          currentSlaDueAt={ticket.slaDueAt ? ticket.slaDueAt.toISOString() : null}
          currentTagIds={ticket.tags.map((t) => t.id)}
          currentWatchers={ticket.watchers.map((w) => ({ id: w.id, name: w.name }))}
          tags={await listTags()}
          groups={isAdmin ? (await listTicketGroups()).map((g) => ({ id: g.id, name: g.name })) : []}
          isAdmin={isAdmin}
        />
      )}

      {user && (
        <TicketAttachments
          ticketId={ticket.id}
          attachments={ticket.attachments}
          currentUserId={user.id}
          isAdmin={canManage}
        />
      )}

      {user && <TicketHistoryTimeline entries={ticket.history} />}

      <TicketThread
        ticketId={ticket.id}
        token={token}
        initialMessages={visibleMessages}
        canAddInternalNote={isAdmin}
      />
      </main>
    </>
  );
}
