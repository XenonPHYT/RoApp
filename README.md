# RoApp — public Discord bot & dashboard

Create, manage, and process community applications through Discord and the RoApp Dashboard.

This is a complete, configurable source project, not an already deployed service. No owner credentials were supplied, no commands were registered against a live application, and no production deployment was performed. Local integration and browser test evidence is in [docs/testing.md](docs/testing.md).

## Stack

JavaScript ES modules; one Cloudflare Worker; one D1 database; same-origin static HTML/CSS/vanilla JavaScript; native fetch/Web Crypto. No runtime npm libraries, Gateway connection, frontend build framework, R2, Redis, queue service, or second database. Development-only dependencies provide Wrangler, local D1 simulation, Chromium tests, ESLint, and Prettier.

## First command

After extraction, open a terminal in the `roapp` directory and run:

```sh
npm ci
```

Requires Node.js 22.13+ (tested on 22.23.4), npm, and a supported local workerd platform. The Node SQLite test adapter currently emits an experimental-feature warning on Node 22; it is not used in the production Worker.

## Local setup

```sh
cp .env.example .dev.vars
```

Replace the values in `.dev.vars` with your own Discord development application configuration. The template sets the local origin to `http://localhost:8787`. Keep `.dev.vars` private. Use a random SESSION_SECRET of at least 32 characters; for example generate one with `openssl rand -hex 32`. Do not paste real credentials into source files or chat.

Authenticate and create exactly one D1 database:

```sh
npx wrangler login
npx wrangler d1 create roapp-db
```

Copy the real database ID returned by Cloudflare into `d1_databases[0].database_id` in `wrangler.jsonc`. Set `vars.APP_ORIGIN` to your eventual production HTTPS origin (no trailing path). The local `.dev.vars` origin overrides that value for development.

Initialize a **fresh empty local database once**:

```sh
npm run db:init:local
npm run dev
```

Open `http://localhost:8787/` and `http://localhost:8787/health`. The public page and health route work before Discord configuration; protected features intentionally fail closed until valid configuration is present. Discord cannot send interactions to a private localhost URL: use a deployed development Worker or a secure HTTPS tunnel with the exact OAuth origin/callback configured accordingly. There is no authentication bypass or production demo login.

The schema is deliberately not idempotent. Do not rerun initialization on a populated database. For fresh development experiments use a separate `--persist-to` directory; do not delete production data. There is one initial schema, not a migrations directory.

## Quality checks

```sh
npm run check
npm run lint
npm run format:check
npm test
npx playwright install --with-deps chromium
npm run test:browser
npm run dry-run
npm audit
```

The first Chromium installation requires system dependencies (on Linux, use an authorized administrator/sudo installation if required). Browser tests intercept APIs with explicit fixtures and test the real frontend; they are not live Discord tests. Backend tests include actual workerd D1 execution as well as a lightweight SQLite adapter. A clean browser-test run starts Wrangler itself on port 8787; an existing local instance can be reused.

## Production setup

Follow [docs/deployment.md](docs/deployment.md) and [docs/discord-setup.md](docs/discord-setup.md). Create the remote empty schema once with `npm run db:init:remote`. Configure every secret using `npx wrangler secret put NAME`, then deploy with `npm run deploy`. Do not deploy configuration placeholders.

### Required configuration

| Binding                  | Value                                                      | Location                                                  |
| ------------------------ | ---------------------------------------------------------- | --------------------------------------------------------- |
| `DB`                     | Your D1 database, named roapp-db                           | wrangler.jsonc                                            |
| `ASSETS`                 | ./public, served by the same Worker                        | wrangler.jsonc                                            |
| `APP_ORIGIN`             | Exact HTTPS deployment origin                              | wrangler.jsonc vars; local override in .dev.vars          |
| `SESSION_HOURS`          | Session lifetime, capped at 8 hours and OAuth token expiry | wrangler.jsonc vars                                       |
| `DISCORD_PUBLIC_KEY`     | Application Ed25519 public key, 64 hex characters          | Wrangler secret / .dev.vars                               |
| `DISCORD_APPLICATION_ID` | Discord application ID                                     | Wrangler secret / .dev.vars; shell env for command script |
| `DISCORD_CLIENT_ID`      | OAuth client ID, normally the application ID               | Wrangler secret / .dev.vars                               |
| `DISCORD_CLIENT_SECRET`  | OAuth client secret                                        | Wrangler secret / .dev.vars                               |
| `DISCORD_BOT_TOKEN`      | Bot token                                                  | Wrangler secret / .dev.vars; shell env for command script |
| `SESSION_SECRET`         | Cryptographically random secret, at least 32 characters    | Wrangler secret / .dev.vars                               |

Public identifiers are kept in the same deployment-secret workflow for simplicity; they are not claimed to be private credentials. Never include a real bot token or OAuth secret in wrangler.jsonc.

## First community workflow

1. Invite the bot with `bot` and `applications.commands` scopes and the minimal channel permissions described in the Discord guide.
2. Register development-guild commands using `npm run register` with shell environment variables; explicitly opt in to global registration later.
3. The actual Discord server owner runs `/setup`. Administrator permission alone is not sufficient.
4. Sign in to the dashboard, select that community, create and save a form, then publish its first version.
5. Configure staff roles and granular permissions. Dashboard access is a separate owner-controlled grant.
6. Configure a text-channel panel, choose forms, save, then publish it. Publishing again patches the stored message instead of intentionally creating another.
7. An applicant uses `/apply` or the panel. Short text-only forms open a Discord modal. Other forms open the authenticated applicant web portal.
8. Reviewers use `/review` privately or the authorized dashboard. Move Pending → Under Review before approving or rejecting. Assignment does not silently change status.
9. Applicant-visible reasons are separate from internal notes. Requested revisions are submitted against the original version snapshot.
10. If you edit/publish/close forms, update any existing panels to refresh their display. The backend rejects closed or stale forms even before a panel is refreshed.

## Included features

Versioned forms for short/long text, multiple choice, dropdown, checkboxes, yes/no, number, date, and Roblox username; required fields, ordering, validation, duplicate/cooldown controls; applicant references and ownership; revisions and withdrawals; private paginated reviewer queues, search, assignment, full-answer reading, internal notes and decisions; per-guild role policy; OAuth/session/CSRF protection; dashboard analytics and audit history; persistent panels; public Roblox username lookup; durable DM retry jobs with an every-five-minute scheduled handler.

Application references use `APP-<UTC year>-<16 random hex characters>` rather than a predictable sequential counter. A database UNIQUE constraint is the collision backstop. They are references, never authorization tokens.

## Important limits

Live Discord/OAuth/Roblox behavior and Cloudflare production deployment still require your credentials and a real test server. Public Roblox lookup confirms existence only, never account ownership. DMs are best-effort, with retries; disabled DMs produce a visible failed job. Delivery is at-least-once and cannot be made perfectly atomic with an external Discord API. See [docs/security.md](docs/security.md) for operational limits, rates, and retention responsibilities.

No applicant draft autosave, Roblox OAuth/group-rank verification, platform-owner admin panel, file uploads, or global administrator bypass is presented as available. They are outside the required initial feature set. Forms are archived by closing rather than destructively deleting historical versions.

## Troubleshooting

- `origin_not_configured` / `session_secret_not_configured`: replace placeholders, check `.dev.vars`, and restart Wrangler.
- OAuth callback failure: use the exact scheme/hostname/port and callback path configured in Discord; start login again after an expired or consumed state.
- `community_not_configured`: the current server owner must run `/setup` after the bot is installed.
- `dashboard_forbidden`: Administrator is intentionally not enough; the owner must grant the correct Discord role dashboard access.
- `permission_denied`: grant the specific granular permission; decisions also require review access.
- `stale_record` / `stale_form`: reload the record before editing or deciding. Another action or a Roblox lookup may have advanced its revision.
- `duplicate_or_cooldown`: an active application exists or the configured cooldown has not elapsed. Completed applications allow another submission subject to cooldown.
- Missing panel message: remove the saved panel (404 on Discord delete is tolerated), then recreate/publish it in the correct channel.
- Upstream Discord failures: verify token, installation, channel rights, current membership and API availability. Authorization never falls back to browser claims.
- Failed DMs: check Community Settings → Notification delivery. After fixing the cause, explicitly retry a failed job.
- `table already exists`: the initial schema was already applied; do not run it again. Back up and plan schema changes separately after launch.

No license is assigned; the project owner did not specify one.
