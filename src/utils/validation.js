import { assert } from "./helpers.js";
export function snowflake(v) {
  assert(
    typeof v === "string" && /^\d{17,22}$/.test(v),
    400,
    "invalid_discord_id",
  );
  return v;
}
export function id(v) {
  assert(
    typeof v === "string" && /^[A-Za-z0-9_-]{1,60}$/.test(v),
    400,
    "invalid_id",
  );
  return v;
}
export function text(v, min = 0, max = 4000) {
  assert(
    typeof v === "string" && v.trim().length >= min && v.length <= max,
    400,
    "invalid_text",
    `Text must contain ${min}–${max} characters.`,
  );
  return v.trim();
}
export function integer(v, min, max) {
  assert(
    Number.isSafeInteger(v) && v >= min && v <= max,
    400,
    "invalid_number",
  );
  return v;
}
export const TYPES = [
  "short_text",
  "long_text",
  "multiple_choice",
  "dropdown",
  "checkbox",
  "yes_no",
  "number",
  "date",
  "roblox_username",
];
export function definition(input) {
  assert(
    input && typeof input === "object" && !Array.isArray(input),
    400,
    "invalid_form",
  );
  const out = {
    title: text(input.title, 1, 100),
    description: text(input.description || "", 0, 2000),
    instructions: text(input.instructions || "", 0, 4000),
    requirements: text(input.requirements || "", 0, 2000),
    questions: [],
  };
  assert(
    Array.isArray(input.questions) &&
      input.questions.length >= 1 &&
      input.questions.length <= 30,
    400,
    "invalid_questions",
  );
  const seen = new Set();
  for (const q of input.questions) {
    assert(q && typeof q === "object", 400, "invalid_question");
    const key = id(q.id);
    assert(
      !["__proto__", "constructor", "prototype"].includes(key),
      400,
      "reserved_question_id",
    );
    assert(!seen.has(key), 400, "duplicate_question_id");
    seen.add(key);
    assert(TYPES.includes(q.type), 400, "invalid_field_type");
    const field = {
      id: key,
      type: q.type,
      label: text(q.label, 1, 200),
      required: q.required !== false,
    };
    if (["short_text", "long_text", "roblox_username"].includes(q.type))
      field.max_length = integer(
        q.max_length ??
          (q.type === "short_text"
            ? 300
            : q.type === "roblox_username"
              ? 20
              : 4000),
        1,
        q.type === "roblox_username" ? 20 : 4000,
      );
    if (["multiple_choice", "dropdown", "checkbox"].includes(q.type)) {
      assert(
        Array.isArray(q.options) &&
          q.options.length >= 1 &&
          q.options.length <= 25,
        400,
        "invalid_options",
      );
      field.options = q.options.map((o) => text(o, 1, 100));
      assert(
        new Set(field.options).size === field.options.length,
        400,
        "duplicate_options",
      );
    }
    if (q.type === "number") {
      field.min = q.min ?? -1000000000;
      field.max = q.max ?? 1000000000;
      assert(
        Number.isFinite(field.min) &&
          Number.isFinite(field.max) &&
          field.min <= field.max,
        400,
        "invalid_range",
      );
    }
    out.questions.push(field);
  }
  return out;
}
export function answers(def, input) {
  assert(
    input && typeof input === "object" && !Array.isArray(input),
    400,
    "invalid_answers",
  );
  assert(
    Object.keys(input).every((k) => def.questions.some((q) => q.id === k)),
    400,
    "unknown_answer",
  );
  const out = {};
  for (const q of def.questions) {
    let v = Object.hasOwn(input, q.id) ? input[q.id] : undefined;
    const absent =
      v === undefined ||
      v === null ||
      v === "" ||
      (Array.isArray(v) && v.length === 0);
    if (absent) {
      assert(!q.required, 400, "required_answer", `${q.label} is required.`);
      continue;
    }
    if (["short_text", "long_text", "roblox_username"].includes(q.type)) {
      v = text(v, 1, q.max_length);
      if (q.type === "roblox_username")
        assert(/^[A-Za-z0-9_]{3,20}$/.test(v), 400, "invalid_roblox_username");
    } else if (q.type === "yes_no")
      assert(typeof v === "boolean", 400, "invalid_boolean");
    else if (q.type === "number")
      assert(
        typeof v === "number" && Number.isFinite(v) && v >= q.min && v <= q.max,
        400,
        "invalid_numeric_answer",
      );
    else if (q.type === "date") {
      assert(
        typeof v === "string" &&
          /^\d{4}-\d{2}-\d{2}$/.test(v) &&
          !Number.isNaN(Date.parse(v)) &&
          new Date(v).toISOString().slice(0, 10) === v,
        400,
        "invalid_date",
      );
    } else if (q.type === "checkbox") {
      assert(
        Array.isArray(v) &&
          v.every((o) => q.options.includes(o)) &&
          new Set(v).size === v.length &&
          v.length <= q.options.length,
        400,
        "invalid_choice",
      );
    } else
      assert(
        typeof v === "string" && q.options.includes(v),
        400,
        "invalid_choice",
      );
    out[q.id] = v;
  }
  return out;
}
