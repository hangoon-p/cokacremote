import test from "node:test";
import assert from "node:assert/strict";

import {
  groupTasksBySession,
  shortSessionId,
  taskDisplayTitle,
} from "../public/task-groups.js";

test("groups active tasks by MCP session", () => {
  const groups = groupTasksBySession([
    {
      taskId: "a1",
      chatSession: "session-a",
      status: "WORKING",
      title: "First chat work",
      lastActivityAt: "2026-10-07T09:00:00.000Z",
    },
    {
      taskId: "a2",
      chatSession: "session-a",
      status: "OBSERVED",
      lastActivityAt: "2026-10-07T09:01:00.000Z",
    },
    {
      taskId: "b1",
      chatSession: "session-b",
      status: "STALLED",
      userRequest: "Second chat request",
      lastActivityAt: "2026-10-07T08:59:00.000Z",
    },
  ]);

  assert.equal(groups.length, 2);
  assert.equal(groups[0].sessionKey, "session-b");
  assert.equal(groups[0].status, "STALLED");
  assert.equal(groups[0].title, "Second chat request");
  assert.equal(groups[1].sessionKey, "session-a");
  assert.equal(groups[1].status, "WORKING");
  assert.equal(groups[1].tasks.length, 2);
});

test("STALLED wins the aggregate session status", () => {
  const [group] = groupTasksBySession([
    {
      taskId: "1",
      chatSession: "session-a",
      status: "WORKING",
      lastActivityAt: "2026-10-07T09:00:00.000Z",
    },
    {
      taskId: "2",
      chatSession: "session-a",
      status: "STALLED",
      lastActivityAt: "2026-10-07T08:59:00.000Z",
    },
  ]);

  assert.equal(group.status, "STALLED");
});

test("completed tasks are hidden from current session view by default", () => {
  const groups = groupTasksBySession([
    {
      taskId: "done",
      chatSession: "session-a",
      status: "COMPLETED",
      title: "Old completed work",
      lastActivityAt: "2026-10-07T08:00:00.000Z",
    },
    {
      taskId: "current",
      chatSession: "session-a",
      status: "WORKING",
      title: "Current work",
      lastActivityAt: "2026-10-07T09:00:00.000Z",
    },
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].tasks.length, 1);
  assert.equal(groups[0].tasks[0].taskId, "current");
  assert.equal(groups[0].title, "Current work");
});

test("representative title prefers a named task over an unnamed newer task", () => {
  const [group] = groupTasksBySession([
    {
      taskId: "named",
      chatSession: "session-a",
      status: "WORKING",
      title: "Readable chat title",
      lastActivityAt: "2026-10-07T09:00:00.000Z",
    },
    {
      taskId: "unnamed",
      chatSession: "session-a",
      status: "OBSERVED",
      lastActivityAt: "2026-10-07T09:02:00.000Z",
    },
  ]);

  assert.equal(group.title, "Readable chat title");
  assert.equal(group.tasks[0].taskId, "unnamed");
});

test("unknown session activity remains grouped safely", () => {
  const [group] = groupTasksBySession([
    {
      taskId: "unknown",
      status: "OBSERVED",
      lastActivityAt: "2026-10-07T09:00:00.000Z",
    },
  ]);

  assert.equal(group.sessionKey, "__unknown__");
  assert.equal(group.sessionLabel, "unknown");
  assert.equal(group.title, "세션 식별 정보 없음");
});

test("long session ids are shortened for display only", () => {
  assert.equal(
    shortSessionId("1234567890abcdefghijklmnopqrstuvwxyz"),
    "12345678…vwxyz",
  );
});


test("implicit activity gets a readable tool-based title instead of a UUID", () => {
  const task = {
    taskId: "28d57dd6-8ee6-46bf-b0d0-2e9023d40572",
    chatSession: "session-a",
    status: "OBSERVED",
    lastTool: "replace_in_file",
    lastActivityAt: "2026-10-07T09:00:00.000Z",
  };

  assert.equal(taskDisplayTitle(task), "파일 수정 작업");
  const [group] = groupTasksBySession([task]);
  assert.equal(group.title, "파일 수정 작업");
  assert.equal(group.titleSource, "inferred");
});

test("long user requests are compacted for the session heading", () => {
  const [group] = groupTasksBySession([
    {
      taskId: "request",
      chatSession: "session-a",
      status: "WORKING",
      userRequest:
        "대시보드는 밝은 테마로 바꾸고 알림은 설정으로 옮기면서 세션 제목도 짧고 알아보기 쉽게 표시해줘",
      lastActivityAt: "2026-10-07T09:00:00.000Z",
    },
  ]);

  assert.ok(group.title.length <= 42);
  assert.match(group.title, /…$/);
  assert.equal(group.titleSource, "request");
});


test("INACTIVE implicit sessions remain visible and rank above OBSERVED", () => {
  const groups = groupTasksBySession([
    {
      taskId: "observed",
      chatSession: "session-observed",
      status: "OBSERVED",
      lastTool: "read_file",
      lastActivityAt: "2026-10-07T09:02:00.000Z",
    },
    {
      taskId: "inactive",
      chatSession: "session-inactive",
      status: "INACTIVE",
      lastTool: "exec_command",
      lastActivityAt: "2026-10-07T09:00:00.000Z",
    },
  ]);

  assert.equal(groups.length, 2);
  assert.equal(groups[0].status, "INACTIVE");
  assert.equal(groups[0].title, "명령 실행 작업");
  assert.equal(groups[1].status, "OBSERVED");
});
