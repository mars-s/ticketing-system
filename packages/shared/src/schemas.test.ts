import { describe, expect, it } from 'vitest';
import {
  createInternalTicketSchema,
  createMessageSchema,
  createTicketSchema,
  linkDiscordSchema,
  updateTicketSchema,
  uptimeKumaWebhookSchema,
} from './schemas';

describe('createTicketSchema', () => {
  it('accepts a valid payload', () => {
    const result = createTicketSchema.parse({ title: 'Printer down', description: 'no ink' });
    expect(result.title).toBe('Printer down');
  });

  it('leaves priority/type/description undefined when omitted (resolved server-side against the group config)', () => {
    const result = createTicketSchema.parse({ title: 'valid title' });
    expect(result.priority).toBeUndefined();
    expect(result.type).toBeUndefined();
    expect(result.description).toBeUndefined();
  });

  it('rejects a title shorter than 3 characters', () => {
    expect(() => createTicketSchema.parse({ title: 'ab', description: 'x' })).toThrow();
  });

  it('rejects an empty description when one is provided', () => {
    expect(() => createTicketSchema.parse({ title: 'valid title', description: '' })).toThrow();
  });

  it('accepts customFieldValues as a mix of strings and booleans', () => {
    const result = createTicketSchema.parse({
      title: 'valid title',
      description: 'x',
      customFieldValues: { 'ticket-a': true, 'field-b': 'some text' },
    });
    expect(result.customFieldValues).toEqual({ 'ticket-a': true, 'field-b': 'some text' });
  });
});

describe('createInternalTicketSchema', () => {
  it('requires discordUserId and discordUsername in addition to base fields', () => {
    expect(() =>
      createInternalTicketSchema.parse({ title: 'valid title', description: 'x' }),
    ).toThrow();

    const result = createInternalTicketSchema.parse({
      title: 'valid title',
      description: 'x',
      discordUserId: '123',
      discordUsername: 'someone',
    });
    expect(result.discordUserId).toBe('123');
  });
});

describe('createMessageSchema', () => {
  it('defaults isInternalNote to false', () => {
    expect(createMessageSchema.parse({ body: 'hello' }).isInternalNote).toBe(false);
  });

  it('rejects an empty body', () => {
    expect(() => createMessageSchema.parse({ body: '' })).toThrow();
  });
});

describe('updateTicketSchema', () => {
  it('allows a partial patch with just status', () => {
    expect(updateTicketSchema.parse({ status: 'escalated' })).toEqual({ status: 'escalated' });
  });

  it('rejects an invalid status value', () => {
    expect(() => updateTicketSchema.parse({ status: 'not-a-real-status' })).toThrow();
  });

  it('allows assigneeIds to be an empty array (unassign all)', () => {
    expect(updateTicketSchema.parse({ assigneeIds: [] }).assigneeIds).toEqual([]);
  });
});

describe('linkDiscordSchema', () => {
  it('requires exactly 8 characters', () => {
    expect(() => linkDiscordSchema.parse({ code: 'short' })).toThrow();
    expect(linkDiscordSchema.parse({ code: 'ABCD1234' }).code).toBe('ABCD1234');
  });
});

describe('uptimeKumaWebhookSchema', () => {
  it('parses a typical down-heartbeat payload', () => {
    const result = uptimeKumaWebhookSchema.parse({
      monitor: { id: 7, name: 'API' },
      heartbeat: { status: 0, msg: 'timeout' },
    });
    expect(result.heartbeat.status).toBe(0);
  });

  it('rejects a payload missing the monitor', () => {
    expect(() =>
      uptimeKumaWebhookSchema.parse({ heartbeat: { status: 1 } } as unknown),
    ).toThrow();
  });
});
