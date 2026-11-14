# Cloudflare deployment runbook

## Before deployment

Use Node 22.13+ and install with `npm ci`. Keep a copy of the source and take a D1 backup before any later schema change. Authenticate with `npx wrangler login` in your own account. No account, database or application identifiers in the templates are real deployment values.

Create exactly one database:

```sh
npx wrangler d1 create roapp-db
```

Put the returned ID into wrangler.jsonc. Keep the binding DB and database name roapp-db (or consistently rename the npm database commands too). Set APP_ORIGIN to the exact HTTPS Worker/custom-domain origin and keep compatibility_date 2026-11-13. Configure a stable custom domain or your assigned workers.dev hostname; do not invent one.

Apply schema once to a **new empty remote database**:

```sh
npm run db:init:remote
```

There are no initial migrations. Do not rerun this on a database that contains tables. Local D1 data is separate from remote D1.

## Secrets

Run each command and enter the value in the private Wrangler prompt:

```sh
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_APPLICATION_ID
npx wrangler secret put DISCORD_CLIENT_ID
npx wrangler secret put DISCORD_CLIENT_SECRET
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put SESSION_SECRET
```

Generate SESSION_SECRET with a cryptographically secure source, at least 32 characters. Never use the placeholder or test fixture strings. Public IDs and the Ed25519 public key can be treated as non-secret deployment values, but this project uses Wrangler secrets consistently to avoid accidental confusion.

Do not deploy .dev.vars, .env, test credentials, local databases, node_modules, build caches or test output. Wrangler bundles src and public assets; the ZIP excludes local/private artifacts.

## Validate and deploy

```sh
npm run check
npm run lint
npm run format:check
npm test
npm run test:browser
npm run dry-run
npm run deploy
```

Install Chromium once first with `npx playwright install --with-deps chromium` for browser tests. Dry-run bundles without deploying and does not prove real credentials or production resource access. Check the actual deployed `/health` returns 200 and correct JSON. Configure Discord's interactions endpoint and exact OAuth callback only after the Worker is reachable.

The deployment includes an every-five-minute cron trigger. This is an internal Worker scheduled handler, not a separate background service. Each tick expires old auth/abuse infrastructure records and handles up to ten due DM jobs. This initial throughput is about 120 jobs/hour under normal timing; multiple pending status updates can create several jobs per application. Monitor backlog and adjust the bounded batch/schedule only after capacity testing. Local Wrangler does not automatically fire scheduled events; trigger `/cdn-cgi/local/scheduled` on a local instance for a manual test.

## Acceptance with real credentials

Perform the checklist in docs/testing.md in a private Discord server before public invitations. Verify signature/PING setup, all native component types, OAuth round trip, live role revocation, tenant boundaries, panel updates, private answers/notes and DMs. Exercise both a modal form and a web form on desktop/mobile. Confirm the scheduled job runs on the deployed Worker and Discord rate-limit responses behave as expected.

Do not mark live acceptance complete based only on the included local tests.

## Operating and backups

Use Cloudflare D1 export before changes:

```sh
npx wrangler d1 export roapp-db --remote --output roapp-backup.sql
```

This export contains private applicant/session data: store it encrypted with restricted access, never commit it. Restore to an empty replacement database and validate offline before switching bindings. Choose and document a community retention/privacy policy before collecting real applications; automatic tenant data erasure is not exposed in this initial management UI.

For a session-secret rotation, set a new secret **and revoke stored sessions** (for example, an authorized operator can execute `DELETE FROM dashboard_sessions` against the correct database). Merely changing the token-encryption key is not a guaranteed logout for every existing opaque session. Rotating the Discord token requires updating the Wrangler secret; rotating OAuth credentials may require users to sign in again.

## Common deployment failures

A wrong APP_ORIGIN breaks origin/CSRF/OAuth validation by design. An invalid Discord key fails PING setup. Missing bot installation or permissions blocks current-member checks and panel delivery. A wrong D1 binding or uninitialized schema fails health or data routes; do not create a second database to mask a configuration error. Diagnose in Wrangler without logging tokens, OAuth bodies, cookies or application answers.
