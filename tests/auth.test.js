import test from "node:test";
import assert from "node:assert/strict";
import { testDB } from "./support.js";
import {
  authRoute,
  consumeState,
  createSession,
  session,
  checkCsrf,
  encrypt,
  decrypt,
  logout,
  cookie,
} from "../src/dashboard/auth.js";
import { digest, epoch } from "../src/utils/helpers.js";
const env = () => ({
  DB: testDB(),
  APP_ORIGIN: "https://roapp.example",
  SESSION_SECRET: "test-only-secret-".repeat(3),
  DISCORD_CLIENT_ID: "100000000000000001",
});
test("OAuth state is cookie-bound, expiring and single-use", async () => {
  const e = env();
  const r = await authRoute(new Request(e.APP_ORIGIN + "/auth/discord"), e);
  assert.equal(r.status, 302);
  const state = new URL(r.headers.get("Location")).searchParams.get("state");
  await assert.rejects(
    consumeState(e, state, "bad"),
    (x) => x.code === "oauth_state_invalid",
  );
  await consumeState(e, state, state);
  await assert.rejects(consumeState(e, state, state));
  const old = "a".repeat(64);
  await e.DB.prepare("INSERT INTO oauth_states VALUES(?,?)")
    .bind(await digest(old), epoch() - 1)
    .run();
  await assert.rejects(consumeState(e, old, old));
});
test("sessions encrypt tokens, expire, enforce CSRF/origin and revoke at logout", async () => {
  const e = env();
  const made = await createSession(
    e,
    { id: "200000000000000001", username: "Applicant" },
    "oauth-test-token",
    3600,
  );
  const make = (csrf = made.csrf, origin = e.APP_ORIGIN) =>
    new Request(e.APP_ORIGIN + "/api/logout", {
      method: "POST",
      headers: {
        Cookie: `__Host-roapp_session=${made.sid}`,
        Origin: origin,
        "X-CSRF-Token": csrf,
      },
    });
  const s = await session(make(), e);
  assert.notEqual(s.access_token, "oauth-test-token");
  assert.equal(await decrypt(e, s.access_token), "oauth-test-token");
  await checkCsrf(make(), e, s);
  await assert.rejects(
    checkCsrf(make("bad"), e, s),
    (x) => x.code === "csrf_failed",
  );
  await assert.rejects(
    checkCsrf(make(made.csrf, "https://evil.example"), e, s),
  );
  assert.match(
    cookie(e, made.sid),
    /HttpOnly; SameSite=Lax; Max-Age=28800; Secure/,
  );
  const tampered = await encrypt(e, "test");
  await assert.rejects(decrypt(e, tampered.slice(0, -3) + "abc"));
  await logout(make(), e, s);
  await assert.rejects(session(make(), e), (x) => x.status === 401);
  const expired = await createSession(
    e,
    { id: "200000000000000001" },
    "token",
    1,
  );
  await e.DB.prepare("UPDATE dashboard_sessions SET expires_at=?")
    .bind(epoch() - 1)
    .run();
  await assert.rejects(
    session(
      new Request(e.APP_ORIGIN, {
        headers: { Cookie: `__Host-roapp_session=${expired.sid}` },
      }),
      e,
    ),
  );
});
test("OAuth redirects only to fixed same-origin root and rejects wrong host", async () => {
  const e = env();
  await assert.rejects(
    authRoute(new Request("https://evil.example/auth/discord"), e),
    (x) => x.code === "wrong_origin",
  );
});
