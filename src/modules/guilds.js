import { discord } from "../utils/discord.js";
import { snowflake } from "../utils/validation.js";
import { assert, now } from "../utils/helpers.js";
import { one, stmt, audit } from "../database/db.js";
export async function currentMember(env, guild, user, timeout = 2500) {
  snowflake(guild);
  snowflake(user);
  const [g, m] = await Promise.all([
    discord(env, `/guilds/${guild}`, { timeout }),
    discord(env, `/guilds/${guild}/members/${user}`, { timeout }),
  ]);
  assert(
    g.id === guild && m.user?.id === user && Array.isArray(m.roles),
    403,
    "membership_unconfirmed",
  );
  return {
    guild_id: guild,
    user_id: user,
    owner: g.owner_id === user,
    roles: m.roles,
    name: g.name,
    owner_id: g.owner_id,
  };
}
export async function setupGuild(env, guild, user) {
  const m = await currentMember(env, guild, user);
  assert(
    m.owner,
    403,
    "owner_required",
    "Only the current Discord server owner can initialize RoApp.",
  );
  await env.DB.batch([
    stmt(
      env,
      "INSERT INTO guilds(guild_id,name,owner_id,created_at) VALUES(?,?,?,?) ON CONFLICT(guild_id) DO UPDATE SET name=excluded.name,owner_id=excluded.owner_id",
      guild,
      m.name,
      m.owner_id,
      now(),
    ),
    audit(env, guild, user, "guild.setup", guild),
  ]);
  return m;
}
export const guildRecord = (env, guild) =>
  one(env, "SELECT * FROM guilds WHERE guild_id=?", guild);
