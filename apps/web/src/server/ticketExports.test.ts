import { describe, expect, it } from 'vitest';
import { buildTicketExportSnapshot } from './ticketExports';

describe('buildTicketExportSnapshot', () => {
  const ticket = {
    id: 'ticket-1',
    incidentNumber: 'INC-2026-000123',
    title: 'VPN is down',
    status: 'open',
    priority: 'high',
    type: 'bug',
    customFieldValues: { region: 'us-east' },
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    assignees: [{ name: 'Alice' }, { name: 'Bob' }],
  };

  it('maps a ticket + group name to the target-agnostic snapshot shape', () => {
    const snapshot = buildTicketExportSnapshot(ticket, 'Partnerships', 'https://tickets.example.com');
    expect(snapshot).toEqual({
      incidentNumber: 'INC-2026-000123',
      title: 'VPN is down',
      status: 'open',
      priority: 'high',
      type: 'bug',
      groupName: 'Partnerships',
      assigneeNames: ['Alice', 'Bob'],
      customFieldValues: { region: 'us-east' },
      ticketUrl: 'https://tickets.example.com/t/ticket-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
  });

  it('nulls customFieldValues when the ticket has none', () => {
    const snapshot = buildTicketExportSnapshot({ ...ticket, customFieldValues: null }, 'Partnerships', 'https://x');
    expect(snapshot.customFieldValues).toBeNull();
  });

  it('produces an empty assigneeNames array for an unassigned ticket', () => {
    const snapshot = buildTicketExportSnapshot({ ...ticket, assignees: [] }, 'Partnerships', 'https://x');
    expect(snapshot.assigneeNames).toEqual([]);
  });
});
