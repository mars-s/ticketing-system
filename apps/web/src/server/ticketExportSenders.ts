import type { GoogleSheetsExportConfig, NotionExportConfig, TicketExportSnapshot } from '@ticketing/shared';
import { getGoogleSheetsAccessToken } from '@/lib/googleServiceAccount';

const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

/** Notion database property names this integration reads/writes. A group's database must
 * have these (any extra properties are left untouched); shown in the export setup UI. */
export const NOTION_REQUIRED_PROPERTIES = {
  title: 'Name',
  incidentNumber: 'Incident Number',
  status: 'Status',
  priority: 'Priority',
  type: 'Type',
  group: 'Group',
  assignees: 'Assignees',
  ticketUrl: 'Ticket URL',
} as const;

function notionHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

function notionProperties(snapshot: TicketExportSnapshot) {
  const p = NOTION_REQUIRED_PROPERTIES;
  return {
    [p.title]: { title: [{ text: { content: snapshot.title } }] },
    [p.incidentNumber]: { rich_text: [{ text: { content: snapshot.incidentNumber } }] },
    [p.status]: { select: { name: snapshot.status } },
    [p.priority]: { select: { name: snapshot.priority } },
    [p.type]: { select: { name: snapshot.type } },
    [p.group]: { rich_text: [{ text: { content: snapshot.groupName } }] },
    [p.assignees]: { rich_text: [{ text: { content: snapshot.assigneeNames.join(', ') || '—' } }] },
    [p.ticketUrl]: { url: snapshot.ticketUrl },
  };
}

/** Human-readable integration name shown in the export setup UI ("share your database
 * with <name>") so the one manual step this feature depends on is unambiguous. Returns
 * null on any failure (unset/invalid token) -- the UI falls back to generic copy. */
export async function getNotionBotName(token: string): Promise<string | null> {
  try {
    const res = await fetch(`${NOTION_API_BASE}/users/me`, { headers: notionHeaders(token) });
    if (!res.ok) return null;
    const body = (await res.json()) as { name?: string };
    return body.name ?? null;
  } catch {
    return null;
  }
}

async function findNotionPageId(token: string, databaseId: string, incidentNumber: string): Promise<string | null> {
  const res = await fetch(`${NOTION_API_BASE}/databases/${databaseId}/query`, {
    method: 'POST',
    headers: notionHeaders(token),
    body: JSON.stringify({
      filter: {
        property: NOTION_REQUIRED_PROPERTIES.incidentNumber,
        rich_text: { equals: incidentNumber },
      },
      page_size: 1,
    }),
  });
  if (!res.ok) throw new Error(`Notion query failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { results: { id: string }[] };
  return body.results[0]?.id ?? null;
}

/** Upserts one Notion page per ticket, keyed on the "Incident Number" property, so
 * re-delivery on a ticket update edits the existing page instead of duplicating it. */
export async function sendToNotion(
  token: string,
  config: NotionExportConfig,
  snapshot: TicketExportSnapshot,
): Promise<void> {
  const existingPageId = await findNotionPageId(token, config.databaseId, snapshot.incidentNumber);
  const properties = notionProperties(snapshot);

  const res = existingPageId
    ? await fetch(`${NOTION_API_BASE}/pages/${existingPageId}`, {
        method: 'PATCH',
        headers: notionHeaders(token),
        body: JSON.stringify({ properties }),
      })
    : await fetch(`${NOTION_API_BASE}/pages`, {
        method: 'POST',
        headers: notionHeaders(token),
        body: JSON.stringify({ parent: { database_id: config.databaseId }, properties }),
      });

  if (!res.ok) throw new Error(`Notion ${existingPageId ? 'update' : 'create'} failed: ${res.status} ${await res.text()}`);
}

const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

/** Column order written to the sheet -- documented in the export setup UI so a group knows
 * what header row to add. Incident Number (col A) is the upsert key. */
export const SHEETS_COLUMNS = [
  'Incident Number',
  'Title',
  'Status',
  'Priority',
  'Type',
  'Group',
  'Assignees',
  'Ticket URL',
  'Created At',
  'Updated At',
] as const;

function snapshotRow(snapshot: TicketExportSnapshot): string[] {
  return [
    snapshot.incidentNumber,
    snapshot.title,
    snapshot.status,
    snapshot.priority,
    snapshot.type,
    snapshot.groupName,
    snapshot.assigneeNames.join(', '),
    snapshot.ticketUrl,
    snapshot.createdAt,
    snapshot.updatedAt,
  ];
}

async function findSheetRowNumber(
  accessToken: string,
  spreadsheetId: string,
  sheetName: string,
  incidentNumber: string,
): Promise<number | null> {
  const range = encodeURIComponent(`${sheetName}!A:A`);
  const res = await fetch(`${SHEETS_API_BASE}/${spreadsheetId}/values/${range}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Sheets read failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { values?: string[][] };
  const rowIndex = (body.values ?? []).findIndex((row) => row[0] === incidentNumber);
  return rowIndex === -1 ? null : rowIndex + 1; // 1-indexed for the Sheets API
}

/** Upserts one row per ticket, keyed on column A (Incident Number), via a linear scan --
 * fine for the per-group sheet sizes this feature targets (hundreds, not millions, of rows). */
export async function sendToGoogleSheets(
  serviceAccountJson: string,
  config: GoogleSheetsExportConfig,
  snapshot: TicketExportSnapshot,
): Promise<void> {
  const accessToken = await getGoogleSheetsAccessToken(serviceAccountJson);
  const sheetName = config.sheetName ?? 'Sheet1';
  const rowNumber = await findSheetRowNumber(accessToken, config.spreadsheetId, sheetName, snapshot.incidentNumber);
  const row = snapshotRow(snapshot);
  const lastCol = String.fromCharCode('A'.charCodeAt(0) + SHEETS_COLUMNS.length - 1);

  if (rowNumber) {
    const range = encodeURIComponent(`${sheetName}!A${rowNumber}:${lastCol}${rowNumber}`);
    const res = await fetch(`${SHEETS_API_BASE}/${config.spreadsheetId}/values/${range}?valueInputOption=RAW`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [row] }),
    });
    if (!res.ok) throw new Error(`Sheets update failed: ${res.status} ${await res.text()}`);
    return;
  }

  const appendRange = encodeURIComponent(`${sheetName}!A:${lastCol}`);
  const res = await fetch(
    `${SHEETS_API_BASE}/${config.spreadsheetId}/values/${appendRange}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [row] }),
    },
  );
  if (!res.ok) throw new Error(`Sheets append failed: ${res.status} ${await res.text()}`);
}
