import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { testDB } from "./support.js";
test("fresh schema, foreign keys and Worker health", async () => {
  const DB = testDB();
  const r = await worker.fetch(new Request("https://test/health"), { DB });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
  assert.equal(DB._db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.throws(() =>
    DB._db.exec(
      "INSERT INTO dashboard_role_access VALUES('missing','role',1,'[]')",
    ),
  );
});
