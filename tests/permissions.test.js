import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluatePermissions,
  authorize,
  setRole,
} from "../src/modules/permissions.js";
import { testDB, seed } from "./support.js";
const guild = "100000000000000001",
  user = "200000000000000001",
  role = "300000000000000001";
const policy = [
  { role_id: role, dashboard: 1, permissions_json: '["applications.review"]' },
];
test("owner, configured role, administrator-only and ordinary member policies", () => {
  assert.equal(
    evaluatePermissions({ owner: true, roles: [] }, []).dashboard,
    true,
  );
  assert.deepEqual(
    evaluatePermissions({ owner: false, roles: [role] }, policy).permissions,
    ["applications.review"],
  );
  assert.equal(
    evaluatePermissions({ owner: false, roles: [], permissions: "8" }, policy)
      .dashboard,
    false,
  );
  assert.equal(
    evaluatePermissions({ owner: false, roles: [] }, []).permissions.length,
    0,
  );
});
test("live authorization revalidates roles and cannot use another tenant policy", async () => {
  let roles = [role];
  const env = {
    DB: testDB(),
    FETCH: async (url) =>
      Response.json(
        url.includes("/members/")
          ? { user: { id: user }, roles }
          : { id: guild, name: "Test", owner_id: "900000000000000001" },
      ),
  };
  await seed(env);
  await env.DB.prepare("INSERT INTO dashboard_role_access VALUES(?,?,?,?)")
    .bind(guild, role, 1, '["applications.review"]')
    .run();
  assert.equal(
    (
      await authorize(env, guild, user, "applications.review", {
        dashboard: true,
      })
    ).dashboard,
    true,
  );
  roles = [];
  await assert.rejects(
    authorize(env, guild, user, "applications.review"),
    (e) => e.status === 403,
  );
  await seed(env, "100000000000000002");
  roles = [role];
  const env2 = {
    ...env,
    FETCH: async (url) =>
      Response.json(
        url.includes("/members/")
          ? { user: { id: user }, roles }
          : {
              id: "100000000000000002",
              name: "Other",
              owner_id: "900000000000000001",
            },
      ),
  };
  await assert.rejects(
    authorize(env2, "100000000000000002", user, "applications.review"),
    (e) => e.status === 403,
  );
});
test("staff cannot self-escalate dashboard or permissions", async () => {
  const env = { DB: testDB() };
  await seed(env);
  const access = {
    guild_id: guild,
    user_id: user,
    owner: false,
    permissions: ["staff.manage"],
  };
  await assert.rejects(
    setRole(env, access, { role_id: role, dashboard: true, permissions: [] }),
    (e) => e.status === 403,
  );
  await assert.rejects(
    setRole(env, access, {
      role_id: role,
      dashboard: false,
      permissions: ["applications.decide"],
    }),
    (e) => e.status === 403,
  );
});
