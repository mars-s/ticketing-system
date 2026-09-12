import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@ticketing/db';
import type { GroupExportConfig, GroupFormConfig } from '@ticketing/shared';
import { resetDatabase, createTestUser } from '@/test/db';
import {
  createTicketGroup,
  isTicketGroupMember,
  updateTicketGroup,
  updateTicketGroupExportConfig,
  updateTicketGroupFormConfig,
} from './ticketGroups';

beforeEach(async () => {
  await resetDatabase();
});

async function makeGroup(memberId: string) {
  const admin = await createTestUser({ name: 'Admin', email: `admin-${Date.now()}@test.local`, role: 'admin' });
  const group = await createTicketGroup(
    { name: 'Partnerships', authentikGroupNames: ['partnerships'], announcementChannelId: null, unassignedBacklogChannelId: null },
    admin.id,
  );
  await prisma.ticketGroup.update({ where: { id: group.id }, data: { members: { connect: { id: memberId } } } });
  return group;
}

describe('isTicketGroupMember', () => {
  it('is true for a member and false for a stranger', async () => {
    const member = await createTestUser({ name: 'Member' });
    const stranger = await createTestUser({ name: 'Stranger', email: 'stranger@test.local' });
    const group = await makeGroup(member.id);

    expect(await isTicketGroupMember(member.id, group.id)).toBe(true);
    expect(await isTicketGroupMember(stranger.id, group.id)).toBe(false);
  });
});

describe('updateTicketGroupFormConfig', () => {
  const config: GroupFormConfig = {
    standardFields: { priority: { shown: false, required: false, defaultValue: 'high' } },
    customFields: [{ id: 'phone', kind: 'text', label: 'Phone number', required: true }],
  };

  it('persists a config and resets to default (null) on request', async () => {
    const member = await createTestUser({ name: 'Member' });
    const group = await makeGroup(member.id);

    const saved = await updateTicketGroupFormConfig(group.id, config, member.id);
    expect(saved.formConfig).toEqual(config);

    const reset = await updateTicketGroupFormConfig(group.id, null, member.id);
    expect(reset.formConfig).toBeNull();
  });
});

describe('updateTicketGroupExportConfig', () => {
  const config: GroupExportConfig = { notion: { databaseId: 'db-123' } };

  it('persists a config and turns export off (null) on request', async () => {
    const member = await createTestUser({ name: 'Member' });
    const group = await makeGroup(member.id);

    const saved = await updateTicketGroupExportConfig(group.id, config, member.id);
    expect(saved.exportConfig).toEqual(config);

    const disabled = await updateTicketGroupExportConfig(group.id, null, member.id);
    expect(disabled.exportConfig).toBeNull();
  });
});

describe('updateTicketGroup', () => {
  it('does not clobber an existing formConfig when the caller omits it (admin editing name/channels)', async () => {
    const member = await createTestUser({ name: 'Member' });
    const group = await makeGroup(member.id);
    const config: GroupFormConfig = { standardFields: {}, customFields: [] };
    await updateTicketGroupFormConfig(group.id, config, member.id);

    const updated = await updateTicketGroup(
      group.id,
      {
        name: 'Partnerships Renamed',
        authentikGroupNames: ['partnerships'],
        announcementChannelId: null,
        unassignedBacklogChannelId: null,
      },
      member.id,
    );

    expect(updated.name).toBe('Partnerships Renamed');
    expect(updated.formConfig).toEqual(config);
  });
});
