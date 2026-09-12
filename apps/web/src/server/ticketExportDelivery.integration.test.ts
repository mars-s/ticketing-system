// Sets shared export credentials before any module (including this file's own imports)
// gets a chance to load @/lib/env, whose optional NOTION_INTEGRATION_TOKEN/
// GOOGLE_SERVICE_ACCOUNT_JSON fields are read once at module-evaluation time.
process.env.NOTION_INTEGRATION_TOKEN = 'test-notion-token';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@ticketing/db';
import type { GroupExportConfig } from '@ticketing/shared';
import { resetDatabase, createTestUser } from '@/test/db';
import { createTicketGroup, updateTicketGroupExportConfig } from '@/server/ticketGroups';
import { createTicket } from '@/server/tickets';
import { deliverPendingTicketExports } from './ticketExportDelivery';

beforeEach(async () => {
  await resetDatabase();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function makeGroupWithExport(exportConfig: GroupExportConfig) {
  const admin = await createTestUser({ name: 'Admin', email: `admin-${Date.now()}-${Math.random()}@test.local`, role: 'admin' });
  const group = await createTicketGroup(
    { name: 'Partnerships', authentikGroupNames: ['partnerships'], announcementChannelId: null, unassignedBacklogChannelId: null },
    admin.id,
  );
  await updateTicketGroupExportConfig(group.id, exportConfig, admin.id);
  return { admin, group };
}

describe('deliverPendingTicketExports', () => {
  it('marks a job sent on a successful delivery', async () => {
    const { group } = await makeGroupWithExport({ notion: { databaseId: 'db-1' } });
    const requester = await createTestUser({ name: 'Requester', email: `req-${Date.now()}@test.local` });
    await createTicket(requester.id, 'user', { title: 'VPN down', description: 'help', groupId: group.id });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/query')) return new Response(JSON.stringify({ results: [] }), { status: 200 });
        return new Response(JSON.stringify({ id: 'page-1' }), { status: 200 });
      }),
    );

    const result = await deliverPendingTicketExports();
    expect(result).toEqual({ sent: 1, failed: 0 });

    const job = await prisma.ticketExportJob.findFirstOrThrow({ where: { groupId: group.id } });
    expect(job.sentAt).not.toBeNull();
    expect(job.attempts).toBe(0);
  });

  it('increments attempts and records lastError on a failed delivery, without throwing', async () => {
    const { group } = await makeGroupWithExport({ notion: { databaseId: 'db-1' } });
    const requester = await createTestUser({ name: 'Requester', email: `req-${Date.now()}@test.local` });
    await createTicket(requester.id, 'user', { title: 'VPN down', description: 'help', groupId: group.id });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/query')) return new Response(JSON.stringify({ results: [] }), { status: 200 });
        return new Response('invalid database_id', { status: 400 });
      }),
    );

    const result = await deliverPendingTicketExports();
    expect(result).toEqual({ sent: 0, failed: 1 });

    const job = await prisma.ticketExportJob.findFirstOrThrow({ where: { groupId: group.id } });
    expect(job.sentAt).toBeNull();
    expect(job.attempts).toBe(1);
    expect(job.lastError).toMatch(/Notion create failed: 400/);
  });

  it('excludes a job at the attempt ceiling from the next poll', async () => {
    const { group } = await makeGroupWithExport({ notion: { databaseId: 'db-1' } });
    const requester = await createTestUser({ name: 'Requester', email: `req-${Date.now()}@test.local` });
    await createTicket(requester.id, 'user', { title: 'VPN down', description: 'help', groupId: group.id });
    await prisma.ticketExportJob.updateMany({ where: { groupId: group.id }, data: { attempts: 5 } });

    vi.stubGlobal('fetch', vi.fn());

    const result = await deliverPendingTicketExports();
    expect(result).toEqual({ sent: 0, failed: 0 });
  });

  it('fails a job gracefully when the group turned export off after it was queued', async () => {
    const { admin, group } = await makeGroupWithExport({ notion: { databaseId: 'db-1' } });
    const requester = await createTestUser({ name: 'Requester', email: `req-${Date.now()}@test.local` });
    await createTicket(requester.id, 'user', { title: 'VPN down', description: 'help', groupId: group.id });
    await updateTicketGroupExportConfig(group.id, null, admin.id);

    const result = await deliverPendingTicketExports();
    expect(result).toEqual({ sent: 0, failed: 1 });

    const job = await prisma.ticketExportJob.findFirstOrThrow({ where: { groupId: group.id } });
    expect(job.lastError).toMatch(/turned off/);
  });
});
