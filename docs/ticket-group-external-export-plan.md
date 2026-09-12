**Status: implemented** (2026-09-12). All 8 rollout steps below are done, including tests.
`ticketExportDelivery.integration.test.ts` and the `updateTicketGroupExportConfig` cases in
`ticketGroups.integration.test.ts` need a running Postgres (`docker-compose up postgres`) to
execute -- not available in this sandbox, so they're written but unrun here; run
`pnpm test:integration` (`scripts/test-integration.sh`) once DB is up. Also apply the new
migration (`packages/db/prisma/migrations/20260912000000_group_ticket_export`) via
`pnpm --filter db migrate:dev` / `migrate deploy`, and set `NOTION_INTEGRATION_TOKEN` /
`GOOGLE_SERVICE_ACCOUNT_JSON` (see `.env.example`) plus the cron entry for
`POST /api/internal/ticket-exports/pending` to actually enable delivery.

# Plan: group-configurable Notion / Google Sheets export

Goal: let each `TicketGroup` opt into mirroring its tickets to a Notion database
and/or a Google Sheet. Group members configure their own group's export target;
admins configure any group's. Off by default. Mirrors the existing
`formConfig`/"Send to" pattern: member-or-admin edits one JSON blob on
`TicketGroup`, everything else on the group stays admin-only.

## 0. Design decision: shared app credentials, not per-group secrets

No secret-storage/encryption infra exists in this codebase today (checked --
`DiscordSettings` stores channel IDs, not tokens; the bot token lives in env).
Follow that precedent instead of introducing one:

- **Notion**: one app-wide internal integration token in env
  (`NOTION_INTEGRATION_TOKEN`). A group just supplies the target **database
  ID** and must share that database with the integration in Notion first (same
  shape as "invite the bot to your channel"). We never store a Notion secret
  in Postgres.
- **Google Sheets**: one app-wide service account (`GOOGLE_SERVICE_ACCOUNT_JSON`
  in env / secret manager). A group supplies the target **spreadsheet ID** and
  shares that sheet with the service account's email (shown in the UI so the
  user knows what to share with) as an Editor. Same reasoning -- no OAuth
  dance, no per-user token refresh/storage problem.

If a future group needs a *different* Notion workspace or Google account than
the shared one, that's a v2 (per-group encrypted credentials); out of scope
here since no current requester needs it.

## 1. Data model

```prisma
enum TicketExportTarget {
  notion
  google_sheets
}

model TicketGroup {
  // ...existing fields unchanged...
  /// Null = export off for this group. Validated shape: GroupExportConfig
  /// (packages/shared/src/exportConfig.ts). Editable by group members or admins,
  /// same gating as formConfig -- see isTicketGroupMember/updateTicketGroupExportConfig.
  exportConfig Json?
}

/// Outbox row per (ticket, target) mutation the group wants mirrored. Web app enqueues
/// on ticket create/update; /api/internal/ticket-exports/pending is polled by an external
/// cron hitting the Notion/Sheets APIs directly (no bot/gateway needed for either, unlike
/// Discord) -- mirrors DiscordDm/DiscordChannelMessage's enqueue-then-deliver shape.
model TicketExportJob {
  id          String              @id @default(cuid())
  ticketId    String
  ticket      Ticket              @relation(fields: [ticketId], references: [id], onDelete: Cascade)
  groupId     String
  target      TicketExportTarget
  /// Denormalized snapshot of the row to write (title, status, priority, assignee names,
  /// custom field values, ticket URL, etc) -- computed at enqueue time so delivery doesn't
  /// need to re-read a possibly-since-changed ticket. Shape: TicketExportSnapshot.
  payload     Json
  attempts    Int                 @default(0)
  lastError   String?
  sentAt      DateTime?
  createdAt   DateTime            @default(now())

  @@index([sentAt])
  @@index([target, createdAt])
  @@map("ticket_export_jobs")
}
```

Migration is additive/forward-only (new table + one nullable column, no
backfill, no `migrate reset` -- see [[feedback_prod_migrations_no_wipe]]).

## 2. Shared config shape (`packages/shared/src/exportConfig.ts`)

```ts
export interface NotionExportConfig {
  databaseId: string;
}

export interface GoogleSheetsExportConfig {
  spreadsheetId: string;
  /** Defaults to the first sheet/tab if omitted. */
  sheetName?: string;
}

export interface GroupExportConfig {
  notion?: NotionExportConfig;
  googleSheets?: GoogleSheetsExportConfig;
}
```

`groupExportConfigSchema` (zod): both keys optional, at least one required
when the object itself is non-null; `databaseId`/`spreadsheetId` non-empty
strings (format is opaque to us -- a bad id just surfaces as delivery
`lastError` on first sync attempt, caught in section 4).

## 3. Enqueue path (`packages/shared` snapshot + `server/ticketExports.ts`)

- `buildTicketExportSnapshot(ticket, group)`: pure function producing the
  `TicketExportSnapshot` (incidentNumber, title, status, priority, type,
  assignee names, group name, customFieldValues, ticket URL, createdAt,
  updatedAt). Reused by both targets; each target's sender maps it to that
  API's shape (Notion page properties vs. a sheet row array).
- `enqueueTicketExportJobs(ticket, group)`: called from the same places
  `tickets.ts` already touches group-routing -- ticket create, and any update
  that changes a field present in the snapshot (status/priority/assignee/etc).
  Reads `group.exportConfig`; no-ops per-target if that target is unset. Skips
  entirely if `exportConfig` is null. **Fire-and-forget from the caller's
  perspective**: this only writes an outbox row inside the same transaction as
  the ticket mutation, so it can never fail the user-facing request.
- One `TicketExportJob` row per configured target per triggering mutation --
  not a single "sync now" flag on the ticket -- so a transient Notion outage
  doesn't block Sheets delivery and each target's retry/backoff is independent.

## 4. Delivery (`apps/web/src/server/ticketExportDelivery.ts` + internal route)

Follows the `cleanup-attachments`/`sync-authentik` shape: external cron POSTs
`/api/internal/ticket-exports/pending`, gated by `requireInternalSecret`.

```typescript
export async function deliverPendingTicketExports(limit = 50): Promise<{ sent: number; failed: number }> {
  const jobs = await prisma.ticketExportJob.findMany({
    where: { sentAt: null, attempts: { lt: MAX_ATTEMPTS } },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });

  let sent = 0, failed = 0;
  for (const job of jobs) {
    try {
      await sendToTarget(job.target, job.payload as TicketExportSnapshot, job);
      await prisma.ticketExportJob.update({ where: { id: job.id }, data: { sentAt: new Date() } });
      sent++;
    } catch (error) {
      await prisma.ticketExportJob.update({
        where: { id: job.id },
        data: { attempts: { increment: 1 }, lastError: getErrorMessage(error) },
      });
      failed++;
    }
  }
  return { sent, failed };
}
```

- `MAX_ATTEMPTS = 5`; jobs stuck at the ceiling are surfaced in the group's
  export UI (section 6) as "last error: ..." rather than retried forever.
  Delivery itself doesn't need in-process exponential backoff since the cron
  interval (every few minutes) already spaces out retries.
- `sendToTarget('notion', ...)`: `PATCH`-or-`POST` to
  `https://api.notion.com/v1/pages` (find-existing-page-by-incidentNumber via
  a filtered query first, so re-delivery on update upserts rather than
  duplicates) using `NOTION_INTEGRATION_TOKEN`.
- `sendToTarget('google_sheets', ...)`: Sheets API v4
  `spreadsheets.values.append` for new tickets; for updates, look up the row
  by incidentNumber in column A (small per-group sheets -- a linear scan via
  one `values.get` is fine) and `values.update` that row. Auth via
  `google-auth-library`'s `JWT` client from the service account JSON.
- Both senders throw on non-2xx so the catch block above records `lastError`
  and increments `attempts` uniformly -- no per-target error handling
  duplicated at the delivery-loop level.

## 5. API routes

- `PATCH /api/ticket-groups/[id]/export-config` -- same gate as
  `.../form-config` (`role === 'admin' || isTicketGroupMember`), body validated
  by `updateGroupExportConfigSchema`, calls
  `updateTicketGroupExportConfig(groupId, exportConfig, actorId)` (writes the
  column + audit log entry `ticket_group.export_config_update`).
- `POST /api/internal/ticket-exports/pending` -- `requireInternalSecret`,
  calls `deliverPendingTicketExports()`. Cron hits this every few minutes
  (documented in deploy config, not this repo).
- Nothing new needed for enqueue -- it rides inside the existing ticket
  create/update server actions.

## 6. UI (`/groups/[id]/export`, `frontend-design` pass)

New page alongside `/groups/[id]/fields`, same access gate
(`isTicketGroupMember` or admin), same header/back-link shell
(`AppHeader`, `page`/`pageHeader`/`pageTitle` tokens) -- this is a settings
surface, not a place to introduce a new visual language, so it inherits the
existing group-editor chrome rather than reinventing it.

Two toggle cards (`Notion` / `Google Sheets`), each:

- Off by default; a switch reveals the one text input that target needs
  (database ID / spreadsheet ID + optional sheet name) plus **static setup
  copy telling the user exactly what to share and with whom** --
  the Notion integration's name/share-link and the service account email
  (both read from env at the page's server component, never hardcoded) --
  since that's the one manual step outside this app the feature depends on.
- A "Send a test row" button per enabled target: `POST` a single ad-hoc
  `TicketExportJob`-shaped delivery synchronously (not via the outbox) and
  show success or the raw error inline -- lets someone verify sharing/IDs are
  right before relying on the cron path, without waiting for a poll cycle.
- Last-delivery status per target: most recent job's `sentAt` or `lastError`
  (query on group open, not polled) -- flat two-line status text, not a full
  history table; failures beyond `MAX_ATTEMPTS` are the thing worth
  surfacing, not routine success noise.

Hierarchy: title small-caps label ("EXPORT") sits above the two cards at the
same weight `TicketGroupFieldsEditor` uses for its section labels, so the page
reads as one more tab of group settings rather than a bolted-on feature.

## 7. Testing

- `exportConfig.test.ts` (shared): schema validation edge cases (empty
  object, both unset, invalid ids).
- `ticketExports.test.ts`: `buildTicketExportSnapshot` pure-function unit
  tests; `enqueueTicketExportJobs` unit tests with a mocked prisma (no-op
  when `exportConfig` null, one job per configured target).
- `ticketExportDelivery.integration.test.ts`: mocked `fetch` for both Notion
  and Sheets sends -- success marks `sentAt`, 4xx/5xx increments `attempts` +
  sets `lastError`, job past `MAX_ATTEMPTS` excluded from the next poll.
- `ticketGroups.integration.test.ts`: extend existing suite with
  export-config PATCH gating (member yes, non-member no, admin yes for any
  group) -- same cases already covered for `form-config`.

## 8. Rollout order

1. Migration: `TicketExportTarget` enum, `TicketExportJob` table,
   `TicketGroup.exportConfig` column.
2. `packages/shared/src/exportConfig.ts` + schema + tests.
3. `server/ticketExports.ts` (snapshot + enqueue) + tests; wire into ticket
   create/update in `server/tickets.ts`.
4. `server/ticketExportDelivery.ts` (Notion + Sheets senders) + integration
   tests; env vars documented (`NOTION_INTEGRATION_TOKEN`,
   `GOOGLE_SERVICE_ACCOUNT_JSON`).
5. `updateTicketGroupExportConfig` + `PATCH .../export-config` route +
   `POST /api/internal/ticket-exports/pending` route.
6. `/groups/[id]/export` page + `TicketGroupExportEditor` component
   (frontend-design pass), linked from `/groups/[id]/fields` and the admin
   group editor next to the existing "Fields" link.
7. Update `docs/` deploy notes with the cron entry for the new internal route.
