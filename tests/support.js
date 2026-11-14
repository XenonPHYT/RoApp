import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
export function testDB() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    readFileSync(
      new URL("../src/database/schema.sql", import.meta.url),
      "utf8",
    ),
  );
  function prepare(sql) {
    let args = [];
    return {
      bind(...a) {
        args = a;
        return this;
      },
      async first() {
        return db.prepare(sql).get(...args) || null;
      },
      async all() {
        return { results: db.prepare(sql).all(...args) };
      },
      async run() {
        const r = db.prepare(sql).run(...args);
        return {
          success: true,
          meta: {
            changes: Number(r.changes),
            last_row_id: Number(r.lastInsertRowid),
          },
        };
      },
      _exec() {
        const s = db.prepare(sql);
        if (s.columns().length)
          return {
            results: s.all(...args),
            meta: { changes: Number(db.prepare("SELECT changes() n").get().n) },
          };
        const r = s.run(...args);
        return { results: [], meta: { changes: Number(r.changes) } };
      },
    };
  }
  return {
    prepare,
    async batch(stmts) {
      db.exec("BEGIN");
      try {
        const results = stmts.map((s) => s._exec());
        db.exec("COMMIT");
        return results;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    _db: db,
  };
}
export async function seed(
  env,
  guild = "100000000000000001",
  owner = "200000000000000001",
) {
  await env.DB.prepare(
    "INSERT INTO guilds(guild_id,name,owner_id) VALUES(?,?,?)",
  )
    .bind(guild, "Test community", owner)
    .run();
  return { guild, owner };
}
