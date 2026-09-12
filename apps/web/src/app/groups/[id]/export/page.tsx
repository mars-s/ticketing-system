import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import type { GroupExportConfig } from '@ticketing/shared';
import { prisma } from '@ticketing/db';
import { getCurrentSession } from '@/lib/session';
import { env } from '@/lib/env';
import { getTicketGroupOr404, isTicketGroupMember } from '@/server/ticketGroups';
import { getGoogleServiceAccountEmail } from '@/lib/googleServiceAccount';
import { getNotionBotName } from '@/server/ticketExportSenders';
import { AppHeader } from '@/components/AppHeader';
import { TicketGroupExportEditor } from '@/components/TicketGroupExportEditor';
import { backLink, mutedText, page, pageHeader, pageTitle } from '@/lib/styles';

interface PageProps {
  params: Promise<{ id: string }>;
}

/** Group members configure their own group's ticket export here; admins can reach any
 * group's the same way. Mirrors /groups/[id]/fields's access gate exactly. */
export default async function GroupExportPage({ params }: PageProps) {
  const { id } = await params;
  const session = await getCurrentSession();
  if (!session) redirect('/');

  const isAdmin = session.user.role === 'admin';
  if (!isAdmin && !(await isTicketGroupMember(session.user.id, id))) notFound();

  const group = await getTicketGroupOr404(id).catch(() => null);
  if (!group) notFound();

  const [notionBotName, googleServiceAccountEmail, lastNotionJob, lastSheetsJob] = await Promise.all([
    env.notionIntegrationToken ? getNotionBotName(env.notionIntegrationToken) : Promise.resolve(null),
    Promise.resolve(env.googleServiceAccountJson ? getGoogleServiceAccountEmail(env.googleServiceAccountJson) : null),
    prisma.ticketExportJob.findFirst({
      where: { groupId: id, target: 'notion' },
      orderBy: { createdAt: 'desc' },
      select: { sentAt: true, lastError: true, attempts: true },
    }),
    prisma.ticketExportJob.findFirst({
      where: { groupId: id, target: 'google_sheets' },
      orderBy: { createdAt: 'desc' },
      select: { sentAt: true, lastError: true, attempts: true },
    }),
  ]);

  return (
    <>
      <AppHeader />
      <main className={page}>
        <div className={pageHeader}>
          <h1 className={pageTitle}>{group.name} — Export</h1>
          <div className="flex items-center gap-4">
            <Link href={`/groups/${group.id}/fields`} className={backLink}>
              Fields
            </Link>
            <Link href={isAdmin ? '/admin/ticket-groups' : '/incoming'} className={backLink}>
              Back
            </Link>
          </div>
        </div>
        <p className={`mb-6 ${mutedText}`}>
          Mirror this group&apos;s tickets to a Notion database or Google Sheet as they&apos;re created and updated. Off
          by default; anyone in the group can turn this on, same as who can edit the group&apos;s fields.
        </p>
        <TicketGroupExportEditor
          groupId={group.id}
          groupName={group.name}
          initialExportConfig={group.exportConfig as GroupExportConfig | null}
          notionAvailable={Boolean(env.notionIntegrationToken)}
          notionIntegrationName={notionBotName}
          googleSheetsAvailable={Boolean(env.googleServiceAccountJson)}
          googleServiceAccountEmail={googleServiceAccountEmail}
          lastNotionJob={lastNotionJob}
          lastSheetsJob={lastSheetsJob}
        />
      </main>
    </>
  );
}
