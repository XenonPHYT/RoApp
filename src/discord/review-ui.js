import { authorize } from "../modules/permissions.js";
import {
  reviewQueue,
  reviewDetail,
  decide,
  addNote,
  assign,
  TRANSITIONS,
} from "../modules/reviews.js";
import { message, embed, row, button, select, modal } from "./responses.js";
import { assert } from "../utils/helpers.js";
export const FILTERS = [
  ["pending", "Pending"],
  ["under_review", "Under Review"],
  ["awaiting_decision", "Awaiting Decision"],
  ["completed", "Completed"],
  ["mine", "My Assignments"],
  ["search", "Search"],
];
export async function queueUI(
  env,
  access,
  filter = "pending",
  page = 0,
  search = "",
) {
  const apps = await reviewQueue(env, access, filter, page, search),
    user = access.user_id;
  const components = [
    select(
      `queue:${user}`,
      FILTERS.map(([value, label]) => ({ value, label })),
    ),
  ];
  if (apps.length)
    components.push(
      select(
        `open:${user}`,
        apps
          .slice(0, 10)
          .map((a) => ({ label: `${a.id} — ${a.status}`, value: a.id })),
        "Open an application",
      ),
    );
  const paging = [];
  if (page > 0 && filter !== "search")
    paging.push(button("Previous", `page:${user}:${filter}:${page - 1}`));
  if (apps.length > 10 && filter !== "search")
    paging.push(button("Next", `page:${user}:${filter}:${page + 1}`));
  if (paging.length) components.push(row(...paging));
  return message("Private reviewer workspace", {
    embeds: [
      embed(
        "RoApp Review",
        `View: ${filter.replaceAll("_", " ")} • Page ${page + 1}\n` +
          apps
            .slice(0, 10)
            .map((a) => `${a.id} — ${a.status}`)
            .join("\n") +
          (apps.length ? "" : "No matching applications."),
      ),
    ],
    components,
  });
}
export async function detailUI(env, access, id, page = 0) {
  const a = await reviewDetail(env, access, id),
    user = access.user_id;
  assert(
    Number.isSafeInteger(page) &&
      page >= 0 &&
      page < Math.ceil(a.definition.questions.length / 5),
    400,
    "invalid_page",
  );
  const fields = a.definition.questions
    .slice(page * 5, page * 5 + 5)
    .map((q) => ({
      name: q.label.slice(0, 200),
      value: String(
        Array.isArray(a.answers[q.id])
          ? a.answers[q.id].join(", ")
          : (a.answers[q.id] ?? "Not answered"),
      ).slice(0, 650),
    }));
  const controls = [];
  if (
    access.permissions.includes("applications.assign") &&
    !["approved", "rejected", "withdrawn"].includes(a.status)
  ) {
    const mine = a.reviewers.some((r) => r.reviewer_id === user);
    controls.push(
      button(
        mine ? "Unassign me" : "Assign to me",
        `${mine ? "unassign" : "assign"}:${user}:${id}`,
      ),
    );
  }
  if (access.permissions.includes("applications.notes"))
    controls.push(button("Add internal note", `note:${user}:${id}`));
  if (page > 0)
    controls.push(
      button("Previous answers", `detail:${user}:${id}:${page - 1}`),
    );
  if ((page + 1) * 5 < a.definition.questions.length)
    controls.push(button("More answers", `detail:${user}:${id}:${page + 1}`));
  const components = controls.length ? [row(...controls)] : [];
  if (access.permissions.includes("applications.decide")) {
    const actions = (TRANSITIONS[a.status] || []).filter(
      (s) => !["pending", "withdrawn"].includes(s),
    );
    if (actions.length)
      components.push(
        row(
          ...actions.map((s) =>
            button(
              s.replaceAll("_", " "),
              `decision:${user}:${id}:${a.revision}:${s}`,
              s === "rejected" ? 4 : s === "approved" ? 3 : 2,
            ),
          ),
        ),
      );
  }
  components.push(
    select(
      `answerpick:${user}:${id}`,
      a.definition.questions.slice(page * 5, page * 5 + 5).map((q, n) => ({
        label: q.label.slice(0, 100),
        value: String(page * 5 + n),
      })),
      "Read a full answer",
    ),
  );
  components.push(
    row(
      ...(a.notes.length
        ? [button("Read internal notes", `notes:${user}:${id}:0`)]
        : []),
      button("Back to queue", `page:${user}:pending:0`),
    ),
  );
  const notes = a.notes
    .slice(0, 2)
    .map((n) => `Staff ${n.author_id}: ${n.body.slice(0, 300)}`)
    .join("\n");
  return message(`Private application ${id}`, {
    embeds: [
      embed(
        a.definition.title,
        `Applicant: ${a.applicant_id}\nStatus: ${a.status}\nAssigned: ${a.reviewers.map((r) => r.reviewer_id).join(", ") || "Unassigned"}\nPublic reason: ${a.decision_reason || "None"}\n${notes ? "Internal notes (latest two):\n" + notes : ""}`,
        fields,
      ),
    ],
    components,
  });
}
export async function reviewImmediate(i, env, parts) {
  const [kind, actor, id, revision, to] = parts;
  const user = i.member?.user?.id;
  if (!["note", "decision", "queue"].includes(kind) || i.type !== 3)
    return null;
  assert(actor === user, 403, "component_owner");
  const access = await authorize(env, i.guild_id, user, "applications.review", {
    timeout: 800,
  });
  if (kind === "queue") {
    assert(i.data.values?.length === 1, 400, "invalid_selection");
    if (i.data.values[0] !== "search") return null;
    return modal(`search:${user}`, "Search applications", [
      { id: "reference", label: "Application reference", max: 60 },
    ]);
  }
  if (kind === "note") {
    assert(
      access.permissions.includes("applications.notes"),
      403,
      "permission_denied",
    );
    await reviewDetail(env, access, id);
    return modal(`savenote:${user}:${id}`, "Internal reviewer note", [
      {
        id: "body",
        label: "Internal note (never sent to applicant)",
        long: true,
        max: 4000,
      },
    ]);
  }
  assert(
    access.permissions.includes("applications.decide"),
    403,
    "permission_denied",
  );
  const a = await reviewDetail(env, access, id);
  assert(
    a.revision === Number(revision) &&
      (TRANSITIONS[a.status] || []).includes(to) &&
      !["pending", "withdrawn"].includes(to),
    409,
    "stale_record",
  );
  return modal(
    `savedecision:${user}:${id}:${revision}:${to}`,
    "Confirm application decision",
    [
      {
        id: "reason",
        label: "Applicant-facing reason (not an internal note)",
        long: true,
        max: 1000,
        required: ["approved", "rejected", "revision_requested"].includes(to),
      },
    ],
  );
}
export async function reviewComponent(i, env, parts) {
  const [kind, actor, id, extra, to] = parts;
  const user = i.member?.user?.id;
  assert(actor === user, 403, "component_owner");
  const access = await authorize(env, i.guild_id, user, "applications.review");
  const values = Object.fromEntries(
    (i.data.components || []).flatMap((r) =>
      (r.components || []).map((c) => [c.custom_id, c.value]),
    ),
  );
  if (kind === "queue") {
    assert(i.data.values?.length === 1, 400, "invalid_selection");
    return queueUI(env, access, i.data.values[0]);
  }
  if (kind === "page") return queueUI(env, access, id, Number(extra));
  if (kind === "open") {
    assert(i.data.values?.length === 1, 400, "invalid_selection");
    return detailUI(env, access, i.data.values[0]);
  }
  if (kind === "detail") return detailUI(env, access, id, Number(extra));
  if (kind === "answerpick") {
    assert(i.data.values?.length === 1, 400, "invalid_selection");
    return fullAnswerUI(env, access, id, Number(i.data.values[0]), 0);
  }
  if (kind === "fullanswer") {
    const indexPage = (extra || "").split("_").map(Number);
    return fullAnswerUI(env, access, id, indexPage[0], indexPage[1]);
  }
  if (kind === "notes") {
    const detail = await reviewDetail(env, access, id),
      page = Number(extra),
      note = detail.notes[page];
    assert(
      Number.isSafeInteger(page) && page >= 0 && note,
      404,
      "note_not_found",
    );
    const buttons = [];
    if (page > 0)
      buttons.push(button("Newer note", `notes:${user}:${id}:${page - 1}`));
    if (page + 1 < detail.notes.length)
      buttons.push(button("Older note", `notes:${user}:${id}:${page + 1}`));
    buttons.push(button("Back to application", `detail:${user}:${id}:0`));
    return message("Private internal reviewer note", {
      embeds: [
        embed(`Internal note ${page + 1}`, note.body, [
          {
            name: "Author / time",
            value: note.author_id + " / " + note.created_at,
          },
        ]),
      ],
      components: [row(...buttons)],
    });
  }
  if (kind === "search" && i.type === 5)
    return queueUI(env, access, "search", 0, values.reference);
  if (kind === "savenote" && i.type === 5) {
    await addNote(env, access, id, values.body);
    return detailUI(env, access, id);
  }
  if (kind === "savedecision" && i.type === 5) {
    await decide(env, access, id, Number(extra), to, values.reason || "");
    return detailUI(env, access, id);
  }
  if (["assign", "unassign"].includes(kind)) {
    await assign(env, access, id, kind === "unassign");
    return detailUI(env, access, id);
  }
  assert(false, 400, "invalid_review_action");
}

export async function fullAnswerUI(env, access, id, index, page) {
  const a = await reviewDetail(env, access, id);
  assert(
    Number.isSafeInteger(index) &&
      index >= 0 &&
      index < a.definition.questions.length &&
      Number.isSafeInteger(page) &&
      page >= 0,
    400,
    "invalid_answer_page",
  );
  const q = a.definition.questions[index],
    raw = a.answers[q.id],
    value = Array.isArray(raw) ? raw.join(", ") : String(raw ?? "Not answered");
  assert(page * 3500 < Math.max(1, value.length), 400, "invalid_answer_page");
  const buttons = [];
  if (page > 0)
    buttons.push(
      button(
        "Previous part",
        `fullanswer:${access.user_id}:${id}:${index}_${page - 1}`,
      ),
    );
  if ((page + 1) * 3500 < value.length)
    buttons.push(
      button(
        "Next part",
        `fullanswer:${access.user_id}:${id}:${index}_${page + 1}`,
      ),
    );
  buttons.push(
    button("Back to application", `detail:${access.user_id}:${id}:0`),
  );
  return message("Private full application answer", {
    embeds: [embed(q.label, value.slice(page * 3500, (page + 1) * 3500))],
    components: [row(...buttons)],
  });
}
