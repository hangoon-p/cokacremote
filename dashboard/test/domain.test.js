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
