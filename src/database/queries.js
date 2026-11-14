import { one, all } from "./db.js";
import { assert } from "../utils/helpers.js";
export async function formRecord(env, guild, id) {
  const f = await one(
    env,
    "SELECT * FROM forms WHERE guild_id=? AND id=?",
    guild,
    id,
  );
  assert(f, 404, "form_not_found");
  return f;
}
export async function applicationRecord(env, guild, id) {
  const a = await one(
    env,
    `SELECT a.*,v.definition_json FROM applications a JOIN form_versions v ON v.guild_id=a.guild_id AND v.form_id=a.form_id AND v.version=a.form_version WHERE a.guild_id=? AND a.id=?`,
    guild,
    id,
  );
  assert(a, 404, "application_not_found");
  return a;
}
export const listForms = (env, guild) =>
  all(
    env,
    "SELECT * FROM forms WHERE guild_id=? ORDER BY created_at DESC",
    guild,
  );
