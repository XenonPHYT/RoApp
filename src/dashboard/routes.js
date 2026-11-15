import {
  session,
  authRoute,
  publicSession,
  logout,
  checkCsrf,
  decrypt,
} from "./auth.js";
import { authorize } from "../modules/permissions.js";
import { currentMember } from "../modules/guilds.js";
import { discord } from "../utils/discord.js";
import { one, all, run, rateLimit } from "../database/db.js";
import { assert, json, readJson, AppError } from "../utils/helpers.js";
import { snowflake } from "../utils/validation.js";
import { setupGuild } from "../modules/guilds.js";
async function userGuilds(env, s) {
  let after = "",
    guilds = [];
  for (let page = 0; page < 10; page++) {
    const list = await discord(
      env,
      `/users/@me/guilds?limit=200${after ? "&after=" + after : ""}`,
      { token: await decrypt(env, s.access_token) },
    );
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
export async function guildChoices(env, s) {
  const guilds = await userGuilds(env, s);
  const out = [];
  for (const g of guilds) {
    const stored = await one(
      env,
      "SELECT guild_id,name FROM guilds WHERE guild_id=?",
      g.id,
    );
    if (!stored) continue;
    const membership = await currentMember(env, g.id, s.user_id);
    const { evaluatePermissions } = await import("../modules/permissions.js");
    const access = evaluatePermissions(
      membership,
      await all(
        env,
        "SELECT * FROM dashboard_role_access WHERE guild_id=?",
        g.id,
      ),
    );
    out.push({
      guild_id: g.id,
      name: membership.name,
      dashboard: access.dashboard,
      permissions: access.permissions,
    });
  }
  return out;
}
async function setupCandidates(env, s) {
  const candidates = [];
  for (const guild of await userGuilds(env, s)) {
    if (!guild.owner) continue;
    if (
      await one(env, "SELECT guild_id FROM guilds WHERE guild_id=?", guild.id)
    )
      continue;
    try {
      const membership = await currentMember(env, guild.id, s.user_id);
      if (membership.owner)
        candidates.push({ guild_id: guild.id, name: membership.name });
    } catch (error) {
      if (error?.upstreamStatus === 404) continue;
      throw error;
    }
  }
  return candidates;
}
export async function dashboardRoute(request, env) {
  const url = new URL(request.url),
    path = url.pathname;
  if (path.startsWith("/auth/")) return authRoute(request, env);
  const s = await session(request, env);
  await rateLimit(env, `session:${s.id_hash}`, 120, 60);
  if (!["GET", "HEAD"].includes(request.method))
    await checkCsrf(request, env, s);
  if (path === "/api/session" && request.method === "GET")
    return json(publicSession(s));
  if (path === "/api/logout" && request.method === "POST")
    return logout(request, env, s);
  if (path === "/api/guilds" && request.method === "GET")
    return json(await guildChoices(env, s));
  if (path === "/api/setup/candidates" && request.method === "GET")
    return json(await setupCandidates(env, s));
  if (path === "/api/guild/setup" && request.method === "POST") {
    const { guild_id } = await readJson(request);
    snowflake(guild_id);
    const guild = await setupGuild(env, guild_id, s.user_id);
    return json({ guild_id: guild.guild_id, name: guild.name });
  }
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
