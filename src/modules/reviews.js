import { all, run, stmt, audit, changed } from "../database/db.js";
import { applicationRecord } from "../database/queries.js";
import { requirePermission } from "./permissions.js";
import { applicantView } from "./applications.js";
import { assert, now, uid } from "../utils/helpers.js";
import { text, integer } from "../utils/validation.js";
export const TRANSITIONS = {
  pending: ["under_review", "withdrawn"],
  under_review: [
    "interview",
    "revision_requested",
    "approved",
    "rejected",
    "withdrawn",
  ],
  interview: [
    "under_review",
    "revision_requested",
    "approved",
    "rejected",
    "withdrawn",
  ],
  revision_requested: ["pending", "withdrawn"],
  approved: [],
  rejected: [],
  withdrawn: [],
};
export function assertTransition(from, to) {
  assert(TRANSITIONS[from]?.includes(to), 409, "invalid_transition");
}
export async function reviewQueue(
  env,
  access,
  filter = "pending",
  page = 0,
  search = "",
) {
  requirePermission(access, "applications.review");
  integer(page, 0, 10000);
  const g = access.guild_id;
  let condition,
    params = [g];
  if (filter === "mine") {
    condition =
      "EXISTS(SELECT 1 FROM application_reviews r WHERE r.guild_id=a.guild_id AND r.application_id=a.id AND r.reviewer_id=?)";
    params.push(access.user_id);
  } else if (filter === "completed")
    condition = "a.status IN ('approved','rejected','withdrawn')";
  else if (filter === "awaiting_decision")
    condition = "a.status IN ('under_review','interview')";
  else if (filter === "search") {
    condition = "a.id=?";
    params.push(text(search, 1, 60).toUpperCase());
  } else {
    assert(Object.hasOwn(TRANSITIONS, filter), 400, "invalid_filter");
    condition = "a.status=?";
    params.push(filter);
  }
  return all(
    env,
    `SELECT a.id,a.applicant_id,a.status,a.created_at FROM applications a WHERE a.guild_id=? AND ${condition} ORDER BY a.created_at DESC,a.id LIMIT 11 OFFSET ?`,
    ...params,
    page * 10,
  );
}
export async function reviewDetail(env, access, id) {
  requirePermission(access, "applications.review");
  const a = await applicationRecord(env, access.guild_id, id);
  return {
    ...applicantView(a),
    applicant_id: a.applicant_id,
    notes: await all(
      env,
      "SELECT id,author_id,body,created_at FROM application_notes WHERE guild_id=? AND application_id=? ORDER BY created_at DESC LIMIT 100",
      access.guild_id,
      id,
    ),
    reviewers: await all(
      env,
      "SELECT reviewer_id,assigned_at FROM application_reviews WHERE guild_id=? AND application_id=?",
      access.guild_id,
      id,
    ),
    events: await all(
      env,
      "SELECT actor_id,kind,data_json,created_at FROM application_events WHERE guild_id=? AND application_id=? ORDER BY event_id DESC LIMIT 100",
      access.guild_id,
      id,
    ),
  };
}
export async function decide(env, access, id, revision, to, reason = "") {
  requirePermission(access, "applications.review");
  requirePermission(access, "applications.decide");
  const a = await applicationRecord(env, access.guild_id, id);
  assertTransition(a.status, to);
  assert(
    !["withdrawn", "pending"].includes(to),
    400,
    "applicant_action_required",
  );
  const publicReason = text(
    reason,
    ["approved", "rejected", "revision_requested"].includes(to) ? 1 : 0,
    1000,
  );
  await changed(
    await run(
      env,
      "UPDATE applications SET status=?,decision_reason=?,revision=revision+1,updated_by=?,updated_at=? WHERE guild_id=? AND id=? AND revision=?",
      to,
      publicReason,
      access.user_id,
      now(),
      access.guild_id,
      id,
      integer(revision, 0, 100000000),
    ),
  );
  return reviewDetail(env, access, id);
}
export async function addNote(env, access, id, body) {
  requirePermission(access, "applications.review");
  requirePermission(access, "applications.notes");
  await applicationRecord(env, access.guild_id, id);
  const note = uid(),
    t = now();
  await env.DB.batch([
    stmt(
      env,
      "INSERT INTO application_notes(guild_id,id,application_id,author_id,body,created_at) VALUES(?,?,?,?,?,?)",
      access.guild_id,
      note,
      id,
      access.user_id,
      text(body, 1, 4000),
      t,
    ),
    stmt(
      env,
      "INSERT INTO application_events(guild_id,application_id,actor_id,kind,created_at) VALUES(?,?,?,'note_added',?)",
      access.guild_id,
      id,
      access.user_id,
      t,
    ),
    audit(env, access.guild_id, access.user_id, "review.note_added", id),
  ]);
  return note;
}
export async function assign(env, access, id, remove = false) {
  requirePermission(access, "applications.review");
  requirePermission(access, "applications.assign");
  const a = await applicationRecord(env, access.guild_id, id);
  assert(
    !["approved", "rejected", "withdrawn"].includes(a.status),
    409,
    "application_completed",
  );
  const t = now();
  const sql = remove
    ? "DELETE FROM application_reviews WHERE guild_id=? AND application_id=? AND reviewer_id=?"
    : "INSERT INTO application_reviews(guild_id,application_id,reviewer_id,assigned_at) SELECT guild_id,id,?,? FROM applications WHERE guild_id=? AND id=? AND status NOT IN ('approved','rejected','withdrawn') ON CONFLICT DO NOTHING";
  const args = remove
    ? [access.guild_id, id, access.user_id]
    : [access.user_id, t, access.guild_id, id];
  const r = await env.DB.batch([
    stmt(env, sql, ...args),
    stmt(
      env,
      "INSERT INTO application_events(guild_id,application_id,actor_id,kind,created_at) SELECT ?,?,?,?,? WHERE changes()=1",
      access.guild_id,
      id,
      access.user_id,
      remove ? "unassigned" : "assigned",
      t,
    ),
    stmt(
      env,
      "INSERT INTO audit_logs(guild_id,actor_id,action,target_id,created_at) SELECT ?,?,?,?,? WHERE changes()=1",
      access.guild_id,
      access.user_id,
      remove ? "review.unassigned" : "review.assigned",
      id,
      t,
    ),
  ]);
  return r[0].meta.changes === 1;
}
