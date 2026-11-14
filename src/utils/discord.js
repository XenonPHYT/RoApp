import { AppError, assert } from "./helpers.js";
export const API = "https://discord.com/api/v10";
export async function discord(
  env,
  path,
  { method = "GET", body, token, timeout = 2500 } = {},
) {
  const headers = {
    Authorization: token ? `Bearer ${token}` : `Bot ${env.DISCORD_BOT_TOKEN}`,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await (env.FETCH || fetch)(API + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    throw new AppError(
      503,
      "discord_unavailable",
      "Discord is unavailable. Access could not be verified; try again.",
    );
  }
  if (res.status === 429) {
    let retry = 60;
    try {
      retry = Number((await res.json()).retry_after) || 60;
    } catch {}
    const e = new AppError(
      429,
      "discord_rate_limited",
      "Discord rate limit; please retry later.",
    );
    e.retryAfter = Math.min(3600, Math.max(1, retry));
    throw e;
  }
  if (!res.ok) {
    const e = new AppError(
      res.status === 404 ? 404 : 502,
      "discord_request_failed",
      "Discord could not complete this request.",
    );
    e.upstreamStatus = res.status;
    throw e;
  }
  return res.status === 204 ? null : res.json();
}
export async function editOriginal(env, i, data) {
  assert(/^\d{17,22}$/.test(i.application_id), 400, "invalid_application");
  return discord(
    env,
    `/webhooks/${i.application_id}/${encodeURIComponent(i.token)}/messages/@original`,
    { method: "PATCH", body: { ...data, allowed_mentions: { parse: [] } } },
  );
}
export const dashboardURL = (env, suffix = "") => env.APP_ORIGIN + suffix;
