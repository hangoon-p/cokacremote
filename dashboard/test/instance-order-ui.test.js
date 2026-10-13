import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { moveInstance, sortInstances } from "../public/task-groups.js";

// Exercise the actual in-page reorder handler with a minimal browser-like scope.
// A past regression used an undefined "ids" variable, which updated only memory:
// the next refresh showed the order, while the immediate rerender never ran.
const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const handler = appSource.match(/^function reorderInstance\(fromId, toId\) \{[\s\S]*?^\}/m)?.[0];
assert.ok(handler, "reorderInstance handler must be present in app.js");

test("changing instance order saves and rerenders immediately", () => {
  const instances = ["home", "office", "server"].map((instanceId) => ({ instanceId }));
  const saved = new Map();
  const renders = [];
  const scope = {
    lastStatusData: { instances, serverTime: Date.now() },
    instanceOrder: [],
    INSTANCE_ORDER_KEY: "cokacremote-instance-order-v1",
    moveInstance,
    localStorage: {
      setItem(key, value) {
        saved.set(key, value);
      },
    },
    renderStatus(data) {
      renders.push(sortInstances(data.instances, scope.instanceOrder).map((item) => item.instanceId));
    },
  };

  vm.createContext(scope);
  vm.runInContext(handler, scope);
  vm.runInContext('reorderInstance("server", "home")', scope);

  assert.equal(renders.length, 1, "must rerender synchronously on click/drop");
  assert.deepEqual(renders[0], ["server", "home", "office"]);
  assert.deepEqual(JSON.parse(saved.get(scope.INSTANCE_ORDER_KEY)), renders[0]);

  vm.runInContext('reorderInstance("office", "server")', scope);
  assert.equal(renders.length, 2);
  assert.deepEqual(renders[1], ["office", "server", "home"]);
  assert.deepEqual(JSON.parse(saved.get(scope.INSTANCE_ORDER_KEY)), renders[1]);

  // The next browser/app load uses the persisted ordering.
  assert.deepEqual(
    sortInstances(instances, JSON.parse(saved.get(scope.INSTANCE_ORDER_KEY)))
      .map((item) => item.instanceId),
    renders[1],
  );
});

test("a no-op reorder does not rewrite localStorage or rerender", () => {
  let writes = 0;
  let renders = 0;
  const scope = {
    lastStatusData: { instances: [{ instanceId: "home" }] },
    instanceOrder: [],
    INSTANCE_ORDER_KEY: "test-instance-order",
    moveInstance,
    localStorage: { setItem() { writes += 1; } },
    renderStatus() { renders += 1; },
  };
  vm.createContext(scope);
  vm.runInContext(handler, scope);
  vm.runInContext('reorderInstance("home", "home")', scope);
  assert.equal(writes, 0);
  assert.equal(renders, 0);
});
