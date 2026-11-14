# Architecture and schema review

## Deployment boundary

One ES-module Worker handles signed Discord interactions, OAuth, protected JSON APIs, static assets, and scheduled maintenance. One D1 binding stores structured state. No Node-only code is imported by src/; the Node test/registration tools are not runtime services. `run_worker_first: true` ensures routing and security headers run before assets, including navigations. Static assets use the ASSETS binding.

## Source responsibilities

- `src/index.js`: HTTP and scheduled entry points, safe errors and headers.
- `src/discord/interactions.js`: raw-byte signature verification, PING, replay receipts, immediate modal preparation, deferred private responses.
- `commands.js`: single command-definition source of truth and handlers.
- `components.js`: custom-ID parsing, ownership checks and component dispatch.
- `responses.js`: native Discord response structures and embed budgets.
- `review-ui.js`: real responsibility added beyond the starting tree: queue/detail, full-answer, note and modal presentation, separate from business logic.
- `src/modules/`: forms, applications, reviews, panels, permissions, guilds, Roblox and notification services, shared across Discord and web APIs.
- `src/dashboard/`: OAuth, sessions, selected-guild policy, management/applicant APIs.
- `src/database/`: bound SQL helpers, reusable scoped lookups and the single initial schema.
- `public/`: vanilla frontend. `css/tokens.css` holds the shared palette; no external fonts or image dependency. No logo was supplied or invented.
- `scripts/`: command registration and recursive JavaScript syntax checks.
- `tests/`: SQLite-adapter tests, full HTTP-module tests, real workerd D1 tests and Chromium UI tests.

## Table purposes

| Table                 | Purpose and ownership                                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| guilds                | Tenant directory and small validated settings JSON. Combines settings to avoid a redundant one-to-one table.                     |
| dashboard_role_access | Per-guild Discord role dashboard grants and granular permissions; no implicit Administrator grant.                               |
| forms                 | Editable definition JSON, workflow state, cooldown/duplicate rules and monotonic edit revision.                                  |
| form_versions         | Immutable published question-set/metadata snapshots with composite tenant/form/version key.                                      |
| applications          | Applicant identity, original version FK, validated answers JSON, status, public reason, Roblox lookup metadata and CAS revision. |
| application_reviews   | Per-guild application/reviewer assignments, allowing several reviewers only when configured.                                     |
| application_notes     | Private notes, physically separate from public application projections.                                                          |
| application_events    | Actor/time/status and review history, including archived prior answers on resubmission. Staff-only.                              |
| panels                | Tenant/channel/message IDs, validated public config and short durable leases.                                                    |
| audit_logs            | Tenant-scoped administrative and application change records; no copied private note bodies.                                      |
| dashboard_sessions    | Global opaque-session hashes, encrypted OAuth tokens, CSRF material, selected guild and expiry.                                  |
| oauth_states          | Hashed, expiring, single-use OAuth state. Global auth infrastructure.                                                            |
| interaction_receipts  | Global Discord interaction IDs and expiry, for replay suppression.                                                               |
| rate_limits           | Global request-abuse buckets keyed by session, OAuth source hash, or tenant/user operation.                                      |
| notification_jobs     | Tenant/application-scoped durable DM outbox with retry state, bounded attempts and leases.                                       |

Published questions and answers are JSON documents: no redundant form_questions/application_answers tables are needed. A form_version is already the full immutable question set, and every application has its exact version FK. All tenant relationships use composite guild keys. Session/state/rate/receipt tables are global security infrastructure; they are not browser-addressable community data.

## Atomicity and concurrency

D1 batch is used for related writes and audit insertion. Publication inserts a snapshot and opens the form in one batch guarded by version + edit revision. Saves increment edit revision, including same-millisecond edits. Application submission triggers atomically check open/current form version, active duplicates and cooldown. Status triggers reject transitions independently of frontend checks. Application writes use revision compare-and-swap; state, events, audit and notification insertions occur in the same database transaction. Single-reviewer policy has a database guard.

D1 metadata `meta.changes` can include trigger side effects. The stale-update helper checks for a positive count, not exactly one; SQL-level `changes()` remains the direct-statement count. This difference is explicitly exercised against real local workerd D1.

Discord side effects cannot share a transaction with D1. Panel and outbox leases reduce concurrent duplicate work; Discord nonce/enforce_nonce reduces short-window duplicates. A process crash after Discord succeeds but before D1 stores the result can still produce duplicates on a later retry. The code does not claim exactly-once external delivery.

## Application state machine

- Pending → Under Review, Withdrawn.
- Under Review → Interview, Revision Requested, Approved, Rejected, Withdrawn.
- Interview → Under Review, Revision Requested, Approved, Rejected, Withdrawn.
- Revision Requested → Pending (applicant resubmits original question set), Withdrawn.
- Approved / Rejected / Withdrawn are terminal.

Only the applicant can use the withdrawal/resubmission paths. Reviewers cannot use the generic decision API to impersonate them. A submitted application is never an editable draft; form drafts are persisted separately.

## Design decisions

Setup is triggered by the current owner's `/setup`, a supported first-configuration interaction flow; no Gateway installation listener is needed. Optional /queue is omitted because /review already provides it. Form creation, policies and settings are dashboard-first. No platform owner identity model is assumed or privileged platform bypass implemented. Cron and D1 outbox justify a minimal durable retry mechanism without additional services.
