import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TicketExportSnapshot } from '@ticketing/shared';
import { sendToGoogleSheets, sendToNotion } from './ticketExportSenders';

const snapshot: TicketExportSnapshot = {
  incidentNumber: 'INC-2026-000123',
  title: 'VPN is down',
  status: 'open',
  priority: 'high',
  type: 'bug',
  groupName: 'Partnerships',
  assigneeNames: ['Alice'],
  customFieldValues: null,
  ticketUrl: 'https://tickets.example.com/t/1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sendToNotion', () => {
  it('creates a new page when no existing page matches the incident number', async () => {
    const calls: { url: string; method: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, method: init.method ?? 'GET' });
        if (url.endsWith('/query')) {
          return new Response(JSON.stringify({ results: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({ id: 'page-1' }), { status: 200 });
      }),
    );

    await sendToNotion('token-abc', { databaseId: 'db-1' }, snapshot);

    expect(calls).toEqual([
      { url: 'https://api.notion.com/v1/databases/db-1/query', method: 'POST' },
      { url: 'https://api.notion.com/v1/pages', method: 'POST' },
    ]);
  });

  it('updates the existing page when the incident number already matches one', async () => {
    const calls: { url: string; method: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, method: init.method ?? 'GET' });
        if (url.endsWith('/query')) {
          return new Response(JSON.stringify({ results: [{ id: 'page-existing' }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ id: 'page-existing' }), { status: 200 });
      }),
    );

    await sendToNotion('token-abc', { databaseId: 'db-1' }, snapshot);

    expect(calls).toEqual([
      { url: 'https://api.notion.com/v1/databases/db-1/query', method: 'POST' },
      { url: 'https://api.notion.com/v1/pages/page-existing', method: 'PATCH' },
    ]);
  });

  it('throws with the response body when Notion returns a non-2xx status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/query')) return new Response(JSON.stringify({ results: [] }), { status: 200 });
        return new Response('invalid database_id', { status: 400 });
      }),
    );

    await expect(sendToNotion('token-abc', { databaseId: 'bad-id' }, snapshot)).rejects.toThrow(
      /Notion create failed: 400/,
    );
  });
});

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const serviceAccountJson = JSON.stringify({
  client_email: 'export-bot@my-project.iam.gserviceaccount.com',
  private_key: privateKey,
});

function stubGoogleFetch(handleSheetsCall: (url: string, init: RequestInit) => Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ access_token: 'token-abc', expires_in: 3600 }), { status: 200 });
      }
      return handleSheetsCall(url, init);
    }),
  );
}

describe('sendToGoogleSheets', () => {
  it('appends a new row when the incident number is not already in column A', async () => {
    const calls: { url: string; method: string }[] = [];
    stubGoogleFetch((url, init) => {
      calls.push({ url, method: init.method ?? 'GET' });
      if (init.method === undefined || init.method === 'GET') {
        return new Response(JSON.stringify({ values: [['Incident Number']] }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    await sendToGoogleSheets(serviceAccountJson, { spreadsheetId: 'sheet-1' }, snapshot);

    expect(calls[0]?.url).toContain('/values/Sheet1!A%3AA');
    expect(calls[1]?.method).toBe('POST');
    expect(calls[1]?.url).toContain(':append');
  });

  it('updates the existing row when the incident number is already present', async () => {
    const calls: { url: string; method: string }[] = [];
    stubGoogleFetch((url, init) => {
      calls.push({ url, method: init.method ?? 'GET' });
      if (init.method === undefined || init.method === 'GET') {
        return new Response(JSON.stringify({ values: [['Incident Number'], [snapshot.incidentNumber]] }), {
          status: 200,
        });
      }
      return new Response('{}', { status: 200 });
    });

    await sendToGoogleSheets(serviceAccountJson, { spreadsheetId: 'sheet-1' }, snapshot);

    expect(calls[1]?.method).toBe('PUT');
    expect(calls[1]?.url).toContain('A2%3AJ2');
  });

  it('throws with the response body when Sheets returns a non-2xx status', async () => {
    stubGoogleFetch((url, init) => {
      if (init.method === undefined || init.method === 'GET') {
        return new Response(JSON.stringify({ values: [] }), { status: 200 });
      }
      return new Response('permission denied', { status: 403 });
    });

    await expect(sendToGoogleSheets(serviceAccountJson, { spreadsheetId: 'sheet-1' }, snapshot)).rejects.toThrow(
      /Sheets append failed: 403/,
    );
  });
});
