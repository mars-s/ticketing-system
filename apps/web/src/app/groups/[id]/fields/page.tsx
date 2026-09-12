import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import type { GroupFormConfig } from '@ticketing/shared';
import { getCurrentSession } from '@/lib/session';
import { getTicketGroupOr404, isTicketGroupMember } from '@/server/ticketGroups';
import { AppHeader } from '@/components/AppHeader';
import { TicketGroupFieldsEditor } from '@/components/TicketGroupFieldsEditor';
import { backLink, mutedText, page, pageHeader, pageTitle } from '@/lib/styles';

interface PageProps {
  params: Promise<{ id: string }>;
}

/** Group members edit their own group's create-ticket fields here; admins can reach any
 * group's the same way (also linked from /admin/ticket-groups). Everything else about the
 * group (name, Authentik links, channels) stays admin-only on the main group editor. */
export default async function GroupFieldsPage({ params }: PageProps) {
  const { id } = await params;
  const session = await getCurrentSession();
  if (!session) redirect('/');

  const isAdmin = session.user.role === 'admin';
  if (!isAdmin && !(await isTicketGroupMember(session.user.id, id))) notFound();

  const group = await getTicketGroupOr404(id).catch(() => null);
  if (!group) notFound();

  return (
    <>
      <AppHeader />
      <main className={page}>
        <div className={pageHeader}>
          <h1 className={pageTitle}>{group.name} — Fields</h1>
          <div className="flex items-center gap-4">
            <Link href={`/groups/${group.id}/export`} className={backLink}>
              Export
            </Link>
            <Link href={isAdmin ? '/admin/ticket-groups' : '/incoming'} className={backLink}>
              Back
            </Link>
          </div>
        </div>
        <p className={`mb-6 ${mutedText}`}>
          Customize what requesters are asked when they route a ticket to this group. Anyone in the group can
          edit this; only admins can change the group&apos;s name, Authentik links, or Discord channels.
        </p>
        <TicketGroupFieldsEditor
          groupId={group.id}
          groupName={group.name}
          initialFormConfig={group.formConfig as GroupFormConfig | null}
        />
      </main>
    </>
  );
}
