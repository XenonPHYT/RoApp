import { assert, AppError } from "../utils/helpers.js";
import { rateLimit } from "../database/db.js";
import { id as validId } from "../utils/validation.js";
import { publishedForm } from "../modules/forms.js";
import {
  submitApplication,
  submissionBlock,
  myApplications,
} from "../modules/applications.js";
import { panelForm } from "../modules/panels.js";
import { getDraft, saveDraft, clearDraft } from "../modules/drafts.js";
import {
  stepsOf,
  stepRange,
  needsPanel,
  widget,
  buildModal,
  flattenSubmitted,
  rawFrom,
  validateQuestions,
  display,
  firstInvalidStep,
} from "../modules/form-steps.js";
import { allowedMentions, button, link, row, embed } from "./responses.js";
// Applicant workflow: pick a form once -> intro (title, description, instructions,
// requirements, questions) -> one modal per group of up to 5 questions -> review ->
// submit. Everything is read from the saved form and answers are kept server-side.
const BLUE = 0x00b7ff,
  GREEN = 0x2ecc71,
  RED = 0xe74c3c,
  AMBER = 0xf1c40f;
export const reply = (data) => ({
  type: 4,
  data: { flags: 64, allowed_mentions: allowedMentions, ...data },
});
export const update = (data) => ({
  type: 7,
  data: { allowed_mentions: allowedMentions, ...data },
});
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const card = (title, description, { color = BLUE, fields, footer } = {}) => ({
  title: clip(title, 256),
  ...(description ? { description: description.slice(0, 4096) } : {}),
  color,
  ...(fields?.length ? { fields } : {}),
  ...(footer ? { footer: { text: clip(footer, 2048) } } : {}),
});
const bar = (done, total) => "▰".repeat(done) + "▱".repeat(total - done);
const cid = (...p) => p.join(":");
const primary = (label, id) => button(label, id, 1);
const cancelButton = (user, formId) =>
  button("Cancel", cid("acancel", user, formId), 2);
function fitSections(sections, budget) {
  const parts = sections
    .map(([h, t]) => [h, String(t || "").trim()])
    .filter(([, t]) => t);
  const head = (h) => (h ? `**${h}**\n` : "");
  let room = Math.max(
    0,
    budget - parts.reduce((n, [h]) => n + head(h).length + 2, 0),
  );
  const alloc = [];
  let left = parts.length;
  for (const idx of parts
    .map((_, n) => n)
    .sort((a, b) => parts[a][1].length - parts[b][1].length)) {
    const take = Math.min(parts[idx][1].length, Math.floor(room / left));
    alloc[idx] = take;
    room -= take;
    left--;
  }
  let truncated = false;
  const text = parts
    .map(([h, t], idx) => {
      if (t.length > alloc[idx]) {
        truncated = true;
        t = t.slice(0, Math.max(0, alloc[idx] - 1)) + "…";
      }
      return head(h) + t;
    })
    .join("\n\n");
  return { text, truncated };
}
function outline(def) {
  const lines = [];
  let used = 0;
  for (const [n, q] of def.questions.entries()) {
    const line = `${n + 1}. ${clip(q.label, 60)}${q.required ? " *" : ""}`;
    if (used + line.length + 1 > 940) {
      lines.push(`…and ${def.questions.length - n} more`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}
const blockText = (b) =>
  b.kind === "cooldown"
    ? `You can apply to this form again <t:${b.until}:R>.`
    : "You already have an active application for this form. Wait for a decision, or withdraw it from My Applications.";
const usableDraft = async (env, guild, user, formId, version) => {
  const d = await getDraft(env, guild, user, formId);
  return d && d.form_version === version ? d : null;
};
async function openForm(env, guild, formId, versionText) {
  const f = await publishedForm(env, guild, validId(formId));
  if (versionText !== undefined) {
    const v = Number(versionText);
    assert(
      Number.isSafeInteger(v) && v === f.version,
      409,
      "stale_form",
      "This form was updated. Open the application again from the panel or /apply.",
    );
  }
  return f;
}
export async function introData(env, guild, user, formId) {
  const f = await publishedForm(env, guild, validId(formId));
  const def = f.definition;
  const [saved, block] = await Promise.all([
    usableDraft(env, guild, user, formId, f.version),
    submissionBlock(env, guild, user, formId),
  ]);
  const { text, truncated } = fitSections(
    [
      ["", def.description],
      ["Instructions", def.instructions],
      ["Requirements", def.requirements],
    ],
    3700,
  );
  const fields = [
    { name: `Questions (${def.questions.length})`, value: outline(def) },
  ];
  if (saved)
    fields.push({
      name: "Saved progress",
      value: `${Object.keys(saved.answers).length} answer(s) saved. Resume where you left off, or start over.`,
    });
  if (block)
    fields.push({ name: "Not available right now", value: blockText(block) });
  const steps = stepsOf(def).length;
  const start = {
    ...primary(
      saved ? "Resume Application" : "Start Application",
      cid("astart", user, formId, f.version),
    ),
    ...(block ? { disabled: true } : {}),
  };
  const buttons = [start];
  if (saved && !block)
    buttons.push(button("Start over", cid("arestart", user, formId, f.version), 2));
  if (block) buttons.push(button("My Applications", cid("amine", user), 2));
  buttons.push(cancelButton(user, formId));
  if (truncated && env.APP_ORIGIN)
    buttons.push(link("Read full text", `${env.APP_ORIGIN}/?apply=${guild}.${formId}`));
  return {
    content: "",
    embeds: [
      card(def.title, text, {
        fields,
        footer: `${def.questions.length} question(s) • ${steps} step(s)`,
      }),
    ],
    components: [row(...buttons)],
  };
}
// Full question text for one step, shown before the modal so nothing is truncated.
function stepData(user, formId, f, step, { saved = false, label } = {}) {
  const def = f.definition,
    steps = stepsOf(def),
    [a] = stepRange(def, step);
  const lines = steps[step].map(
    (q, n) =>
      `**${a + n}.** ${q.label}${q.required ? " *" : " _(optional)_"}` +
      (q.options && widget(q) === "text"
        ? `\n_Type exactly one of: ${clip(q.options.join(", "), 500)}_`
        : ""),
  );
  const base = cid(user, formId, f.version);
  const buttons = [
    primary(
      label || `Continue to step ${step + 1}`,
      `aopen:${base}:${step}:g`,
    ),
  ];
  if (step > 0)
    buttons.push(button(`Edit step ${step}`, `aopen:${base}:${step - 1}`, 2));
  buttons.push(cancelButton(user, formId));
  return {
    content: "",
    embeds: [
      card(
        def.title,
        `${bar(step, steps.length)}  Step ${step + 1} of ${steps.length}\n${saved ? `✅ Step ${step} saved.\n` : ""}\n${lines.join("\n")}\n\n_* required_`,
        { footer: "Answers are saved as you go." },
      ),
    ],
    components: [row(...buttons)],
  };
}
function reviewData(user, formId, f, raw) {
  const def = f.definition,
    steps = stepsOf(def),
    n = def.questions.length;
  const cap = Math.max(40, Math.floor(3800 / n) - 90);
  let shortened = false;
  const lines = def.questions.map((q, idx) => {
    const v = display(q, raw[q.id]);
    if (v.length > cap) shortened = true;
    return `**${idx + 1}. ${clip(q.label, 70)}**\n${clip(v, cap)}`;
  });
  const base = cid(user, formId, f.version);
  const controls = [];
  if (steps.length > 1)
    controls.push(
      row({
        type: 3,
        custom_id: `aedit:${base}`,
        placeholder: "Edit a step…",
        options: steps.map((qs, s) => {
          const [a, b] = stepRange(def, s);
          return {
            label: `Step ${s + 1} of ${steps.length}`,
            value: String(s),
            description: `Questions ${a}–${b}`,
          };
        }),
      }),
    );
  const buttons = [
    button("Submit Application", `asubmit:${base}`, 3),
    ...(steps.length > 1 ? [] : [button("Edit answers", `aopen:${base}:0`, 2)]),
    cancelButton(user, formId),
  ];
  return {
    content: "",
    embeds: [
      card(
        `Review: ${def.title}`,
        `Please review your answers before submitting.\n\n${lines.join("\n\n")}`,
        {
          color: BLUE,
          footer: shortened
            ? "Long answers are shortened here; the full answers are submitted."
            : "Nothing is sent until you press Submit Application.",
        },
      ),
    ],
    components: [...controls, row(...buttons)],
  };
}
function errorData(user, formId, f, errors, step) {
  const lines = errors
    .slice(0, 15)
    .map((e) => `• **${clip(e.label, 80)}** — ${e.message}`);
  return {
    content: "",
    embeds: [
      card("Please fix these answers", lines.join("\n"), {
        color: RED,
        footer: "Your other answers are saved.",
      }),
    ],
    components: [
      row(
        primary(
          "Fix answers",
          `aopen:${cid(user, formId, f.version)}:${step}:g`,
        ),
        cancelButton(user, formId),
      ),
    ],
  };
}
const noteData = (title, text, color = AMBER, components = []) => ({
  content: "",
  embeds: [card(title, text, { color })],
  components,
});
export async function myApplicationsData(env, guild, user) {
  const apps = await myApplications(env, guild, user);
  return {
    content: apps.length
      ? "Your applications (most recent 100):"
      : "You have no applications.",
    embeds: [
      embed(
        "My applications",
        apps
          .slice(0, 20)
          .map((a) => `${a.id} — ${a.status}`)
          .join("\n") || "No applications yet.",
      ),
    ],
    components: [
      row(link("Applicant portal", env.APP_ORIGIN + `/?mine=${guild}`)),
    ],
  };
}
async function openStep(env, ctx, step, force) {
  const { guild, user, formId, f } = ctx,
    def = f.definition,
    steps = stepsOf(def);
  assert(
    Number.isSafeInteger(step) && step >= 0 && step < steps.length,
    400,
    "invalid_step",
  );
  if (!force && needsPanel(steps[step]))
    return update(stepData(user, formId, f, step, { label: `Answer step ${step + 1}` }));
  const draft = await usableDraft(env, guild, user, formId, f.version);
  return buildModal({
    user,
    formId,
    version: f.version,
    step,
    def,
    raw: draft?.answers ?? {},
  });
}
async function resume(env, ctx, draft) {
  const { user, formId, f } = ctx,
    S = stepsOf(f.definition).length;
  if (!draft) return openStep(env, ctx, 0, false);
  if (draft.step >= S) {
    const bad = firstInvalidStep(f.definition, draft.answers);
    return bad === -1
      ? update(reviewData(user, formId, f, draft.answers))
      : openStep(env, ctx, bad, false);
  }
  return openStep(env, ctx, draft.step, false);
}
const APPLY_KINDS = new Set([
  "astart",
  "arestart",
  "aopen",
  "aedit",
  "asubmit",
  "acancel",
  "amine",
]);
export async function applyComponent(i, env, parts) {
  const [kind, actor, ...rest] = parts,
    user = i.member?.user?.id,
    guild = i.guild_id;
  if (kind === "panel") {
    assert(i.data.values?.length === 1, 400, "invalid_selection");
    const formId = await panelForm(env, guild, actor, i.data.values[0]);
    return reply(await introData(env, guild, user, formId));
  }
  if (kind === "forms") {
    assert(
      actor === user && i.data.values?.length === 1,
      403,
      "component_owner",
    );
    return update(await introData(env, guild, user, i.data.values[0]));
  }
  if (!APPLY_KINDS.has(kind)) return null;
  assert(actor === user, 403, "component_owner");
  await rateLimit(env, `flow:${guild}:${user}`, 200, 60);
  if (kind === "amine") return reply(await myApplicationsData(env, guild, user));
  const [formId, versionText, stepText, flag] = rest;
  if (kind === "acancel")
    return update({
      content:
        "Application closed. Your saved answers are kept for 24 hours; open the application again to resume.",
      embeds: [],
      components: [],
    });
  const f = await openForm(env, guild, formId, versionText);
  const ctx = { guild, user, formId, f };
  if (kind === "astart" || kind === "arestart") {
    const block = await submissionBlock(env, guild, user, formId);
    assert(!block, 409, "apply_blocked", blockText(block || {}));
    if (kind === "arestart") {
      await clearDraft(env, guild, user, formId);
      return openStep(env, ctx, 0, false);
    }
    return resume(env, ctx, await usableDraft(env, guild, user, formId, f.version));
  }
  if (kind === "aopen") return openStep(env, ctx, Number(stepText), flag === "g");
  if (kind === "aedit") {
    assert(i.data.values?.length === 1, 400, "invalid_selection");
    return openStep(env, ctx, Number(i.data.values[0]), false);
  }
  return submit(env, ctx);
}
async function submit(env, ctx) {
  const { guild, user, formId, f } = ctx,
    def = f.definition,
    S = stepsOf(def).length;
  const draft = await usableDraft(env, guild, user, formId, f.version);
  assert(
    draft && draft.step >= S,
    409,
    "draft_incomplete",
    "Finish every step before submitting. Open the application again to continue.",
  );
  const { values, errors } = validateQuestions(def.questions, draft.answers);
  if (errors.length)
    return update(errorData(user, formId, f, errors, firstInvalidStep(def, draft.answers)));
  try {
    const a = await submitApplication(env, guild, user, formId, f.version, values);
    try {
      await clearDraft(env, guild, user, formId);
    } catch {
      // The draft expires on its own; the submission already succeeded.
    }
    return update({
      content: "",
      embeds: [
        card(
          "Application Submitted!",
          "Your application has been submitted successfully. You can check its status in My Applications.",
          {
            color: GREEN,
            fields: [
              { name: "Application", value: def.title.slice(0, 256) },
              { name: "Reference", value: a.id },
              { name: "Status", value: "Pending", inline: true },
            ],
            footer: "Thank you for applying! We'll get back to you soon.",
          },
        ),
      ],
      components: [row(button("View My Applications", cid("amine", user), 1))],
    });
  } catch (e) {
    const text = String(e?.message || "");
    if (text.includes("duplicate_or_cooldown")) {
      const b = await submissionBlock(env, guild, user, formId);
      return update(
        noteData(
          "Application not submitted",
          b ? blockText(b) : "You cannot submit this form right now.",
          AMBER,
          [row(button("My Applications", cid("amine", user), 2))],
        ),
      );
    }
    if (
      text.includes("form_closed_or_changed") ||
      (e instanceof AppError && ["form_closed", "stale_form"].includes(e.code))
    )
      return update(
        noteData(
          "This form changed",
          "The form was closed or updated while you were applying. Open the application again to start with the current questions.",
        ),
      );
    throw e;
  }
}
// Modal submit for one step: validate, save, then move on without losing anything.
export async function applyModal(i, env, parts) {
  const [kind, actor, formId, versionText, stepText] = parts,
    user = i.member?.user?.id,
    guild = i.guild_id;
  if (kind !== "astep") return null;
  assert(actor === user, 403, "component_owner");
  await rateLimit(env, `flow:${guild}:${user}`, 200, 60);
  const f = await openForm(env, guild, formId, versionText);
  const def = f.definition,
    steps = stepsOf(def),
    step = Number(stepText);
  assert(
    Number.isSafeInteger(step) && step >= 0 && step < steps.length,
    400,
    "invalid_step",
  );
  const submitted = flattenSubmitted(i.data.components);
  const qs = steps[step];
  for (const id of submitted.keys())
    assert(qs.some((q) => q.id === id), 400, "invalid_component");
  const prior = await usableDraft(env, guild, user, formId, f.version);
  const raw = { ...(prior?.answers ?? {}) };
  for (const q of qs) {
    const v = rawFrom(q, submitted.get(q.id));
    if (v === undefined || v === "" || (Array.isArray(v) && !v.length))
      delete raw[q.id];
    else raw[q.id] = v;
  }
  const { errors } = validateQuestions(qs, raw);
  const reached = prior?.step ?? 0;
  if (errors.length) {
    await saveDraft(env, guild, user, formId, f.version, raw, reached);
    return update(errorData(user, formId, f, errors, step));
  }
  const done = Math.max(reached, step + 1);
  await saveDraft(env, guild, user, formId, f.version, raw, done);
  if (done < steps.length)
    return update(stepData(user, formId, f, done, { saved: true }));
  const bad = firstInvalidStep(def, raw);
  if (bad !== -1) {
    const all = validateQuestions(steps[bad], raw).errors;
    return update(errorData(user, formId, f, all, bad));
  }
  return update(reviewData(user, formId, f, raw));
}
