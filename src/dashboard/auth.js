import { one, run, rateLimit } from "../database/db.js";
import {
  assert,
  uid,
  digest,
  equal,
  epoch,
  json,
  AppError,
} from "../utils/helpers.js";
import { discord } from "../utils/discord.js";
export function appOrigin(env) {
  let u;
  try {
    u = new URL(env.APP_ORIGIN);
  } catch {
    throw new AppError(503, "origin_not_configured");
  }
  assert(
    (u.protocol === "https:" && !u.hostname.includes("REPLACE")) ||
      (u.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(u.hostname)),
    503,
    "origin_not_configured",
  );
  assert(
    u.pathname === "/" && !u.search && !u.hash && !u.username && !u.password,
    503,
    "invalid_origin_configuration",
  );
  return u.origin;
}
function cookieName(env, type = "session") {
  return `${appOrigin(env).startsWith("https:") ? "__Host-" : ""}roapp_${type}`;
}
export function cookies(request) {
  return Object.fromEntries(
    (request.headers.get("Cookie") || "")
      .split(";")
      .map((x) => x.trim().split(/=(.*)/s).slice(0, 2))
      .filter((x) => x.length === 2),
  );
}
export function cookie(env, value, type = "session", maxAge = 28800) {
  return `${cookieName(env, type)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${appOrigin(env).startsWith("https:") ? "; Secure" : ""}`;
}
async function encryptionKey(env) {
  assert(
    typeof env.SESSION_SECRET === "string" &&
      env.SESSION_SECRET.length >= 32 &&
      !env.SESSION_SECRET.startsWith("REPLACE"),
    503,
    "session_secret_not_configured",
  );
  return crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(env.SESSION_SECRET),
    ),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}
const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export async function encrypt(env, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(env),
    new TextEncoder().encode(plain),
  );
  return b64(iv) + "." + b64(new Uint8Array(data));
}
export async function decrypt(env, cipher) {
  try {
    const [iv, data] = cipher.split(".");
    return new TextDecoder().decode(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: unb64(iv) },
        await encryptionKey(env),
        unb64(data),
      ),
    );
  } catch {
    throw new AppError(401, "session_invalid", "Sign in again.");
  }
}
export async function session(request, env) {
  const sid = cookies(request)[cookieName(env)];
  assert(/^[a-f0-9]{64}$/.test(sid || ""), 401, "login_required");
  const s = await one(
    env,
    "SELECT * FROM dashboard_sessions WHERE id_hash=? AND expires_at>?",
    await digest(sid),
    epoch(),
  );
  assert(s, 401, "session_expired", "Sign in again.");
  return s;
}
export async function checkCsrf(request, env, s) {
  assert(
    request.headers.get("Origin") === appOrigin(env),
    403,
    "origin_mismatch",
  );
  assert(
    equal(await digest(request.headers.get("X-CSRF-Token") || ""), s.csrf_hash),
    403,
    "csrf_failed",
  );
}
// Idle window (SESSION_HOURS, default 8, max 24) slides forward while the dashboard is
// used; the absolute limit (SESSION_MAX_DAYS, default and max 7, fractions allowed) is
// measured from sign-in.
export function sessionPolicy(env) {
  return {
    idle: Math.floor(
      Math.min(24, Math.max(1, Number(env.SESSION_HOURS) || 8)) * 3600,
    ),
    absolute: Math.floor(
      Math.min(7, Math.max(1 / 24, Number(env.SESSION_MAX_DAYS) || 7)) * 86400,
    ),
  };
}
export const hasSessionCookie = (request, env) =>
  Boolean(cookies(request)[cookieName(env)]);
export const clearSessionCookie = (env) => cookie(env, "", "session", 0);
// Extends a still-valid session while it is in use. Returns a refreshed Set-Cookie
// value, or null when nothing changed. Never extends past the absolute limit.
export async function refreshSession(request, env, s) {
  const { idle, absolute } = sessionPolicy(env),
    t = epoch(),
    next = Math.min(t + idle, s.created_at + absolute);
  if (s.expires_at - t >= idle / 2 || next - s.expires_at < 60) return null;
  const r = await run(
    env,
    "UPDATE dashboard_sessions SET expires_at=? WHERE id_hash=? AND expires_at<?",
    next,
    s.id_hash,
    next,
  );
  if (!r.meta.changes) return null;
  s.expires_at = next;
  return cookie(env, cookies(request)[cookieName(env)], "session", next - t);
}
export async function createSession(env, user, token, expiresIn) {
  assert(
    user?.id && Number.isFinite(expiresIn) && expiresIn > 0,
    502,
    "invalid_oauth_response",
  );
  const sid = uid() + uid(),
    csrf = uid() + uid(),
    ttl = Math.max(1, Math.min(sessionPolicy(env).idle, expiresIn));
  const expires = epoch() + Math.floor(ttl);
  await run(
    env,
    "INSERT INTO dashboard_sessions(id_hash,user_id,username,access_token,csrf_hash,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)",
    await digest(sid),
    user.id,
    user.global_name || user.username || user.id,
    await encrypt(env, token),
    await digest(csrf),
    csrf,
    expires,
    epoch(),
  );
  return { sid, csrf, ttl, expires };
}
function rejectState(reason) {
  // Category only: never log the state value, cookie value or any token.
  console.warn("RoApp OAuth state rejected", { reason });
  throw new AppError(400, "oauth_state_invalid");
}
export async function consumeState(env, state, cookieState) {
  if (!/^[a-f0-9]{64}$/.test(state || "")) rejectState("state_malformed");
  if (!cookieState) rejectState("cookie_missing");
  if (!equal(state, cookieState)) rejectState("cookie_mismatch");
  const s = await one(
    env,
    "DELETE FROM oauth_states WHERE state_hash=? AND expires_at>? RETURNING state_hash",
    await digest(state),
    epoch(),
  );
  if (!s) rejectState("state_unknown_expired_or_used");
}
const redirect = (location) =>
  new Response(null, {
    status: 302,
    headers: { Location: location, "Cache-Control": "no-store" },
  });
export async function authRoute(request, env) {
  const url = new URL(request.url),
    origin = appOrigin(env);
  assert(url.origin === origin, 400, "wrong_origin");
  if (url.pathname === "/auth/discord" && request.method === "GET") {
    await encryptionKey(env);
    // Already signed in: open the dashboard instead of another Discord round trip.
    if (!url.searchParams.has("reauth")) {
      try {
        await session(request, env);
        return redirect("/");
      } catch (e) {
        if (!(e instanceof AppError) || e.status !== 401) throw e;
      }
    }
    await rateLimit(
      env,
      "oauth:" +
        (await digest(request.headers.get("CF-Connecting-IP") || "local")),
      15,
      60,
    );
    assert(
      /^\d{17,22}$/.test(env.DISCORD_CLIENT_ID || ""),
      503,
      "oauth_not_configured",
    );
    const state = uid() + uid();
    // Returning users (a prior successful sign-in left a hint cookie) skip Discord's
    // authorization screen with prompt=none; the callback falls back to the normal
    // screen once if Discord refuses.
    const quick =
      cookies(request)[cookieName(env, "seen")] === "1" &&
      !url.searchParams.has("consent") &&
      !url.searchParams.has("reauth");
    await run(
      env,
      "INSERT INTO oauth_states(state_hash,expires_at) VALUES(?,?)",
      await digest(state),
      epoch() + 600,
    );
    const target = new URL("https://discord.com/oauth2/authorize");
    target.search = new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      response_type: "code",
      redirect_uri: origin + "/auth/discord/callback",
      scope: "identify guilds",
      state,
      ...(quick ? { prompt: "none" } : {}),
    }).toString();
    // One cookie per attempt, so a second tab or a retry cannot overwrite it.
    return new Response(null, {
      status: 302,
      headers: {
        Location: target.toString(),
        "Set-Cookie": cookie(
          env,
          quick ? state + ".n" : state,
          `oauth_${state.slice(0, 16)}`,
          600,
        ),
        "Cache-Control": "no-store",
      },
    });
  }
  if (url.pathname === "/auth/discord/callback" && request.method === "GET") {
    const state = url.searchParams.get("state") || "",
      jar = cookies(request),
      key = /^[a-f0-9]{64}$/.test(state) ? `oauth_${state.slice(0, 16)}` : "oauth";
    // The per-attempt cookie is preferred; the original single cookie name is still
    // accepted so sign-ins started before this version keep working.
    const [cookieState, mode] = (
      jar[cookieName(env, key)] ??
      jar[cookieName(env, "oauth")] ??
      ""
    ).split(".");
    const clear = new Set([key, "oauth"]);
    const back = (location) => {
      const h = new Headers({ Location: location, "Cache-Control": "no-store" });
      for (const k of clear) h.append("Set-Cookie", cookie(env, "", k, 0));
      return new Response(null, { status: 302, headers: h });
    };
    try {
      await consumeState(env, state, cookieState);
    } catch (e) {
      if (!(e instanceof AppError) || e.code !== "oauth_state_invalid") throw e;
      // Still a rejection: no token exchange, no session. Someone who is already
      // signed in (back button, reloaded callback) simply lands on the dashboard;
      // everyone else gets a recoverable message instead of a raw JSON page. Other
      // attempts' cookies are left alone so a newer in-flight sign-in still works.
      try {
        await session(request, env);
        return redirect("/");
      } catch (err) {
        if (!(err instanceof AppError) || err.status !== 401) throw err;
      }
      return redirect("/?auth_error=oauth_state_invalid");
    }
    if (url.searchParams.has("error") || !url.searchParams.get("code")) {
      // A refused prompt=none attempt is retried once with the normal screen; a
      // refusal there (the person pressed Cancel) is final, so this cannot loop.
      return back(
        mode === "n" ? "/auth/discord?consent=1" : "/?auth_error=oauth_denied",
      );
    }
    const form = new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code: url.searchParams.get("code"),
      redirect_uri: origin + "/auth/discord/callback",
    });
    let res;
    try {
      res = await (env.FETCH || fetch)("https://discord.com/api/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form,
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new AppError(503, "oauth_unavailable");
    }
    assert(res.ok, 502, "oauth_exchange_failed");
    const token = await res.json();
    assert(
      typeof token.access_token === "string" &&
        token.token_type?.toLowerCase() === "bearer",
      502,
      "invalid_oauth_response",
    );
    if (typeof token.scope === "string") {
      const granted = token.scope.split(/[\s,]+/);
      assert(
        granted.includes("identify") && granted.includes("guilds"),
        403,
        "oauth_scope_missing",
        "Discord did not grant the required permissions. Sign in again and approve all requested access.",
      );
    }
    const user = await discord(env, "/users/@me", {
      token: token.access_token,
    });
    const s = await createSession(
      env,
      user,
      token.access_token,
      Number(token.expires_in),
    );
    // Replace any previous session of this browser instead of leaving it behind.
    const oldSid = jar[cookieName(env)];
    if (/^[a-f0-9]{64}$/.test(oldSid || ""))
      await run(
        env,
        "DELETE FROM dashboard_sessions WHERE id_hash=?",
        await digest(oldSid),
      );
    const headers = new Headers({ Location: "/", "Cache-Control": "no-store" });
    headers.append("Set-Cookie", cookie(env, s.sid, "session", s.ttl));
    for (const k of clear) headers.append("Set-Cookie", cookie(env, "", k, 0));
    headers.append("Set-Cookie", cookie(env, "1", "seen", 15552000));
    return new Response(null, { status: 302, headers });
  }
  throw new AppError(404, "not_found");
}
export async function logout(request, env, s) {
  await checkCsrf(request, env, s);
  await run(env, "DELETE FROM dashboard_sessions WHERE id_hash=?", s.id_hash);
  // Also forget the "signed in before" hint so the next sign-in shows Discord's
  // screen again (allows switching accounts on a shared device).
  const r = json({ ok: true });
  r.headers.append("Set-Cookie", cookie(env, "", "session", 0));
  r.headers.append("Set-Cookie", cookie(env, "", "seen", 0));
  return r;
}
export function publicSession(s) {
  return {
    user: { id: s.user_id, username: s.username },
    csrf: s.csrf_token,
    selected_guild_id: s.selected_guild_id,
    expires_at: s.expires_at,
  };
}
