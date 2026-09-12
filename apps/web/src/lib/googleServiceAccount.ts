import { createSign } from 'node:crypto';
import { AppError } from '@/lib/errors';

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

let cached: CachedToken | null = null;

function parseServiceAccount(rawJson: string): ServiceAccountKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new AppError('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON');
  }
  const key = parsed as Partial<ServiceAccountKey>;
  if (!key.client_email || !key.private_key) {
    throw new AppError('GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key');
  }
  return key as ServiceAccountKey;
}

/** The email a group must share their spreadsheet with (as Editor) for export to work --
 * shown in the group export UI so the manual setup step is unambiguous. */
export function getGoogleServiceAccountEmail(rawJson: string): string {
  return parseServiceAccount(rawJson).client_email;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** Signs a Google service-account JWT and exchanges it for an OAuth access token
 * (RFC 7523 JWT bearer grant). No SDK dependency -- just node:crypto + fetch, matching the
 * app's existing minimal-dependency style. Cached in-process until ~1 minute before expiry. */
export async function getGoogleSheetsAccessToken(rawJson: string): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;

  const { client_email, private_key } = parseServiceAccount(rawJson);
  const nowSec = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      iat: nowSec,
      exp: nowSec + 3600,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(private_key);
  const jwt = `${signingInput}.${base64url(signature)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    throw new AppError(`Google token exchange failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { access_token: string; expires_in: number };
  cached = { accessToken: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return cached.accessToken;
}
