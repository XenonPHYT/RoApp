import { test, expect } from "@playwright/test";
const guild = "100000000000000001",
  user = "200000000000000001";
const permissions = [
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
async function fakeAPI(page) {
  const forms = [],
    requests = [];
  const app = {
    id: "APP-2026-ABCDEF1234567890",
    guild_id: guild,
    applicant_id: user,
    form_id: "f1",
    form_version: 1,
    revision: 0,
    status: "pending",
    created_at: "2026-11-13T08:00:00Z",
    updated_at: "2026-11-13T08:00:00Z",
    answers: { a: "Browser test answer" },
    definition: {
      title: "Staff application",
      questions: [
        {
          id: "a",
          label: "Why join?",
          type: "short_text",
          required: true,
          max_length: 300,
        },
      ],
    },
    notes: [],
    events: [],
    reviewers: [],
  };
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      u = new URL(req.url()),
      path = u.pathname;
    let result = { ok: true };
    requests.push({ path, method: req.method(), body: req.postDataJSON() });
    if (path === "/api/session")
      result = {
        user: { id: user, username: "Community Owner" },
        csrf: "browser-only-fixture",
        selected_guild_id: guild,
      };
    else if (path === "/api/guilds")
      result = [
        {
          guild_id: guild,
          name: "Test Community",
          dashboard: true,
          permissions,
        },
      ];
    else if (path === "/api/manage/context")
      result = {
        guild_id: guild,
        name: "Test Community",
        settings: { notifications: true, multiple_reviewers: true },
        access: { owner: true, permissions },
        permission_types: permissions,
      };
    else if (path === "/api/manage/overview")
      result = { statuses: [{ status: "pending", total: 1 }], open_forms: 1 };
    else if (path === "/api/manage/forms" && req.method() === "GET")
      result = forms;
    else if (path === "/api/manage/forms" && req.method() === "POST") {
      const b = req.postDataJSON();
      result = {
        ...b,
        id: "browser-form",
        draft: b.definition,
        status: "draft",
        version: 0,
        updated_at: "2026-11-13T09:00:00Z",
        edit_revision: 0,
      };
      forms.push(result);
    } else if (
      path.startsWith("/api/manage/forms/") &&
      path.endsWith("/publish")
    ) {
      forms[0].status = "open";
      forms[0].version++;
      result = forms[0];
    } else if (path === "/api/manage/applications")
      result = { items: [app], has_more: false };
    else if (path.includes("/notes") && req.method() === "POST") {
      app.notes.push({
        id: "n1",
        body: req.postDataJSON().body,
        author_id: user,
        created_at: app.created_at,
      });
    } else if (path.includes("/decision") && req.method() === "POST") {
      app.status = req.postDataJSON().status;
      app.revision++;
    } else if (path.startsWith("/api/manage/applications/")) result = app;
    else if (path === "/api/manage/staff")
      result = {
        roles: [{ id: "300000000000000001", name: "Review Team" }],
        assignments: [],
      };
    else if (path === "/api/manage/panels")
      result = {
        panels: [],
        forms: forms.map((f) => ({
          id: f.id,
          title: f.draft.title,
          status: f.status,
        })),
      };
    else if (path === "/api/manage/notifications") result = [];
    else if (path === "/api/manage/audit") result = [];
    else if (path === `/api/applicant/${guild}/forms`)
      result = [{ id: "f1", ...app.definition }];
    else if (
      path === `/api/applicant/${guild}/forms/f1` &&
      req.method() === "GET"
    )
      result = {
        id: "f1",
        guild_id: guild,
        version: 1,
        definition: app.definition,
      };
    else if (
      path === `/api/applicant/${guild}/forms/f1` &&
      req.method() === "POST"
    )
      result = app;
    else if (path === `/api/applicant/${guild}/applications`) result = [app];
    else if (path.startsWith(`/api/applicant/${guild}/applications/`))
      result = app;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(result),
    });
  });
  return requests;
}
test("public landing renders responsively without authenticated controls", async ({
  page,
}) => {
  await page.route("**/api/session", (r) =>
    r.fulfill({
      status: 401,
      contentType: "application/json",
      body: '{"error":"login_required"}',
    }),
  );
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Better applications.",
  );
  await expect(page.locator("#sidebar")).toBeHidden();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await expect(
    page.getByRole("link", { name: "Get started with Discord" }),
  ).toHaveAttribute("href", "/auth/discord");
});
test("desktop form builder saves and publishes, reviewer can add private notes and decide", async ({
  page,
}) => {
  const requests = await fakeAPI(page);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Test Community", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Form builder", exact: true }).click();
  await page
    .getByRole("button", { name: "Create a form", exact: true })
    .click();
  await page.getByLabel("Form title", { exact: true }).fill("Test recruitment");
  await page.getByLabel("Question label", { exact: true }).fill("Why join?");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Test recruitment", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Publish draft", exact: true })
    .click();
  await expect(
    page.getByText("Published version 1", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Applications", exact: true }).click();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page
    .getByLabel("Add internal note", { exact: true })
    .fill("Internal test note");
  await page
    .getByRole("button", { name: "Save internal note", exact: true })
    .click();
  await expect(
    page.getByText("Internal test note", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Confirm state change", exact: true })
    .click();
  await expect(page.locator(".pill")).toContainText("under review");
  expect(
    requests.some(
      (r) => r.path.endsWith("/notes") && r.body.body === "Internal test note",
    ),
  ).toBeTruthy();
  expect(errors).toEqual([]);
});
test("mobile management navigation and settings save remain usable", async ({
  page,
}) => {
  const requests = await fakeAPI(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Community settings", exact: true })
    .click();
  await page
    .getByLabel("Send applicant status updates through Discord DMs")
    .uncheck();
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(page.locator("#notice")).toContainText(
    "Community settings saved",
  );
  expect(
    requests.some(
      (r) =>
        r.path === "/api/manage/settings" && r.body.notifications === false,
    ),
  ).toBeTruthy();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
});
test("long-form web applicant submission uses the actual form version and private detail view", async ({
  page,
}) => {
  const requests = await fakeAPI(page);
  await page.goto(`/?apply=${guild}.f1`);
  await page
    .getByLabel("Why join? *", { exact: true })
    .fill("I want to contribute");
  await page
    .getByRole("button", { name: "Submit application", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "APP-2026-ABCDEF1234567890",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    requests.find((r) => r.method === "POST" && r.path.endsWith("/forms/f1"))
      .body,
  ).toEqual({ version: 1, answers: { a: "I want to contribute" } });
  await expect(
    page.getByRole("heading", { name: "Internal reviewer notes", exact: true }),
  ).toHaveCount(0);
});
