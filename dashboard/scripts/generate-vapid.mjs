const pair = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"],
);
const publicKey = Buffer.from(
  await crypto.subtle.exportKey("raw", pair.publicKey),
).toString("base64url");
const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
if (!privateJwk.d) throw new Error("Failed to export VAPID private key");
console.log("VAPID_PUBLIC_KEY=" + publicKey);
console.log("VAPID_PRIVATE_KEY=" + privateJwk.d);
