import { buildPushPayload } from "@block65/webcrypto-web-push";

import {
  alertMessage,
  isHealthy,
  offlineMessage,
  recoveryMessage,
  statusKey,
  summarizeSnapshot,
  validSnapshot,
} from "./domain.js";

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function bearerToken(request) {
  const value = request.headers.get("authorization") || "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

function authorized(request, expected) {
  return (
    typeof expected === "string" &&
    expected.length > 0 &&
    bearerToken(request) === expected
  );
}

function offlineAfterMs(env) {
  const parsed = Number(env.OFFLINE_AFTER_SECONDS || "120");
  const seconds = Number.isFinite(parsed) && parsed >= 30 ? parsed : 120;
  return Math.round(seconds * 1000);
}

async function readJson(request, maxBytes = 512 * 1024) {
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error("Request body too large");
  }
  const text = await request.text();
  if (text.length > maxBytes) {
    throw new Error("Request body too large");
  }
  return JSON.parse(text);
}

function pushConfigured(env) {
  return Boolean(
    env.VAPID_SUBJECT &&
      env.VAPID_PUBLIC_KEY &&
      env.VAPID_PRIVATE_KEY,
  );
}

async function notifyAll(env, message) {
  if (!pushConfigured(env)) {
    return { configured: false, sent: 0, failed: 0, removed: 0 };
  }

  const rows = await env.DB.prepare(
    "SELECT endpoint, subscription_json FROM push_subscriptions",
  ).all();

  let sent = 0;
  let failed = 0;
  let removed = 0;
  const vapid = {
    subject: env.VAPID_SUBJECT,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  };

  for (const row of rows.results || []) {
    try {
      const subscription = JSON.parse(row.subscription_json);
      const payload = await buildPushPayload(
        {
          data: JSON.stringify(message),
          options: { ttl: 120 },
        },
        subscription,
        vapid,
      );
      const response = await fetch(subscription.endpoint, payload);
      if (response.ok) {
        sent += 1;
      } else {
        failed += 1;
        if (response.status === 404 || response.status === 410) {
          await env.DB.prepare(
            "DELETE FROM push_subscriptions WHERE endpoint = ?",
          )
            .bind(row.endpoint)
            .run();
          removed += 1;
        }
      }
      await response.body?.cancel().catch(() => undefined);
    } catch {
      failed += 1;
    }
  }

  return { configured: true, sent, failed, removed };
}

async function heartbeat(request, env, ctx) {
  if (!env.INGEST_TOKEN) {
    return json({ error: "INGEST_TOKEN is not configured" }, 503);
  }
  if (!authorized(request, env.INGEST_TOKEN)) {
    return json({ error: "unauthorized" }, 401);
  }

  let snapshot;
  try {
    snapshot = await readJson(request);
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : "invalid JSON" },
      400,
    );
  }
  if (!validSnapshot(snapshot)) {
    return json({ error: "invalid watcher snapshot" }, 400);
  }

  const now = Date.now();
  const summary = summarizeSnapshot(snapshot);
  const nextKey = statusKey(summary);
  const previous = await env.DB.prepare(
    `SELECT status_key, offline_notified
       FROM instances
      WHERE instance_id = ?`,
  )
    .bind(snapshot.instanceId)
    .first();

  await env.DB.prepare(
    `INSERT INTO instances
      (instance_id, snapshot_json, status_key, last_seen_at, offline_notified)
     VALUES (?, ?, ?, ?, 0)
     ON CONFLICT(instance_id) DO UPDATE SET
       snapshot_json = excluded.snapshot_json,
       status_key = excluded.status_key,
       last_seen_at = excluded.last_seen_at,
       offline_notified = 0`,
  )
    .bind(
      snapshot.instanceId,
      JSON.stringify(snapshot),
      nextKey,
      now,
    )
    .run();

  const wasOffline = previous?.offline_notified === 1;
  const stateChanged = Boolean(previous && previous.status_key !== nextKey);
  const healthy = isHealthy(summary);
  let notification;

  if (wasOffline) {
    notification = healthy
      ? recoveryMessage(snapshot.instanceId)
      : alertMessage(snapshot.instanceId, summary);
  } else if (stateChanged) {
    notification = healthy
      ? recoveryMessage(snapshot.instanceId)
      : alertMessage(snapshot.instanceId, summary);
  } else if (!previous && !healthy) {
    notification = alertMessage(snapshot.instanceId, summary);
  }

  if (notification) {
    ctx.waitUntil(notifyAll(env, notification));
  }

  return json({
    ok: true,
    instanceId: snapshot.instanceId,
    receivedAt: now,
    stateChanged,
    heartbeatRestored: wasOffline,
  });
}

async function listStatus(request, env) {
  if (!env.DASHBOARD_TOKEN) {
    return json({ error: "DASHBOARD_TOKEN is not configured" }, 503);
  }
  if (!authorized(request, env.DASHBOARD_TOKEN)) {
    return json({ error: "unauthorized" }, 401);
  }

  const now = Date.now();
  const offlineMs = offlineAfterMs(env);
  const rows = await env.DB.prepare(
    `SELECT instance_id, snapshot_json, last_seen_at, offline_notified
       FROM instances
      ORDER BY instance_id`,
  ).all();

  const instances = (rows.results || []).map((row) => {
    let snapshot;
    try {
      snapshot = JSON.parse(row.snapshot_json);
    } catch {
      snapshot = undefined;
    }
    const lastSeenAt = Number(row.last_seen_at);
    return {
      instanceId: row.instance_id,
      hostname:
        snapshot && typeof snapshot.hostname === "string"
          ? snapshot.hostname
          : "",
      lastSeenAt,
      ageMs: Math.max(0, now - lastSeenAt),
      offline: now - lastSeenAt > offlineMs,
      offlineNotified: row.offline_notified === 1,
      snapshot,
    };
  });

  return json({
    serverTime: now,
    offlineAfterSeconds: offlineMs / 1000,
    pushConfigured: pushConfigured(env),
    instances,
  });
}

function validSubscription(value) {
  return (
    value &&
    typeof value === "object" &&
    typeof value.endpoint === "string" &&
    value.endpoint.startsWith("https://") &&
    value.keys &&
    typeof value.keys === "object" &&
    typeof value.keys.p256dh === "string" &&
    typeof value.keys.auth === "string"
  );
}

async function subscribePush(request, env) {
  if (!env.DASHBOARD_TOKEN || !authorized(request, env.DASHBOARD_TOKEN)) {
    return json({ error: "unauthorized" }, 401);
  }

  let subscription;
  try {
    subscription = await readJson(request, 64 * 1024);
  } catch {
    return json({ error: "invalid subscription" }, 400);
  }
  if (!validSubscription(subscription)) {
    return json({ error: "invalid subscription" }, 400);
  }

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO push_subscriptions
      (endpoint, subscription_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       subscription_json = excluded.subscription_json,
       updated_at = excluded.updated_at`,
  )
    .bind(subscription.endpoint, JSON.stringify(subscription), now)
    .run();

  return json({ ok: true });
}

async function unsubscribePush(request, env) {
  if (!env.DASHBOARD_TOKEN || !authorized(request, env.DASHBOARD_TOKEN)) {
    return json({ error: "unauthorized" }, 401);
  }
  let body;
  try {
    body = await readJson(request, 16 * 1024);
  } catch {
    return json({ error: "invalid request" }, 400);
  }
  if (!body || typeof body.endpoint !== "string") {
    return json({ error: "endpoint is required" }, 400);
  }
  await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?")
    .bind(body.endpoint)
    .run();
  return json({ ok: true });
}

async function pushKey(request, env) {
  if (!env.DASHBOARD_TOKEN || !authorized(request, env.DASHBOARD_TOKEN)) {
    return json({ error: "unauthorized" }, 401);
  }
  if (!env.VAPID_PUBLIC_KEY) {
    return json({ error: "Web Push is not configured" }, 503);
  }
  return json({ publicKey: env.VAPID_PUBLIC_KEY });
}

async function testPush(request, env, ctx) {
  if (!env.DASHBOARD_TOKEN || !authorized(request, env.DASHBOARD_TOKEN)) {
    return json({ error: "unauthorized" }, 401);
  }
  if (!pushConfigured(env)) {
    return json({ error: "Web Push is not configured" }, 503);
  }
  ctx.waitUntil(
    notifyAll(env, {
      title: "Cokacremote notification test",
      body: "Push notifications are working.",
      url: "/",
      tag: "cokacremote-test",
    }),
  );
  return json({ ok: true });
}

async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  if (url.pathname === "/api/heartbeat" && request.method === "POST") {
    return heartbeat(request, env, ctx);
  }
  if (url.pathname === "/api/status" && request.method === "GET") {
    return listStatus(request, env);
  }
  if (url.pathname === "/api/push/key" && request.method === "GET") {
    return pushKey(request, env);
  }
  if (url.pathname === "/api/push/subscribe" && request.method === "POST") {
    return subscribePush(request, env);
  }
  if (url.pathname === "/api/push/subscribe" && request.method === "DELETE") {
    return unsubscribePush(request, env);
  }
  if (url.pathname === "/api/push/test" && request.method === "POST") {
    return testPush(request, env, ctx);
  }
  return json({ error: "not found" }, 404);
}

async function markOfflineInstances(env) {
  const now = Date.now();
  const cutoff = now - offlineAfterMs(env);
  const rows = await env.DB.prepare(
    `SELECT instance_id, last_seen_at
       FROM instances
      WHERE last_seen_at < ? AND offline_notified = 0`,
  )
    .bind(cutoff)
    .all();

  for (const row of rows.results || []) {
    const updated = await env.DB.prepare(
      `UPDATE instances
          SET offline_notified = 1
        WHERE instance_id = ?
          AND offline_notified = 0
          AND last_seen_at < ?`,
    )
      .bind(row.instance_id, cutoff)
      .run();
    if ((updated.meta?.changes || 0) === 0) {
      continue;
    }

    const ageMs = Math.max(0, now - Number(row.last_seen_at));
    await notifyAll(env, offlineMessage(row.instance_id, ageMs));
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(markOfflineInstances(env));
  },
};
