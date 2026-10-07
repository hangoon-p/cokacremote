const STATUS_PRIORITY = {
  STALLED: 4,
  WORKING: 3,
  OBSERVED: 2,
  COMPLETED: 1,
};

function taskActivityTime(task) {
  const value =
    task?.lastActivityAt ||
    task?.stalledAt ||
    task?.completedAt ||
    task?.startedAt ||
    "";
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function sessionStatus(tasks) {
  let result = "COMPLETED";
  let priority = 0;
  for (const task of tasks) {
    const status = String(task?.status || "OBSERVED");
    const next = STATUS_PRIORITY[status] || STATUS_PRIORITY.OBSERVED;
    if (next > priority) {
      result = status;
      priority = next;
    }
  }
  return result;
}

function representativeTask(tasks) {
  return [...tasks].sort((a, b) => {
    const aNamed = a?.title || a?.userRequest ? 1 : 0;
    const bNamed = b?.title || b?.userRequest ? 1 : 0;
    if (aNamed !== bNamed) return bNamed - aNamed;
    return taskActivityTime(b) - taskActivityTime(a);
  })[0];
}

export function shortSessionId(value) {
  const text = String(value || "").trim();
  if (!text) return "unknown";
  if (text.length <= 14) return text;
  return `${text.slice(0, 8)}…${text.slice(-5)}`;
}

export function groupTasksBySession(tasks, { includeCompleted = false } = {}) {
  const source = Array.isArray(tasks) ? tasks : [];
  const groups = new Map();

  for (const task of source) {
    if (!task || typeof task !== "object") continue;
    if (!includeCompleted && task.status === "COMPLETED") continue;

    const sessionKey =
      typeof task.chatSession === "string" && task.chatSession.trim()
        ? task.chatSession.trim()
        : "__unknown__";
    if (!groups.has(sessionKey)) {
      groups.set(sessionKey, []);
    }
    groups.get(sessionKey).push(task);
  }

  return [...groups.entries()]
    .map(([sessionKey, sessionTasks]) => {
      const sortedTasks = [...sessionTasks].sort(
        (a, b) => taskActivityTime(b) - taskActivityTime(a),
      );
      const representative = representativeTask(sortedTasks);
      const title =
        representative?.title ||
        representative?.userRequest ||
        (sessionKey === "__unknown__"
          ? "세션 식별 정보 없음"
          : `MCP 세션 ${shortSessionId(sessionKey)}`);
      return {
        sessionKey,
        sessionLabel:
          sessionKey === "__unknown__"
            ? "unknown"
            : shortSessionId(sessionKey),
        title: String(title).slice(0, 160),
        status: sessionStatus(sortedTasks),
        lastActivityAt: sortedTasks[0]?.lastActivityAt,
        tasks: sortedTasks,
      };
    })
    .sort((a, b) => {
      const priorityDiff =
        (STATUS_PRIORITY[b.status] || 0) - (STATUS_PRIORITY[a.status] || 0);
      if (priorityDiff !== 0) return priorityDiff;
      return taskActivityTime(b.tasks[0]) - taskActivityTime(a.tasks[0]);
    });
}
