import { answers } from "../utils/validation.js";
import { AppError } from "../utils/helpers.js";
// Pure helpers that turn a saved form definition into modal steps and turn
// submitted modal values back into validated answers. The dashboard-saved
// definition stays the single source of truth; nothing here is form-specific.
export const STEP_SIZE = 5; // Discord modals allow at most 5 top-level components.
// A Label shows 45 characters and its description 100 more; labels longer than
// this are shown in full in the step message instead of being cut off.
export const LABEL_FIT = 143;
export const DEFAULT_MIN = -1000000000;
export const DEFAULT_MAX = 1000000000;
export function stepsOf(def) {
  const out = [];
  for (let i = 0; i < def.questions.length; i += STEP_SIZE)
    out.push(def.questions.slice(i, i + STEP_SIZE));
  return out;
}
export const stepCount = (def) => Math.ceil(def.questions.length / STEP_SIZE);
export const stepRange = (def, step) => [
  step * STEP_SIZE + 1,
  Math.min((step + 1) * STEP_SIZE, def.questions.length),
];
// Steps whose full text cannot fit in modal labels (very long questions, or choice
// lists typed by hand because Discord cannot show them) get a message first.
export const needsPanel = (questions) =>
  questions.some(
    (q) => q.label.length > LABEL_FIT || (q.options && widget(q) === "text"),
  );
// Which Discord component represents a question.
export function widget(q) {
  const n = q.options?.length ?? 0;
  switch (q.type) {
    case "yes_no":
      return "radio";
    case "multiple_choice":
      return n >= 2 && n <= 10 ? "radio" : n <= 25 ? "select" : "text";
    case "dropdown":
      return n <= 25 ? "select" : "text";
    case "checkbox":
      return n <= 10 ? "checkgroup" : n <= 25 ? "multiselect" : "text";
    default:
      return "text";
  }
}
export function numberHint(q) {
  const lo = q.min !== DEFAULT_MIN,
    hi = q.max !== DEFAULT_MAX;
  if (lo && hi) return `a number between ${q.min} and ${q.max}`;
  if (lo) return `a number, at least ${q.min}`;
  if (hi) return `a number, at most ${q.max}`;
  return "a number";
}
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
export function labelParts(q, extra = []) {
  const text = q.label;
  if (text.length <= 45) {
    const hints = [
      ...(typeof q.description === "string" && q.description
        ? [q.description]
        : []),
      ...(q.required ? [] : ["Optional"]),
      ...extra,
    ];
    return {
      label: text,
      ...(hints.length ? { description: clip(hints.join(" · "), 100) } : {}),
    };
  }
  return {
    label: text.slice(0, 44) + "…",
    description: clip("…" + text.slice(44), 100),
  };
}
const optionObjects = (q, selected, withDefault = true) =>
  q.options.map((o, idx) => ({
    value: String(idx),
    label: o.slice(0, 100),
    ...(withDefault && selected.includes(o) ? { default: true } : {}),
  }));
const asText = (raw) =>
  Array.isArray(raw) ? raw.join("\n") : raw === undefined ? "" : String(raw);
// One Label per question, so a step of up to five questions is a valid modal.
export function questionComponent(q, raw) {
  const w = widget(q),
    required = q.required !== false;
  const custom_id = q.id;
  let component, extra = [];
  if (w === "radio") {
    const options =
      q.type === "yes_no"
        ? [
            { value: "yes", label: "Yes", ...(raw === true ? { default: true } : {}) },
            { value: "no", label: "No", ...(raw === false ? { default: true } : {}) },
          ]
        : optionObjects(q, [raw]);
    component = { type: 21, custom_id, options, required };
  } else if (w === "select" || w === "multiselect") {
    const multi = w === "multiselect";
    const selected = multi ? (Array.isArray(raw) ? raw : []) : [raw];
    component = {
      type: 3,
      custom_id,
      options: optionObjects(q, selected),
      placeholder: multi ? "Select all that apply…" : "Select an option…",
      min_values: required ? 1 : 0,
      max_values: multi ? q.options.length : 1,
      required,
    };
    if (multi) extra = ["Select all that apply"];
  } else if (w === "checkgroup") {
    component = {
      type: 22,
      custom_id,
      options: optionObjects(q, Array.isArray(raw) ? raw : []),
      min_values: required ? 1 : 0,
      max_values: q.options.length,
      required,
    };
    extra = ["Select all that apply"];
  } else {
    // Text input: free text, number, date, Roblox username, or a choice list
    // longer than Discord's 25-option limit (answered by typing the exact option).
    const choice = ["multiple_choice", "dropdown", "checkbox"].includes(q.type);
    const long = q.type === "long_text" || (choice && q.type === "checkbox");
    const max =
      q.type === "number"
        ? 32
        : q.type === "date"
          ? 10
          : choice
            ? 4000
            : q.max_length;
    const min = q.type === "date" ? 10 : q.type === "roblox_username" ? 3 : 0;
    const hint =
      q.type === "number"
        ? `Enter ${numberHint(q)}`
        : q.type === "date"
          ? "YYYY-MM-DD"
          : q.type === "roblox_username"
            ? "3–20 letters, numbers or underscores"
            : choice
              ? q.type === "checkbox"
                ? "Type the exact options, one per line"
                : "Type one of the exact options"
              : "";
    component = {
      type: 4,
      custom_id,
      style: long ? 2 : 1,
      required,
      max_length: Math.max(1, max),
      ...(required && min ? { min_length: min } : {}),
      ...(hint ? { placeholder: hint.slice(0, 100) } : {}),
      ...(raw !== undefined && asText(raw)
        ? { value: asText(raw).slice(0, Math.max(1, max)) }
        : {}),
    };
    if (choice)
      extra = [
        `Options: ${q.options.join(", ")}`.slice(0, 100),
      ];
  }
  return { type: 18, ...labelParts(q, extra), component };
}
export function modalTitle(title, step, total) {
  if (total <= 1) return title.slice(0, 45);
  const suffix = ` • ${step + 1}/${total}`;
  return title.slice(0, 45 - suffix.length) + suffix;
}
export function buildModal({ user, formId, version, step, def, raw }) {
  const steps = stepsOf(def);
  return {
    type: 9,
    data: {
      custom_id: `astep:${user}:${formId}:${version}:${step}`,
      title: modalTitle(def.title, step, steps.length),
      components: steps[step].map((q) => questionComponent(q, raw[q.id])),
    },
  };
}
// Modal-submit payloads nest each answer in a Label (type 18); older action-row
// payloads are still understood.
export function flattenSubmitted(components = []) {
  const out = new Map();
  for (const c of components) {
    const inner = c.component
      ? [c.component]
      : Array.isArray(c.components)
        ? c.components
        : [c];
    for (const x of inner)
      if (typeof x?.custom_id === "string") out.set(x.custom_id, x);
  }
  return out;
}
const index = (q, v) => {
  if (!/^\d{1,2}$/.test(String(v)) || Number(v) >= q.options.length)
    throw new AppError(400, "invalid_choice");
  return q.options[Number(v)];
};
const matchOption = (q, text) => {
  const t = text.trim().toLowerCase();
  return q.options.find((o) => o.toLowerCase() === t) ?? text.trim();
};
// Raw answer for one question from its submitted component (undefined = unanswered).
export function rawFrom(q, c) {
  if (!c) return undefined;
  const w = widget(q);
  if (w === "text") {
    assert4(c);
    const v = String(c.value ?? "");
    if (q.type === "checkbox")
      return v
        .split(/\r?\n|,/)
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => matchOption(q, x));
    return ["multiple_choice", "dropdown"].includes(q.type)
      ? v.trim()
        ? matchOption(q, v)
        : undefined
      : v;
  }
  if (q.type === "yes_no") {
    if (c.type !== 21) throw new AppError(400, "invalid_component");
    return c.value === "yes" ? true : c.value === "no" ? false : undefined;
  }
  if (w === "radio") {
    if (c.type !== 21) throw new AppError(400, "invalid_component");
    return c.value == null ? undefined : index(q, c.value);
  }
  if (c.type !== 3 && c.type !== 22)
    throw new AppError(400, "invalid_component");
  const vals = Array.isArray(c.values) ? c.values : [];
  if (w === "select") return vals.length ? index(q, vals[0]) : undefined;
  return vals.map((v) => index(q, v));
}
function assert4(c) {
  if (c.type !== 4 && c.type !== undefined)
    throw new AppError(400, "invalid_component");
}
function candidate(q, r) {
  if (r === undefined || r === null) return undefined;
  if (typeof r === "string") {
    const t = r.trim();
    if (!t) return undefined;
    if (q.type === "number")
      return /^[-+]?(\d+\.?\d*|\.\d+)$/.test(t) ? Number(t) : t;
    return r;
  }
  return r;
}
function friendly(q, e) {
  switch (e.code) {
    case "required_answer":
      return "This question is required.";
    case "invalid_text":
      return `Use 1–${q.max_length ?? 4000} characters.`;
    case "invalid_roblox_username":
      return "Roblox usernames use 3–20 letters, numbers or underscores.";
    case "invalid_numeric_answer":
      return `Enter ${numberHint(q)}.`;
    case "invalid_date":
      return "Use the format YYYY-MM-DD, for example 2026-11-14.";
    case "invalid_choice":
      return "Choose only from the listed options.";
    case "invalid_boolean":
      return "Choose Yes or No.";
    default:
      return "This answer is not valid.";
  }
}
// Validates with the same rules used at final submission (utils/validation.js).
export function validateQuestions(questions, raw) {
  const values = {},
    errors = [];
  for (const q of questions) {
    const c = candidate(q, raw[q.id]);
    try {
      Object.assign(
        values,
        answers({ questions: [q] }, c === undefined ? {} : { [q.id]: c }),
      );
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      errors.push({ id: q.id, label: q.label, message: friendly(q, e) });
    }
  }
  return { values, errors };
}
export function display(q, raw) {
  if (raw === undefined || raw === null || raw === "" || raw?.length === 0)
    return "—";
  if (typeof raw === "boolean") return raw ? "Yes" : "No";
  if (Array.isArray(raw)) return raw.join(", ");
  return String(raw);
}
// First step (0-based) whose answers are not valid yet, or -1 when all are.
export function firstInvalidStep(def, raw) {
  const steps = stepsOf(def);
  for (let s = 0; s < steps.length; s++)
    if (validateQuestions(steps[s], raw).errors.length) return s;
  return -1;
}
