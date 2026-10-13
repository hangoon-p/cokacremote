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

// A session reflects the newest task, never historic status severity.
export function taskStartTime(task) {
  const parsed = Date.parse(String(task?.startedAt || task?.lastActivityAt || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}
export function latestTask(tasks) {
  return [...tasks].sort((a, b) =>
    taskStartTime(b) - taskStartTime(a) ||
    taskActivityTime(b) - taskActivityTime(a)
  )[0];
}
// 0 newest only; 1 newest three; 2 all.
export function visibleTaskCount(level, count) {
  return level === 2 ? count : Math.min(count, level === 1 ? 3 : 1);
}

function representativeTask(tasks) {
  return [...tasks].sort((a, b) => {
    const aNamed = a?.title || a?.userRequest ? 1 : 0;
    const bNamed = b?.title || b?.userRequest ? 1 : 0;
    if (aNamed !== bNamed) return bNamed - aNamed;
    return taskActivityTime(b) - taskActivityTime(a);
  })[0];
}

function compactText(value, maxLength = 42) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function inferredTitle(tasks) {
  const project = tasks.find((task) => task?.projectName)?.projectName;
  return project ? `${compactText(project, 38)} 관련 작업` : "제목 미지정 세션";
}

export function taskDisplayTitle(task) {
  const explicitTitle = compactText(task?.title, 48);
  if (explicitTitle) return explicitTitle;
  const requestTitle = compactText(task?.userRequest, 42);
  if (requestTitle) return requestTitle;
  if (task?.projectName) return `${compactText(task.projectName, 38)} 관련 작업`;
  return "작업 내용 미지정";
}

export const INACTIVE_DISPLAY_RETENTION_MS = 24 * 60 * 60 * 1000;

function completedTaskIsExpired(task, now, retentionMs) {
  const timestamp = Date.parse(String(task?.completedAt || task?.lastActivityAt || ""));
  return Number.isFinite(timestamp) && now - timestamp >= retentionMs;
}

export function sessionIsExpired(
  session,
  now = Date.now(),
  retentionMs = INACTIVE_DISPLAY_RETENTION_MS,
) {
  if (!session || (session.status !== "INACTIVE" && session.status !== "COMPLETED")) {
    return false;
  }
  const reference = session.status === "COMPLETED"
    ? session.completedAt || session.lastActivityAt
    : session.inactiveAt || session.lastActivityAt;
  const timestamp = Date.parse(String(reference || ""));
  if (!Number.isFinite(timestamp)) return false;
  return now - timestamp >= retentionMs;
}

export function hiddenSessionStillApplies(record, session) {
  if (!record || !session) return false;

  const activeStatuses = new Set(["OBSERVED", "WORKING", "STALLED"]);
  if (
    activeStatuses.has(String(session.status || "")) &&
    String(record.status || "") !== String(session.status || "")
  ) {
    return false;
  }

  const hiddenActivity = Date.parse(String(record.lastActivityAt || ""));
  const currentActivity = Date.parse(String(session.lastActivityAt || ""));
  if (!Number.isFinite(currentActivity)) return true;
  if (!Number.isFinite(hiddenActivity)) return false;
  return currentActivity <= hiddenActivity;
}

export function shortSessionId(value) {
  const text = String(value || "").trim();
  if (!text) return "unknown";
  if (text.length <= 14) return text;
  return `${text.slice(0, 8)}…${text.slice(-5)}`;
}

export function groupTasksBySession(
  tasks,
  { includeCompleted = true, now = Date.now(), retentionMs = INACTIVE_DISPLAY_RETENTION_MS } = {},
) {
  const source = Array.isArray(tasks) ? tasks : [];
  const groups = new Map();

  for (const task of source) {
    if (!task || typeof task !== "object") continue;
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
        (a, b) => taskStartTime(b) - taskStartTime(a) ||
          taskActivityTime(b) - taskActivityTime(a),
      );
      // Determine the latest session state BEFORE filtering expired history.
      // Otherwise an older STALLED entry would revive after newer COMPLETED expires.
      const visibleTasks = sortedTasks.filter((task) =>
        (includeCompleted || task.status !== "COMPLETED") &&
        !(task.status === "COMPLETED" && completedTaskIsExpired(task, now, retentionMs))
      );
      const representative = representativeTask(sortedTasks);
      const explicitTitle = compactText(representative?.title, 48);
      const requestTitle = compactText(representative?.userRequest, 42);
      const fallbackTitle =
        sessionKey === "__unknown__"
          ? "세션 식별 정보 없음"
          : inferredTitle(sortedTasks);
      return {
        sessionKey,
        sessionLabel:
          sessionKey === "__unknown__"
            ? "unknown"
            : shortSessionId(sessionKey),
        title: explicitTitle || requestTitle || fallbackTitle,
        titleSource: explicitTitle
          ? "title"
          : requestTitle
            ? "request"
            : sortedTasks.some((task) => task?.projectName)
              ? "project"
              : "unknown",
        status: sortedTasks[0]?.status || "OBSERVED",
        lastActivityAt: sortedTasks[0]?.lastActivityAt,
        inactiveAt: sortedTasks
          .filter((task) => task?.status === "INACTIVE" && task?.inactiveAt)
          .map((task) => task.inactiveAt)
          .sort()
          .at(-1),
        completedAt: sortedTasks
          .filter((task) => task?.status === "COMPLETED")
          .map((task) => task.completedAt || task.lastActivityAt)
          .filter(Boolean)
          .sort()
          .at(-1),
        tasks: visibleTasks,
      };
    })
    .filter((session) =>
      !(session.status === "COMPLETED" && sessionIsExpired(session, now, retentionMs))
    )
    .sort((a, b) => (Date.parse(String(b.lastActivityAt || "")) || 0) -
      (Date.parse(String(a.lastActivityAt || "")) || 0));
}

// Browser-local instance order; newly discovered instances follow in ID order.
export function sortInstances(instances, order = []) {
  const ranks = new Map(order.map((id, i) => [id, i]));
  return [...instances].sort((a, b) =>
    (ranks.get(a.instanceId) ?? Infinity) - (ranks.get(b.instanceId) ?? Infinity) ||
    a.instanceId.localeCompare(b.instanceId));
}

export function moveInstance(instances, order, fromId, toId) {
  const ids = sortInstances(instances, order).map((entry) => entry.instanceId);
  const from = ids.indexOf(fromId);
  const to = ids.indexOf(toId);
  if (from < 0 || to < 0 || from === to) return ids;
  ids.splice(to, 0, ...ids.splice(from, 1));
  return ids;
}
