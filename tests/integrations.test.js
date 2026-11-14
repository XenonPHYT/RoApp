import test from "node:test";
import assert from "node:assert/strict";
import { testDB, seed } from "./support.js";
import { saveForm, publishForm } from "../src/modules/forms.js";
import { submitApplication } from "../src/modules/applications.js";
import { decide } from "../src/modules/reviews.js";
import { resolveUsername, resolveApplication } from "../src/modules/roblox.js";
import {
  processNotifications,
  maintenance,
} from "../src/modules/notifications.js";
const guild = "100000000000000001",
  user = "200000000000000001";
async function fixture() {
  const env = { DB: testDB() };
  await seed(env);
  const access = {
    guild_id: guild,
    user_id: user,
    permissions: ["forms.manage", "applications.review", "applications.decide"],
  };
  const f = await saveForm(env, access, {
    definition: {
      title: "Roblox applicants",
      questions: [
        {
          id: "rb",
          label: "Roblox username",
          type: "roblox_username",
          max_length: 20,
        },
      ],
    },
  });
  await publishForm(env, access, f.id);
  const a = await submitApplication(env, guild, user, f.id, 1, {
    rb: "ExampleUser",
  });
  return { env, access, a };
}
test("Roblox username resolution validates response identity and never claims ownership", async () => {
  const { env, a } = await fixture();
  env.FETCH = async () =>
    Response.json({
      data: [
        {
          requestedUsername: "ExampleUser",
          id: 123456,
          name: "ExampleUser",
          displayName: "Example",
        },
      ],
    });
  const found = await resolveApplication(env, guild, user, a.id);
  assert.equal(found.id, "123456");
  assert.equal(found.ownership_verified, false);
  env.FETCH = async () =>
    Response.json({
      data: [
        { requestedUsername: "SomeoneElse", id: 123456, name: "SomeoneElse" },
      ],
    });
  await assert.rejects(
    resolveUsername(env, "ExampleUser"),
    (e) => e.code === "roblox_not_found",
  );
  env.FETCH = async () => new Response("", { status: 429 });
  await assert.rejects(
    resolveUsername(env, "ExampleUser"),
    (e) => e.code === "roblox_rate_limited",
  );
});
test("durable notifications send once in normal operation, redact notes and back off on 429", async () => {
  const { env, access, a } = await fixture();
  await decide(env, access, a.id, 0, "under_review");
  let messages = 0;
  env.FETCH = async (url, opt) => {
    if (url.endsWith("/users/@me/channels"))
      return Response.json({ id: "300000000000000001" });
    messages++;
    assert.equal(JSON.parse(opt.body).allowed_mentions.parse.length, 0);
    return Response.json({ id: "400000000000000001" });
  };
  assert.equal(await processNotifications(env), 1);
  assert.equal(await processNotifications(env), 0);
  assert.equal(messages, 1);
  await decide(env, access, a.id, 1, "approved", "Welcome");
  env.FETCH = async () => Response.json({ retry_after: 120 }, { status: 429 });
  await processNotifications(env);
  const job = await env.DB.prepare(
    "SELECT * FROM notification_jobs WHERE status='pending'",
  ).first();
  assert.equal(job.attempts, 1);
  assert.equal(job.last_error, "discord_rate_limited");
  assert.ok(job.next_attempt > Math.floor(Date.now() / 1000));
  env.FETCH = async () => new Response("", { status: 403 });
  await env.DB.prepare("UPDATE notification_jobs SET next_attempt=0").run();
  await processNotifications(env);
  assert.equal(
    (
      await env.DB.prepare("SELECT status FROM notification_jobs WHERE id=?")
        .bind(job.id)
        .first()
    ).status,
    "failed",
  );
});
test("maintenance removes expired infrastructure state without deleting tenant records", async () => {
  const { env } = await fixture();
  await env.DB.prepare("INSERT INTO oauth_states VALUES('expired',0)").run();
  await maintenance(env);
  assert.equal(
    (await env.DB.prepare("SELECT count(*) n FROM oauth_states").first()).n,
    0,
  );
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
});
