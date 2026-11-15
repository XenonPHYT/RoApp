import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { testDB, seed } from "./support.js";
import { createSession } from "../src/dashboard/auth.js";
import { guildChoices } from "../src/dashboard/routes.js";
import { digest, epoch } from "../src/utils/helpers.js";
const ORIGIN = "https://roapp.example",
  A = "100000000000000001",
  B = "100000000000000002",
  OWNER = "200000000000000001",
  USER = "200000000000000002",
  ROLE = "300000000000000001";
function baseEnv(extra = {}) {
  return {
    DB: testDB(),
    APP_ORIGIN: ORIGIN,
    SESSION_SECRET: "oauth-community-test-secret-".repeat(2),
    DISCORD_CLIENT_ID: "100000000000000009",
    DISCORD_CLIENT_SECRET: "test-client-secret",
    ASSETS: { fetch: async () => new Response("asset") },
    ...extra,
  };
}
const quiet = () => {
  const orig = console.warn;
  console.warn = () => {};
  return () => (console.warn = orig);
};
async function start(env) {
  const r = await worker.fetch(new Request(ORIGIN + "/auth/discord"), env, {});
  const loc = new URL(r.headers.get("Location"));
  const cookie = r.headers.getSetCookie()[0];
  return {
    r,
    loc,
    state: loc.searchParams.get("state"),
    cookie: cookie.split(";")[0],
  };
}
const callback = (env, state, cookie) =>
  worker.fetch(
    new Request(`${ORIGIN}/auth/discord/callback?code=c&state=${state}`, {
      headers: cookie ? { Cookie: cookie } : {},
    }),
    env,
    {},
  );
const sessions = (env) =>
  env.DB._db.prepare("SELECT count(*) n FROM dashboard_sessions").get().n;
function discordFetch(calls, scope = "identify guilds") {
  return async (url) => {
    calls.push(url);
    if (url.includes("oauth2/token"))
      return Response.json({
        access_token: "tok",
        token_type: "Bearer",
        expires_in: 3600,
        scope,
      });
    if (url.endsWith("/users/@me")) return Response.json({ id: USER });
    return new Response("{}", { status: 404 });
  };
}
test("authorization request asks for identify and guilds with the fixed callback", async () => {
  const env = baseEnv();
  const { loc, r } = await start(env);
  assert.equal(r.status, 302);
  assert.equal(loc.searchParams.get("scope"), "identify guilds");
  assert.equal(
    loc.searchParams.get("redirect_uri"),
    ORIGIN + "/auth/discord/callback",
  );
  assert.match(
    r.headers.getSetCookie()[0],
    /^__Host-roapp_oauth_[a-f0-9]{16}=.*; Secure$/,
  );
});
test("valid state succeeds once; replay, missing, mismatched and expired state are rejected without token exchange or session", async () => {
  const restore = quiet();
  try {
    const calls = [],
      env = baseEnv({ FETCH: discordFetch(calls) });
    const ok = await start(env);
    const good = await callback(env, ok.state, ok.cookie);
    assert.equal(good.status, 302);
    assert.equal(good.headers.get("Location"), "/");
    assert.equal(sessions(env), 1);
    // Replay of the same callback (state is single-use).
    const exchanged = calls.length;
    const replay = await callback(env, ok.state, ok.cookie);
    assert.match(
      replay.headers.get("Location"),
      /auth_error=oauth_state_invalid/,
    );
    // Missing cookie.
    const a = await start(env);
    const missing = await callback(env, a.state, "");
    assert.match(
      missing.headers.get("Location"),
      /auth_error=oauth_state_invalid/,
    );
    // Mismatched cookie (another attempt's state).
    const b = await start(env);
    const mismatch = await callback(env, a.state, b.cookie);
    assert.match(
      mismatch.headers.get("Location"),
      /auth_error=oauth_state_invalid/,
    );
    // Malformed state.
    const bad = await callback(env, "nope", b.cookie);
    assert.match(bad.headers.get("Location"), /auth_error=oauth_state_invalid/);
    // Expired state.
    const c = await start(env);
    env.DB._db
      .prepare("UPDATE oauth_states SET expires_at=? WHERE state_hash=?")
      .run(epoch() - 1, await digest(c.state));
    const expired = await callback(env, c.state, c.cookie);
    assert.match(
      expired.headers.get("Location"),
      /auth_error=oauth_state_invalid/,
    );
    assert.equal(sessions(env), 1);
    assert.equal(
      calls.length,
      exchanged,
      "no token exchange for rejected state",
    );
    // The still-valid attempt b was not consumed by the failed mismatch.
    const still = await callback(env, b.state, b.cookie);
    assert.equal(still.headers.get("Location"), "/");
  } finally {
    restore();
  }
});
test("token response missing the guilds scope is refused before any session exists", async () => {
  const env = baseEnv({ FETCH: discordFetch([], "identify") });
  const a = await start(env);
  const r = await callback(env, a.state, a.cookie);
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, "oauth_scope_missing");
  assert.equal(sessions(env), 0);
});
async function guildFixture({ failing = [], member = USER, roles = [] } = {}) {
  const env = baseEnv();
  await seed(env, A, OWNER);
  await seed(env, B, OWNER);
  env.FETCH = async (url) => {
    if (url.includes("/users/@me/guilds"))
      return Response.json([
        { id: A },
        { id: B },
        { id: "100000000000000099" },
      ]);
    const gid = url.includes(A) ? A : B;
    if (failing.includes(gid)) return new Response("{}", { status: 403 });
    if (url.includes("/members/"))
      return Response.json({ user: { id: member }, roles });
    return Response.json({
      id: gid,
      name: "G-" + gid.slice(-1),
      owner_id: OWNER,
    });
  };
  const made = await createSession(
    env,
    { id: member, username: "t" },
    "tok",
    3600,
  );
  const s = env.DB._db
    .prepare("SELECT * FROM dashboard_sessions WHERE id_hash=?")
    .get(await digest(made.sid));
  return { env, s };
}
test("community list: only registered communities, owner gets full access, Administrator-only users get none", async () => {
  const owner = await guildFixture({ member: OWNER });
  const o = await guildChoices(owner.env, owner.s);
  assert.deepEqual(o.map((g) => g.guild_id).sort(), [A, B]);
  assert.ok(o.every((g) => g.dashboard && g.permissions.length === 9));
  const plain = await guildFixture({ member: USER });
  const p = await guildChoices(plain.env, plain.s);
  assert.equal(p.length, 2);
  assert.ok(
    p.every((g) => g.dashboard === false && g.permissions.length === 0),
  );
});
test("community list: configured dashboard role grants only its permissions", async () => {
  const f = await guildFixture({ member: USER, roles: [ROLE] });
  f.env.DB._db
    .prepare(
      "INSERT INTO dashboard_role_access(guild_id,role_id,dashboard,permissions_json) VALUES(?,?,1,?)",
    )
    .run(A, ROLE, JSON.stringify(["audit.view"]));
  const list = await guildChoices(f.env, f.s);
  const a = list.find((g) => g.guild_id === A),
    b = list.find((g) => g.guild_id === B);
  assert.deepEqual([a.dashboard, a.permissions], [true, ["audit.view"]]);
  assert.equal(b.dashboard, false);
});
test("community list: one failing community does not hide the others; total failure is reported", async () => {
  const restore = quiet();
  try {
    const one = await guildFixture({ member: OWNER, failing: [B] });
    const list = await guildChoices(one.env, one.s);
    assert.deepEqual(
      list.map((g) => g.guild_id),
      [A],
    );
    const all = await guildFixture({ member: OWNER, failing: [A, B] });
    await assert.rejects(
      guildChoices(all.env, all.s),
      (e) => e.code === "discord_request_failed",
    );
  } finally {
    restore();
  }
});
