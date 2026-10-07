const STATUS_PRIORITY = {
  STALLED: 5,
  WORKING: 4,
  INACTIVE: 3,
  OBSERVED: 2,
  COMPLETED: 1,
};

const TOOL_TITLES = {
  exec_command: "명령 실행",
  run_script: "스크립트 실행",
  read_process: "실행 상태 확인",
  write_stdin: "프로세스 입력",
  terminate_process: "프로세스 종료",
  list_processes: "프로세스 확인",
  read_file: "파일 확인",
  write_file: "파일 작성",
  replace_in_file: "파일 수정",
  apply_patch: "코드 패치",
  list_directory: "폴더 확인",
  stat_path: "파일 정보 확인",
  make_directory: "폴더 생성",
  copy_path: "파일 복사",
  move_path: "파일 이동",
  remove_path: "파일 삭제",
  chmod_path: "권한 변경",
  upload_file: "파일 업로드",
  download_file: "파일 다운로드",
  hash_file: "파일 검증",
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

function compactText(value, maxLength = 42) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function inferredTitle(tasks) {
  const tool = tasks.find((task) => task?.lastTool)?.lastTool;
  if (!tool) return "제목 없는 MCP 작업";
  return `${TOOL_TITLES[tool] || tool} 작업`;
}

export function taskDisplayTitle(task) {
  const explicitTitle = compactText(task?.title, 48);
  if (explicitTitle) return explicitTitle;
  const requestTitle = compactText(task?.userRequest, 42);
  if (requestTitle) return requestTitle;
  const tool = task?.lastTool;
  return tool ? `${TOOL_TITLES[tool] || tool} 작업` : "관찰 작업";
}

export const INACTIVE_DISPLAY_RETENTION_MS = 24 * 60 * 60 * 1000;

export function sessionIsExpired(
  session,
  now = Date.now(),
  retentionMs = INACTIVE_DISPLAY_RETENTION_MS,
) {
  if (!session || session.status !== "INACTIVE") return false;
  const reference = session.inactiveAt || session.lastActivityAt;
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
            : "inferred",
        status: sessionStatus(sortedTasks),
        lastActivityAt: sortedTasks[0]?.lastActivityAt,
        inactiveAt: sortedTasks
          .filter((task) => task?.status === "INACTIVE" && task?.inactiveAt)
          .map((task) => task.inactiveAt)
          .sort()
          .at(-1),
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
