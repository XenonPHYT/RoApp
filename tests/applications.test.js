import test from "node:test";
import assert from "node:assert/strict";
import { testDB, seed } from "./support.js";
import { saveForm, publishForm, closeForm } from "../src/modules/forms.js";
import {
  submitApplication,
  ownApplication,
  withdraw,
  reference,
} from "../src/modules/applications.js";
import { definition, answers } from "../src/utils/validation.js";
export const def = {
  title: "Staff application",
  questions: [
    {
      id: "why",
      label: "Why join?",
      type: "short_text",
      required: true,
      max_length: 100,
    },
  ],
};
export async function fixture() {
  const env = { DB: testDB() };
  const { guild, owner } = await seed(env);
  const access = {
    guild_id: guild,
    user_id: owner,
    permissions: ["forms.manage"],
  };
  const f = await saveForm(env, access, { definition: def });
  await publishForm(env, access, f.id);
  return { env, guild, owner, access, f };
}
test("field validation supports types, required answers, dates and safe choices", () => {
  assert.throws(() => answers(def, {}));
  assert.throws(() =>
    definition({ ...def, questions: [...def.questions, ...def.questions] }),
  );
  const d = definition({
    title: "Types",
    questions: [
      { id: "d", label: "Date", type: "date" },
      { id: "n", label: "Number", type: "number", min: 0, max: 10 },
      { id: "c", label: "Choices", type: "checkbox", options: ["A", "B"] },
      { id: "y", label: "Yes?", type: "yes_no" },
    ],
  });
  assert.deepEqual(answers(d, { d: "2026-11-13", n: 3, c: ["A"], y: false }), {
    d: "2026-11-13",
    n: 3,
    c: ["A"],
    y: false,
  });
  assert.throws(() => answers(d, { d: "2026-02-30", n: 3, c: ["A"], y: true }));
  assert.throws(() =>
    answers(d, { d: "2026-11-13", n: 11, c: ["evil"], y: true }),
  );
});
test("submit, duplicate gate, immutable snapshots, closed forms, own data and tenant isolation", async () => {
  const { env, guild, owner, access, f } = await fixture();
  const a = await submitApplication(env, guild, owner, f.id, 1, {
    why: "I can help",
  });
  assert.match(a.id, /^APP-\d{4}-[A-F0-9]{16}$/);
  await assert.rejects(
    submitApplication(env, guild, owner, f.id, 1, { why: "again" }),
    /duplicate_or_cooldown/,
  );
  await assert.rejects(
    ownApplication(env, guild, "200000000000000002", a.id),
    (e) => e.status === 403,
  );
  await assert.rejects(
    ownApplication(env, "100000000000000002", owner, a.id),
    (e) => e.status === 404,
  );
  const saved = await env.DB.prepare(
    "SELECT * FROM forms WHERE guild_id=? AND id=?",
  )
    .bind(guild, f.id)
    .first();
  await saveForm(
    env,
    access,
    {
      definition: { ...def, title: "Changed" },
      edit_revision: saved.edit_revision,
    },
    f.id,
  );
  await publishForm(env, access, f.id);
  assert.equal(
    (await ownApplication(env, guild, owner, a.id)).definition.title,
    def.title,
  );
  await closeForm(env, access, f.id);
  await assert.rejects(
    submitApplication(env, guild, "200000000000000002", f.id, 2, { why: "ok" }),
    (e) => e.code === "form_closed",
  );
  await withdraw(env, guild, owner, a.id, 0);
  assert.equal(
    (await ownApplication(env, guild, owner, a.id)).status,
    "withdrawn",
  );
  await assert.rejects(withdraw(env, guild, owner, a.id, 1));
});
test("references use independent cryptographic randomness", () => {
  const ids = new Set(Array.from({ length: 10000 }, () => reference()));
  assert.equal(ids.size, 10000);
});
