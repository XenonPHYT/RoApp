import { discord } from "../utils/discord.js";
import { one, run } from "../database/db.js";
import { uid, epoch } from "../utils/helpers.js";
export async function processNotifications(env, limit = 10) {
  let processed = 0;
  for (let n = 0; n < limit; n++) {
    const token = uid(),
      t = epoch();
    const job = await one(
      env,
      "UPDATE notification_jobs SET lease_token=?,lease_until=?,attempts=attempts+1 WHERE id=(SELECT id FROM notification_jobs WHERE status='pending' AND next_attempt<=? AND lease_until<=? ORDER BY next_attempt,id LIMIT 1) AND status='pending' AND lease_until<=? RETURNING *",
      token,
      t + 30,
      t,
      t,
      t,
    );
    if (!job) break;
    try {
      const channel = await discord(env, "/users/@me/channels", {
        method: "POST",
        body: { recipient_id: job.user_id },
      });
      await discord(env, `/channels/${channel.id}/messages`, {
        method: "POST",
        body: {
          content: job.body.slice(0, 1900),
          allowed_mentions: { parse: [] },
          nonce: `r${job.id}`,
          enforce_nonce: true,
        },
      });
      await run(
        env,
        "UPDATE notification_jobs SET status='sent',lease_until=0,lease_token=NULL,last_error=NULL WHERE guild_id=? AND id=? AND lease_token=?",
        job.guild_id,
        job.id,
        token,
      );
    } catch (e) {
      const permanent = [400, 401, 403, 404].includes(e.upstreamStatus);
      const failed = permanent || job.attempts >= 8;
      const delay = Math.ceil(
        e.retryAfter || Math.min(3600, 30 * 2 ** job.attempts),
      );
      await run(
        env,
        "UPDATE notification_jobs SET status=?,next_attempt=?,lease_until=0,lease_token=NULL,last_error=? WHERE guild_id=? AND id=? AND lease_token=?",
        failed ? "failed" : "pending",
        epoch() + delay,
        e.upstreamStatus
          ? `discord_http_${e.upstreamStatus}`
          : e.code === "discord_rate_limited"
            ? "discord_rate_limited"
            : "delivery_unavailable",
        job.guild_id,
        job.id,
        token,
      );
    }
    processed++;
  }
  return processed;
}
export async function maintenance(env) {
  const t = epoch();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM dashboard_sessions WHERE expires_at<=?").bind(
      t,
    ),
    env.DB.prepare("DELETE FROM oauth_states WHERE expires_at<=?").bind(t),
    env.DB.prepare("DELETE FROM interaction_receipts WHERE expires_at<=?").bind(
      t,
    ),
    env.DB.prepare("DELETE FROM rate_limits WHERE window_start<?").bind(
      t - 86400,
    ),
  ]);
  try {
    await env.DB.prepare("DELETE FROM application_drafts WHERE expires_at<=?")
      .bind(t)
      .run();
  } catch {
    // Table missing until migrations/0001_application_drafts.sql is applied.
  }
  return processNotifications(env);
}
