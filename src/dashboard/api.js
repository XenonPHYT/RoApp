import { resolveApplication } from "../modules/roblox.js";
import { json, readJson, assert, AppError, now } from "../utils/helpers.js";
import { id, snowflake, integer, text } from "../utils/validation.js";
import { all, one, stmt, audit } from "../database/db.js";
import { listForms, formRecord } from "../database/queries.js";
import {
  saveForm,
  publishForm,
  closeForm,
  serializeForm,
  availableForms,
  publishedForm,
} from "../modules/forms.js";
import {
  submitApplication,
  myApplications,
  ownApplication,
  withdraw,
  revise,
} from "../modules/applications.js";
import {
  reviewQueue,
  reviewDetail,
  decide,
  addNote,
  assign,
} from "../modules/reviews.js";
import {
  requirePermission,
  setRole,
  removeRole,
  PERMISSIONS,
} from "../modules/permissions.js";
import { currentMember, guildRecord } from "../modules/guilds.js";
import {
  savePanel,
  publishPanel,
  removePanel,
  listPanels,
} from "../modules/panels.js";
import { discord } from "../utils/discord.js";
export async function applicantAPI(request, env, s) {
  const parts = new URL(request.url).pathname
      .split("/")
      .filter(Boolean)
      .slice(2),
    [guild, kind, target, action] = parts;
  snowflake(guild);
  await currentMember(env, guild, s.user_id);
  assert(await guildRecord(env, guild), 404, "community_not_configured");
  const method = request.method;
  if (kind === "forms" && !target && method === "GET")
    return json(await availableForms(env, guild));
  if (kind === "forms" && target) {
    id(target);
    if (method === "GET") return json(await publishedForm(env, guild, target));
    if (method === "POST") {
      const b = await readJson(request);
      return json(
        await submitApplication(
          env,
          guild,
          s.user_id,
          target,
          b.version,
          b.answers,
        ),
        201,
      );
    }
  }
  if (kind === "applications" && !target && method === "GET")
    return json(await myApplications(env, guild, s.user_id));
  if (kind === "applications" && target) {
    id(target);
    if (method === "GET" && !action)
      return json(await ownApplication(env, guild, s.user_id, target));
    if (method === "POST") {
      const b = await readJson(request);
      if (action === "roblox")
        return json(await resolveApplication(env, guild, s.user_id, target));
      if (action === "withdraw") {
        assert(b.confirm === target, 400, "confirmation_required");
        return json(
          await withdraw(
            env,
            guild,
            s.user_id,
            target,
            integer(b.revision, 0, 100000000),
          ),
        );
      }
      if (action === "revise")
        return json(
          await revise(
            env,
            guild,
            s.user_id,
            target,
            integer(b.revision, 0, 100000000),
            b.answers,
          ),
        );
    }
  }
  throw new AppError(404, "not_found");
}
export async function managementAPI(request, env, s, access) {
  const url = new URL(request.url),
    parts = url.pathname.split("/").filter(Boolean).slice(2),
    [kind, target, action] = parts;
  const method = request.method,
    guild = access.guild_id,
    user = access.user_id;
  assert(url.pathname.startsWith("/api/manage/"), 404, "not_found");
  if (kind === "context" && method === "GET") {
    const g = await guildRecord(env, guild);
    return json({
      guild_id: guild,
      name: g.name,
      settings: JSON.parse(g.settings_json),
      access: { owner: access.owner, permissions: access.permissions },
      permission_types: PERMISSIONS,
    });
  }
  if (kind === "overview" && method === "GET") {
    const stats = await all(
      env,
      "SELECT status,count(*) AS total FROM applications WHERE guild_id=? GROUP BY status",
      guild,
    );
    const forms = await one(
      env,
      "SELECT count(*) AS total FROM forms WHERE guild_id=? AND status='open'",
      guild,
    );
    return json({ statuses: stats, open_forms: forms.total });
  }
  if (kind === "forms") {
    requirePermission(access, "forms.manage");
    if (!target && method === "GET")
      return json((await listForms(env, guild)).map(serializeForm));
    if (!target && method === "POST")
      return json(await saveForm(env, access, await readJson(request)), 201);
    if (target) {
      id(target);
      if (method === "GET")
        return json(serializeForm(await formRecord(env, guild, target)));
      if (method === "PUT")
        return json(
          await saveForm(env, access, await readJson(request), target),
        );
      if (method === "POST" && action === "publish")
        return json(await publishForm(env, access, target));
      if (method === "POST" && action === "close") {
        await closeForm(env, access, target);
        return json({ ok: true });
      }
    }
  }
  if (kind === "applications") {
    requirePermission(access, "applications.review");
    if (!target && method === "GET") {
      const items = await reviewQueue(
        env,
        access,
        url.searchParams.get("filter") || "pending",
        Number(url.searchParams.get("page") || 0),
        url.searchParams.get("search") || "",
      );
      return json({ items: items.slice(0, 10), has_more: items.length > 10 });
    }
    if (target) {
      id(target);
      if (method === "GET")
        return json(await reviewDetail(env, access, target));
      if (method === "POST") {
        const b = await readJson(request);
        if (action === "roblox")
          return json(
            await resolveApplication(env, guild, user, target, access),
          );
        if (action === "decision")
          return json(
            await decide(
              env,
              access,
              target,
              integer(b.revision, 0, 100000000),
              text(b.status, 1, 30),
              b.reason || "",
            ),
          );
        if (action === "notes") {
          await addNote(env, access, target, b.body);
          return json({ ok: true });
        }
        if (action === "assign") {
          assert(typeof b.remove === "boolean", 400, "invalid_assignment");
          await assign(env, access, target, b.remove);
          return json({ ok: true });
        }
      }
    }
  }
  if (kind === "staff") {
    requirePermission(access, "staff.manage");
    if (method === "GET") {
      const roles = await discord(env, `/guilds/${guild}/roles`);
      return json({
        roles: roles
          .filter((r) => r.id !== guild)
          .map((r) => ({ id: r.id, name: r.name })),
        assignments: await all(
          env,
          "SELECT * FROM dashboard_role_access WHERE guild_id=?",
          guild,
        ),
      });
    }
    if (method === "PUT") {
      await setRole(env, access, await readJson(request));
      return json({ ok: true });
    }
    if (method === "DELETE" && target) {
      const b = await readJson(request);
      assert(b.confirm === target, 400, "confirmation_required");
      await removeRole(env, access, snowflake(target));
      return json({ ok: true });
    }
  }
  if (kind === "panels") {
    requirePermission(access, "panels.manage");
    if (method === "GET")
      return json({
        panels: await listPanels(env, guild),
        forms: (await listForms(env, guild)).map((f) => ({
          id: f.id,
          title: JSON.parse(f.draft_json).title,
          status: f.status,
        })),
      });
    if (method === "POST" && !target)
      return json(await savePanel(env, access, await readJson(request)), 201);
    if (target) {
      id(target);
      if (method === "PUT")
        return json(
          await savePanel(env, access, await readJson(request), target),
        );
      if (method === "POST" && action === "publish")
        return json(await publishPanel(env, access, target));
      if (method === "DELETE") {
        const b = await readJson(request);
        await removePanel(env, access, target, b.confirm);
        return json({ ok: true });
      }
    }
  }
  if (kind === "settings" && method === "PUT") {
    requirePermission(access, "settings.manage");
    const b = await readJson(request);
    assert(
      typeof b.notifications === "boolean" &&
        typeof b.multiple_reviewers === "boolean",
      400,
      "invalid_settings",
    );
    await env.DB.batch([
      stmt(
        env,
        "UPDATE guilds SET settings_json=? WHERE guild_id=?",
        JSON.stringify({
          notifications: b.notifications,
          multiple_reviewers: b.multiple_reviewers,
        }),
        guild,
      ),
      audit(env, guild, user, "settings.saved", guild),
    ]);
    return json({ ok: true });
  }
  if (kind === "audit" && method === "GET") {
    requirePermission(access, "audit.view");
    const before = integer(
      Number(url.searchParams.get("before") || Number.MAX_SAFE_INTEGER),
      1,
      Number.MAX_SAFE_INTEGER,
    );
    return json(
      await all(
        env,
        "SELECT id,actor_id,action,target_id,created_at FROM audit_logs WHERE guild_id=? AND id<? ORDER BY id DESC LIMIT 50",
        guild,
        before,
      ),
    );
  }
  if (kind === "notifications") {
    requirePermission(access, "settings.manage");
    if (method === "GET")
      return json(
        await all(
          env,
          "SELECT id,application_id,status,attempts,next_attempt,last_error FROM notification_jobs WHERE guild_id=? AND status<>'sent' ORDER BY id DESC LIMIT 50",
          guild,
        ),
      );
    if (method === "POST" && target) {
      const b = await readJson(request);
      assert(b.confirm === target, 400, "confirmation_required");
      await env.DB.batch([
        stmt(
          env,
          "UPDATE notification_jobs SET status='pending',attempts=0,next_attempt=unixepoch(),last_error=NULL WHERE guild_id=? AND id=? AND status='failed'",
          guild,
          integer(Number(target), 1, Number.MAX_SAFE_INTEGER),
        ),
        audit(env, guild, user, "notification.retry", target),
      ]);
      return json({ ok: true });
    }
  }
  throw new AppError(404, "not_found");
}
