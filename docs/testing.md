# Verification evidence and live acceptance

## Executed locally

The final release checks are run from this project, on Node.js 22.23.4 with Wrangler 4.161.0. Automated fixture identifiers and tokens are synthetic and deliberately isolated from operational configuration.

| Check                       | Result                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                  | 28 passing Node tests, zero failures/skips. Includes real workerd D1 integration.                                         |
| `npm run test:browser`      | 4 passing Chromium tests: public mobile landing, desktop form/review workflow, mobile settings, applicant web submission. |
| `npm run check`             | All project JavaScript parses successfully.                                                                               |
| `npm run lint`              | ESLint correctness rules pass.                                                                                            |
| `npm run format:check`      | Prettier formatting passes after formatting the source.                                                                   |
| `npm run dry-run`           | Wrangler bundles the Worker and static assets without deploying.                                                          |
| Fresh local schema          | Applied successfully through Wrangler and separately through the actual local workerd D1 binding.                         |
| Worker health/static routes | Wrangler local server starts; /health and public HTML/CSS/JS routes respond.                                              |
| `npm audit`                 | No known vulnerabilities reported in the installed lockfile at final verification.                                        |
| Archive inspection          | Re-opened as ZIP, CRC-tested and checked for required files/excluded private/cache artifacts.                             |

## Backend coverage

`foundation.test.js`: fresh schema and foreign keys, Worker health.

`discord.test.js`: valid/invalid/modified/expired Ed25519 inputs, signed PING, private help and custom-ID validation.

`permissions.test.js`: owner/configured-role policy, Administrator-only denial, regular-member denial, live role revalidation, cross-tenant policy isolation, self-escalation denial.

`applications.test.js`: question type/required/date/choice validation, submit/duplicate/closure, applicant ownership, cross-tenant reference guessing, immutable prior snapshots, withdrawal rules, 10,000 unique generated references.

`reviews.test.js`: allowed/invalid transitions, stale decisions, assignments, notes and privacy, revision resubmission, forbidden component/modal use, stored panel POST then PATCH and wrong-guild channel rejection.

`auth.test.js`: OAuth state cookie binding/expiry/single use, token encryption/tamper detection, secure cookies, session expiry/logout, CSRF and Origin, wrong-host rejection.

`dashboard.test.js`: protected HTTP roundtrip from guild selection through form publication, submission, note/decision and audit; forged selection and CSRF/session failures; revoked access; scoped role/settings management.

`integrations.test.js`: validated Roblox identity lookup and rate limit, ownership-not-verified semantics, durable notification success/429 backoff/403 terminal failure, scheduled cleanup safety.

`d1-runtime.test.js`: complete schema against real workerd D1; actual batch/trigger metadata; version publication and stale draft detection; application revision and concurrent decision CAS. This caught and corrected a D1-versus-plain-SQLite change-count difference during development.

`security-edge.test.js`: signed form select → modal → persisted submission → deferred result, replay suppression, command routing, Discord aggregate limits/full long-answer reader, duplicate races/single-reviewer SQL guards, JSON shape/size rejection, complete simulated OAuth callback/session exchange.

## Scope of browser evidence

Chromium executes the real HTML/CSS/JS served by local Wrangler. Browser API traffic is explicitly intercepted with fixture responses, so UI correctness is tested independently of credentials. Backend HTTP/module tests exercise real business logic and SQLite; the workerd test additionally exercises actual D1 semantics. None of those tests pretend to be live Discord, Roblox or remote Cloudflare operations. Mobile checks cover narrow viewport layout and overflow, not a complete screen-reader/accessibility certification or every physical device.

## Must be completed by the owner before launch

- Deploy using the real Worker/D1 account and configure all secrets and origin.
- Verify the deployed health route and that Discord accepts the signed interactions endpoint and invalid-signature rejection.
- Register commands in an actual private server and verify command/button/select/modal payload rendering and end-to-end response latency.
- Confirm owner setup, configured dashboard roles, Administrator-only denial and role-removal effects against real Discord membership.
- Complete actual Discord OAuth login/callback/logout in the deployed browser origin and inspect HTTPS cookie settings.
- Test two real guilds: references, forms, panels, roles, settings, audit and application actions must not cross boundaries.
- Test modal short form and web long form, all field types, closed forms, duplicates/cooldowns, applicant ownership/withdrawal and original-version revisions.
- Test assignment, full long-answer reading, private notes, decision reasons and terminal-state rejection.
- Confirm a public panel never contains submitted answers and repeated updates reuse the same message ID.
- Confirm real Roblox success/not-found/rate-limit behavior, without claiming ownership verification.
- Confirm deployed scheduled retries and actual DM success plus disabled-DM failure; monitor pending backlog.
- Review privacy/retention policy, backups, incident response and public-bot scalability before inviting real communities.

Live cloud deployment, remote database initialization, command registration, real OAuth/Discord/Roblox calls, large-scale load testing and an independent penetration test were not performed by this build.
