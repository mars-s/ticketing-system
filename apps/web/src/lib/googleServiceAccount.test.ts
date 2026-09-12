import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getGoogleServiceAccountEmail, getGoogleSheetsAccessToken } from './googleServiceAccount';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const serviceAccountJson = JSON.stringify({
  client_email: 'export-bot@my-project.iam.gserviceaccount.com',
  private_key: privateKey,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getGoogleServiceAccountEmail', () => {
  it('reads client_email out of the service account JSON', () => {
    expect(getGoogleServiceAccountEmail(serviceAccountJson)).toBe(
      'export-bot@my-project.iam.gserviceaccount.com',
    );
  });

  it('throws on malformed JSON', () => {
    expect(() => getGoogleServiceAccountEmail('not json')).toThrow();
  });

  it('throws when a required key is missing', () => {
    expect(() => getGoogleServiceAccountEmail(JSON.stringify({ client_email: 'x@y.com' }))).toThrow();
  });
});

describe('getGoogleSheetsAccessToken', () => {
  // Order matters: the module caches the last-issued token in-process (single shared
  // service account, see getGoogleSheetsAccessToken's comment), so the failure case runs
  // first -- otherwise it'd hit the cache from the success case instead of exercising fetch.
  it('throws when the token exchange fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bad request', { status: 400 })),
    );
    await expect(getGoogleSheetsAccessToken(serviceAccountJson)).rejects.toThrow(/Google token exchange failed/);
  });

  it('signs a JWT and exchanges it for an access token', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://oauth2.googleapis.com/token');
      const body = new URLSearchParams(init.body as string);
      expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
      expect(body.get('assertion')?.split('.')).toHaveLength(3);
      return new Response(JSON.stringify({ access_token: 'token-abc', expires_in: 3600 }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const token = await getGoogleSheetsAccessToken(serviceAccountJson);
    expect(token).toBe('token-abc');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
