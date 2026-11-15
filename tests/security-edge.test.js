import test from "node:test";
import assert from "node:assert/strict";
import { testDB, seed } from "./support.js";
import { interactionRoute } from "../src/discord/interactions.js";
import { saveForm, publishForm } from "../src/modules/forms.js";
import { submitApplication } from "../src/modules/applications.js";
import { decide, assign } from "../src/modules/reviews.js";
import { fullAnswerUI, detailUI } from "../src/discord/review-ui.js";
import { embed } from "../src/discord/responses.js";
import { readJson } from "../src/utils/helpers.js";
import { authRoute, session } from "../src/dashboard/auth.js";
const guild = "100000000000000001",
  user = "200000000000000001";
async function fixture(
  question = { id: "a", label: "Answer", type: "short_text", max_length: 300 },
) {
  const env = { DB: testDB(), APP_ORIGIN: "https://roapp.example" };
  await seed(env);
  const access = {
    guild_id: guild,
    user_id: user,
    permissions: [
      "forms.manage",
      "applications.review",
      "applications.decide",
      "applications.assign",
      "applications.notes",
    ],
  };
  const f = await saveForm(env, access, {
    definition: { title: "Edge cases", questions: [question] },
  });
  await publishForm(env, access, f.id);
  return { env, access, f };
}
async function sign(i, keys) {
  const body = JSON.stringify(i),
    timestamp = String(Math.floor(Date.now() / 1000));
  const sig = Buffer.from(
    await crypto.subtle.sign(
      "Ed25519",
      keys.privateKey,
      new TextEncoder().encode(timestamp + body),
    ),
  ).toString("hex");
  return new Request("https://roapp.example/api/discord/interactions", {
    method: "POST",
    body,
    headers: { "X-Signature-Timestamp": timestamp, "X-Signature-Ed25519": sig },
  });
}
test("signed button opens modal, modal submits, commands defer quickly and duplicate interactions do not replay", async () => {
  const { env, f } = await fixture();
  const keys = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  env.DISCORD_PUBLIC_KEY = Buffer.from(
    await crypto.subtle.exportKey("raw", keys.publicKey),
  ).toString("hex");
  const edits = [];
  env.FETCH = async (url, options) => {
    edits.push(JSON.parse(options.body));
    return Response.json({ id: "400000000000000001" });
  };
  const works = [],
    ctx = { waitUntil: (p) => works.push(p) };
  const base = {
    guild_id: guild,
    member: { user: { id: user } },
    application_id: "300000000000000001",
    token: "fixture-interaction-token",
  };
  const choice = {
    ...base,
    id: "500000000000000001",
    type: 3,
    data: { custom_id: `forms:${user}`, values: [f.id] },
  };
  const intro = await (
    await interactionRoute(await sign(choice, keys), env, ctx)
  ).json();
  assert.equal(intro.type, 7, JSON.stringify(intro));
  const start = intro.data.components[0].components[0];
  const opened = await (
    await interactionRoute(
      await sign(
        {
          ...base,
          id: "500000000000000002",
          type: 3,
          data: { custom_id: start.custom_id },
        },
        keys,
      ),
      env,
      ctx,
    )
  ).json();
  assert.equal(opened.type, 9);
  const submitted = {
    ...base,
    id: "500000000000000003",
    type: 5,
    data: {
      custom_id: opened.data.custom_id,
      components: [{ component: { custom_id: "a", value: "Test submission" } }],
    },
  };
  const ack = await (
    await interactionRoute(await sign(submitted, keys), env, ctx)
  ).json();
  assert.equal(ack.type, 7);
  const submit = ack.data.components[0].components.find((c) =>
    c.custom_id.startsWith("asubmit:"),
  );
  assert.ok(submit);
  const final = {
    ...base,
    id: "500000000000000004",
    type: 3,
    data: { custom_id: submit.custom_id },
  };
  const completed = await (
    await interactionRoute(await sign(final, keys), env, ctx)
  ).json();
  assert.equal(completed.type, 7);
  assert.equal(completed.data.embeds[0].title, "Application Submitted!");
  await Promise.all(works);
  assert.equal(
    (
      await env.DB.prepare(
        "SELECT count(*) n FROM applications WHERE guild_id=?",
      )
        .bind(guild)
        .first()
    ).n,
    1,
  );
  const replay = await (
    await interactionRoute(await sign(final, keys), env, ctx)
  ).json();
  assert.match(replay.data.content, /already been handled/);
  const command = {
    ...base,
    id: "500000000000000005",
    type: 2,
    data: { name: "myapplications" },
  };
  assert.equal(
    (await (await interactionRoute(await sign(command, keys), env, ctx)).json())
      .type,
    5,
  );
  await Promise.all(works);
  assert.equal(edits.at(-1).embeds[0].title, "My applications");
});
test("all Discord embeds meet aggregate limits and full-answer reader retains long answer tail", async () => {
  const e = embed(
    "T".repeat(300),
    "D".repeat(4000),
    Array.from({ length: 25 }, () => ({
      name: "N".repeat(256),
      value: "V".repeat(1024),
    })),
  );
  assert.ok(
    e.title.length +
      (e.description?.length || 0) +
      e.fields.reduce((n, f) => n + f.name.length + f.value.length, 0) <=
      6000,
  );
  const { env, access, f } = await fixture({
    id: "a",
    label: "Long answer",
    type: "long_text",
    max_length: 4000,
  });
  const answer = "x".repeat(3990) + "ENDING1234";
  const a = await submitApplication(env, guild, user, f.id, 1, { a: answer });
  const full = await fullAnswerUI(env, access, a.id, 0, 1);
  assert.match(full.data.embeds[0].description, /ENDING1234/);
  const detail = await detailUI(env, access, a.id);
  assert.ok(detail.data.components.length <= 5);
  assert.ok(
    detail.data.components
      .flatMap((r) => r.components)
      .every((c) => !c.custom_id || c.custom_id.length <= 100),
  );
});
test("duplicate/cooldown races and single reviewer policy are guarded by SQL", async () => {
  const { env, access, f } = await fixture();
  const results = await Promise.allSettled([
    submitApplication(env, guild, user, f.id, 1, { a: "First" }),
    submitApplication(env, guild, user, f.id, 1, { a: "Second" }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const a = results.find((r) => r.status === "fulfilled").value;
  await env.DB.prepare("UPDATE guilds SET settings_json=? WHERE guild_id=?")
    .bind('{"notifications":false,"multiple_reviewers":false}', guild)
    .run();
  await assign(env, access, a.id);
  await assert.rejects(
    assign(env, { ...access, user_id: "200000000000000002" }, a.id),
    /already_assigned/,
  );
  await decide(env, access, a.id, 0, "under_review");
  assert.equal(
    (
      await env.DB.prepare(
        "SELECT count(*) n FROM notification_jobs WHERE guild_id=?",
      )
        .bind(guild)
        .first()
    ).n,
    0,
  );
});
test("JSON input rejects arrays, null, oversized bodies and malformed content", async () => {
  for (const body of ["null", "[]", "{bad"])
    await assert.rejects(
      readJson(
        new Request("https://test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        }),
      ),
      (e) => e.status === 400,
    );
  await assert.rejects(
    readJson(
      new Request("https://test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "x".repeat(100),
      }),
      10,
    ),
    (e) => e.status === 413,
  );
});
test("OAuth callback exchanges code and establishes a real encrypted server session with fixed redirect", async () => {
  const env = {
    DB: testDB(),
    APP_ORIGIN: "https://roapp.example",
    SESSION_SECRET: "fixture-only-key-material-".repeat(2),
    DISCORD_CLIENT_ID: "100000000000000001",
    DISCORD_CLIENT_SECRET: "fixture-only-client-secret",
  };
  let tokenCalls = 0;
  env.FETCH = async (url, opt) => {
    if (url.includes("/oauth2/token")) {
      tokenCalls++;
      assert.equal(
        opt.body.get("redirect_uri"),
        "https://roapp.example/auth/discord/callback",
      );
      return Response.json({
        access_token: "fixture-only-access-token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    return Response.json({ id: user, username: "Applicant" });
  };
  const start = await authRoute(
    new Request(env.APP_ORIGIN + "/auth/discord"),
    env,
  );
  const state = new URL(start.headers.get("Location")).searchParams.get(
    "state",
  );
  const r = await authRoute(
    new Request(
      env.APP_ORIGIN +
        `/auth/discord/callback?state=${state}&code=fixture-code`,
      { headers: { Cookie: `__Host-roapp_oauth=${state}` } },
    ),
    env,
  );
  assert.equal(r.headers.get("Location"), "/");
  const sid = r.headers
    .getSetCookie()
    .find((c) => c.startsWith("__Host-roapp_session="))
    .split(";")[0];
  const s = await session(
    new Request(env.APP_ORIGIN, { headers: { Cookie: sid } }),
    env,
  );
  assert.equal(s.user_id, user);
  assert.notEqual(s.access_token, "fixture-only-access-token");
  assert.equal(tokenCalls, 1);
});
