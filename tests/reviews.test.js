import test from "node:test";
import assert from "node:assert/strict";
import { testDB, seed } from "./support.js";
import { saveForm, publishForm } from "../src/modules/forms.js";
import {
  submitApplication,
  ownApplication,
  revise,
} from "../src/modules/applications.js";
import {
  decide,
  addNote,
  reviewDetail,
  assign,
  assertTransition,
  reviewQueue,
} from "../src/modules/reviews.js";
import {
  handleComponent,
  immediateComponent,
} from "../src/discord/components.js";
import { publishPanel, savePanel } from "../src/modules/panels.js";
const guild = "100000000000000001",
  user = "200000000000000001",
  staff = "200000000000000002";
async function fixture() {
  const env = { DB: testDB() };
  await seed(env);
  const access = {
    guild_id: guild,
    user_id: staff,
    permissions: [
      "forms.manage",
      "panels.manage",
      "applications.review",
      "applications.decide",
      "applications.notes",
      "applications.assign",
    ],
  };
  const f = await saveForm(env, access, {
    definition: {
      title: "Apply",
      questions: [{ id: "a", label: "Answer", type: "short_text" }],
    },
  });
  await publishForm(env, access, f.id);
  const a = await submitApplication(env, guild, user, f.id, 1, { a: "Hello" });
  return { env, access, f, a };
}
test("status transitions, optimistic concurrency, events, assignment and internal note privacy", async () => {
  const { env, access, a } = await fixture();
  assert.throws(() => assertTransition("approved", "pending"));
  await addNote(env, access, a.id, "PRIVATE_REVIEWER_NOTE");
  await assign(env, access, a.id);
  assert.equal((await reviewDetail(env, access, a.id)).notes.length, 1);
  assert.equal(
    JSON.stringify(await ownApplication(env, guild, user, a.id)).includes(
      "PRIVATE_REVIEWER_NOTE",
    ),
    false,
  );
  await decide(env, access, a.id, 0, "under_review");
  await assert.rejects(
    decide(env, access, a.id, 0, "approved", "Accepted"),
    (e) => e.status === 409,
  );
  await decide(
    env,
    access,
    a.id,
    1,
    "revision_requested",
    "Please expand your answer",
  );
  const revised = await revise(env, guild, user, a.id, 2, {
    a: "Expanded answer",
  });
  assert.equal(revised.status, "pending");
  await decide(env, access, a.id, 3, "under_review");
  await decide(env, access, a.id, 4, "approved", "Accepted");
  assert.equal((await reviewQueue(env, access, "completed")).length, 1);
  const jobs = await env.DB.prepare("SELECT body FROM notification_jobs").all();
  assert.equal(
    jobs.results.some((j) => j.body.includes("PRIVATE_REVIEWER_NOTE")),
    false,
  );
  await assert.rejects(
    reviewDetail(env, { ...access, guild_id: "100000000000000002" }, a.id),
    (e) => e.status === 404,
  );
});
test("forged components are denied, including private modal opening", async () => {
  const { env, a } = await fixture();
  env.FETCH = async (url) =>
    Response.json(
      url.includes("/members/")
        ? { user: { id: user }, roles: [] }
        : { id: guild, name: "Test", owner_id: "900000000000000001" },
    );
  const i = {
    type: 3,
    guild_id: guild,
    member: { user: { id: user } },
    data: { custom_id: `assign:${user}:${a.id}` },
  };
  await assert.rejects(handleComponent(i, env), (e) => e.status === 403);
  await assert.rejects(
    immediateComponent(
      { ...i, data: { custom_id: `note:${user}:${a.id}` } },
      env,
    ),
    (e) => e.status === 403,
  );
  await assert.rejects(
    handleComponent(
      { ...i, data: { custom_id: `withdraw:${staff}:${a.id}:0` } },
      env,
    ),
    (e) => e.status === 403,
  );
});
test("stored panel message is patched rather than duplicated; channel tenant validated", async () => {
  const { env, access, f } = await fixture();
  let posts = 0,
    patches = 0;
  env.FETCH = async (url, opt) => {
    if (url.includes("/messages")) {
      if (opt.method === "POST") posts++;
      if (opt.method === "PATCH") patches++;
      return Response.json({ id: "400000000000000001" });
    }
    return Response.json({
      id: "500000000000000001",
      guild_id: guild,
      type: 0,
    });
  };
  const p = await savePanel(env, access, {
    channel_id: "500000000000000001",
    title: "Apply here",
    form_ids: [f.id],
  });
  await publishPanel(env, access, p.id);
  await publishPanel(env, access, p.id);
  assert.equal(posts, 1);
  assert.equal(patches, 1);
  env.FETCH = async () =>
    Response.json({ guild_id: "100000000000000002", type: 0 });
  await assert.rejects(
    savePanel(env, access, {
      channel_id: "500000000000000001",
      title: "Wrong tenant",
      form_ids: [f.id],
    }),
    (e) => e.code === "invalid_panel_channel",
  );
});
