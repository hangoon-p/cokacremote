const $ = (id) => document.getElementById(id);

const authCard = $("authCard");
const controls = $("controls");
const tokenInput = $("token");
const instancesEl = $("instances");
const eventsEl = $("events");
const updatedEl = $("updated");
const countEl = $("instanceCount");
const pushStateEl = $("pushState");

let token = localStorage.getItem("cokacremote-dashboard-token") || "";
let refreshTimer;

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function relative(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}초 전`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.round(minutes / 60);
  return `${hours}시간 전`;
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

function taskHtml(task, now) {
  const status = task.status || "UNKNOWN";
  const kind = status === "COMPLETED" ? "ok" : status === "STALLED" ? "bad" : "warn";
  const title = task.title || task.userRequest || task.taskId || "작업";
  const inactive = task.lastActivityAt
    ? relative(Math.max(0, now - new Date(task.lastActivityAt).getTime()))
    : "-";
  return `
    <div class="task">
      <div class="row spread">
        <div class="taskTitle">${esc(String(title).slice(0, 160))}</div>
        ${badge(status, kind)}
      </div>
      <div class="taskMeta">
        마지막 도구 ${esc(task.lastTool || "-")} · 마지막 활동 ${esc(inactive)}
        ${task.runningProcesses ? ` · 실행 프로세스 ${task.runningProcesses}` : ""}
      </div>
    </div>`;
}

function instanceHtml(instance, serverTime) {
  const snapshot = instance.snapshot || {};
  const server = snapshot.server || {};
  const monitor = snapshot.monitor || {};
  const tunnel = snapshot.tunnel || {};
  const runtime = snapshot.runtime || {};
  const tasks = Array.isArray(monitor.state?.tasks) ? monitor.state.tasks : [];
  const activeTasks = tasks
    .filter((task) => task.status !== "COMPLETED")
    .sort((a, b) => String(b.lastActivityAt || "").localeCompare(String(a.lastActivityAt || "")));

  const tunnelUnknown = tunnel.source === "none" || !tunnel.source;
  const cards = [
    instance.offline ? badge("PC OFFLINE", "bad") : badge("PC ONLINE", "ok"),
    server.ok ? badge("MCP OK", "ok") : badge("MCP DOWN", "bad"),
    monitor.ok ? badge("MONITOR OK", "ok") : badge("MONITOR DOWN", "bad"),
    tunnelUnknown
      ? badge("TUNNEL N/A", "warn")
      : tunnel.ok
        ? badge("TUNNEL OK", "ok")
        : badge("TUNNEL DOWN", "bad"),
  ].join("");

  return `
    <article class="card">
      <div class="row spread">
        <div>
          <h3>${esc(instance.instanceId)}</h3>
          <div class="muted">${esc(instance.hostname || snapshot.hostname || "")}</div>
        </div>
        <div class="muted">${esc(relative(instance.ageMs || 0))}</div>
      </div>
      <div class="badges">${cards}</div>
      <div class="kv">
        <span>마지막 heartbeat</span><b>${esc(time(instance.lastSeenAt))}</b>
        <span>Runtime phase</span><b>${esc(runtime.phase || "-")}</b>
        <span>MCP 요청</span><b>${esc(server.health?.activeMcpRequests ?? "-")}</b>
        <span>관리 프로세스</span><b>${esc(server.health?.managedProcesses ?? "-")}</b>
        <span>Watcher 수집</span><b>${esc(time(snapshot.collectedAt))}</b>
      </div>
      <div class="tasks">
        <div class="row spread">
          <strong>진행/이상 작업</strong>
          <span class="muted">${activeTasks.length}건</span>
        </div>
        ${activeTasks.length
          ? activeTasks.map((task) => taskHtml(task, serverTime)).join("")
          : '<div class="empty">진행 중이거나 정지된 작업이 없습니다.</div>'}
      </div>
    </article>`;
}

function renderStatus(data) {
  const instances = data.instances || [];
  countEl.textContent = `${instances.length}대`;
  instancesEl.innerHTML = instances.length
    ? instances.map((instance) => instanceHtml(instance, data.serverTime)).join("")
    : '<div class="empty">아직 heartbeat가 없습니다.</div>';
  updatedEl.textContent = `업데이트 ${new Date(data.serverTime).toLocaleTimeString("ko-KR", {
    hour12: false,
  })} · Offline 기준 ${data.offlineAfterSeconds}초`;
}

function renderEvents(data) {
  const events = data.events || [];
  eventsEl.innerHTML = events.length
    ? events
        .map((event) => {
          const payload = event.payload || {};
          let body = "";
          if (payload.ageMs != null) body = `heartbeat 누락 ${relative(payload.ageMs)}`;
          if (payload.summary?.stalledTasks?.length) {
            body = `정지 작업 ${payload.summary.stalledTasks.length}건`;
          }
          return `
            <div class="event">
              <div class="eventTop">
                <span class="eventName">${esc(event.instanceId)} · ${esc(event.eventType)}</span>
                <span class="eventTime">${esc(time(event.occurredAt))}</span>
              </div>
              <div class="eventBody">${esc(event.severity)}${body ? ` · ${esc(body)}` : ""}</div>
            </div>`;
        })
        .join("")
    : '<div class="empty">이벤트가 없습니다.</div>';
}

async function refresh() {
  if (!token) return;
  try {
    const [status, events] = await Promise.all([
      api("/api/status"),
      api("/api/events?limit=40"),
    ]);
    authCard.classList.add("hidden");
    controls.classList.remove("hidden");
    renderStatus(status);
    renderEvents(events);
    await updatePushState();
  } catch (error) {
    updatedEl.textContent = error.message;
    if (error.message.includes("Token")) {
      authCard.classList.remove("hidden");
      controls.classList.add("hidden");
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
  controls.classList.add("hidden");
  authCard.classList.remove("hidden");
  instancesEl.innerHTML = "";
  eventsEl.innerHTML = "";
  updatedEl.textContent = "로그아웃됨";
});

if (token) {
  tokenInput.value = token;
  refresh();
}
serviceWorkerRegistration().catch(() => undefined);
clearInterval(refreshTimer);
refreshTimer = setInterval(refresh, 15000);
