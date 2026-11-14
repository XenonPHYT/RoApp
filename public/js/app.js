const $ = (s) => document.querySelector(s);
const state = {
  session: null,
  guilds: [],
  context: null,
  tab: "overview",
  applicantGuild: null,
};
const main = $("#main");
function mount(...nodes) {
  main.replaceChildren(
    ...nodes.flat(Infinity).filter((n) => n !== null && n !== undefined),
  );
}
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (
      k === "checked" ||
      k === "disabled" ||
      k === "required" ||
      k === "hidden"
    )
      n[k] = !!v;
    else if (v !== undefined && v !== null) n.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c !== null && c !== undefined)
      n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
}
function notify(text, error = false) {
  const n = $("#notice");
  n.textContent = text;
  n.className = error ? "error" : "";
  n.hidden = false;
}
function task(fn) {
  return async (e) => {
    try {
      await fn(e);
    } catch (err) {
      notify(err.message || "Something went wrong.", true);
    }
  };
}
function btn(label, fn, cls = "", attrs = {}) {
  return el(
    "button",
    {
      type: "button",
      class: cls,
      ...attrs,
      onclick: task(async (e) => {
        const b = e.currentTarget;
        b.disabled = true;
        try {
          await fn(e);
        } finally {
          b.disabled = false;
        }
      }),
    },
    label,
  );
}
function field(label, control, hint = "") {
  const key = control.id || `field-${crypto.randomUUID()}`;
  control.id = key;
  return el(
    "div",
    { class: "field" },
    el("label", { for: key }, label),
    control,
    hint ? el("small", { class: "muted" }, hint) : null,
  );
}
function input(value = "", attrs = {}) {
  const n = el("input", { type: "text", ...attrs });
  n.value = value;
  return n;
}
function area(value = "", attrs = {}) {
  const n = el("textarea", attrs);
  n.value = value;
  return n;
}
function choose(options, value = "", attrs = {}) {
  const n = el(
    "select",
    attrs,
    ...options.map((o) =>
      el(
        "option",
        { value: typeof o === "string" ? o : o.value },
        typeof o === "string" ? o : o.label,
      ),
    ),
  );
  n.value = value;
  return n;
}
function check(label, value = false) {
  const n = el("input", { type: "checkbox", checked: value });
  return { input: n, node: el("label", { class: "check" }, n, label) };
}
const actions = (...nodes) => el("div", { class: "actions" }, nodes);
const card = (...nodes) => el("section", { class: "card" }, nodes);
const pill = (s) => el("span", { class: "pill" }, s.replaceAll("_", " "));
const date = (s) => new Date(s).toLocaleString();
function heading(title, desc = "") {
  return el(
    "div",
    { class: "section-head" },
    el(
      "div",
      {},
      el("p", { class: "eyebrow" }, "ROAPP / " + state.tab.toUpperCase()),
      el("h1", {}, title),
      desc ? el("p", { class: "muted" }, desc) : null,
    ),
  );
}
function empty(text) {
  return el("div", { class: "empty" }, text);
}
function has(permission) {
  return !!state.context?.access.permissions.includes(permission);
}
async function api(path, method = "GET", body) {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(method !== "GET"
        ? { "X-CSRF-Token": state.session?.csrf || "" }
        : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error("The server returned an invalid response.");
  }
  if (!res.ok) {
    const err = new Error(data.message || data.error || "Request failed");
    err.status = res.status;
    throw err;
  }
  return data;
}
const manage = (path, method = "GET", body) =>
  api("/api/manage/" + path, method, body);
const applicant = (guild, path, method = "GET", body) =>
  api(`/api/applicant/${encodeURIComponent(guild)}/${path}`, method, body);
function table(headers, rows) {
  return el(
    "div",
    { class: "table-wrap" },
    el(
      "table",
      {},
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          headers.map((h) => el("th", { scope: "col" }, h)),
        ),
      ),
      el(
        "tbody",
        {},
        rows.map((r) =>
          el(
            "tr",
            {},
            r.map((c) => el("td", {}, c)),
          ),
        ),
      ),
    ),
  );
}
async function loadContext() {
  state.context = await manage("context");
  renderNav();
}
function renderNav() {
  const nav = $("#nav");
  nav.replaceChildren();
  const tabs = [
    ["overview", "Overview", null],
    ["forms", "Form builder", "forms.manage"],
    ["applications", "Applications", "applications.review"],
    ["staff", "Staff & permissions", "staff.manage"],
    ["panels", "Public panels", "panels.manage"],
    ["settings", "Community settings", "settings.manage"],
    ["audit", "Audit history", "audit.view"],
  ];
  for (const [key, label, permission] of tabs) {
    if (!permission || has(permission))
      nav.append(
        btn(label, () => showTab(key), state.tab === key ? "active" : ""),
      );
  }
  nav.append(btn("My applications", () => showApplicant()));
}
async function showTab(tab) {
  state.tab = tab;
  renderNav();
  mount(el("p", { class: "loading" }, "Loading…"));
  const handlers = {
    overview,
    forms: formList,
    applications: () => applicationList(),
    staff: staffUI,
    panels: panelList,
    settings: settingsUI,
    audit: () => auditUI(),
  };
  try {
    await handlers[tab]();
  } catch (e) {
    mount(
      heading("Unable to load this section"),
      empty(e.message),
      btn("Retry", () => showTab(tab)),
    );
    throw e;
  }
}
async function overview() {
  const data = await manage("overview");
  const sum = data.statuses.reduce((n, s) => n + s.total, 0);
  const count = (key) =>
    data.statuses.find((s) => s.status === key)?.total || 0;
  mount(
    heading(
      state.context.name,
      "A clear view of your community’s application workflow.",
    ),
    el(
      "div",
      { class: "stats" },
      [
        ["Total applications", sum],
        ["Pending", count("pending")],
        ["Under review", count("under_review")],
        ["Open forms", data.open_forms],
      ].map(([title, n]) =>
        el(
          "div",
          { class: "stat" },
          el("span", { class: "muted" }, title),
          el("strong", {}, n),
        ),
      ),
    ),
    card(
      el("h2", {}, "Community workflow"),
      el(
        "p",
        {},
        "Publish a versioned form, connect it to a Discord panel, and review submissions privately.",
      ),
      actions(
        has("forms.manage")
          ? btn("Manage forms", () => showTab("forms"), "primary")
          : null,
        has("applications.review")
          ? btn("Open review queue", () => showTab("applications"))
          : null,
        btn("Applicant portal", () => showApplicant(state.context.guild_id)),
      ),
    ),
    card(
      el("h2", {}, "Application states"),
      data.statuses.length
        ? table(
            ["State", "Applications"],
            data.statuses.map((s) => [pill(s.status), s.total]),
          )
        : empty("Applications will appear here after the first submission."),
    ),
  );
}
async function formList() {
  const forms = await manage("forms");
  mount(
    heading(
      "Form builder",
      "Saved drafts are separate from immutable published versions.",
    ),
    actions(btn("Create a form", () => formEditor(), "primary")),
    forms.length
      ? el(
          "div",
          { class: "grid" },
          forms.map((f) =>
            card(
              el("h2", {}, f.draft.title),
              pill(f.status),
              el(
                "p",
                { class: "muted" },
                `${f.draft.questions.length} questions · Published version ${f.version}`,
              ),
              el("p", { class: "code" }, f.id),
              actions(
                btn("Edit draft", () => formEditor(f)),
                btn(
                  "Publish draft",
                  async () => {
                    if (
                      confirm(
                        "Publish a new version and open submissions? Existing applications retain their original version.",
                      )
                    ) {
                      await manage(`forms/${f.id}/publish`, "POST", {});
                      notify(
                        "New form version published. Update existing Discord panels to refresh their display.",
                      );
                      await formList();
                    }
                  },
                  "primary",
                ),
                f.status === "open"
                  ? btn("Close", async () => {
                      if (confirm("Close this form to new submissions?")) {
                        await manage(`forms/${f.id}/close`, "POST", {});
                        await formList();
                      }
                    })
                  : null,
              ),
            ),
          ),
        )
      : empty("Create your first form to start receiving applications."),
  );
}
const TYPES = [
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
function formEditor(existing = null) {
  const draft = structuredClone(
    existing?.draft || {
      title: "",
      description: "",
      instructions: "",
      requirements: "",
      questions: [
        {
          id: crypto.randomUUID().slice(0, 8),
          label: "",
          type: "short_text",
          required: true,
          max_length: 300,
        },
      ],
    },
  );
  let cooldown = existing?.cooldown_seconds || 0,
    duplicates = !!existing?.allow_duplicates;
  const shell = el("div", { class: "wide" });
  const title = input(draft.title, {
      maxlength: 100,
      required: true,
      oninput: (e) => (draft.title = e.target.value),
    }),
    description = area(draft.description, {
      maxlength: 2000,
      oninput: (e) => (draft.description = e.target.value),
    }),
    instructions = area(draft.instructions, {
      maxlength: 4000,
      oninput: (e) => (draft.instructions = e.target.value),
    }),
    requirements = area(draft.requirements, {
      maxlength: 2000,
      oninput: (e) => (draft.requirements = e.target.value),
    });
  const cd = input(cooldown, {
    type: "number",
    min: 0,
    max: 31536000,
    oninput: (e) => (cooldown = Number(e.target.value)),
  });
  const dupe = check(
    "Allow multiple active applications for this form",
    duplicates,
  );
  dupe.input.addEventListener(
    "change",
    () => (duplicates = dupe.input.checked),
  );
  const questions = el("div");
  function drawQuestions() {
    questions.replaceChildren();
    draft.questions.forEach((q, index) => {
      const label = input(q.label, {
        maxlength: 200,
        required: true,
        oninput: (e) => (q.label = e.target.value),
      });
      const type = choose(TYPES, q.type, {
        onchange: (e) => {
          q.type = e.target.value;
          if (["multiple_choice", "dropdown", "checkbox"].includes(q.type))
            q.options = q.options || ["Option 1"];
          if (["short_text", "long_text", "roblox_username"].includes(q.type))
            q.max_length =
              q.type === "roblox_username"
                ? 20
                : q.type === "long_text"
                  ? 4000
                  : 300;
          drawQuestions();
        },
      });
      const req = check("Required question", q.required !== false);
      req.input.addEventListener(
        "change",
        () => (q.required = req.input.checked),
      );
      const details = [];
      if (["short_text", "long_text", "roblox_username"].includes(q.type))
        details.push(
          field(
            "Maximum characters",
            input(q.max_length || 300, {
              type: "number",
              min: 1,
              max: q.type === "roblox_username" ? 20 : 4000,
              oninput: (e) => (q.max_length = Number(e.target.value)),
            }),
          ),
        );
      if (["multiple_choice", "dropdown", "checkbox"].includes(q.type))
        details.push(
          field(
            "Choices — one per line",
            area((q.options || []).join("\n"), {
              oninput: (e) =>
                (q.options = e.target.value
                  .split("\n")
                  .map((s) => s.trim())
                  .filter(Boolean)),
            }),
            "Between 1 and 25 distinct choices.",
          ),
        );
      if (q.type === "number")
        details.push(
          el(
            "div",
            { class: "two" },
            field(
              "Minimum",
              input(q.min ?? -1000000000, {
                type: "number",
                oninput: (e) => (q.min = Number(e.target.value)),
              }),
            ),
            field(
              "Maximum",
              input(q.max ?? 1000000000, {
                type: "number",
                oninput: (e) => (q.max = Number(e.target.value)),
              }),
            ),
          ),
        );
      questions.append(
        card(
          el(
            "div",
            { class: "question-head" },
            el("h3", {}, `Question ${index + 1}`),
            actions(
              index > 0
                ? btn("Move up", () => {
                    [draft.questions[index - 1], draft.questions[index]] = [
                      q,
                      draft.questions[index - 1],
                    ];
                    drawQuestions();
                  })
                : null,
              index < draft.questions.length - 1
                ? btn("Move down", () => {
                    [draft.questions[index + 1], draft.questions[index]] = [
                      q,
                      draft.questions[index + 1],
                    ];
                    drawQuestions();
                  })
                : null,
              draft.questions.length > 1
                ? btn(
                    "Remove",
                    () => {
                      draft.questions.splice(index, 1);
                      drawQuestions();
                    },
                    "danger",
                  )
                : null,
            ),
          ),
          field("Question label", label),
          field("Field type", type),
          req.node,
          details,
        ),
      );
    });
  }
  drawQuestions();
  const editor = el(
    "form",
    {
      onsubmit: task(async (e) => {
        e.preventDefault();
        const save = e.submitter;
        save.disabled = true;
        try {
          const saved = await manage(
            existing ? `forms/${existing.id}` : "forms",
            existing ? "PUT" : "POST",
            {
              definition: draft,
              cooldown_seconds: cooldown,
              allow_duplicates: duplicates,
              edit_revision: existing?.edit_revision,
            },
          );
          notify(
            "Draft saved. Publish it when you are ready to open submissions.",
          );
          await formList();
          return saved;
        } finally {
          save.disabled = false;
        }
      }),
    },
    card(
      field("Form title", title),
      field("Description", description),
      field("Instructions", instructions),
      field("Requirements", requirements),
      field("Submission cooldown (seconds)", cd),
      dupe.node,
    ),
    el("h2", {}, "Questions"),
    questions,
    actions(
      btn("Add question", () => {
        if (draft.questions.length >= 30)
          throw new Error("A form supports up to 30 questions.");
        draft.questions.push({
          id: crypto.randomUUID().slice(0, 8),
          type: "short_text",
          label: "",
          required: true,
          max_length: 300,
        });
        drawQuestions();
      }),
      el("button", { type: "submit", class: "primary" }, "Save draft"),
      btn("Cancel", () => formList()),
    ),
  );
  shell.append(editor);
  mount(
    heading(
      existing ? "Edit form draft" : "Create a form",
      "Question order and field validation are enforced on submission.",
    ),
    shell,
  );
}
const FILTERS = [
  ["pending", "Pending"],
  ["under_review", "Under Review"],
  ["awaiting_decision", "Awaiting Decision"],
  ["interview", "Interview"],
  ["revision_requested", "Revision Requested"],
  ["completed", "Completed"],
  ["mine", "My Assignments"],
  ["search", "Search"],
];
async function applicationList(filter = "pending", page = 0, search = "") {
  const data = await manage(
    `applications?filter=${encodeURIComponent(filter)}&page=${page}&search=${encodeURIComponent(search)}`,
  );
  const selector = choose(
    FILTERS.map(([value, label]) => ({ value, label })),
    filter,
    { onchange: task((e) => applicationList(e.target.value)) },
  );
  const searchInput = input(search, {
    placeholder: "APP-2026-…",
    "aria-label": "Exact application reference",
  });
  const searchForm = el(
    "form",
    {
      onsubmit: task(async (e) => {
        e.preventDefault();
        await applicationList("search", 0, searchInput.value);
      }),
    },
    actions(searchInput, el("button", { type: "submit" }, "Find reference")),
  );
  mount(
    heading(
      "Applications",
      "Private answers and reviewer tools. All actions are permission-checked.",
    ),
    field("Queue view", selector),
    searchForm,
    data.items.length
      ? table(
          ["Reference", "Applicant", "Status", "Submitted", "Action"],
          data.items.map((a) => [
            el("span", { class: "code" }, a.id),
            a.applicant_id,
            pill(a.status),
            date(a.created_at),
            btn("Open", () => applicationDetail(a.id)),
          ]),
        )
      : empty("No applications match this view."),
    actions(
      page > 0
        ? btn("Previous", () => applicationList(filter, page - 1, search))
        : null,
      el("span", { class: "muted" }, `Page ${page + 1}`),
      data.has_more
        ? btn("Next", () => applicationList(filter, page + 1, search))
        : null,
    ),
  );
}
function answerContent(a) {
  return a.definition.questions.map((q) =>
    el(
      "section",
      {},
      el("h3", {}, q.label),
      el(
        "div",
        { class: "answer" },
        Array.isArray(a.answers[q.id])
          ? a.answers[q.id].join(", ")
          : String(a.answers[q.id] ?? "Not answered"),
      ),
    ),
  );
}
const NEXT = {
  pending: ["under_review"],
  under_review: ["interview", "revision_requested", "approved", "rejected"],
  interview: ["under_review", "revision_requested", "approved", "rejected"],
};
async function applicationDetail(id) {
  const a = await manage(`applications/${id}`);
  const statusCard = card(
    el("h2", {}, a.definition.title),
    pill(a.status),
    el(
      "p",
      { class: "muted" },
      `Applicant ${a.applicant_id} · ${date(a.created_at)} · Form version ${a.form_version}`,
    ),
    el(
      "p",
      {},
      "Assigned: " +
        (a.reviewers.map((r) => r.reviewer_id).join(", ") || "Unassigned"),
    ),
    el("p", {}, "Applicant-facing reason: " + (a.decision_reason || "None")),
  );
  if (
    has("applications.assign") &&
    !["approved", "rejected", "withdrawn"].includes(a.status)
  ) {
    const mine = a.reviewers.some(
      (r) => r.reviewer_id === state.session.user.id,
    );
    statusCard.append(
      btn(mine ? "Unassign me" : "Assign to me", async () => {
        await manage(`applications/${id}/assign`, "POST", { remove: mine });
        await applicationDetail(id);
      }),
    );
  }
  const reviewActions = [];
  if (has("applications.decide") && NEXT[a.status]?.length) {
    const target = choose(NEXT[a.status], NEXT[a.status][0]);
    const reason = area("", { maxlength: 1000 });
    reviewActions.push(
      card(
        el("h2", {}, "Update application state"),
        el(
          "form",
          {
            onsubmit: task(async (e) => {
              e.preventDefault();
              if (
                !confirm(
                  `Confirm ${target.value.replaceAll("_", " ")}? The reason is visible to the applicant.`,
                )
              )
                return;
              await manage(`applications/${id}/decision`, "POST", {
                status: target.value,
                reason: reason.value,
                revision: a.revision,
              });
              notify(
                "Application updated. A private applicant notification has been queued.",
              );
              await applicationDetail(id);
            }),
          },
          field("New state", target),
          field(
            "Applicant-facing reason",
            reason,
            "Required for approval, rejection, or revision request. Never enter internal notes here.",
          ),
          el(
            "button",
            { type: "submit", class: "primary" },
            "Confirm state change",
          ),
        ),
      ),
    );
  }
  const notes = card(
    el("h2", {}, "Internal reviewer notes"),
    el(
      "p",
      { class: "muted" },
      "Only authorized reviewers can access these notes. They are never included in applicant notifications.",
    ),
    a.notes.length
      ? a.notes.map((n) =>
          el(
            "div",
            { class: "card inset" },
            el(
              "small",
              { class: "muted" },
              `${n.author_id} · ${date(n.created_at)}`,
            ),
            el("p", { class: "answer" }, n.body),
          ),
        )
      : el("p", { class: "muted" }, "No notes yet."),
  );
  if (has("applications.notes")) {
    const body = area("", { required: true, maxlength: 4000 });
    notes.append(
      el(
        "form",
        {
          onsubmit: task(async (e) => {
            e.preventDefault();
            await manage(`applications/${id}/notes`, "POST", {
              body: body.value,
            });
            await applicationDetail(id);
          }),
        },
        field("Add internal note", body),
        el("button", { type: "submit" }, "Save internal note"),
      ),
    );
  }
  const history = card(
    el("h2", {}, "Review history"),
    a.events.map((event) =>
      el(
        "div",
        { class: "card inset" },
        el(
          "p",
          {},
          `${date(event.created_at)} · ${event.actor_id} · ${event.kind}`,
        ),
        el("pre", {}, JSON.stringify(JSON.parse(event.data_json), null, 2)),
      ),
    ),
  );
  mount(
    heading(id),
    actions(btn("Back to applications", () => applicationList())),
    statusCard,
    card(el("h2", {}, "Applicant answers"), answerContent(a)),
    robloxCard(a, () => applicationDetail(id), false),
    reviewActions,
    notes,
    history,
  );
}
function robloxCard(a, reload, own) {
  if (!a.roblox_username) return null;
  return card(
    el("h2", {}, "Roblox account lookup"),
    el(
      "p",
      {},
      `${a.roblox_username}${a.roblox_user_id ? " · User ID " + a.roblox_user_id : ""}`,
    ),
    el(
      "p",
      { class: "warning" },
      "Ownership is not verified. A public lookup only confirms an account exists.",
    ),
    btn(
      a.roblox_user_id ? "Refresh username lookup" : "Resolve username",
      async () => {
        const path = `applications/${a.id}/roblox`;
        const result = own
          ? await applicant(a.guild_id, path, "POST", {})
          : await manage(path, "POST", {});
        notify(result.message);
        await reload();
      },
    ),
  );
}
async function staffUI() {
  const data = await manage("staff");
  const role = choose([
    { value: "", label: "Select a Discord role" },
    ...data.roles.map((r) => ({ value: r.id, label: r.name })),
  ]);
  const dashboard = check("Grant RoApp dashboard access", false);
  dashboard.input.disabled = !state.context.access.owner;
  const controls = state.context.permission_types.map((p) => ({
    permission: p,
    ...check(p, false),
  }));
  const form = el(
    "form",
    {
      onsubmit: task(async (e) => {
        e.preventDefault();
        await manage("staff", "PUT", {
          role_id: role.value,
          dashboard: dashboard.input.checked,
          permissions: controls
            .filter((c) => c.input.checked)
            .map((c) => c.permission),
        });
        notify(
          "Role access saved. Permissions are checked again on the next request.",
        );
        await staffUI();
      }),
    },
    field("Role", role),
    dashboard.node,
    el(
      "p",
      { class: "muted small" },
      "Administrator does not grant RoApp access. Only the owner can grant dashboard access.",
    ),
    el(
      "div",
      { class: "grid" },
      controls.map((c) => c.node),
    ),
    el("button", { type: "submit", class: "primary" }, "Save role access"),
  );
  role.addEventListener("change", () => {
    const existing = data.assignments.find((a) => a.role_id === role.value);
    dashboard.input.checked = !!existing?.dashboard;
    const permissions = existing ? JSON.parse(existing.permissions_json) : [];
    for (const c of controls)
      c.input.checked = permissions.includes(c.permission);
  });
  mount(
    heading(
      "Staff & permissions",
      "Assign only the permissions each role needs.",
    ),
    card(el("h2", {}, "Role access policy"), form),
    card(
      el("h2", {}, "Configured roles"),
      data.assignments.length
        ? table(
            ["Role", "Dashboard", "Permissions", "Action"],
            data.assignments.map((a) => [
              data.roles.find((r) => r.id === a.role_id)?.name || a.role_id,
              a.dashboard ? "Yes" : "No",
              JSON.parse(a.permissions_json).join(", ") || "None",
              btn(
                "Remove",
                async () => {
                  if (confirm("Remove this role’s RoApp access?")) {
                    await manage(`staff/${a.role_id}`, "DELETE", {
                      confirm: a.role_id,
                    });
                    await staffUI();
                  }
                },
                "danger",
              ),
            ]),
          )
        : empty(
            "Only the current server owner has access until roles are configured.",
          ),
    ),
  );
}
async function panelList() {
  const data = await manage("panels");
  mount(
    heading(
      "Public application panels",
      "Persistent Discord messages. Publishing an existing panel updates its stored message.",
    ),
    actions(
      btn("Create panel", () => panelEditor(null, data.forms), "primary"),
    ),
    data.panels.length
      ? el(
          "div",
          { class: "grid" },
          data.panels.map((p) => {
            const cfg = JSON.parse(p.config_json);
            return card(
              el("h2", {}, cfg.title),
              el("p", { class: "code" }, p.id),
              el(
                "p",
                { class: "muted" },
                `Channel ${p.channel_id} · ${p.message_id ? "Published" : "Not published"}`,
              ),
              actions(
                btn("Edit", () => panelEditor(p, data.forms)),
                btn(
                  "Publish / update",
                  async () => {
                    await manage(`panels/${p.id}/publish`, "POST", {});
                    notify("Panel message published or updated.");
                    await panelList();
                  },
                  "primary",
                ),
                btn(
                  "Remove",
                  async () => {
                    if (confirm("Delete this panel and its Discord message?")) {
                      await manage(`panels/${p.id}`, "DELETE", {
                        confirm: p.id,
                      });
                      await panelList();
                    }
                  },
                  "danger",
                ),
              ),
            );
          }),
        )
      : empty("Create a panel after publishing at least one form."),
  );
}
function panelEditor(existing, forms) {
  const cfg = existing
    ? JSON.parse(existing.config_json)
    : {
        title: "Community applications",
        description: "Choose an open application to begin.",
        form_ids: [],
      };
  const title = input(cfg.title, { required: true, maxlength: 100 }),
    description = area(cfg.description, { maxlength: 2000 }),
    channel = input(existing?.channel_id || "", {
      required: true,
      pattern: "[0-9]{17,22}",
      readonly: existing ? "" : undefined,
    });
  const checks = forms.map((f) => ({
    id: f.id,
    ...check(`${f.title} (${f.status})`, cfg.form_ids.includes(f.id)),
  }));
  const form = el(
    "form",
    {
      onsubmit: task(async (e) => {
        e.preventDefault();
        await manage(
          existing ? `panels/${existing.id}` : "panels",
          existing ? "PUT" : "POST",
          {
            title: title.value,
            description: description.value,
            channel_id: channel.value,
            form_ids: checks.filter((c) => c.input.checked).map((c) => c.id),
          },
        );
        notify(
          "Panel configuration saved. Use Publish / update to send it to Discord.",
        );
        await panelList();
      }),
    },
    field("Panel title", title),
    field("Description", description),
    field(
      "Discord channel ID",
      channel,
      "Enable Discord Developer Mode to copy a text channel ID. The server verifies channel ownership.",
    ),
    el("h3", {}, "Forms to include (up to 25)"),
    checks.map((c) => c.node),
    actions(
      el("button", { type: "submit", class: "primary" }, "Save panel"),
      btn("Cancel", () => panelList()),
    ),
  );
  mount(heading(existing ? "Edit panel" : "Create panel"), card(form));
}
async function settingsUI() {
  await loadContext();
  const s = state.context.settings,
    n = check(
      "Send applicant status updates through Discord DMs",
      s.notifications,
    ),
    m = check("Allow multiple reviewers per application", s.multiple_reviewers);
  const jobs = await manage("notifications");
  mount(
    heading("Community settings"),
    card(
      el(
        "form",
        {
          onsubmit: task(async (e) => {
            e.preventDefault();
            await manage("settings", "PUT", {
              notifications: n.input.checked,
              multiple_reviewers: m.input.checked,
            });
            notify("Community settings saved.");
            await settingsUI();
          }),
        },
        n.node,
        m.node,
        el("button", { type: "submit", class: "primary" }, "Save settings"),
      ),
    ),
    card(
      el("h2", {}, "Notification delivery"),
      el(
        "p",
        { class: "muted" },
        "Pending jobs are processed every five minutes. DMs may fail when an applicant blocks the bot or disables messages. The applicant portal remains the source of truth.",
      ),
      jobs.length
        ? table(
            ["Application", "Status", "Attempts", "Error", "Action"],
            jobs.map((j) => [
              j.application_id,
              j.status,
              j.attempts,
              j.last_error || "—",
              j.status === "failed"
                ? btn("Retry", async () => {
                    if (confirm("Retry this failed notification?")) {
                      await manage(`notifications/${j.id}`, "POST", {
                        confirm: String(j.id),
                      });
                      await settingsUI();
                    }
                  })
                : "Scheduled",
            ]),
          )
        : empty("No pending or failed notifications."),
    ),
  );
}
async function auditUI(before = "") {
  const rows = await manage("audit" + (before ? "?before=" + before : ""));
  mount(
    heading(
      "Audit history",
      "UTC storage; times below are displayed in your browser’s local timezone.",
    ),
    rows.length
      ? table(
          ["Time", "Actor", "Action", "Target"],
          rows.map((r) => [
            date(r.created_at),
            r.actor_id,
            r.action,
            r.target_id,
          ]),
        )
      : empty("No audit entries."),
    actions(
      before ? btn("Newest entries", () => auditUI()) : null,
      rows.length === 50
        ? btn("Older entries", () => auditUI(rows.at(-1).id))
        : null,
    ),
  );
}
function applicantHeader(guild) {
  const selector = choose(
    [
      { value: "", label: "Choose a community" },
      ...state.guilds.map((g) => ({ value: g.guild_id, label: g.name })),
    ],
    guild || "",
    { onchange: task((e) => showApplicant(e.target.value)) },
  );
  return card(
    field("Applicant community", selector),
    el(
      "p",
      { class: "muted small" },
      "Applicant access does not grant community management permissions.",
    ),
  );
}
async function showApplicant(guild = state.applicantGuild) {
  state.tab = "applicant";
  renderNav();
  state.applicantGuild = guild || null;
  mount(
    heading(
      "My applications",
      "Apply, track your status, or respond to a revision request.",
    ),
    applicantHeader(guild),
  );
  if (!guild) return;
  const [forms, apps] = await Promise.all([
    applicant(guild, "forms"),
    applicant(guild, "applications"),
  ]);
  main.append(
    card(
      el("h2", {}, "Open applications"),
      forms.length
        ? el(
            "div",
            { class: "grid" },
            forms.map((f) =>
              card(
                el("h3", {}, f.title),
                el("p", { class: "muted" }, f.description),
                btn("Apply", () => webApplication(guild, f.id), "primary"),
              ),
            ),
          )
        : empty("No forms are open."),
    ),
    card(
      el("h2", {}, "Your submissions"),
      apps.length
        ? table(
            ["Reference", "Status", "Updated", "Action"],
            apps.map((a) => [
              a.id,
              pill(a.status),
              date(a.updated_at),
              btn("View", () => ownDetail(guild, a.id)),
            ]),
          )
        : empty("You have not submitted an application in this community."),
    ),
  );
}
function answerForm(def, current = {}) {
  const controls = [];
  const node = el("div");
  for (const q of def.questions) {
    let control, read;
    if (q.type === "checkbox") {
      const list = q.options.map((value) => ({
        value,
        ...check(value, (current[q.id] || []).includes(value)),
      }));
      control = el(
        "fieldset",
        {},
        el("legend", {}, q.label + (q.required ? " *" : "")),
        list.map((c) => c.node),
      );
      read = () => list.filter((c) => c.input.checked).map((c) => c.value);
      node.append(el("div", { class: "field" }, control));
    } else {
      if (q.type === "yes_no") {
        control = choose(
          [
            { value: "", label: "Choose…" },
            { value: "true", label: "Yes" },
            { value: "false", label: "No" },
          ],
          current[q.id] === undefined ? "" : String(current[q.id]),
          { required: q.required },
        );
        read = () =>
          control.value === "" ? undefined : control.value === "true";
      } else if (["multiple_choice", "dropdown"].includes(q.type)) {
        control = choose(
          [{ value: "", label: "Choose…" }, ...q.options],
          current[q.id] || "",
          { required: q.required },
        );
        read = () => control.value;
      } else if (q.type === "long_text") {
        control = area(current[q.id] || "", {
          required: q.required,
          maxlength: q.max_length,
        });
        read = () => control.value;
      } else {
        control = input(current[q.id] ?? "", {
          type:
            q.type === "number"
              ? "number"
              : q.type === "date"
                ? "date"
                : "text",
          required: q.required,
          maxlength: q.max_length,
          min: q.min,
          max: q.max,
          step: q.type === "number" ? "any" : undefined,
          pattern:
            q.type === "roblox_username" ? "[A-Za-z0-9_]{3,20}" : undefined,
        });
        read = () =>
          q.type === "number"
            ? control.value === ""
              ? undefined
              : Number(control.value)
            : control.value;
      }
      node.append(
        field(
          q.label + (q.required ? " *" : ""),
          control,
          q.type === "roblox_username"
            ? "Public username lookup does not verify account ownership."
            : "",
        ),
      );
    }
    controls.push({ id: q.id, read });
  }
  return {
    node,
    read: () =>
      Object.fromEntries(
        controls
          .map((c) => [c.id, c.read()])
          .filter(([, v]) => v !== undefined),
      ),
  };
}
async function webApplication(guild, formId) {
  const f = await applicant(guild, `forms/${formId}`),
    d = f.definition,
    answers = answerForm(d);
  state.tab = "applicant";
  mount(
    heading(d.title, d.description),
    card(
      el(
        "p",
        { class: "answer" },
        d.instructions || "Complete the questions below.",
      ),
      d.requirements ? el("p", { class: "help" }, d.requirements) : null,
      el(
        "form",
        {
          onsubmit: task(async (e) => {
            e.preventDefault();
            e.submitter.disabled = true;
            try {
              const a = await applicant(guild, `forms/${formId}`, "POST", {
                version: f.version,
                answers: answers.read(),
              });
              notify(`Application submitted: ${a.id}`);
              sessionStorage.removeItem("roapp-intent");
              await ownDetail(guild, a.id);
            } finally {
              e.submitter.disabled = false;
            }
          }),
        },
        answers.node,
        actions(
          el(
            "button",
            { type: "submit", class: "primary" },
            "Submit application",
          ),
          btn("Cancel", () => showApplicant(guild)),
        ),
      ),
    ),
  );
}
async function ownDetail(guild, id) {
  const a = await applicant(guild, `applications/${id}`);
  const controls = [];
  if (!["approved", "rejected", "withdrawn"].includes(a.status))
    controls.push(
      btn(
        "Withdraw application",
        async () => {
          if (confirm("Withdraw this application? This cannot be undone.")) {
            await applicant(guild, `applications/${id}/withdraw`, "POST", {
              revision: a.revision,
              confirm: id,
            });
            await ownDetail(guild, id);
          }
        },
        "danger",
      ),
    );
  const revisions = [];
  if (a.status === "revision_requested") {
    const form = answerForm(a.definition, a.answers);
    revisions.push(
      card(
        el("h2", {}, "Submit a revision"),
        el("p", {}, a.decision_reason),
        el(
          "form",
          {
            onsubmit: task(async (e) => {
              e.preventDefault();
              await applicant(guild, `applications/${id}/revise`, "POST", {
                revision: a.revision,
                answers: form.read(),
              });
              notify("Revision submitted for review.");
              await ownDetail(guild, id);
            }),
          },
          form.node,
          el(
            "button",
            { type: "submit", class: "primary" },
            "Resubmit revised answers",
          ),
        ),
      ),
    );
  }
  mount(
    heading(id),
    actions(
      btn("Back to my applications", () => showApplicant(guild)),
      controls,
    ),
    card(
      el("h2", {}, a.definition.title),
      pill(a.status),
      el(
        "p",
        { class: "muted" },
        `Submitted ${date(a.created_at)} · Version ${a.form_version}`,
      ),
      el("p", {}, a.decision_reason || "No decision reason yet."),
    ),
    card(el("h2", {}, "Your submitted answers"), answerContent(a)),
    robloxCard(a, () => ownDetail(guild, id), true),
    revisions,
  );
}
const AUTH_ERRORS = {
  oauth_state_invalid:
    "Sign-in could not be verified (the login session was missing, expired or already used). Start sign-in again from this same browser.",
};
async function initialize() {
  const authError = new URLSearchParams(location.search).get("auth_error");
  if (authError) {
    history.replaceState(null, "", location.pathname);
    notify(AUTH_ERRORS[authError] || "Sign-in failed. Please try again.", true);
  }
  const intent =
    location.search || sessionStorage.getItem("roapp-intent") || "";
  if (intent) sessionStorage.setItem("roapp-intent", intent);
  try {
    state.session = await api("/api/session");
  } catch (e) {
    if (e.status === 401) return;
    throw e;
  }
  $("#account").replaceChildren(
    el("span", { class: "username" }, state.session.user.username),
    btn("Sign out", async () => {
      await api("/api/logout", "POST", {});
      sessionStorage.clear();
      location.assign("/");
    }),
  );
  state.guilds = await api("/api/guilds");
  $("#sidebar").hidden = false;
  const picker = $("#community");
  for (const g of state.guilds.filter((g) => g.dashboard))
    picker.append(el("option", { value: g.guild_id }, g.name));
  picker.addEventListener(
    "change",
    task(async () => {
      if (!picker.value) return;
      await api("/api/guild/select", "POST", { guild_id: picker.value });
      state.session.selected_guild_id = picker.value;
      await loadContext();
      await showTab("overview");
    }),
  );
  const query = new URLSearchParams(intent),
    apply = query.get("apply"),
    mine = query.get("mine");
  if (apply && /^\d{17,22}\.[A-Za-z0-9_-]{1,60}$/.test(apply)) {
    const [guild, form] = apply.split(".");
    state.applicantGuild = guild;
    await webApplication(guild, form);
    return;
  }
  if (mine && /^\d{17,22}$/.test(mine)) {
    await showApplicant(mine);
    return;
  }
  const selected =
    state.guilds.find(
      (g) => g.dashboard && g.guild_id === state.session.selected_guild_id,
    ) || state.guilds.find((g) => g.dashboard);
  if (selected) {
    picker.value = selected.guild_id;
    if (state.session.selected_guild_id !== selected.guild_id)
      await api("/api/guild/select", "POST", { guild_id: selected.guild_id });
    await loadContext();
    await showTab("overview");
  } else if (!state.guilds.length) {
    mount(
      heading("No communities found"),
      empty(
        "RoApp has no registered community that includes your Discord account. The server owner must run /setup in the server after installing RoApp.",
      ),
    );
  } else {
    notify(
      "You do not have dashboard access in any community. Ask the server owner to grant one of your roles dashboard access.",
      true,
    );
    await showApplicant(state.guilds[0]?.guild_id);
  }
}
initialize().catch((e) => {
  notify(e.message, true);
  mount(
    heading("Connection unavailable"),
    empty(
      "RoApp could not confirm your current access. No protected data was loaded.",
    ),
    btn("Try again", () => location.reload()),
  );
});
