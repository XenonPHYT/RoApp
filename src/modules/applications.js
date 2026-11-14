import { one, all, run, rateLimit, changed } from "../database/db.js";
import { applicationRecord } from "../database/queries.js";
import { publishedForm } from "./forms.js";
import { answers } from "../utils/validation.js";
import { assert, now, uid } from "../utils/helpers.js";
export const TERMINAL = ["approved", "rejected", "withdrawn"];
export function reference() {
  return `APP-${new Date().getUTCFullYear()}-${uid().slice(0, 16).toUpperCase()}`;
}
export function assertOwner(application, user) {
  assert(application.applicant_id === user, 403, "not_your_application");
}
export function applicantView(a) {
  return {
    id: a.id,
    guild_id: a.guild_id,
    form_id: a.form_id,
    form_version: a.form_version,
    status: a.status,
    decision_reason: a.decision_reason,
    definition: JSON.parse(a.definition_json),
    answers: JSON.parse(a.answers_json),
    revision: a.revision,
    created_at: a.created_at,
    updated_at: a.updated_at,
    roblox_user_id: a.roblox_user_id,
    roblox_username: a.roblox_username,
    roblox_ownership_verified: false,
  };
}
export async function submitApplication(
  env,
  guild,
  user,
  formId,
  version,
  input,
) {
  await rateLimit(env, `submit:${guild}:${user}`, 6, 60);
  const f = await publishedForm(env, guild, formId);
  assert(
    version === f.version,
    409,
    "stale_form",
    "The form was updated. Reopen it before submitting.",
  );
  const value = answers(f.definition, input);
  const t = now();
  const id = reference();
  const roblox = f.definition.questions.find(
    (q) => q.type === "roblox_username" && value[q.id],
  );
  await run(
    env,
    `INSERT INTO applications(guild_id,id,form_id,form_version,applicant_id,answers_json,updated_by,created_at,updated_at,roblox_username) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    guild,
    id,
    formId,
    version,
    user,
    JSON.stringify(value),
    user,
    t,
    t,
    roblox ? value[roblox.id] : null,
  );
  return applicantView(await applicationRecord(env, guild, id));
}
export async function ownApplication(env, guild, user, id) {
  const a = await applicationRecord(env, guild, id);
  assertOwner(a, user);
  return applicantView(a);
}
export const myApplications = (env, guild, user) =>
  all(
    env,
    "SELECT id,form_id,status,decision_reason,created_at,updated_at FROM applications WHERE guild_id=? AND applicant_id=? ORDER BY created_at DESC LIMIT 100",
    guild,
    user,
  );
export async function withdraw(env, guild, user, id, revision) {
  const a = await applicationRecord(env, guild, id);
  assertOwner(a, user);
  assert(!TERMINAL.includes(a.status), 409, "already_completed");
  assert(a.revision === revision, 409, "stale_record");
  await changed(
    await run(
      env,
      "UPDATE applications SET status='withdrawn',decision_reason='',revision=revision+1,updated_by=?,updated_at=? WHERE guild_id=? AND id=? AND applicant_id=? AND revision=?",
      user,
      now(),
      guild,
      id,
      user,
      revision,
    ),
  );
  return ownApplication(env, guild, user, id);
}
export async function revise(env, guild, user, id, revision, input) {
  const a = await applicationRecord(env, guild, id);
  assertOwner(a, user);
  assert(a.status === "revision_requested", 409, "revision_not_requested");
  const value = answers(JSON.parse(a.definition_json), input);
  const t = now();
  const r = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO application_events(guild_id,application_id,actor_id,kind,data_json,created_at) SELECT guild_id,id,?,'answers_before_revision',answers_json,? FROM applications WHERE guild_id=? AND id=? AND applicant_id=? AND revision=? AND status='revision_requested'",
    ).bind(user, t, guild, id, user, revision),
    env.DB.prepare(
      "UPDATE applications SET answers_json=?,status='pending',decision_reason='',revision=revision+1,updated_by=?,updated_at=?,roblox_user_id=NULL,roblox_username=? WHERE guild_id=? AND id=? AND applicant_id=? AND revision=? AND status='revision_requested' AND changes()=1",
    ).bind(
      JSON.stringify(value),
      user,
      t,
      JSON.parse(a.definition_json).questions.find(
        (q) => q.type === "roblox_username" && value[q.id],
      )
        ? value[
            JSON.parse(a.definition_json).questions.find(
              (q) => q.type === "roblox_username" && value[q.id],
            ).id
          ]
        : null,
      guild,
      id,
      user,
      revision,
    ),
  ]);
  await changed(r[1]);
  return ownApplication(env, guild, user, id);
}
