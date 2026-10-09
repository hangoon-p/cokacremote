import test from "node:test";
import assert from "node:assert/strict";

import {
  groupTasksBySession,
  hiddenSessionStillApplies,
  sessionIsExpired,
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

test("recent completed tasks stay visible beside newer work in the same session", () => {
  const tasks = [
    {
      taskId: "done",
      chatSession: "session-a",
      status: "COMPLETED",
      title: "Old completed work",
      completedAt: "2026-10-07T08:01:00.000Z",
      lastActivityAt: "2026-10-07T08:00:00.000Z",
    },
    {
      taskId: "current",
      chatSession: "session-a",
      status: "WORKING",
      title: "Current work",
      lastActivityAt: "2026-10-07T09:00:00.000Z",
    },
  ];
  const now = Date.parse("2026-10-07T09:15:00.000Z");
  const groups = groupTasksBySession(tasks, { now });

  assert.equal(groups.length, 1);
  assert.equal(groups[0].tasks.length, 2);
  assert.equal(groups[0].tasks[0].taskId, "current");
  assert.equal(groups[0].title, "Current work");
  assert.equal(groupTasksBySession(tasks, { now, includeCompleted: false })[0].tasks.length, 1);
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


test("implicit activity without project or request never pretends a tool name is the task title", () => {
  const task = {
    taskId: "28d57dd6-8ee6-46bf-b0d0-2e9023d40572",
    chatSession: "session-a",
    status: "OBSERVED",
    lastTool: "replace_in_file",
    lastActivityAt: "2026-10-07T09:00:00.000Z",
  };

  assert.equal(taskDisplayTitle(task), "작업 내용 미지정");
  const [group] = groupTasksBySession([task]);
  assert.equal(group.title, "제목 미지정 세션");
  assert.equal(group.titleSource, "unknown");
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
  assert.equal(groups[0].title, "제목 미지정 세션");
  assert.equal(groups[1].status, "OBSERVED");
});


test("implicit activity uses repository context instead of tool names", () => {
  const [group] = groupTasksBySession([
    {
      taskId: "project-record",
      chatSession: "session-project",
      status: "OBSERVED",
      projectName: "ksystem-bridge",
      lastTool: "exec_command",
      lastActivityAt: "2026-10-07T09:00:00.000Z",
    },
  ]);

  assert.equal(group.title, "ksystem-bridge 관련 작업");
  assert.equal(group.titleSource, "project");
  assert.equal(taskDisplayTitle(group.tasks[0]), "ksystem-bridge 관련 작업");
});

test("INACTIVE session expires from the current view after 24 hours", () => {
  const [session] = groupTasksBySession([
    {
      taskId: "inactive-old",
      chatSession: "session-old",
      status: "INACTIVE",
      inactiveAt: "2026-10-06T09:00:00.000Z",
      lastActivityAt: "2026-10-06T08:57:00.000Z",
    },
  ]);

  assert.equal(
    sessionIsExpired(session, Date.parse("2026-10-07T08:59:59.000Z")),
    false,
  );
  assert.equal(
    sessionIsExpired(session, Date.parse("2026-10-07T09:00:00.000Z")),
    true,
  );
});

test("manual hide remains while session activity has not changed", () => {
  const record = {
    status: "INACTIVE",
    lastActivityAt: "2026-10-07T09:00:00.000Z",
  };
  const session = {
    status: "INACTIVE",
    lastActivityAt: "2026-10-07T09:00:00.000Z",
  };

  assert.equal(hiddenSessionStillApplies(record, session), true);
});

test("manual hide is cleared when new MCP activity is detected", () => {
  const record = {
    status: "INACTIVE",
    lastActivityAt: "2026-10-07T09:00:00.000Z",
  };

  assert.equal(
    hiddenSessionStillApplies(record, {
      status: "OBSERVED",
      lastActivityAt: "2026-10-07T09:05:00.000Z",
    }),
    false,
  );

  assert.equal(
    hiddenSessionStillApplies(
      {
        status: "OBSERVED",
        lastActivityAt: "2026-10-07T09:00:00.000Z",
      },
      {
        status: "OBSERVED",
        lastActivityAt: "2026-10-07T09:00:01.000Z",
      },
    ),
    false,
  );
});


test("COMPLETED sessions remain visible until exactly 24 hours after completion", () => {
  const completedAt = "2026-10-07T10:00:00.000Z";
  const tasks = [{
    taskId: "done",
    chatSession: "session-done",
    status: "COMPLETED",
    completedAt,
    lastActivityAt: "2026-10-07T09:55:00.000Z",
    title: "Finished work",
  }];
  const before = Date.parse("2026-10-08T09:59:59.999Z");
  const deadline = Date.parse("2026-10-08T10:00:00.000Z");
  const [session] = groupTasksBySession(tasks, { now: before });

  assert.equal(session.status, "COMPLETED");
  assert.equal(session.tasks.length, 1);
  assert.equal(session.completedAt, completedAt);
  assert.equal(sessionIsExpired(session, before), false);
  assert.equal(sessionIsExpired(session, deadline), true);
  assert.equal(groupTasksBySession(tasks, { now: deadline }).length, 0);
});

test("old COMPLETED tasks expire even when the same chat session becomes active again", () => {
  const tasks = [{
    taskId: "old",
    chatSession: "session-again",
    status: "COMPLETED",
    completedAt: "2026-10-07T09:00:00.000Z",
    lastActivityAt: "2026-10-07T09:00:00.000Z",
  }, {
    taskId: "new",
    chatSession: "session-again",
    status: "WORKING",
    lastActivityAt: "2026-10-08T09:01:00.000Z",
  }];
  const [session] = groupTasksBySession(tasks, {
    now: Date.parse("2026-10-08T09:01:00.000Z"),
  });
  assert.equal(session.status, "WORKING");
  assert.deepEqual(session.tasks.map((task) => task.taskId), ["new"]);
  assert.equal(sessionIsExpired(session, Date.parse("2026-10-08T09:01:00.000Z")), false);
});

test("COMPLETED manual hide persists until newer activity appears", () => {
  const hidden = {
    status: "COMPLETED",
    lastActivityAt: "2026-10-07T10:00:00.000Z",
  };
  assert.equal(hiddenSessionStillApplies(hidden, {
    status: "COMPLETED", lastActivityAt: "2026-10-07T10:00:00.000Z",
  }), true);
  assert.equal(hiddenSessionStillApplies(hidden, {
    status: "WORKING", lastActivityAt: "2026-10-07T11:00:00.000Z",
  }), false);
});

test("legacy COMPLETED tasks without completedAt fall back to lastActivityAt", () => {
  const tasks = [{
    status: "COMPLETED",
    chatSession: "old-compatible",
    lastActivityAt: "2026-10-07T09:00:00.000Z",
  }];
  assert.equal(groupTasksBySession(tasks, {
    now: Date.parse("2026-10-08T08:59:59.000Z"),
  }).length, 1);
  assert.equal(groupTasksBySession(tasks, {
    now: Date.parse("2026-10-08T09:00:00.000Z"),
  }).length, 0);
});
