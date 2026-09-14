# Ticketing System

Self-hosted support ticketing system. Discord bot ticket creation, Authentik SSO
via BetterAuth, admin escalation/assignment, and Uptime Kuma-fed status page.
Deploys to Kubernetes via ArgoCD.

## Features

- **Discord ticket creation** — `/ticket` opens a modal, creates a ticket, DMs the
  user a link. Works before they even have a web account.
- **Account linking** — `/link <code>` binds a Discord account to a web account
  (code generated from `/settings/link-discord`), merging past + future tickets.
- **SSO via Authentik** — sign in through BetterAuth's generic OIDC plugin.
  Authentik group membership auto-grants admin (`ADMIN_GROUPS` env), everyone
  else is a regular user.
- **Ticket lifecycle** — create, reply (live via SSE), status/priority/SLA/tag
  changes, one-click escalate, admin-only internal notes.
- **Admin queue** — `/admin` lists every ticket (submitter, title, status,
  priority, assignee, tags, SLA due date) with filters for status, priority,
  assignee, tag, and overdue-only. Overdue rows are highlighted.
- **SLA due dates** — admins set a due date per ticket; tickets are "overdue"
  once that date passes and the ticket isn't resolved/closed. Auto-clears when
  resolved and is re-evaluated if reopened.
- **Admin dashboard metrics** — `/admin/metrics` shows open/pending/escalated/
  resolved/closed counts, overdue count, average resolution time, and a
  priority breakdown.
- **Ticket categories/tags** — admins manage a shared tag set at `/admin/tags`
  (name + color) and apply multiple tags per ticket from the ticket detail view.
- **File attachments** — upload files to a ticket (any S3/minio-compatible
  bucket). Uploads go straight from the browser to storage via a presigned
  URL; the server never proxies file bytes.
- **Assignment is admin-only** — tickets can only be assigned to users with
  the `admin` role; the API rejects assigning to a regular user.
- **Uptime Kuma integration** — Kuma's webhook notification posts to this app,
  which opens/resolves a maintenance event and shows it on a public `/status`
  page. Admins can also post manual maintenance windows.
- **RBAC** — users see and reply to their own tickets, including who's
  assigned; admins see and manage everything via the admin queue.

## Architecture

pnpm monorepo:

```
apps/web      Next.js app — UI, API routes, BetterAuth, Prisma access
apps/bot      background service — syncs Authentik directory, sends Discord DMs via external bot API
packages/db   Prisma schema + generated client, shared by web (bot only calls the API)
packages/shared  zod schemas + types shared between web and bot
deploy/       kustomize base + prod overlay for k8s
argocd/       ArgoCD Application manifest
```

The bot never touches Postgres directly — it calls `apps/web`'s
`/api/internal/*` routes with a shared secret (`INTERNAL_API_SECRET`). This
keeps one write path into the database.

## Prerequisites

- Node 20+, [pnpm](https://pnpm.io) (`npm install -g pnpm` if you don't have it)
- Docker + Docker Compose (for local Postgres / full-stack run)
- An Authentik instance with an OIDC application configured for this app
- A key for the external Discord bot HTTP API (`DISCORD_DM_API_KEY`) — a separate system owns
  the Discord gateway connection (slash commands, receiving messages) and calls this app's
  `/api/internal/*` routes; this app only calls back out to send DMs
- An S3-compatible bucket for ticket attachments (AWS S3, or self-hosted
  [minio](https://min.io) — the local Docker Compose stack runs minio for you)
- The [Prometheus Operator CRDs](https://github.com/prometheus-operator/prometheus-operator)
  installed in the target cluster before the first sync — `deploy/base` includes a
  `ServiceMonitor` (`web-servicemonitor.yaml`), and ArgoCD will fail to sync an unknown
  `monitoring.coreos.com/v1` kind without them

## Configuring Authentik

1. Create an OIDC/OAuth2 **application + provider** in Authentik.
   - Client type: **Confidential**
   - Redirect URI: `https://<your-domain>/api/auth/oauth2/callback/authentik`
     (or `http://localhost:3000/...` for local dev)
   - Scopes: `openid`, `profile`, `email`, and a `groups` scope mapping so the
     userinfo response includes a `groups` claim
2. Note the issuer URL, client ID, and client secret — these become
   `AUTHENTIK_ISSUER`, `AUTHENTIK_CLIENT_ID`, `AUTHENTIK_CLIENT_SECRET`.
3. Pick (or create) an Authentik group for admins, e.g. `ticketing-admins`, and
   set it as `ADMIN_GROUPS` (comma-separated if more than one). Anyone in that
   group is granted the `admin` role on next sign-in; everyone else is `user`.

## Configuring Discord

Slash commands and the Discord gateway connection live in a separate system —
this repo doesn't register or handle them. That system calls this app's
`POST /api/internal/tickets` (see `docs/discord-ticket-api.md`) to create
tickets, and `apps/bot` calls the external Discord bot HTTP API
(`DISCORD_DM_API_KEY`) to send DMs back to users.

## Environment variables

Copy `.env.example` to `.env` at the repo root (used by `docker-compose.yml`)
and fill in real values. Per-app `.env.example` files exist too, for running
`apps/web` / `apps/bot` outside Docker.

| Variable | Used by | Notes |
|---|---|---|
| `DATABASE_URL` | web, db | Postgres connection string |
| `BETTER_AUTH_SECRET` | web | 32+ random bytes, e.g. `openssl rand -hex 32` |
| `BETTER_AUTH_URL` / `PUBLIC_APP_URL` | web | Public URL of the web app |
| `AUTHENTIK_ISSUER` | web | Authentik OIDC issuer URL |
| `AUTHENTIK_CLIENT_ID` / `AUTHENTIK_CLIENT_SECRET` | web | From the Authentik application |
| `AUTHENTIK_API_TOKEN` | web | Authentik API token with read access to `core/users/`, used to sync the user directory |
| `ADMIN_GROUPS` | web | Comma-separated Authentik group names → admin role |
| `INTERNAL_API_SECRET` | web, bot | Shared secret between bot and web's internal API |
| `UPTIME_KUMA_WEBHOOK_SECRET` | web | Sent as `?secret=` query param on the Kuma webhook URL |
| `DISCORD_DM_API_KEY` | bot | Bearer key for the external Discord bot HTTP API used to send DMs |
| `DISCORD_DM_API_URL` | bot | Optional, defaults to `https://discordbot.monashautomation.com` |
| `S3_ENDPOINT` | web | Must be reachable from the **browser** — presigned upload/download URLs are handed to the client directly, not proxied |
| `S3_REGION` | web | Defaults to `us-east-1`; minio ignores the value but the SDK requires one |
| `S3_BUCKET` | web | Bucket for ticket attachments (created automatically by the `minio-init` compose service in dev) |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | web | Credentials for the bucket |
| `S3_FORCE_PATH_STYLE` | web | `true` for minio/most self-hosted S3-compatible stores; `false` for AWS S3 |

## Running in development

Two ways to run locally. Both need `docker compose up -d postgres` at minimum
(or the full stack, for the Docker option).

### Option A: Docker Compose (closest to prod, least setup)

```bash
cp .env.example .env   # fill in real values
docker compose up -d postgres migrate minio minio-init web bot
curl http://localhost:3000/api/health   # should return {"success":true,...}
```

`minio-init` creates the attachments bucket automatically. The minio console
is at `http://localhost:9001` (login with `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`).

Rebuild after code changes: `docker compose up -d --build web bot`.

### Option B: Native (faster iteration, hot reload)

```bash
pnpm install
docker compose up -d postgres minio minio-init   # database + attachment storage
pnpm --filter @ticketing/db generate
DATABASE_URL=postgresql://ticketing:ticketing@localhost:5432/ticketing?schema=public \
  pnpm --filter @ticketing/db exec prisma migrate deploy

pnpm dev:web   # apps/web, http://localhost:3000, hot reload
pnpm dev:bot   # apps/bot, separate terminal, hot reload via tsx watch
```

Or run both at once, split-pane, via [mprocs](https://github.com/pvolok/mprocs):

```bash
pnpm dev
```

### Testing

```bash
pnpm test               # unit tests (packages/shared, apps/web) — no DB needed
pnpm test:integration   # spins up a throwaway Postgres via Docker, runs migrations,
                         # runs integration tests, tears it down
pnpm typecheck
pnpm lint
```

## Running in production

Production runs as containers on Kubernetes, deployed via ArgoCD (GitOps) —
not `docker compose up` on a server.

- `deploy/base` — Deployments/Services/Ingress/ConfigMaps + the migration
  `Job` (kustomize base). Includes a self-hosted minio Deployment
  (`minio.yaml`) for ticket attachments, with its own public `Ingress` at
  `S3_ENDPOINT` (browser needs direct access for presigned uploads) — swap
  for a real AWS S3 bucket instead by deleting `minio.yaml` from
  `kustomization.yaml` and pointing `S3_ENDPOINT`/`S3_INTERNAL_ENDPOINT` at
  AWS.
- `deploy/overlays/prod` — prod-specific patches + image tags
- `argocd/application.yaml` — ArgoCD `Application` pointing at
  `deploy/overlays/prod`

Three images are built: `ticketing-web`, `ticketing-bot`, and
`ticketing-migrate` (built from `packages/db/Dockerfile`, runs
`prisma migrate deploy` and exits). The migrate image runs as a k8s `Job`
annotated `argocd.argoproj.io/hook: PreSync` — ArgoCD runs it to completion
against `DATABASE_URL` before every sync that changes the web/bot
Deployments, so the schema is always migrated ahead of the new pods starting.

**One-time setup before the first sync:**

1. Update image references (`ghcr.io/ORG/...`) and the ingress host in
   `deploy/base/*.yaml` and `deploy/overlays/prod/kustomization.yaml`.
2. Generate real secrets from `deploy/base/secrets.example.yaml` with
   [`kubeseal`](https://github.com/bitnami-labs/sealed-secrets) and commit the
   result to `deploy/overlays/prod/sealed-secrets.yaml` (placeholder only —
   never commit plaintext secrets). This includes `DATABASE_URL` (used by both
   the web Deployment and the migration Job) and the `S3_ACCESS_KEY_ID`/
   `S3_SECRET_ACCESS_KEY` pair — the non-secret S3 vars (`S3_ENDPOINT`,
   `S3_REGION`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE`) live in
   `deploy/base/configmap.yaml` and need real values for your bucket too.
   For the bundled minio, `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` must
   match `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` in `ticketing-minio-secrets`
   — same credentials in both Secrets. A `PostSync` Job
   (`ticketing-minio-init`) creates the bucket automatically on first sync.
3. `kubectl apply -f argocd/application.yaml`

**Ongoing deploys are automatic:** CI (`.github/workflows/ci.yml`) builds and
pushes all three images on every merge to `main`, bumps the overlay's image
tags (a GitOps commit), and ArgoCD picks up the change, runs the migration
Job, then syncs the web/bot Deployments — no manual `kubectl apply` needed
after the initial setup above.

**Rolling back:** revert or fix-forward the GitOps commit that bumped the
image tag in `deploy/overlays/prod/kustomization.yaml`; ArgoCD will sync to
whatever that file points at. Note the migration Job only ever runs forward
(`prisma migrate deploy`) — reverting the tag does **not** undo a schema
migration. If a bad release included one, fix-forward with a new migration
rather than reverting past it.

## Uptime Kuma setup

In Uptime Kuma, add a **Webhook** notification pointing at:

```
https://<your-domain>/api/webhooks/uptime-kuma?secret=<UPTIME_KUMA_WEBHOOK_SECRET>
```

Attach it to the monitors you want reflected on `/status`. Down → opens a
maintenance event; the next matching up → resolves it.

## Known limitations

- SSE (live ticket replies) uses an in-memory event bus — fine for one `web`
  replica, needs Redis pub/sub if you scale past that.
- No email notifications; Discord DM + web UI only.
- Attachments are capped at 25MB per file (enforced in `requestUploadSchema`);
  raise the limit there and in your S3/minio bucket policy if needed.
- No malware/content scanning on uploaded attachments — if that matters for
  your deployment, add a scanning step (e.g. ClamAV sidecar) before trusting
  downloads.
