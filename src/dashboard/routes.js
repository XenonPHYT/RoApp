import {
  session,
  authRoute,
  publicSession,
  logout,
  checkCsrf,
  decrypt,
  refreshSession,
  hasSessionCookie,
  clearSessionCookie,
} from "./auth.js";
import { authorize, evaluatePermissions } from "../modules/permissions.js";
import { currentMember, setupGuild } from "../modules/guilds.js";
import { discord } from "../utils/discord.js";
import { one, all, run, rateLimit } from "../database/db.js";
import {
  assert,
  json,
  readJson,
  safeError,
  AppError,
} from "../utils/helpers.js";
import { snowflake } from "../utils/validation.js";
async function userGuilds(env, s) {
  let after = "",
    guilds = [];
  for (let page = 0; page < 10; page++) {
    let list;
    try {
      list = await discord(
        env,
        `/users/@me/guilds?limit=200${after ? "&after=" + after : ""}`,
        { token: await decrypt(env, s.access_token) },
      );
    } catch (e) {
      // Discord rejected the stored sign-in token (expired or revoked): end this
      // session so the person can sign in again instead of seeing a generic error.
      if (e instanceof AppError && e.upstreamStatus === 401) {
        await run(
          env,
          "DELETE FROM dashboard_sessions WHERE id_hash=?",
          s.id_hash,
        );
        throw new AppError(
          401,
          "session_expired",
          "Your Discord sign-in expired. Sign in again.",
        );
      }
      throw e;
    }
    assert(Array.isArray(list), 502, "discord_invalid_guilds");
    guilds.push(...list);
    if (list.length < 200) break;
    after = list.at(-1).id;
    assert(
      page < 9,
      422,
      "too_many_guilds",
      "Your account has more than 2,000 servers. Contact the operator.",
    );
  }
  return guilds;
}
// Servers the signed-in user owns (per Discord) that are not registered yet.
// This list is only a convenience for the UI; POST /api/guild/setup re-verifies
// ownership server-side with the bot before anything is written.
export async function setupCandidates(env, s) {
  const out = [];
  for (const g of await userGuilds(env, s)) {
    if (g?.owner !== true || typeof g.id !== "string") continue;
    const stored = await one(
      env,
      "SELECT guild_id FROM guilds WHERE guild_id=?",
      g.id,
    );
    if (!stored)
      out.push({ guild_id: g.id, name: String(g.name || g.id).slice(0, 100) });
  }
  return out;
}
export async function guildChoices(env, s) {
  const guilds = await userGuilds(env, s);
  const candidates = [];
  for (const g of guilds) {
    const stored = await one(
      env,
      "SELECT guild_id,name FROM guilds WHERE guild_id=?",
      g.id,
    );
    if (stored) candidates.push(g.id);
  }
  // Each community is verified independently and server-side. A failure for one
  // community fails closed for that community only; it must not hide the others.
  const results = await Promise.all(
    candidates.map(async (id) => {
      try {
        const membership = await currentMember(env, id, s.user_id);
        const access = evaluatePermissions(
          membership,
          await all(
            env,
            "SELECT * FROM dashboard_role_access WHERE guild_id=?",
            id,
          ),
        );
        return {
          ok: true,
          value: {
            guild_id: id,
            name: membership.name,
            dashboard: access.dashboard,
            permissions: access.permissions,
          },
        };
      } catch (e) {
        console.warn("RoApp community access check failed", {
          category: e?.code || e?.name || "Error",
          upstream: e?.upstreamStatus,
        });
        return { ok: false, error: e };
      }
    }),
  );
  const out = results.filter((r) => r.ok).map((r) => r.value);
  // If every check failed, report the error instead of an empty (misleading) list.
  if (!out.length && results.length) throw results[0].error;
  return out;
}
// Wraps the dashboard handler so a session that is still in use is extended, and a
// stale session cookie (expired, unknown or malformed) is cleared on the 401 reply.
export async function dashboardRoute(request, env) {
  const ctx = {};
  let response;
  try {
    response = await handleDashboard(request, env, ctx);
  } catch (e) {
    response = safeError(e);
    if (
      e instanceof AppError &&
      e.status === 401 &&
      hasSessionCookie(request, env)
    )
      ctx.refresh = clearSessionCookie(env);
  }
  if (ctx.refresh) response.headers.append("Set-Cookie", ctx.refresh);
  return response;
}
async function handleDashboard(request, env, ctx) {
  const url = new URL(request.url),
    path = url.pathname;
  if (path.startsWith("/auth/")) return authRoute(request, env);
  const s = await session(request, env);
  await rateLimit(env, `session:${s.id_hash}`, 120, 60);
  ctx.refresh = await refreshSession(request, env, s);
  if (!["GET", "HEAD"].includes(request.method))
    await checkCsrf(request, env, s);
  if (path === "/api/session" && request.method === "GET")
    return json(publicSession(s));
  if (path === "/api/logout" && request.method === "POST")
    return logout(request, env, s);
  if (path === "/api/guilds" && request.method === "GET")
    return json(await guildChoices(env, s));
  if (path === "/api/guild/select" && request.method === "POST") {
    const { guild_id } = await readJson(request);
    snowflake(guild_id);
    await authorize(env, guild_id, s.user_id, null, { dashboard: true });
    await run(
      env,
      "UPDATE dashboard_sessions SET selected_guild_id=? WHERE id_hash=?",
      guild_id,
      s.id_hash,
    );
    return json({ guild_id });
  }
  if (path === "/api/setup/candidates" && request.method === "GET")
    return json(await setupCandidates(env, s));
  if (path === "/api/guild/setup" && request.method === "POST") {
    const { guild_id } = await readJson(request);
    snowflake(guild_id);
    try {
      await setupGuild(env, guild_id, s.user_id);
    } catch (e) {
      if (
        e instanceof AppError &&
        e.code === "discord_request_failed" &&
        [403, 404].includes(e.upstreamStatus)
      )
        throw new AppError(
          409,
          "bot_not_installed",
          "RoApp is not installed in that server, or cannot see it. Install the bot there, then try again.",
        );
      throw e;
    }
    return json({ guild_id });
  }
  if (path.startsWith("/api/applicant/")) {
    const { applicantAPI } = await import("./api.js");
    return applicantAPI(request, env, s);
  }
  assert(s.selected_guild_id, 400, "select_community");
  const access = await authorize(env, s.selected_guild_id, s.user_id, null, {
    dashboard: true,
  });
  const { managementAPI } = await import("./api.js");
  return managementAPI(request, env, s, access);
}
