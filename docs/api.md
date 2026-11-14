# HTTP API overview

All APIs return JSON and no-store caching. Authentication is a server-side session cookie. Mutations require Origin matching APP_ORIGIN and X-CSRF-Token from GET /api/session. Except the signed Discord endpoint and OAuth entry/callback, there are no anonymous data APIs. Unknown routes fail safely.

| Method / route                 | Authorization / behavior                                                                |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| GET /health                    | Minimal D1 health, no secrets or configuration returned.                                |
| POST /api/discord/interactions | Discord signature required; PING, commands, buttons/selects/modals.                     |
| GET /auth/discord              | Begin OAuth, set state cookie.                                                          |
| GET /auth/discord/callback     | Consume matching state, exchange code, establish session, fixed redirect.               |
| GET /api/session               | Current user, CSRF, selected guild, expiry; no OAuth token.                             |
| POST /api/logout               | CSRF; revoke current session and clear cookie.                                          |
| GET /api/guilds                | Actual Discord memberships restricted to configured communities; policy evaluated live. |
| POST /api/guild/select         | CSRF + actual owner/allowed dashboard-role policy; stores selected guild.               |

## Management routes

Every `/api/manage/*` resolves guild from the server session and revalidates live dashboard access. Browser-supplied tenant assertions do not override it.

- GET context: current guild metadata, settings and effective granular permissions.
- GET overview: application status aggregates and open form count, for dashboard-authorized users.
- GET/POST forms; GET/PUT forms/:id; POST forms/:id/publish|close: forms.manage. Save sends `{definition,cooldown_seconds,allow_duplicates,edit_revision}`; edit_revision is required when updating an existing record.
- GET applications?filter=&page=&search=: applications.review, ten/page, exact-reference search.
- GET applications/:id: applications.review, private detail/notes/events.
- POST applications/:id/decision: applications.review + applications.decide, `{revision,status,reason}`.
- POST applications/:id/notes: applications.review + applications.notes, `{body}`.
- POST applications/:id/assign: applications.review + applications.assign, `{remove:boolean}`; current actor self-assigns/unassigns.
- POST applications/:id/roblox: applications.review, resolve the application's existing username (no arbitrary applicant identity override).
- GET/PUT staff; DELETE staff/:role_id: staff.manage; deletion body `{confirm:role_id}`. Owner-only dashboard grant, no delegated permission escalation.
- GET/POST panels; PUT panels/:id; POST panels/:id/publish; DELETE panels/:id: panels.manage. Deletion body `{confirm:panel_id}`.
- PUT settings: settings.manage, `{notifications:boolean,multiple_reviewers:boolean}`.
- GET notifications; POST notifications/:id: settings.manage, retry failed job with `{confirm:stringId}`.
- GET audit?before=: audit.view, 50 most recent older-than-ID records per page.

## Applicant routes

Each `/api/applicant/:guild/*` checks the current session user, live Discord membership and configured community. An applicant is not required to have dashboard management access. Reads/writes remain guild-scoped; application detail/mutations additionally enforce applicant ownership.

- GET forms: public definitions of currently open forms.
- GET forms/:id: current immutable published version, not the unpublished draft.
- POST forms/:id: `{version,answers}`; current/open version, required fields, cooldown and duplicates enforced atomically.
- GET applications: current user's most recent 100 applications in that guild.
- GET applications/:id: applicant-safe DTO, not staff events/notes/reviewers.
- POST applications/:id/withdraw: `{revision,confirm:application_id}`; only nonterminal owned records.
- POST applications/:id/revise: `{revision,answers}`; only Revision Requested; validates against original version and archives old answers privately.
- POST applications/:id/roblox: resolve the existing submitted username for the owner only.

The frontend uses all of these surfaces; there are no generic arbitrary-SQL, platform-admin or role-bypass endpoints.
