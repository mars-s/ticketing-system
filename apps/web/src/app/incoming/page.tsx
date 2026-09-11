import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentSession } from '@/lib/session';
import { AppHeader } from '@/components/AppHeader';
import { groupTicketsByStatus, isOverdue, listTicketsForGroupQueue } from '@/server/tickets';
import { listTicketGroupsForUser } from '@/server/ticketGroups';
import {
  badgeDanger,
  mutedText,
  pageHeader,
  pageTitle,
  pageWide,
  table,
  tableCell,
  tableHead,
  tableHeadCell,
  tableRowDivider,
  tableWrap,
} from '@/lib/styles';
import { STATUS_CONFIG, StatusPill } from '@/lib/ticketStatus';
import { PriorityPill } from '@/lib/ticketPriority';

function TicketTable({ tickets }: { tickets: Awaited<ReturnType<typeof listTicketsForGroupQueue>> }) {
  return (
    <div className={tableWrap}>
      <table className={table}>
        <thead className={tableHead}>
          <tr>
            <th className={tableHeadCell}>Ref</th>
            <th className={tableHeadCell}>Title</th>
            <th className={tableHeadCell}>Group</th>
            <th className={tableHeadCell}>Submitted by</th>
            <th className={tableHeadCell}>Status</th>
            <th className={tableHeadCell}>Priority</th>
            <th className={tableHeadCell}>Assignees</th>
            <th className={tableHeadCell}>SLA due</th>
          </tr>
        </thead>
        <tbody className={tableRowDivider}>
          {tickets.map((ticket) => {
            const overdue = isOverdue(ticket);
            return (
              <tr key={ticket.id} className={overdue ? 'bg-danger-soft' : undefined}>
                <td className={`${tableCell} text-text-secondary font-mono text-xs`}>{ticket.incidentNumber}</td>
                <td className={tableCell}>
                  <Link href={`/t/${ticket.id}`} className="font-medium text-text hover:text-accent">
                    {ticket.title}
                  </Link>
                </td>
                <td className={`${tableCell} text-text-secondary`}>{ticket.group?.name ?? '—'}</td>
                <td className={`${tableCell} text-text-secondary`}>{ticket.createdBy.name}</td>
                <td className={tableCell}>
                  <StatusPill status={ticket.status} />
                </td>
                <td className={tableCell}>
                  <PriorityPill priority={ticket.priority} />
                </td>
                <td className={`${tableCell} text-text-secondary`}>
                  {ticket.assignees.length > 0 ? ticket.assignees.map((a) => a.name).join(', ') : '—'}
                </td>
                <td className={tableCell}>
                  {overdue ? (
                    <span className={badgeDanger}>overdue</span>
                  ) : (
                    <span className="text-text-secondary">
                      {ticket.slaDueAt ? new Date(ticket.slaDueAt).toLocaleString() : '—'}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
          {tickets.length === 0 && (
            <tr>
              <td colSpan={7} className={`px-4 py-6 text-center ${mutedText}`}>
                No incoming tickets.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Tickets routed to any TicketGroup the signed-in user belongs to (via Authentik group membership). */
export default async function IncomingTicketsPage() {
  const session = await getCurrentSession();
  if (!session) redirect('/');

  const [tickets, myGroups] = await Promise.all([
    listTicketsForGroupQueue(session.user.id),
    listTicketGroupsForUser(session.user.id),
  ]);
  const { active, closedOrResolved } = groupTicketsByStatus(tickets);

  return (
    <>
      <AppHeader />
      <main className={pageWide}>
        <div className={pageHeader}>
          <h1 className={pageTitle}>Incoming Tickets</h1>
        </div>

        {myGroups.length > 0 && (
          <p className={`mb-6 ${mutedText}`}>
            Create-ticket fields:{' '}
            {myGroups.map((group, index) => (
              <span key={group.id}>
                {index > 0 && ', '}
                <Link href={`/groups/${group.id}/fields`} className="text-accent hover:underline">
                  {group.name}
                </Link>
              </span>
            ))}
          </p>
        )}

        <div className="flex flex-col gap-8">
          {(['open', 'escalated', 'pending', 'in_progress'] as const).map((status) => (
            <section key={status}>
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-text-secondary">
                {STATUS_CONFIG[status].label} ({active[status].length})
              </h2>
              <TicketTable tickets={active[status]} />
            </section>
          ))}

          <details className="group">
            <summary className="mb-2 cursor-pointer list-none text-sm font-semibold uppercase tracking-wide text-text-secondary">
              <span className="inline-block transition-transform group-open:rotate-90">▸</span>{' '}
              Resolved &amp; Closed ({closedOrResolved.length})
            </summary>
            <TicketTable tickets={closedOrResolved} />
          </details>
        </div>
      </main>
    </>
  );
}
