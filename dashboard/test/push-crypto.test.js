import test from "node:test";
import assert from "node:assert/strict";

import { buildPushPayload } from "@block65/webcrypto-web-push";

test("builds an Apple-compatible aes128gcm Web Push payload", async () => {
  const vapidPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const vapidPublicKey = Buffer.from(
    await crypto.subtle.exportKey("raw", vapidPair.publicKey),
  ).toString("base64url");
  const vapidPrivate = await crypto.subtle.exportKey("jwk", vapidPair.privateKey);

  const clientPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const clientPublicKey = Buffer.from(
    await crypto.subtle.exportKey("raw", clientPair.publicKey),
  ).toString("base64url");
  const auth = Buffer.from(
    crypto.getRandomValues(new Uint8Array(16)),
  ).toString("base64url");

  const payload = await buildPushPayload(
    {
      data: JSON.stringify({ title: "test", body: "ok" }),
      options: { ttl: 60 },
    },
    {
      endpoint: "https://push.example.test/subscription",
      expirationTime: null,
      keys: { p256dh: clientPublicKey, auth },
    },
    {
      subject: "https://example.test",
      publicKey: vapidPublicKey,
      privateKey: vapidPrivate.d,
    },
  );

  const headers = new Headers(payload.headers);
  assert.equal(payload.method.toUpperCase(), "POST");
  assert.match(headers.get("authorization") || "", /^vapid /);
  assert.equal(headers.get("content-encoding"), "aes128gcm");
  assert.ok(payload.body);
  assert.ok(payload.body.byteLength > 0);
});
