import {
  groupTasksBySession,
  hiddenSessionStillApplies,
  sessionIsExpired,
  taskDisplayTitle,
  visibleTaskCount,
  sortInstances,
  moveInstance,
} from "/task-groups.js";

const $ = (id) => document.getElementById(id);

const authCard = $("authCard");
const tokenInput = $("token");
const instancesEl = $("instances");
const updatedEl = $("updated");
const countEl = $("instanceCount");
const pushStateEl = $("pushState");
const settingsButton = $("settings");
const settingsDialog = $("settingsDialog");
const hiddenSessionsEl = $("hiddenSessions");

const HIDDEN_SESSIONS_KEY = "cokacremote-hidden-sessions-v1";
const SESSION_TITLES_KEY = "cokacremote-session-titles-v1";
const INSTANCE_ORDER_KEY = "cokacremote-instance-order-v1";

let token = localStorage.getItem("cokacremote-dashboard-token") || "";
let refreshTimer;
let hiddenSessions = loadHiddenSessions();
let sessionTitles = loadSessionTitles();
let renderedSessions = new Map();
let editingSessionKey = null;
let lastStatusData = null;
let instanceOrder = loadInstanceOrder();
const sessionExpansion = new Map();
let draggingInstanceId = null;

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function loadInstanceOrder() {
  try {
    const ids = JSON.parse(localStorage.getItem(INSTANCE_ORDER_KEY) || "[]");
    return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function orderedInstances(instances) {
  return sortInstances(instances, instanceOrder);
}

function reorderInstance(fromId, toId) {
  if (!lastStatusData || fromId === toId) return;
  instanceOrder = moveInstance(lastStatusData.instances || [], instanceOrder, fromId, toId);
  localStorage.setItem(INSTANCE_ORDER_KEY, JSON.stringify(ids));
  renderStatus(lastStatusData);
}

function loadHiddenSessions() {
  try {
    const parsed = JSON.parse(localStorage.getItem(HIDDEN_SESSIONS_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function saveHiddenSessions() {
  localStorage.setItem(HIDDEN_SESSIONS_KEY, JSON.stringify(hiddenSessions));
}

function loadSessionTitles() {
  try {
    const value = JSON.parse(localStorage.getItem(SESSION_TITLES_KEY) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function saveSessionTitles() {
  localStorage.setItem(SESSION_TITLES_KEY, JSON.stringify(sessionTitles));
}

function displaySessionTitle(instanceId, session) {
  return sessionTitles[hiddenSessionKey(instanceId, session.sessionKey)] || session.title;
}

function hiddenSessionKey(instanceId, sessionKey) {
  return `${instanceId}::${sessionKey}`;
}

function hideSession(instanceId, session) {
  const key = hiddenSessionKey(instanceId, session.sessionKey);
  hiddenSessions[key] = {
    instanceId,
    sessionKey: session.sessionKey,
    title: displaySessionTitle(instanceId, session),
    sessionLabel: session.sessionLabel,
    status: session.status,
    lastActivityAt: session.lastActivityAt || "",
    hiddenAt: Date.now(),
  };
  saveHiddenSessions();
}

function restoreHiddenSession(key) {
  if (!(key in hiddenSessions)) return;
  delete hiddenSessions[key];
  saveHiddenSessions();
}

function isSessionManuallyHidden(instanceId, session) {
  const key = hiddenSessionKey(instanceId, session.sessionKey);
  const record = hiddenSessions[key];
  if (!record) return false;

  if (!hiddenSessionStillApplies(record, session)) {
    restoreHiddenSession(key);
    return false;
  }
  return true;
}

function renderHiddenSessions() {
  const entries = Object.entries(hiddenSessions).sort(
    ([, a], [, b]) => Number(b.hiddenAt || 0) - Number(a.hiddenAt || 0),
  );

  hiddenSessionsEl.innerHTML = entries.length
    ? entries
        .map(
          ([key, record]) => `
            <div class="hiddenSessionItem">
              <div class="hiddenSessionInfo">
                <strong>${esc(record.title || "숨긴 세션")}</strong>
                <span>${esc(record.instanceId || "")} · ${esc(record.sessionLabel || "")}</span>
              </div>
              <button
                class="smallIconButton ghost"
                type="button"
                data-restore-session="${esc(key)}"
                aria-label="세션 다시 표시"
                title="다시 표시"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/>
                  <circle cx="12" cy="12" r="2.8"/>
                </svg>
              </button>
            </div>`,
        )
        .join("")
    : '<div class="empty compactEmpty">숨긴 세션이 없습니다.</div>';
}

function relative(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}초 전`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.round(hours / 24);
  return `${days}일 전`;
}

function time(value) {
  if (!value) return "-";
  const date = typeof value === "number" ? new Date(value) : new Date(String(value));
  return Number.isNaN(date.getTime())
    ? "-"
    : date.toLocaleString("ko-KR", { hour12: false });
}

async function api(path, options = {}) {
  if (!token) throw new Error("Dashboard Token이 필요합니다.");
  const headers = new Headers(options.headers || {});
  headers.set("authorization", `Bearer ${token}`);
  if (options.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(path, { ...options, headers });
  let body;
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("Dashboard Token이 올바르지 않습니다.");
    }
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return body;
}

function badge(text, kind) {
  return `<span class="badge ${kind}">${esc(text)}</span>`;
}

function statusKind(status) {
  if (status === "COMPLETED") return "ok";
  if (status === "STALLED") return "bad";
  return "warn";
}

function taskHtml(task, now) {
  const status = task.status || "UNKNOWN";
  const title = taskDisplayTitle(task);
  const inactive = task.lastActivityAt
    ? relative(Math.max(0, now - new Date(task.lastActivityAt).getTime()))
    : "-";

  return `
    <div class="task">
      <div class="row spread">
        <div class="taskTitle">${esc(String(title).slice(0, 160))}</div>
        ${badge(status, statusKind(status))}
      </div>
      <div class="taskMeta">
        마지막 도구 ${esc(task.lastTool || "-")} · 마지막 활동 ${esc(inactive)}
        ${task.runningProcesses ? ` · 실행 프로세스 ${task.runningProcesses}` : ""}
      </div>
    </div>`;
}

function sessionHtml(instanceId, session, now) {
  const key = hiddenSessionKey(instanceId, session.sessionKey);
  const level = sessionExpansion.get(key) || 0;
  const count = visibleTaskCount(level, session.tasks.length);
  const inactive = session.lastActivityAt
    ? relative(Math.max(0, now - new Date(session.lastActivityAt).getTime()))
    : "-";

  return `
    <section class="chatSession">
      <div class="chatSessionHead">
        <div class="chatSessionIdentity">
          <div class="chatSessionTitle">${esc(displaySessionTitle(instanceId, session))}</div>
          <div class="chatSessionMeta">
            ChatGPT / MCP 세션 ${esc(session.sessionLabel)} · 마지막 활동 ${esc(inactive)}
          </div>
        </div>
        <div class="chatSessionActionColumn">
          <div class="chatSessionActions">
          ${badge(session.status, statusKind(session.status))}
          <button
            class="smallIconButton ghost"
            type="button"
            data-edit-session="${esc(hiddenSessionKey(instanceId, session.sessionKey))}"
            aria-label="세션 제목 수정"
            title="세션 제목 수정"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m15 5 4 4M4 20l4.8-1L20 7.8a2 2 0 0 0-2.8-2.8L6 16.2 4 20Z"/>
            </svg>
          </button>
          <button
            class="smallIconButton ghost sessionHideButton"
            type="button"
            data-hide-session="${esc(hiddenSessionKey(instanceId, session.sessionKey))}"
            aria-label="세션 숨기기"
            title="세션 숨기기"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3 3l18 18"/>
              <path d="M10.6 5.2A10.7 10.7 0 0 1 12 5c6 0 9.5 7 9.5 7a17.5 17.5 0 0 1-3.1 4.1M6.2 6.2C3.8 8 2.5 12 2.5 12s3.5 7 9.5 7c1.6 0 3-.5 4.2-1.1"/>
              <path d="M9.9 9.9A3 3 0 0 0 14.1 14.1"/>
            </svg>
          </button>
          </div>
          ${session.tasks.length > 1 ? `<button type="button" class="sessionExpandButton ghost"
            data-toggle-session="${esc(key)}" aria-expanded="${level !== 0}">
            ${level === 0 ? `펼치기 (${session.tasks.length}) ▾` : "접기 ▴"}
          </button>` : ""}
        </div>
      </div>
      <div class="chatSessionTasks">
        ${session.tasks.slice(0, count).map((task) => taskHtml(task, now)).join("")}
        ${level === 1 && session.tasks.length > 3 ? `<button type="button"
          class="taskMoreButton ghost" data-show-all="${esc(key)}">
          더 보기 (${session.tasks.length - 3}개) ▾</button>` : ""}
        ${level === 2 && session.tasks.length > 3 ? `<button type="button"
          class="taskMoreButton ghost" data-show-less="${esc(key)}">간략히 보기 ▴</button>` : ""}
      </div>
    </section>`;
}

function instanceHtml(instance, serverTime, index, total) {
  const snapshot = instance.snapshot || {};
  const server = snapshot.server || {};
  const monitor = snapshot.monitor || {};
  const tunnel = snapshot.tunnel || {};
  const tasks = Array.isArray(monitor.state?.tasks) ? monitor.state.tasks : [];
  const allSessions = groupTasksBySession(tasks, { now: serverTime });

  const activeSessions = allSessions.filter((session) => {
    if (sessionIsExpired(session, serverTime)) {
      restoreHiddenSession(hiddenSessionKey(instance.instanceId, session.sessionKey));
      return false;
    }
    if (isSessionManuallyHidden(instance.instanceId, session)) return false;

    renderedSessions.set(hiddenSessionKey(instance.instanceId, session.sessionKey), {
      instanceId: instance.instanceId,
      session,
    });
    return true;
  });

  const activeTaskCount = activeSessions.reduce(
    (total, session) => total + session.tasks.length,
    0,
  );

  const tunnelUnknown = tunnel.source === "none" || !tunnel.source;
  const online = !instance.offline && server.ok === true && monitor.ok === true &&
    (tunnelUnknown || tunnel.ok === true);
  const offlineReasons = [
    instance.offline ? "PC heartbeat 없음" : "",
    !server.ok ? "MCP 서버 연결 불가" : "",
    !monitor.ok ? "모니터 연결 불가" : "",
    !tunnelUnknown && !tunnel.ok ? "터널 연결 불가" : "",
  ].filter(Boolean).join(" · ");

  return `
    <article class="card instanceCard" data-instance-id="${esc(instance.instanceId)}" draggable="true">
      <div class="row spread">
        <div>
          <h3>${esc(instance.instanceId)}</h3>
          <div class="muted">${esc(instance.hostname || snapshot.hostname || "")}</div>
        </div>
        <div class="instanceControls">
          <div class="muted">${esc(relative(instance.ageMs || 0))}</div>
          <div class="instanceMoveButtons" title="끌어서 이동하거나 화살표로 순서를 변경합니다">
            <button type="button" class="smallIconButton ghost" data-instance-up="${esc(instance.instanceId)}"
              aria-label="${esc(instance.instanceId)} 위로 이동" ${index === 0 ? "disabled" : ""}>↑</button>
            <button type="button" class="smallIconButton ghost" data-instance-down="${esc(instance.instanceId)}"
              aria-label="${esc(instance.instanceId)} 아래로 이동" ${index === total - 1 ? "disabled" : ""}>↓</button>
          </div>
        </div>
      </div>
      <div class="instanceHeartbeat">
        <span>마지막 heartbeat</span><b>${esc(time(instance.lastSeenAt))}</b>
      </div>
      <div class="instanceState">
        ${badge(online ? "활성" : "비활성", online ? "ok" : "bad")}
        ${!online ? `<span class="muted">${esc(offlineReasons)}</span>` : ""}
      </div>
      <div class="tasks">
        <div class="row spread taskSectionHead">
          <strong>채팅/MCP 세션별 작업 상태</strong>
          <span class="muted">${activeSessions.length}세션 · ${activeTaskCount}작업</span>
        </div>
        <div class="sessionNote">
          INACTIVE 및 COMPLETED 작업은 각각 비활성화·완료 시점부터 24시간 후 자동으로 숨겨집니다. 수동으로 숨긴 세션도 새 MCP 활동이 감지되면 자동으로 다시 표시됩니다.
        </div>
        ${
          activeSessions.length
            ? activeSessions
                .map((session) => sessionHtml(instance.instanceId, session, serverTime))
                .join("")
            : '<div class="empty">표시할 최근 세션이 없습니다.</div>'
        }
      </div>
    </article>`;
}

function renderStatus(data) {
  const instances = orderedInstances(data.instances || []);
  lastStatusData = data;
  renderedSessions = new Map();

  countEl.textContent = `${instances.length}대`;
  instancesEl.innerHTML = instances.length
    ? instances.map((instance, index) => instanceHtml(instance, data.serverTime, index, instances.length)).join("")
    : '<div class="empty">아직 heartbeat가 없습니다.</div>';

  renderHiddenSessions();

  updatedEl.textContent = `업데이트 ${new Date(data.serverTime).toLocaleTimeString("ko-KR", {
    hour12: false,
  })} · Offline 기준 ${data.offlineAfterSeconds}초`;
}

async function refresh() {
  if (!token) return;
  try {
    const status = await api("/api/status");
    authCard.classList.add("hidden");
    settingsButton.classList.remove("hidden");
    renderStatus(status);
  } catch (error) {
    updatedEl.textContent = error.message;
    if (error.message.includes("Token")) {
      authCard.classList.remove("hidden");
      settingsButton.classList.add("hidden");
      if (settingsDialog.open) settingsDialog.close();
    }
  }
}

function base64UrlToBytes(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replaceAll("-", "+").replaceAll("_", "/");
  const raw = atob(base64);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

async function serviceWorkerRegistration() {
  if (!("serviceWorker" in navigator)) {
    throw new Error("이 브라우저는 Service Worker를 지원하지 않습니다.");
  }
  await navigator.serviceWorker.register("/sw.js");
  return navigator.serviceWorker.ready;
}

async function updatePushState() {
  if (!("Notification" in window) || !("PushManager" in window)) {
    pushStateEl.textContent = "이 브라우저에서는 Web Push를 사용할 수 없습니다.";
    return;
  }
  try {
    const registration = await serviceWorkerRegistration();
    const subscription = await registration.pushManager.getSubscription();
    pushStateEl.textContent = subscription
      ? "푸시 알림 등록됨"
      : Notification.permission === "denied"
        ? "알림 권한이 차단됨"
        : "푸시 알림 미등록";
  } catch (error) {
    pushStateEl.textContent = error.message;
  }
}

async function enablePush() {
  const registration = await serviceWorkerRegistration();
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("알림 권한이 허용되지 않았습니다.");
  }
  const { publicKey } = await api("/api/push/key");
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToBytes(publicKey),
    });
  }
  await api("/api/push/subscribe", {
    method: "POST",
    body: JSON.stringify(subscription.toJSON()),
  });
  await updatePushState();
}

$("authForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  token = tokenInput.value.trim();
  if (!token) return;
  localStorage.setItem("cokacremote-dashboard-token", token);
  await refresh();
});

$("refresh").addEventListener("click", refresh);

settingsButton.addEventListener("click", async () => {
  renderHiddenSessions();
  settingsDialog.showModal();
  await updatePushState();
});

$("closeSettings").addEventListener("click", () => settingsDialog.close());

settingsDialog.addEventListener("click", (event) => {
  if (event.target === settingsDialog) settingsDialog.close();
});

instancesEl.addEventListener("click", (event) => {
  const moveUp = event.target.closest("[data-instance-up]");
  const moveDown = event.target.closest("[data-instance-down]");
  if (moveUp || moveDown) {
    const ids = orderedInstances(lastStatusData?.instances || []).map((item) => item.instanceId);
    const id = (moveUp || moveDown).dataset[moveUp ? "instanceUp" : "instanceDown"];
    const target = ids[ids.indexOf(id) + (moveUp ? -1 : 1)];
    if (target) reorderInstance(id, target);
    return;
  }
  const toggle = event.target.closest("[data-toggle-session]");
  if (toggle) {
    const key = toggle.dataset.toggleSession;
    sessionExpansion.set(key, (sessionExpansion.get(key) || 0) === 0 ? 1 : 0);
    if (lastStatusData) renderStatus(lastStatusData);
    return;
  }
  const showAll = event.target.closest("[data-show-all]");
  const showLess = event.target.closest("[data-show-less]");
  if (showAll || showLess) {
    const key = (showAll || showLess).dataset[showAll ? "showAll" : "showLess"];
    sessionExpansion.set(key, showAll ? 2 : 1);
    if (lastStatusData) renderStatus(lastStatusData);
    return;
  }
  const editButton = event.target.closest("[data-edit-session]");
  if (editButton) {
    const key = editButton.dataset.editSession;
    const current = renderedSessions.get(key);
    if (current) {
      editingSessionKey = key;
      $("sessionTitleInput").value = sessionTitles[key] || "";
      $("sessionTitleInput").placeholder = current.session.title;
      $("titleDialog").showModal();
      $("sessionTitleInput").focus();
    }
    return;
  }
  const button = event.target.closest("[data-hide-session]");
  if (!button) return;

  const current = renderedSessions.get(button.dataset.hideSession);
  if (!current) return;

  hideSession(current.instanceId, current.session);
  renderHiddenSessions();
  refresh();
});

instancesEl.addEventListener("dragstart", (event) => {
  const card = event.target.closest(".instanceCard");
  if (!card) return;
  draggingInstanceId = card.dataset.instanceId;
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
});
instancesEl.addEventListener("dragover", (event) => {
  if (draggingInstanceId && event.target.closest(".instanceCard")) event.preventDefault();
});
instancesEl.addEventListener("drop", (event) => {
  const card = event.target.closest(".instanceCard");
  if (card && draggingInstanceId) {
    event.preventDefault();
    reorderInstance(draggingInstanceId, card.dataset.instanceId);
  }
  draggingInstanceId = null;
});
instancesEl.addEventListener("dragend", () => { draggingInstanceId = null; });

$("sessionTitleForm").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!editingSessionKey) return;
  const value = $("sessionTitleInput").value.trim().slice(0, 80);
  if (value) sessionTitles[editingSessionKey] = value;
  else delete sessionTitles[editingSessionKey];
  saveSessionTitles();
  $("titleDialog").close();
  editingSessionKey = null;
  refresh();
});

$("resetSessionTitle").addEventListener("click", () => {
  if (!editingSessionKey) return;
  delete sessionTitles[editingSessionKey];
  saveSessionTitles();
  $("titleDialog").close();
  editingSessionKey = null;
  refresh();
});

$("closeTitleDialog").addEventListener("click", () => $("titleDialog").close());
$("titleDialog").addEventListener("close", () => { editingSessionKey = null; });

hiddenSessionsEl.addEventListener("click", (event) => {
  const button = event.target.closest("[data-restore-session]");
  if (!button) return;

  restoreHiddenSession(button.dataset.restoreSession);
  renderHiddenSessions();
  refresh();
});

$("enablePush").addEventListener("click", async () => {
  try {
    await enablePush();
  } catch (error) {
    pushStateEl.textContent = error.message;
  }
});

$("testPush").addEventListener("click", async () => {
  try {
    await api("/api/push/test", { method: "POST" });
    pushStateEl.textContent = "테스트 알림 요청 전송됨";
  } catch (error) {
    pushStateEl.textContent = error.message;
  }
});

$("logout").addEventListener("click", () => {
  token = "";
  localStorage.removeItem("cokacremote-dashboard-token");
  tokenInput.value = "";
  settingsButton.classList.add("hidden");
  if (settingsDialog.open) settingsDialog.close();
  authCard.classList.remove("hidden");
  instancesEl.innerHTML = "";
  countEl.textContent = "";
  updatedEl.textContent = "로그아웃됨";
});

if (token) {
  tokenInput.value = token;
  refresh();
}

serviceWorkerRegistration().catch(() => undefined);

clearInterval(refreshTimer);
refreshTimer = setInterval(refresh, 15000);
