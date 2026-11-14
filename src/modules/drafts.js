import { one, run } from "../database/db.js";
import { epoch } from "../utils/helpers.js";
// Server-side progress for multi-step Discord applications. Answers are kept
// per (community, applicant, form); nothing is trusted from the client.
export const DRAFT_TTL = 86400;
export async function getDraft(env, guild, user, formId) {
  const d = await one(
    env,
    "SELECT form_version,answers_json,step FROM application_drafts WHERE guild_id=? AND user_id=? AND form_id=? AND expires_at>?",
    guild,
    user,
    formId,
    epoch(),
  );
  return d
    ? {
        form_version: d.form_version,
        answers: JSON.parse(d.answers_json),
        step: d.step,
      }
    : null;
}
export const saveDraft = (env, guild, user, formId, version, answers, step) =>
  run(
    env,
    `INSERT INTO application_drafts(guild_id,user_id,form_id,form_version,answers_json,step,updated_at,expires_at) VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(guild_id,user_id,form_id) DO UPDATE SET form_version=excluded.form_version,answers_json=excluded.answers_json,step=excluded.step,updated_at=excluded.updated_at,expires_at=excluded.expires_at`,
    guild,
    user,
    formId,
    version,
    JSON.stringify(answers),
    step,
    epoch(),
    epoch() + DRAFT_TTL,
  );
export const clearDraft = (env, guild, user, formId) =>
  run(
    env,
    "DELETE FROM application_drafts WHERE guild_id=? AND user_id=? AND form_id=?",
    guild,
    user,
    formId,
  );
