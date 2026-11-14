# Discord application setup

## Developer Portal

Create your RoApp application in https://discord.com/developers/applications in your own account. Copy its application ID, Ed25519 public key, OAuth client ID/secret and bot token into the private configuration workflow. Enable public bot installation if you intend other communities to invite it. The bot uses HTTP interactions and REST, not a persistent Gateway session.

After deploying an HTTPS Worker, set Interactions Endpoint URL to:

```text
YOUR_APP_ORIGIN/api/discord/interactions
```

Discord sends a signed PING and may also send invalid-signature probes. RoApp validates the raw timestamp+body bytes before parsing and returns 401 for an invalid signature. No public key or ID is invented in this project.

Set OAuth redirect URI exactly to:

```text
YOUR_APP_ORIGIN/auth/discord/callback
```

Replace YOUR_APP_ORIGIN with your real origin; it is not a valid literal URI. Login requests `identify guilds` scopes. Membership and current role policy are independently confirmed with the installed bot on protected requests. No broad email or member-list OAuth scope is requested. The application uses individual member REST lookups, not Gateway member caching; verify API/intent access in your actual application's configuration if Discord rejects these calls.

## Invite permissions

Invite with `bot` and `applications.commands` scopes using Discord's generated installation URL. Grant View Channels, Send Messages, Embed Links and Read Message History in the intended public panel channels; do not grant Administrator. DMs also depend on recipients' privacy/block settings. No Manage Roles or role-assignment capability is needed. Initial panels support guild text and announcement channels, not forums, voice channels, threads or DMs.

The Discord server owner must run `/setup` to register the community. A person with Discord Administrator but not ownership cannot bootstrap access. After setup, grant specific role permissions in the dashboard. Roles may be allowed to review through Discord without receiving dashboard access; the two grants are separate.

## Repeatable registration

Definitions exist only in `src/discord/commands.js`. The registration script imports them. Set environment variables in your private terminal/session or secret manager; do not put them in source:

```text
DISCORD_APPLICATION_ID=your actual application ID
DISCORD_BOT_TOKEN=your actual bot token
DISCORD_TEST_GUILD_ID=your private test server ID
```

`.dev.vars` is read by Wrangler, not automatically loaded by the Node registration script. Set shell variables explicitly using your platform's secure workflow.

Development guild:

```sh
npm run register
```

Global registration, only after private-server testing:

```sh
npm run register -- --global
```

Registration uses a bulk PUT for the chosen scope and replaces that scope's command set for this application. Coordinate with any existing commands. Remove development-guild duplicates through the Discord API if moving entirely to global registration; global propagation can take time.

## Available commands

`/help`, `/setup`, `/dashboard`, `/apply`, `/myapplications`, `/application view`, `/application withdraw`, `/review`, `/forms list|create|publish|close`, `/panel publish|update|remove`, `/staff`.

Form creation opens the dashboard builder; panel configuration is dashboard-first. Panel publish/update takes a stored panel ID. Removal asks for a confirmation button. Optional /queue is intentionally omitted because /review includes the same functionality. No platform-administration commands are registered.

## Native private flow

All commands respond ephemerally (including deferred results). Public panels are persistent, non-private bot messages with embeds and a native form selector; they never include answers. Application forms of at most five text/Roblox-username fields with Discord-compatible labels open a modal. Other forms link to the authenticated web portal. Choosing a stale/closed form fails safely.

Review queues offer Pending, Under Review, Awaiting Decision, Completed, My Assignments and Search. Awaiting Decision is a view over Under Review/Interview, not an unsupported extra database state. Answer previews are supplemented with full-answer paging, and notes have full private readers. Decisions and notes use native modals; saved reasons are explicitly applicant-facing. Controls are actor-bound, guild-scoped, and reauthorized; visual visibility is not the security boundary.

Slow work is deferred. Modal preparation uses bounded upstream authorization timeouts and an overall preparation budget, returning a safe retry message on timeout. Old/replayed interactions and mismatched actors are rejected. Actual end-to-end Discord latency remains a deployed acceptance test; local fixtures cannot guarantee network timing.

## Reference documentation

- https://docs.discord.com/developers/interactions/overview
- https://docs.discord.com/developers/interactions/receiving-and-responding
- https://docs.discord.com/developers/topics/oauth2
