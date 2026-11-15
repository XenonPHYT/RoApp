import { one, all, stmt, run, audit, changed } from "../database/db.js";
import { requirePermission } from "./permissions.js";
import { formRecord } from "../database/queries.js";
import { discord } from "../utils/discord.js";
import { text, snowflake, id as validId } from "../utils/validation.js";
import { assert, now, uid, epoch } from "../utils/helpers.js";
import { embed, select } from "../discord/responses.js";
export async function savePanel(env, access, input, id = null) {
  requirePermission(access, "panels.manage");
  const channel = snowflake(input.channel_id);
  assert(
    Array.isArray(input.form_ids) &&
      input.form_ids.length > 0 &&
      input.form_ids.length <= 25 &&
      new Set(input.form_ids).size === input.form_ids.length,
    400,
    "invalid_panel_forms",
  );
  for (const form of input.form_ids)
    await formRecord(env, access.guild_id, validId(form));
  const c = await discord(env, `/channels/${channel}`);
  assert(
    c.guild_id === access.guild_id && [0, 5].includes(c.type),
    400,
    "invalid_panel_channel",
  );
  const config = {
    title: text(input.title, 1, 100),
    description: text(input.description || "", 0, 2000),
    form_ids: input.form_ids,
  };
  const t = now();
  id = id || uid();
  const existing = await one(
    env,
    "SELECT * FROM panels WHERE guild_id=? AND id=?",
    access.guild_id,
    id,
  );
  assert(
    !existing || existing.channel_id === channel,
    409,
    "channel_immutable",
    "Remove the panel before moving it to another channel.",
  );
  const r = await env.DB.batch([
    existing
      ? stmt(
          env,
          "UPDATE panels SET config_json=? WHERE guild_id=? AND id=? AND lease_until<? AND state='active'",
          JSON.stringify(config),
          access.guild_id,
          id,
          epoch(),
        )
      : stmt(
          env,
          "INSERT INTO panels(guild_id,id,channel_id,config_json,created_at) VALUES(?,?,?,?,?)",
          access.guild_id,
          id,
          channel,
          JSON.stringify(config),
          t,
        ),
    stmt(
      env,
      "INSERT INTO audit_logs(guild_id,actor_id,action,target_id,created_at) SELECT ?,?,?,?,? WHERE changes()=1",
      access.guild_id,
      access.user_id,
      "panel.saved",
      id,
      t,
    ),
  ]);
  await changed(r[0]);
  return one(
    env,
    "SELECT * FROM panels WHERE guild_id=? AND id=?",
    access.guild_id,
    id,
  );
}
export async function panelMessage(env, guild, panel) {
  const config = JSON.parse(panel.config_json),
    items = [];
  for (const id of config.form_ids) {
    const f = await one(
      env,
      "SELECT f.status,v.definition_json FROM forms f LEFT JOIN form_versions v ON v.guild_id=f.guild_id AND v.form_id=f.id AND v.version=f.version WHERE f.guild_id=? AND f.id=?",
      guild,
      id,
    );
    if (f?.definition_json) {
      const d = JSON.parse(f.definition_json);
      items.push({
        id,
        title: d.title,
        status: f.status,
        description: d.description,
      });
    }
  }
  return {
    embeds: [
      embed(
        config.title,
        config.description,
        items.slice(0, 20).map((f) => ({
          name: `${f.title} — ${f.status}`,
          value: f.description.slice(0, 180) || "Choose below to apply.",
        })),
      ),
    ],
    components: items.some((f) => f.status === "open")
      ? [
          select(
            `panel:${panel.id}`,
            items
              .filter((f) => f.status === "open")
              .map((f) => ({
                label: f.title.slice(0, 100),
                value: f.id,
                ...(f.description
                  ? { description: f.description.slice(0, 100) }
                  : {}),
              })),
            "Select an application…",
          ),
        ]
      : [],
    allowed_mentions: { parse: [] },
  };
}
export async function publishPanel(env, access, id) {
  requirePermission(access, "panels.manage");
  const token = uid();
  const panel = await one(
    env,
    "UPDATE panels SET lease_token=?,lease_until=? WHERE guild_id=? AND id=? AND lease_until<? AND state='active' RETURNING *",
    token,
    epoch() + 30,
    access.guild_id,
    id,
    epoch(),
  );
  assert(panel, 409, "panel_busy_or_missing");
  try {
    const body = await panelMessage(env, access.guild_id, panel);
    const msg = await discord(
      env,
      `/channels/${panel.channel_id}/messages${panel.message_id ? "/" + panel.message_id : ""}`,
      {
        method: panel.message_id ? "PATCH" : "POST",
        body: panel.message_id
          ? body
          : { ...body, nonce: panel.id.slice(0, 24), enforce_nonce: true },
      },
    );
    await env.DB.batch([
      stmt(
        env,
        "UPDATE panels SET message_id=? WHERE guild_id=? AND id=? AND lease_token=?",
        msg.id,
        access.guild_id,
        id,
        token,
      ),
      audit(env, access.guild_id, access.user_id, "panel.published", id),
    ]);
    return { ...panel, message_id: msg.id };
  } finally {
    await run(
      env,
      "UPDATE panels SET lease_token=NULL,lease_until=0 WHERE guild_id=? AND id=? AND lease_token=?",
      access.guild_id,
      id,
      token,
    );
  }
}
export async function removePanel(env, access, id, confirm) {
  requirePermission(access, "panels.manage");
  assert(confirm === id, 400, "confirmation_required");
  const token = uid();
  const p = await one(
    env,
    "UPDATE panels SET state='removing',lease_token=?,lease_until=? WHERE guild_id=? AND id=? AND lease_until<? RETURNING *",
    token,
    epoch() + 30,
    access.guild_id,
    id,
    epoch(),
  );
  assert(p, 409, "panel_busy_or_missing");
  try {
    if (p.message_id) {
      try {
        await discord(
          env,
          `/channels/${p.channel_id}/messages/${p.message_id}`,
          { method: "DELETE" },
        );
      } catch (e) {
        if (e.upstreamStatus !== 404) throw e;
      }
    }
    await env.DB.batch([
      stmt(
        env,
        "DELETE FROM panels WHERE guild_id=? AND id=? AND lease_token=?",
        access.guild_id,
        id,
        token,
      ),
      audit(env, access.guild_id, access.user_id, "panel.removed", id),
    ]);
  } finally {
    await run(
      env,
      "UPDATE panels SET lease_token=NULL,lease_until=0 WHERE guild_id=? AND id=? AND lease_token=?",
      access.guild_id,
      id,
      token,
    );
  }
}
export async function panelForm(env, guild, panelId, formId) {
  const p = await one(
    env,
    "SELECT * FROM panels WHERE guild_id=? AND id=? AND state='active'",
    guild,
    panelId,
  );
  assert(
    p && JSON.parse(p.config_json).form_ids.includes(formId),
    404,
    "panel_form_unavailable",
  );
  return formId;
}
export const listPanels = (env, guild) =>
  all(
    env,
    "SELECT id,channel_id,message_id,config_json,state FROM panels WHERE guild_id=? ORDER BY created_at DESC",
    guild,
  );
