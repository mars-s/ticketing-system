import { prisma } from '@ticketing/db';

/** Deletes all app data between integration tests, in FK-safe order. */
export async function resetDatabase(): Promise<void> {
  await prisma.auditLog.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.discordDm.deleteMany();
  await prisma.ticketAccessToken.deleteMany();
  await prisma.ticketAttachment.deleteMany();
  await prisma.ticketMessage.deleteMany();
  await prisma.ticket.deleteMany();
  await prisma.ticketGroup.deleteMany();
  await prisma.tag.deleteMany();
  await prisma.discordClaim.deleteMany();
  await prisma.maintenanceEvent.deleteMany();
  await prisma.session.deleteMany();
  await prisma.account.deleteMany();
  await prisma.user.deleteMany();
}

export function createTestUser(overrides: Partial<Parameters<typeof prisma.user.create>[0]['data']> = {}) {
  return prisma.user.create({
    data: {
      email: `user-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`,
      name: 'Test User',
      ...overrides,
    },
  });
}
