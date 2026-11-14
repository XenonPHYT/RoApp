import { one, all, stmt, audit, changed } from "../database/db.js";
import { formRecord } from "../database/queries.js";
import { definition, integer } from "../utils/validation.js";
import { now, uid, assert } from "../utils/helpers.js";
import { requirePermission } from "./permissions.js";
export function serializeForm(f) {
  return { ...f, draft: JSON.parse(f.draft_json), draft_json: undefined };
}
export async function saveForm(env, access, input, formId = null) {
  requirePermission(access, "forms.manage");
  const d = definition(input.definition);
  const cooldown = integer(input.cooldown_seconds ?? 0, 0, 31536000);
  assert(
    typeof (input.allow_duplicates ?? false) === "boolean",
    400,
    "invalid_duplicate_rule",
  );
  const t = now(),
    id = formId || uid();
  const statements = [];
  if (formId) {
    const old = await formRecord(env, access.guild_id, formId);
    assert(
      input.edit_revision === old.edit_revision,
      409,
      "stale_form",
      "Reload this form before saving.",
    );
    statements.push(
      stmt(
        env,
        "UPDATE forms SET draft_json=?,cooldown_seconds=?,allow_duplicates=?,updated_at=?,edit_revision=edit_revision+1 WHERE guild_id=? AND id=? AND edit_revision=?",
        JSON.stringify(d),
        cooldown,
        input.allow_duplicates ? 1 : 0,
        t,
        access.guild_id,
        id,
        input.edit_revision,
      ),
    );
  } else
    statements.push(
      stmt(
        env,
        "INSERT INTO forms(guild_id,id,draft_json,cooldown_seconds,allow_duplicates,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
        access.guild_id,
        id,
        JSON.stringify(d),
        cooldown,
        input.allow_duplicates ? 1 : 0,
        t,
        t,
      ),
    );
  statements.push(
    stmt(
      env,
      "INSERT INTO audit_logs(guild_id,actor_id,action,target_id,created_at) SELECT ?,?,?,?,? WHERE changes()=1",
      access.guild_id,
      access.user_id,
      "form.saved",
      id,
      t,
    ),
  );
  const r = await env.DB.batch(statements);
  await changed(r[0]);
  return serializeForm(await formRecord(env, access.guild_id, id));
}
export async function publishForm(env, access, id) {
  requirePermission(access, "forms.manage");
  const f = await formRecord(env, access.guild_id, id);
  definition(JSON.parse(f.draft_json));
  const t = now();
  const r = await env.DB.batch([
    stmt(
      env,
      "INSERT INTO form_versions(guild_id,form_id,version,definition_json,created_at) SELECT guild_id,id,version+1,draft_json,? FROM forms WHERE guild_id=? AND id=? AND version=? AND edit_revision=?",
      t,
      access.guild_id,
      id,
      f.version,
      f.edit_revision,
    ),
    stmt(
      env,
      "UPDATE forms SET version=version+1,status='open',updated_at=?,edit_revision=edit_revision+1 WHERE guild_id=? AND id=? AND version=? AND edit_revision=? AND changes()=1",
      t,
      access.guild_id,
      id,
      f.version,
      f.edit_revision,
    ),
    stmt(
      env,
      "INSERT INTO audit_logs(guild_id,actor_id,action,target_id,created_at) SELECT ?,?,?,?,? WHERE changes()=1",
      access.guild_id,
      access.user_id,
      "form.published",
      id,
      t,
    ),
  ]);
  await changed(r[0]);
  return serializeForm(await formRecord(env, access.guild_id, id));
}
export async function closeForm(env, access, id) {
  requirePermission(access, "forms.manage");
  await formRecord(env, access.guild_id, id);
  await env.DB.batch([
    stmt(
      env,
      "UPDATE forms SET status='closed',updated_at=?,edit_revision=edit_revision+1 WHERE guild_id=? AND id=?",
      now(),
      access.guild_id,
      id,
    ),
    audit(env, access.guild_id, access.user_id, "form.closed", id),
  ]);
}
export async function publishedForm(env, guild, id) {
  const f = await one(
    env,
    `SELECT f.id,f.guild_id,f.status,f.version,v.definition_json FROM forms f JOIN form_versions v ON v.guild_id=f.guild_id AND v.form_id=f.id AND v.version=f.version WHERE f.guild_id=? AND f.id=?`,
    guild,
    id,
  );
  assert(
    f && f.status === "open",
    409,
    "form_closed",
    "This form is closed or unavailable.",
  );
  return {
    ...f,
    definition: JSON.parse(f.definition_json),
    definition_json: undefined,
  };
}
export async function availableForms(env, guild) {
  return (
    await all(
      env,
      `SELECT f.id,f.version,v.definition_json FROM forms f JOIN form_versions v ON v.guild_id=f.guild_id AND v.form_id=f.id AND v.version=f.version WHERE f.guild_id=? AND f.status='open' ORDER BY f.created_at`,
      guild,
    )
  ).map((f) => ({
    id: f.id,
    version: f.version,
    ...JSON.parse(f.definition_json),
  }));
}
export const supportsModal = (d) =>
  d.questions.length <= 5 &&
  d.questions.every(
    (q) =>
      ["short_text", "long_text", "roblox_username"].includes(q.type) &&
      q.label.length <= 45,
  );
