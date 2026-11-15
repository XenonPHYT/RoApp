import { reviewImmediate, reviewComponent } from "./review-ui.js";
import { assert } from "../utils/helpers.js";
import { submitApplication, withdraw } from "../modules/applications.js";
import { removePanel } from "../modules/panels.js";
import { authorize } from "../modules/permissions.js";
import { message } from "./responses.js";
import { applyComponent, applyModal } from "./apply-flow.js";
export function parseCustomId(value) {
  assert(
    typeof value === "string" && value.length <= 100,
    400,
    "invalid_component",
  );
  const parts = value.split(":");
  assert(
    parts.length >= 2 && parts.every((x) => /^[A-Za-z0-9_-]{1,60}$/.test(x)),
    400,
    "invalid_component",
  );
  return parts;
}
export async function immediateComponent(i, env) {
  if (i.type !== 3 && i.type !== 5) return null;
  const parts = parseCustomId(i.data.custom_id);
  if (i.type === 5) return applyModal(i, env, parts);
  const review = await reviewImmediate(i, env, parts);
  if (review) return review;
  return applyComponent(i, env, parts);
}
export async function handleComponent(i, env) {
  const [kind, actor, target, version] = parseCustomId(i.data.custom_id),
    user = i.member?.user?.id;
  assert(actor === user, 403, "component_owner");
  if (
    [
      "queue",
      "page",
      "open",
      "detail",
      "search",
      "savenote",
      "savedecision",
      "assign",
      "unassign",
      "answerpick",
      "fullanswer",
      "notes",
    ].includes(kind)
  )
    return reviewComponent(i, env, [
      kind,
      actor,
      target,
      version,
      ...parseCustomId(i.data.custom_id).slice(4),
    ]);
  if (kind === "formpage" && i.type === 3) {
    const { formChoices } = await import("./commands.js");
    return formChoices(env, i.guild_id, user, Number(target));
  }
  if (kind === "submit" && i.type === 5) {
    const input = Object.fromEntries(
      (i.data.components || []).flatMap((r) =>
        (r.components || []).map((c) => [c.custom_id, c.value]),
      ),
    );
    const a = await submitApplication(
      env,
      i.guild_id,
      user,
      target,
      Number(version),
      input,
    );
    return message(
      `Application submitted: ${a.id}. Use /myapplications to check progress.`,
    );
  }
  if (kind === "withdraw" && i.type === 3) {
    await withdraw(env, i.guild_id, user, target, Number(version));
    return message("Your application has been withdrawn.");
  }
  if (kind === "remove" && i.type === 3) {
    const access = await authorize(env, i.guild_id, user, "panels.manage");
    await removePanel(env, access, target, target);
    return message("Panel removed.");
  }
  assert(
    false,
    400,
    "unknown_component",
    "This control is unsupported or expired. Open a fresh interface.",
  );
}
