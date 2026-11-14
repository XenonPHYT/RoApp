# Security review and operating limits

This is a source-code security review with automated regression tests, not a formal external audit or penetration test.

## Trust boundaries

Discord HTTP interactions must pass Ed25519 verification on the exact timestamp+raw body. A five-minute timestamp skew window and durable receipt table reduce replay exposure. Non-PING guild actions require signed guild/member context. Custom IDs are length/format validated; private controls bind the initiating actor, and every submitted action rechecks ownership, guild and permission. Modal opening is also permission-checked when privileged. Applicants cannot access private notes by guessing an application reference.

Dashboard authentication uses Discord's code flow with a hashed single-use state record plus a host-only HttpOnly state cookie. The callback destination is fixed to `/`; arbitrary redirect destinations are not accepted. OAuth tokens are encrypted at rest with AES-GCM and a random IV using a key derived from SESSION_SECRET. Session IDs are 256-bit random opaque values stored only as SHA-256 hashes. Cookies are HttpOnly, SameSite=Lax, Path=/, Secure and __Host-prefixed on HTTPS. HTTP/non-Secure cookies are permitted only for exact localhost/127.0.0.1 development origins. Session lifetime is capped at eight hours and token expiry; no long-lived refresh token is stored. Expired sessions require login again.

Every state-changing dashboard request requires the exact configured Origin and a matching CSRF token hash. JSON content types, object shapes, sizes and business fields are validated server-side. Current Discord membership/owner/roles are fetched for protected operations; permissions are not trusted from the browser or session. The selected tenant is resolved from the validated server session and separately authorized. Applicant URLs contain a guild ID but still require session identity and current actual membership. Administrator alone is explicitly insufficient.

The owner receives all community permissions. Only the current owner can grant dashboard access. Delegated staff managers cannot grant permissions they do not hold. Role IDs are verified against the current guild's Discord role directory. There is no platform-owner override or public platform-admin route.

## Data and SQL

All user values use bound prepared statements. The few SQL query fragments are selected only from server-controlled, validated filter cases. Tenant-owned rows use guild keys in all reads/writes and composite foreign keys. One schema initializes one database. Triggers protect immutable versions, submission closure/current-version/duplicates/cooldowns, state transitions and single-reviewer assignment. Application updates and form edits use compare-and-swap revisions to reject races.

Applicant DTOs whitelist public fields. They never include notes, staff event payloads, assignment internals or other applicants. Applicant notifications are generated only from reference, public status and public reason, never note bodies. Prior revised answer sets are retained in staff-only events. Application audit history is created atomically with mutations. Failed/stale CAS actions do not generate successful status events.

Text is rendered through DOM textContent/text nodes, never untrusted innerHTML. A same-origin Content Security Policy forbids third-party scripts, framing, inline scripts and arbitrary network origins. Discord payloads disable mention parsing. Embed content is bounded to platform limits; complete long answers have a separate private reader. Public panels contain only validated form metadata, not submitted answers.

Errors expose controlled codes/messages, not stack traces, raw upstream bodies or credentials. Logs contain only general error categories or delivery failure statements. Do not enable middleware that logs Authorization headers, OAuth responses, cookies or answers.

## Rates and sizes

- Dashboard: 120 requests/session/minute.
- OAuth start: 15/source-hash/minute (Cloudflare supplies CF-Connecting-IP; local runs share a fallback bucket).
- Application submit: 6/tenant/user/minute plus form-specific durable cooldown/duplicate policy.
- Roblox lookup: 10/tenant/user/minute.
- JSON request body: 256 KiB; interaction body: 128 KiB.
- Form: 1–30 questions, up to 25 choices each; text fields up to 4,000 characters.
- Discord modal: at most five supported text fields. Other forms use the web portal.
- Panels: at most 25 chosen forms. /apply paginates larger form catalogs.
- Reviewer queues: 10 items/page, bounded page index. Detail views return the latest 100 notes/events; applicant history lists the most recent 100 applications/community.
- Notifications: at most ten jobs/tick, every five minutes; retries back off, respect Discord retry_after, stop after eight attempts or a permanent HTTP failure. A manager can explicitly retry a failed job.

These are database-enforced application limits, not a full distributed DDoS shield. They are keyed by the identity/source available and are not a global multi-account quota. Protect a public deployment with appropriate Cloudflare account-level WAF/bot/rate rules after measuring abuse. No optional paid product is silently provisioned by this source.

## External delivery and availability

Authorization fails closed during Discord outages. Users may temporarily be unable to access even previously authorized communities; stale claims are never used as a fallback. The initial guild-picker fetch is live and sequential for configured communities; very large account/community counts may be slow or hit upstream/subrequest limits. OAuth guild enumeration is bounded at 2,000 servers; no incomplete authorized list is silently treated as complete beyond that limit. Test large-scale use before widening rollout.

Discord API mutations are not atomic with D1. Leases and nonces reduce duplicates but cannot guarantee exactly-once publication or DM delivery after a crash. A lost interaction follow-up is not automatically replayed; the applicant/reviewer can reopen the authoritative persisted record. If a Discord message succeeds but persisting its message ID fails, operators may need to reconcile/delete the orphan message. Applicant portal status remains authoritative even if DMs are unavailable. Public panel contents refresh only on explicit publish/update; stale components still enforce current form state.

Roblox POST /v1/usernames/users is a public account-existence lookup. Responses are matched to the requested username and validated. No ownership, group membership or group rank is inferred. Roblox rate limits/outages/not-found results return safe errors and do not create fake verification.

## Operations and privacy

Before public rollout, publish an operator privacy/retention policy, configure restricted Cloudflare access and backups, and decide how community deletion and data requests will be handled. No automated retention deletion of applications/notes/audits is enabled because the owner supplied no retention policy. Do not collect unnecessary personal information. Local fixtures use obviously synthetic IDs/tokens; they are not real deployments or credentials. No genuine data is bundled.

Revoke sessions when rotating SESSION_SECRET or responding to a security incident. Session-secret rotation alone does not replace an explicit session purge. Delete/rotate credentials through the provider if accidentally exposed, not just from a Git commit. Keep dependency lockfiles reviewed; all dependencies here are development-only but run on the operator's machine.

Owner-provided live credentials, real Discord security/timing tests, deployed OAuth/cookie checks and cloud monitoring remain launch gates. No compliance certification, load test or formal audit is claimed.
