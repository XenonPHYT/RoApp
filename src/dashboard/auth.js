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
export async function createSession(env, user, token, expiresIn) {
  assert(
    user?.id && Number.isFinite(expiresIn) && expiresIn > 0,
    502,
    "invalid_oauth_response",
  );
  const sid = uid() + uid(),
    csrf = uid() + uid(),
    ttl = Math.max(
      1,
      Math.min(
        8 * 3600,
        Math.max(1, Number(env.SESSION_HOURS) || 8) * 3600,
        expiresIn,
      ),
    );
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
export async function consumeState(env, state, cookieState) {
  assert(
    /^[a-f0-9]{64}$/.test(state || "") && equal(state, cookieState),
    400,
    "oauth_state_invalid",
  );
  const s = await one(
    env,
    "DELETE FROM oauth_states WHERE state_hash=? AND expires_at>? RETURNING state_hash",
    await digest(state),
    epoch(),
  );
  assert(s, 400, "oauth_state_invalid");
}
export async function authRoute(request, env) {
  const url = new URL(request.url),
    origin = appOrigin(env);
  assert(url.origin === origin, 400, "wrong_origin");
  if (url.pathname === "/auth/discord" && request.method === "GET") {
    await encryptionKey(env);
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
    }).toString();
    return new Response(null, {
      status: 302,
      headers: {
        Location: target.toString(),
        "Set-Cookie": cookie(env, state, "oauth", 600),
        "Cache-Control": "no-store",
      },
    });
  }
  if (url.pathname === "/auth/discord/callback" && request.method === "GET") {
    await consumeState(
      env,
      url.searchParams.get("state"),
      cookies(request)[cookieName(env, "oauth")],
    );
    assert(
      !url.searchParams.has("error") && url.searchParams.get("code"),
      400,
      "oauth_denied",
      "Discord login was cancelled or denied.",
    );
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
    const user = await discord(env, "/users/@me", {
      token: token.access_token,
    });
    const s = await createSession(
      env,
      user,
      token.access_token,
      Number(token.expires_in),
    );
    const headers = new Headers({ Location: "/", "Cache-Control": "no-store" });
    headers.append("Set-Cookie", cookie(env, s.sid, "session", s.ttl));
    headers.append("Set-Cookie", cookie(env, "", "oauth", 0));
    return new Response(null, { status: 302, headers });
  }
  throw new AppError(404, "not_found");
}
export async function logout(request, env, s) {
  await checkCsrf(request, env, s);
  await run(env, "DELETE FROM dashboard_sessions WHERE id_hash=?", s.id_hash);
  return json({ ok: true }, 200, {
    "Set-Cookie": cookie(env, "", "session", 0),
  });
}
export function publicSession(s) {
  return {
    user: { id: s.user_id, username: s.username },
    csrf: s.csrf_token,
    selected_guild_id: s.selected_guild_id,
    expires_at: s.expires_at,
  };
}
