import { assert, AppError, now } from "../utils/helpers.js";
import { text } from "../utils/validation.js";
import { applicationRecord } from "../database/queries.js";
import { rateLimit, stmt, audit, changed } from "../database/db.js";
import { assertOwner } from "./applications.js";
import { requirePermission } from "./permissions.js";
export async function resolveUsername(env, username) {
  text(username, 3, 20);
  assert(/^[A-Za-z0-9_]{3,20}$/.test(username), 400, "invalid_roblox_username");
  let res;
  try {
    res = await (env.FETCH || fetch)(
      "https://users.roblox.com/v1/usernames/users",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          usernames: [username],
          excludeBannedUsers: true,
        }),
        signal: AbortSignal.timeout(4000),
      },
    );
  } catch {
    throw new AppError(
      503,
      "roblox_unavailable",
      "Roblox lookup is temporarily unavailable. Ownership remains unverified.",
    );
  }
  if (res.status === 429)
    throw new AppError(
      429,
      "roblox_rate_limited",
      "Roblox is rate-limiting lookups. Try again later.",
    );
  assert(res.ok, 503, "roblox_unavailable");
  const data = await res.json();
  const user = data.data?.find(
    (u) =>
      typeof u.requestedUsername === "string" &&
      u.requestedUsername.toLowerCase() === username.toLowerCase(),
  );
  assert(
    user &&
      Number.isSafeInteger(user.id) &&
      user.id > 0 &&
      typeof user.name === "string" &&
      /^[A-Za-z0-9_]{3,20}$/.test(user.name),
    404,
    "roblox_not_found",
    "No matching public Roblox account was returned.",
  );
  return { id: String(user.id), name: user.name, ownership_verified: false };
}
export async function resolveApplication(env, guild, user, id, access = null) {
  if (access) requirePermission(access, "applications.review");
  const a = await applicationRecord(env, guild, id);
  if (!access) assertOwner(a, user);
  await rateLimit(env, `roblox:${guild}:${user}`, 10, 60);
  assert(a.roblox_username, 400, "no_roblox_username");
  const found = await resolveUsername(env, a.roblox_username);
  const result = await env.DB.batch([
    stmt(
      env,
      "UPDATE applications SET roblox_user_id=?,revision=revision+1,updated_by=?,updated_at=? WHERE guild_id=? AND id=? AND revision=? AND roblox_username=?",
      found.id,
      user,
      now(),
      guild,
      id,
      a.revision,
      a.roblox_username,
    ),
    stmt(
      env,
      "INSERT INTO audit_logs(guild_id,actor_id,action,target_id,created_at) SELECT ?,?,?,?,? WHERE changes()=1",
      guild,
      user,
      "roblox.username_resolved",
      id,
      now(),
    ),
  ]);
  await changed(result[0]);
  return {
    ...found,
    message: "Username resolved. Roblox account ownership is NOT verified.",
  };
}
