import test from "node:test";
import assert from "node:assert/strict";

import {
  alertMessage,
  isHealthy,
  offlineMessage,
  statusKey,
  summarizeSnapshot,
  validSnapshot,
} from "../src/domain.js";

function snapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    instanceId: "office-native",
    hostname: "office-pc",
    server: { ok: true },
    monitor: { ok: true, state: { tasks: [] } },
    tunnel: { ok: true, source: "runtime" },
    ...overrides,
  };
}

test("healthy snapshot summary", () => {
  const summary = summarizeSnapshot(snapshot());
  assert.equal(isHealthy(summary), true);
  assert.deepEqual(summary, {
    serverOk: true,
    monitorOk: true,
    tunnel: "ok",
    stalledTasks: [],
    workingTasks: 0,
  });
});

test("stalled tasks are stable and make the state unhealthy", () => {
  const value = snapshot({
    monitor: {
      ok: true,
      state: {
        tasks: [
          { taskId: "b", status: "STALLED", title: "Second" },
          { taskId: "a", status: "STALLED", userRequest: "First request" },
          { taskId: "c", status: "WORKING" },
        ],
      },
    },
  });
  const summary = summarizeSnapshot(value);
  assert.equal(isHealthy(summary), false);
  assert.deepEqual(
    summary.stalledTasks.map((task) => task.taskId),
    ["a", "b"],
  );
  assert.equal(summary.workingTasks, 1);
  assert.match(alertMessage("office-native", summary).body, /2 tasks stalled/);
});

test("unknown tunnel does not count as a tunnel outage", () => {
  const summary = summarizeSnapshot(
    snapshot({ tunnel: { ok: false, source: "none" } }),
  );
  assert.equal(summary.tunnel, "unknown");
  assert.equal(isHealthy(summary), true);
});

test("status key changes only for notification-relevant state", () => {
  const base = summarizeSnapshot(snapshot());
  const changed = summarizeSnapshot(
    snapshot({ server: { ok: false, latencyMs: 900 } }),
  );
  assert.notEqual(statusKey(base), statusKey(changed));

  const latencyOnly = summarizeSnapshot(
    snapshot({ server: { ok: true, latencyMs: 9999 } }),
  );
  assert.equal(statusKey(base), statusKey(latencyOnly));
});

test("watcher snapshot validation rejects malformed input", () => {
  assert.equal(validSnapshot(snapshot()), true);
  assert.equal(validSnapshot({}), false);
  assert.equal(validSnapshot(snapshot({ instanceId: "" })), false);
});

test("offline notification includes heartbeat age", () => {
  assert.match(offlineMessage("office-native", 125000).body, /125s/);
});


test("INACTIVE implicit activity remains visible telemetry without becoming a push alert", () => {
  const base = summarizeSnapshot(snapshot());
  const inactive = summarizeSnapshot(
    snapshot({
      monitor: {
        ok: true,
        state: {
          tasks: [
            {
              taskId: "implicit-a",
              status: "INACTIVE",
              explicitStart: false,
              lastTool: "exec_command",
            },
          ],
        },
      },
    }),
  );

  assert.equal(isHealthy(inactive), true);
  assert.deepEqual(inactive.stalledTasks, []);
  assert.equal(statusKey(inactive), statusKey(base));
});


test("historic STALLED does not alert when newest task in session is WORKING", () => {
  const summary = summarizeSnapshot(snapshot({ monitor: { ok: true, state: { tasks: [
    { taskId: "old", chatSession: "same-session", status: "STALLED",
      startedAt: "2026-10-13T07:00:00Z", lastActivityAt: "2026-10-13T07:30:00Z" },
    { taskId: "new", chatSession: "same-session", status: "WORKING",
      startedAt: "2026-10-13T08:00:00Z", lastActivityAt: "2026-10-13T08:00:00Z" }
  ] } } }));
  assert.deepEqual(summary.stalledTasks, []);
  assert.equal(summary.workingTasks, 1);
  assert.equal(isHealthy(summary), true);
});

test("stalled alert is restored for a new stalled user request", () => {
  const summary = summarizeSnapshot(snapshot({ monitor: { ok: true, state: { tasks: [
    { taskId: "old", chatSession: "same-session", status: "COMPLETED",
      startedAt: "2026-10-13T07:00:00Z" },
    { taskId: "new", chatSession: "same-session", status: "STALLED",
      startedAt: "2026-10-13T08:00:00Z" }
  ] } } }));
  assert.deepEqual(summary.stalledTasks.map((t) => t.taskId), ["new"]);
  assert.equal(isHealthy(summary), false);
});
