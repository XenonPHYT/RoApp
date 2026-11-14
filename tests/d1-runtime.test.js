import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { seed } from "./support.js";
import { saveForm, publishForm } from "../src/modules/forms.js";
import {
  submitApplication,
  ownApplication,
  revise,
} from "../src/modules/applications.js";
import { decide, addNote } from "../src/modules/reviews.js";
function statements(sql) {
  const result = [];
  let current = "",
    trigger = false;
  for (const line of sql.split("\n")) {
    if (!line.trim() || line.trim().startsWith("--")) continue;
    current += line + "\n";
    if (/^CREATE TRIGGER/i.test(current.trim())) trigger = true;
    if (
      line.trim().endsWith(";") &&
      (!trigger ||
        /^\s*END;\s*$/.test(line) ||
        /^CREATE TRIGGER.*BEGIN.*END;\s*$/.test(line))
    ) {
      result.push(current);
      current = "";
      trigger = false;
    }
  }
  assert.equal(current.trim(), "");
  return result;
}
test("real workerd D1 schema, atomic publish, trigger metadata, stale updates and revisions", async () => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("ok")}}',
      compatibilityDate: "2026-11-13",
      d1Databases: ["DB"],
    }),
  );
  try {
    const DB = await mf.getD1Database("DB"),
      env = { DB };
    for (const sql of statements(
      readFileSync(
        new URL("../src/database/schema.sql", import.meta.url),
        "utf8",
      ),
    ))
      await DB.prepare(sql).run();
    const { guild, owner } = await seed(env);
    const access = {
      guild_id: guild,
      user_id: owner,
      permissions: [
        "forms.manage",
        "applications.review",
        "applications.decide",
        "applications.notes",
      ],
    };
    const f = await saveForm(env, access, {
      definition: {
        title: "Actual D1",
        questions: [{ id: "a", label: "Answer", type: "short_text" }],
      },
    });
    assert.equal(f.edit_revision, 0);
    await publishForm(env, access, f.id);
    await assert.rejects(
      saveForm(env, access, { definition: f.draft, edit_revision: 0 }, f.id),
      (e) => e.status === 409,
    );
    const a = await submitApplication(env, guild, owner, f.id, 1, {
      a: "Actual D1 answer",
    });
    await addNote(env, access, a.id, "private");
    await decide(env, access, a.id, 0, "under_review");
    await decide(env, access, a.id, 1, "revision_requested", "Expand");
    const revision = await revise(env, guild, owner, a.id, 2, {
      a: "Expanded in D1",
    });
    assert.equal(revision.status, "pending");
    assert.equal(revision.answers.a, "Expanded in D1");
    assert.equal(
      JSON.stringify(await ownApplication(env, guild, owner, a.id)).includes(
        "private",
      ),
      false,
    );
    const [r1, r2] = await Promise.allSettled([
      decide(env, access, a.id, 3, "under_review"),
      decide(env, access, a.id, 3, "under_review"),
    ]);
    assert.equal([r1, r2].filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(
      (
        await DB.prepare(
          "SELECT count(*) AS n FROM form_versions WHERE guild_id=?",
        )
          .bind(guild)
          .first()
      ).n,
      1,
    );
  } finally {
    await mf.dispose();
  }
});
