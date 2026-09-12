import { z } from 'zod';

export const TICKET_EXPORT_TARGETS = ['notion', 'google_sheets'] as const;
export type TicketExportTarget = (typeof TICKET_EXPORT_TARGETS)[number];

export interface NotionExportConfig {
  databaseId: string;
}

export interface GoogleSheetsExportConfig {
  spreadsheetId: string;
  /** Defaults to the first sheet/tab when omitted. */
  sheetName?: string;
}

/** A TicketGroup's mirror-to-external-tool config. Both keys optional/independent -- a
 * group can enable either, both, or neither. Null on the group = export off entirely.
 * See docs/ticket-group-external-export-plan.md. */
export interface GroupExportConfig {
  notion?: NotionExportConfig;
  googleSheets?: GoogleSheetsExportConfig;
}

const notionExportConfigSchema = z.object({
  databaseId: z.string().trim().min(1, 'Notion database ID is required'),
});

const googleSheetsExportConfigSchema = z.object({
  spreadsheetId: z.string().trim().min(1, 'Spreadsheet ID is required'),
  sheetName: z.string().trim().min(1).optional(),
});

export const groupExportConfigSchema = z
  .object({
    notion: notionExportConfigSchema.optional(),
    googleSheets: googleSheetsExportConfigSchema.optional(),
  })
  .superRefine((config, ctx) => {
    if (!config.notion && !config.googleSheets) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Enable at least one export target, or send exportConfig: null to turn export off',
        path: [],
      });
    }
  });

export type GroupExportConfigInput = z.infer<typeof groupExportConfigSchema>;

/** Snapshot of a ticket's exportable state, computed at enqueue time (see
 * enqueueTicketExportJobs) so delivery never needs to re-read the ticket. Each target's
 * sender maps this to its own API shape (Notion page properties vs. a sheet row). */
export interface TicketExportSnapshot {
  incidentNumber: string;
  title: string;
  status: string;
  priority: string;
  type: string;
  groupName: string;
  assigneeNames: string[];
  customFieldValues: Record<string, string | boolean> | null;
  ticketUrl: string;
  createdAt: string;
  updatedAt: string;
}
