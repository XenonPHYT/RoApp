import { discord } from "../utils/discord.js";
import { currentMember, guildRecord } from "./guilds.js";
import { all, stmt, audit } from "../database/db.js";
import { assert } from "../utils/helpers.js";
import { snowflake } from "../utils/validation.js";
export const PERMISSIONS = [
  "forms.manage",
  "applications.review",
  "applications.decide",
  "applications.notes",
  "applications.assign",
  "panels.manage",
  "staff.manage",
  "settings.manage",
  "audit.view",
];
export function evaluatePermissions(member, roles) {
  if (member.owner)
    return { owner: true, dashboard: true, permissions: [...PERMISSIONS] };
  const matching = roles.filter((r) => member.roles.includes(r.role_id));
  return {
    owner: false,
    dashboard: matching.some((r) => !!r.dashboard),
    permissions: [
      ...new Set(
        matching
          .flatMap((r) => JSON.parse(r.permissions_json))
          .filter((p) => PERMISSIONS.includes(p)),
      ),
    ],
  };
}
export async function authorize(
  env,
  guild,
  user,
  permission = null,
  { dashboard = false, timeout = 2500 } = {},
) {
  const member = await currentMember(env, guild, user, timeout);
  assert(
    await guildRecord(env, guild),
    404,
    "community_not_configured",
    "The server owner must run /setup first.",
  );
  const access = evaluatePermissions(
    member,
    await all(
      env,
      "SELECT * FROM dashboard_role_access WHERE guild_id=?",
      guild,
    ),
  );
  assert(!dashboard || access.dashboard, 403, "dashboard_forbidden");
  assert(
    !permission || access.permissions.includes(permission),
    403,
    "permission_denied",
  );
  return { ...access, guild_id: guild, user_id: user, member };
}
export function requirePermission(access, permission) {
  assert(access.permissions.includes(permission), 403, "permission_denied");
}
export async function setRole(env, access, input) {
  requirePermission(access, "staff.manage");
  const role = snowflake(input.role_id);
  assert(role !== access.guild_id, 400, "everyone_role_forbidden");
  assert(
    typeof input.dashboard === "boolean" &&
      Array.isArray(input.permissions) &&
      input.permissions.every((p) => PERMISSIONS.includes(p)),
    400,
    "invalid_permissions",
  );
  const grants = [...new Set(input.permissions)];
  assert(
    access.owner ||
      (!input.dashboard && grants.every((p) => access.permissions.includes(p))),
    403,
    "cannot_escalate",
    "Only the owner may grant dashboard access; staff cannot grant permissions they do not hold.",
  );
  const roles = await discord(env, `/guilds/${access.guild_id}/roles`);
  assert(
    Array.isArray(roles) && roles.some((r) => r.id === role),
    400,
    "role_not_in_community",
  );
  await env.DB.batch([
    stmt(
      env,
      "INSERT INTO dashboard_role_access(guild_id,role_id,dashboard,permissions_json) VALUES(?,?,?,?) ON CONFLICT(guild_id,role_id) DO UPDATE SET dashboard=excluded.dashboard,permissions_json=excluded.permissions_json",
      access.guild_id,
      role,
      input.dashboard ? 1 : 0,
      JSON.stringify(grants),
    ),
    audit(env, access.guild_id, access.user_id, "staff.role_saved", role),
  ]);
}
export async function removeRole(env, access, role) {
  requirePermission(access, "staff.manage");
  snowflake(role);
  const rows = await all(
    env,
    "SELECT * FROM dashboard_role_access WHERE guild_id=? AND role_id=?",
    access.guild_id,
    role,
  );
  assert(
    access.owner ||
      rows.every(
        (r) =>
          !r.dashboard &&
          JSON.parse(r.permissions_json).every((p) =>
            access.permissions.includes(p),
          ),
      ),
    403,
    "cannot_escalate",
  );
  await env.DB.batch([
    stmt(
      env,
      "DELETE FROM dashboard_role_access WHERE guild_id=? AND role_id=?",
      access.guild_id,
      role,
    ),
    audit(env, access.guild_id, access.user_id, "staff.role_removed", role),
  ]);
}
