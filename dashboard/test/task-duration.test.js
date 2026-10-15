import test from "node:test";
import assert from "node:assert/strict";
import { taskElapsedMs, formatTaskDuration } from "../public/task-groups.js";

test("WORKING and OBSERVED clocks keep increasing from the original start", () => {
  const startedAt = "2026-10-15T08:00:00Z";
  const task = { startedAt, lastActivityAt: "2026-10-15T08:01:00Z" };
  for (const status of ["WORKING", "OBSERVED"]) {
    assert.equal(taskElapsedMs({ ...task, status }, Date.parse("2026-10-15T08:05:00Z")), 300000);
    assert.equal(taskElapsedMs({ ...task, status }, Date.parse("2026-10-15T08:07:00Z")), 420000);
  }
});

test("INACTIVE, STALLED and COMPLETED clocks freeze at their state transitions", () => {
  const startedAt = "2026-10-15T08:00:00Z";
  const later = Date.parse("2026-10-15T13:00:00Z");
  const fixed = { startedAt, lastActivityAt: "2026-10-15T08:02:00Z" };
  for (const [status, field] of [
    ["INACTIVE", "inactiveAt"],
    ["STALLED", "stalledAt"],
    ["COMPLETED", "completedAt"],
  ]) {
    const task = { ...fixed, status, [field]: "2026-10-15T08:11:00Z" };
    assert.equal(taskElapsedMs(task, Date.parse("2026-10-15T08:12:00Z")), 660000);
    assert.equal(taskElapsedMs(task, later), 660000);
  }
});

test("legacy stopped tasks fall back to last activity; missing start is unknown", () => {
  const task = { startedAt: "2026-10-15T08:00:00Z",
    lastActivityAt: "2026-10-15T08:02:00Z", status: "COMPLETED" };
  assert.equal(taskElapsedMs(task, Date.parse("2026-10-15T13:00:00Z")), 120000);
  assert.equal(taskElapsedMs({ ...task, startedAt: undefined }), null);
  assert.equal(taskElapsedMs({ ...task, startedAt: "invalid" }), null);
  assert.equal(taskElapsedMs({ ...task, completedAt: "2026-10-15T07:59:00Z" }), 0);
});

test("task clock displays compact Korean minutes, hours and days", () => {
  assert.equal(formatTaskDuration(null), "-");
  assert.equal(formatTaskDuration(59000), "1분 미만");
  assert.equal(formatTaskDuration(125000), "2분");
  assert.equal(formatTaskDuration(3720000), "1시간 2분");
  assert.equal(formatTaskDuration(93720000), "1일 2시간 2분");
});
