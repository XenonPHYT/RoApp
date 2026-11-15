import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { testDB, seed } from "./support.js";
import { createSession } from "../src/dashboard/auth.js";
const A = "100000000000000001",
  B = "100000000000000002",
  owner = "200000000000000001",
  regular = "200000000000000002";
async function fixture(user = owner) {
  const env = {
    DB: testDB(),
    APP_ORIGIN: "https://roapp.example",
    SESSION_SECRET: "fixture-only-session-secret-".repeat(2),
    ASSETS: { fetch: async () => new Response("asset") },
  };
  await seed(env, A, owner);
  await seed(env, B, "900000000000000001");
  env.FETCH = async (url) => {
    const guild = url.includes(B) ? B : A;
    if (url.includes("/members/"))
      return Response.json({ user: { id: user }, roles: [] });
    if (url.includes("/users/@me/guilds"))
      return Response.json([{ id: A }, { id: B }]);
    if (url.endsWith("/roles"))
      return Response.json([
        { id: A, name: "everyone" },
        { id: "300000000000000001", name: "Reviewer" },
      ]);
    return Response.json({
      id: guild,
      name: guild === A ? "A" : "B",
      owner_id: guild === A ? owner : "900000000000000001",
    });
  };
  const made = await createSession(
    env,
    { id: user, username: "Test" },
    "local-oauth-token",
    3600,
  );
  async function call(path, method = "GET", body, headers = {}) {
    return worker.fetch(
      new Request(env.APP_ORIGIN + path, {
        method,
        headers: {
          Cookie: `__Host-roapp_session=${made.sid}`,
          Origin: env.APP_ORIGIN,
          "X-CSRF-Token": made.csrf,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
      { waitUntil() {} },
    );
  }
  return { env, made, call };
}
test("complete protected API roundtrip uses selected server context and rejects cross-tenant requests", async () => {
  const { call } = await fixture();
  assert.equal((await call("/api/manage/context")).status, 400);
  assert.equal(
    (await call("/api/guild/select", "POST", { guild_id: B })).status,
    403,
  );
  assert.equal(
    (await call("/api/guild/select", "POST", { guild_id: A })).status,
    200,
  );
  const f = await (
    await call("/api/manage/forms", "POST", {
      definition: {
        title: "Reviewers",
        questions: [{ id: "name", label: "Name", type: "short_text" }],
      },
    })
  ).json();
  assert.ok(f.id);
  assert.equal(
    (await call(`/api/manage/forms/${f.id}/publish`, "POST", {})).status,
    200,
  );
  const submitted = await (
    await call(`/api/applicant/${A}/forms/${f.id}`, "POST", {
      version: 1,
      answers: { name: "A person" },
    })
  ).json();
  assert.ok(submitted.id);
  assert.equal(
    (await call(`/api/applicant/${B}/applications/${submitted.id}`)).status,
    404,
  );
  assert.equal(
    (
      await call(`/api/manage/applications/${submitted.id}/notes`, "POST", {
        body: "private note",
      })
    ).status,
    200,
  );
  const own = await (
    await call(`/api/applicant/${A}/applications/${submitted.id}`)
  ).json();
  assert.equal(JSON.stringify(own).includes("private note"), false);
  const reviewed = await (
    await call(`/api/manage/applications/${submitted.id}`)
  ).json();
  assert.equal(reviewed.notes[0].body, "private note");
  assert.equal(
    (
      await call(`/api/manage/applications/${submitted.id}/decision`, "POST", {
        revision: 0,
        status: "under_review",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call(`/api/manage/applications/${submitted.id}/decision`, "POST", {
        revision: 1,
        status: "approved",
        reason: "Welcome",
      })
    ).status,
    200,
  );
  assert.equal(
    (await (await call("/api/manage/overview")).json()).statuses[0].status,
    "approved",
  );
  assert.ok((await (await call("/api/manage/audit")).json()).length > 0);
});
test("CSRF, missing sessions, forged guild selections, role removal and regular-user protection", async () => {
  const f = await fixture();
  assert.equal(
    (
      await f.call(
        "/api/guild/select",
        "POST",
        { guild_id: A },
        { "X-CSRF-Token": "wrong" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.call(
        "/api/guild/select",
        "POST",
        { guild_id: A },
        { Origin: "https://evil.example" },
      )
    ).status,
    403,
  );
  assert.equal(
    (await worker.fetch(new Request(f.env.APP_ORIGIN + "/api/session"), f.env))
      .status,
    401,
  );
  const r = await fixture(regular);
  assert.equal(
    (await r.call("/api/guild/select", "POST", { guild_id: A })).status,
    403,
  );
  await f.call("/api/guild/select", "POST", { guild_id: A });
  f.env.FETCH = async (url) =>
    Response.json(
      url.includes("/members/")
        ? { user: { id: owner }, roles: [] }
        : { id: A, name: "A", owner_id: "900000000000000001" },
    );
  assert.equal((await f.call("/api/manage/overview")).status, 403);
});
test("community setup lists only unregistered owner guilds with bot access and validates setup", async () => {
  const { env, call } = await fixture();
  const C = "100000000000000003",
    D = "100000000000000004";
  env.FETCH = async (url) => {
    if (url.includes("/users/@me/guilds"))
      return Response.json([
        { id: A, owner: true, name: "A" },
        { id: B, owner: false },
        { id: C, owner: true, name: "New community" },
        { id: D, owner: true },
      ]);
    if (url.includes(`/guilds/${D}`))
      return new Response(null, { status: 404 });
    if (url.includes(`/guilds/${C}/members/`))
      return Response.json({ user: { id: owner }, roles: [] });
    if (url.endsWith(`/guilds/${C}`))
      return Response.json({ id: C, name: "New community", owner_id: owner });
    throw new Error("Unexpected Discord request");
  };

  assert.deepEqual(await (await call("/api/setup/candidates")).json(), [
    { guild_id: C, name: "New community" },
    { guild_id: D, name: D },
  ]);
  assert.equal(
    (await call("/api/guild/setup", "POST", { guild_id: C })).status,
    200,
  );
  assert.equal(
    (
      await env.DB.prepare("SELECT name,owner_id FROM guilds WHERE guild_id=?")
        .bind(C)
        .first()
    ).name,
    "New community",
  );
  assert.equal(
    (
      await env.DB.prepare(
        "SELECT action FROM audit_logs WHERE guild_id=? ORDER BY id DESC LIMIT 1",
      )
        .bind(C)
        .first()
    ).action,
    "guild.setup",
  );
  assert.equal(
    (await call("/api/guild/setup", "POST", { guild_id: D })).status,
    409,
  );
  assert.equal(
    (await (await call("/api/guild/setup", "POST", { guild_id: D })).json())
      .error,
    "bot_not_installed",
  );
  assert.equal(
    (
      await call(
        "/api/guild/setup",
        "POST",
        { guild_id: C },
        { "X-CSRF-Token": "invalid" },
      )
    ).status,
    403,
  );
});
test("settings and role policies are scoped, validated, and audited", async () => {
  const { call } = await fixture();
  await call("/api/guild/select", "POST", { guild_id: A });
  assert.equal(
    (
      await call("/api/manage/settings", "PUT", {
        notifications: false,
        multiple_reviewers: false,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call("/api/manage/settings", "PUT", {
        notifications: "yes",
        multiple_reviewers: false,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call("/api/manage/staff", "PUT", {
        role_id: "300000000000000001",
        dashboard: true,
        permissions: ["applications.review"],
      })
    ).status,
    200,
  );
  const staff = await (await call("/api/manage/staff")).json();
  assert.equal(staff.assignments.length, 1);
  assert.equal(
    (
      await call("/api/manage/staff/300000000000000001", "DELETE", {
        confirm: "wrong",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call("/api/manage/staff/300000000000000001", "DELETE", {
        confirm: "300000000000000001",
      })
    ).status,
    200,
  );
});
