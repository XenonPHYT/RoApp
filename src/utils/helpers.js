export class AppError extends Error {
  constructor(status, code, message = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const now = () => new Date().toISOString();
export const epoch = () => Math.floor(Date.now() / 1000);
export const uid = () => crypto.randomUUID().replaceAll("-", "");
export const json = (data, status = 200, headers = {}) =>
  Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
export const assert = (condition, status, code, message) => {
  if (!condition) throw new AppError(status, code, message);
};
export async function digest(value) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  ]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
export function equal(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}
export async function readJson(req, max = 262144) {
  assert(
    (req.headers.get("content-type") || "").startsWith("application/json"),
    415,
    "json_required",
  );
  const text = await readText(req, max);
  try {
    const result = JSON.parse(text);
    assert(
      result && typeof result === "object" && !Array.isArray(result),
      400,
      "json_object_required",
    );
    return result;
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(400, "invalid_json");
  }
}
export async function readText(req, max = 65536) {
  assert(
    Number(req.headers.get("content-length") || 0) <= max,
    413,
    "body_too_large",
  );
  const reader = req.body?.getReader();
  if (!reader) return "";
  let bytes = 0,
    chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > max) {
      await reader.cancel();
      throw new AppError(413, "body_too_large");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(bytes);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.length;
  }
  return new TextDecoder().decode(all);
}
export function safeError(e) {
  if (e instanceof AppError)
    return json({ error: e.code, message: e.message }, e.status);
  const text = String(e?.message || "");
  const conflicts = [
    "duplicate_or_cooldown",
    "form_closed_or_changed",
    "invalid_transition",
    "already_assigned",
  ];
  const known = conflicts.find((x) => text.includes(x));
  if (known) return json({ error: known }, 409);
  console.error("RoApp request failed", { category: e?.name || "Error" });
  return json(
    { error: "internal_error", message: "Request failed. Please try again." },
    500,
  );
}
export function secureResponse(response) {
  const r = new Response(response.body, response);
  r.headers.set("X-Content-Type-Options", "nosniff");
  r.headers.set("Referrer-Policy", "no-referrer");
  r.headers.set("X-Frame-Options", "DENY");
  r.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  r.headers.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  r.headers.set("Strict-Transport-Security", "max-age=31536000");
  return r;
}
