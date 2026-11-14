import test from "node:test";
import assert from "node:assert/strict";
import {
  verifySignature,
  interactionRoute,
  processInteraction,
} from "../src/discord/interactions.js";
import { parseCustomId } from "../src/discord/components.js";
import { testDB } from "./support.js";
const hex = (b) => Buffer.from(b).toString("hex");
async function signed(body) {
  const keys = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  const publicKey = hex(await crypto.subtle.exportKey("raw", keys.publicKey));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = hex(
    await crypto.subtle.sign(
      "Ed25519",
      keys.privateKey,
      new TextEncoder().encode(timestamp + body),
    ),
  );
  return { publicKey, signature, timestamp };
}
test("Ed25519 verifies valid bytes and rejects altered, malformed and expired input", async () => {
  const b = '{"type":1}',
    s = await signed(b);
  assert.equal(
    await verifySignature(s.publicKey, s.signature, s.timestamp, b),
    true,
  );
  assert.equal(
    await verifySignature(s.publicKey, s.signature, s.timestamp, b + " "),
    false,
  );
  assert.equal(
    await verifySignature(s.publicKey, "bad", s.timestamp, b),
    false,
  );
  assert.equal(await verifySignature(s.publicKey, s.signature, "1", b), false);
});
test("signed Discord PING and invalid signature HTTP boundary", async () => {
  const body = '{"type":1}',
    s = await signed(body);
  const req = () =>
    new Request("https://test/api/discord/interactions", {
      method: "POST",
      headers: {
        "X-Signature-Ed25519": s.signature,
        "X-Signature-Timestamp": s.timestamp,
      },
      body,
    });
  assert.deepEqual(
    await (
      await interactionRoute(req(), { DISCORD_PUBLIC_KEY: s.publicKey }, {})
    ).json(),
    { type: 1 },
  );
  await assert.rejects(
    interactionRoute(req(), { DISCORD_PUBLIC_KEY: "00".repeat(32) }, {}),
    (e) => e.status === 401,
  );
});
test("help is ephemeral and custom IDs reject malformed input", async () => {
  const r = await processInteraction(
    { type: 2, data: { name: "help" } },
    { APP_ORIGIN: "https://example.com", DB: testDB() },
  );
  assert.equal(r.data.flags, 64);
  assert.match(r.data.embeds[0].title, /help/);
  assert.deepEqual(parseCustomId("apply:abcdef"), ["apply", "abcdef"]);
  assert.throws(() => parseCustomId("../evil"));
  assert.throws(() => parseCustomId("x:".repeat(100)));
});
