import { AppError, epoch, now, assert } from "../utils/helpers.js";
export const stmt = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
export const one = (env, sql, ...args) => stmt(env, sql, ...args).first();
export async function all(env, sql, ...args) {
  return (await stmt(env, sql, ...args).all()).results;
}
export const run = (env, sql, ...args) => stmt(env, sql, ...args).run();
export const audit = (env, guild, actor, action, target) =>
  stmt(
    env,
    "INSERT INTO audit_logs(guild_id,actor_id,action,target_id,created_at) VALUES(?,?,?,?,?)",
    guild,
    actor,
    action,
    target,
    now(),
  );
export async function rateLimit(env, key, limit = 30, seconds = 60) {
  const t = epoch();
  const row = await one(
    env,
    `INSERT INTO rate_limits(key,window_start,hits) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET window_start=CASE WHEN window_start<=? THEN excluded.window_start ELSE window_start END,hits=CASE WHEN window_start<=? THEN 1 ELSE hits+1 END RETURNING hits`,
    key,
    t,
    t - seconds,
    t - seconds,
  );
  if (row.hits > limit)
    throw new AppError(
      429,
      "rate_limited",
      "Too many requests. Try again later.",
    );
}
export async function changed(result) {
  assert(
    result.meta.changes > 0,
    409,
    "stale_record",
    "The record changed. Reload and try again.",
  );
}
