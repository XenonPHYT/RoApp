import {
  json,
  assert,
  readText,
  epoch,
  safeError,
  AppError,
} from "../utils/helpers.js";
import { one } from "../database/db.js";
import { message, deferred } from "./responses.js";
import { handleCommand } from "./commands.js";
import {
  parseCustomId,
  immediateComponent,
  handleComponent,
} from "./components.js";
import { editOriginal } from "../utils/discord.js";
export async function verifySignature(publicKey, signature, timestamp, body) {
  if (
    !/^[a-f0-9]{64}$/i.test(publicKey || "") ||
    !/^[a-f0-9]{128}$/i.test(signature || "") ||
    !/^\d{10,11}$/.test(timestamp || "") ||
    Math.abs(epoch() - Number(timestamp)) > 300
  )
    return false;
  try {
    const hex = (s) =>
      new Uint8Array(s.match(/../g).map((x) => parseInt(x, 16)));
    const key = await crypto.subtle.importKey(
      "raw",
      hex(publicKey),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      hex(signature),
      new TextEncoder().encode(timestamp + body),
    );
  } catch {
    return false;
  }
}
export async function processInteraction(i, env) {
  if (i.type === 2) return handleCommand(i, env);
  if (i.type === 3 || i.type === 5) {
    parseCustomId(i.data.custom_id);
    return handleComponent(i, env);
  }
  return message("Unsupported interaction.");
}
export async function interactionRoute(request, env, ctx) {
  const body = await readText(request, 131072);
  assert(
    await verifySignature(
      env.DISCORD_PUBLIC_KEY,
      request.headers.get("X-Signature-Ed25519"),
      request.headers.get("X-Signature-Timestamp"),
      body,
    ),
    401,
    "invalid_signature",
  );
  let i;
  try {
    i = JSON.parse(body);
  } catch {
    assert(false, 400, "invalid_json");
  }
  if (i.type === 1) return json({ type: 1 });
  assert(/^\d{17,22}$/.test(i.id || ""), 400, "invalid_interaction");
  const receipt = await one(
    env,
    "INSERT INTO interaction_receipts(id,expires_at) VALUES(?,?) ON CONFLICT(id) DO NOTHING RETURNING id",
    i.id,
    epoch() + 900,
  );
  if (!receipt)
    return json(
      message(
        "This interaction has already been handled. Please use a fresh control.",
      ),
    );
  if (i.type === 2 && i.data.name === "help")
    return json(await handleCommand(i, env));
  assert(i.guild_id && i.member?.user?.id, 400, "guild_only");
  if (i.type === 3 || i.type === 5) {
    try {
      let timer;
      let immediate;
      try {
        // Submitting an application must not be abandoned half-way by a timer:
        // the write either completes or fails and the applicant is told which.
        const submitting = String(i.data?.custom_id).startsWith("asubmit:");
        immediate = await Promise.race([
          immediateComponent(i, env),
          new Promise((_, reject) => {
            if (submitting) return;
            timer = setTimeout(
              () =>
                reject(
                  new AppError(
                    503,
                    "interface_timeout",
                    "Discord authorization took too long. Open a fresh interface and retry.",
                  ),
                ),
              1600,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (immediate) return json(immediate);
    } catch (e) {
      const error = await safeError(e).json();
      return json(message(error.message || error.error));
    }
  }
  const work = (async () => {
    let result;
    try {
      result = await processInteraction(i, env);
    } catch (e) {
      const error = await safeError(e).json();
      result = message(error.message || error.error);
    }
    try {
      await editOriginal(env, i, result.data);
    } catch {
      console.error("RoApp deferred response delivery failed");
    }
  })();
  ctx.waitUntil(work);
  return json(deferred());
}
