export function summarizeSnapshot(snapshot) {
  const tasks = Array.isArray(snapshot?.monitor?.state?.tasks)
    ? snapshot.monitor.state.tasks
    : [];
  const stalledTasks = tasks
    .filter((task) => task && typeof task === "object" && task.status === "STALLED")
    .map((task) => ({
      taskId: String(task.taskId || ""),
      title: String(task.title || task.userRequest || task.taskId || "Task").slice(0, 160),
    }))
    .sort((a, b) => a.taskId.localeCompare(b.taskId));
  const workingTasks = tasks.filter(
    (task) => task && typeof task === "object" && task.status === "WORKING",
  ).length;
  const tunnelConfigured = snapshot?.tunnel?.source && snapshot.tunnel.source !== "none";
  return {
    serverOk: snapshot?.server?.ok === true,
    monitorOk: snapshot?.monitor?.ok === true,
    tunnel: tunnelConfigured
      ? snapshot?.tunnel?.ok === true
        ? "ok"
        : "down"
      : "unknown",
    stalledTasks,
    workingTasks,
  };
}

export function statusKey(summary) {
  return JSON.stringify({
    serverOk: summary.serverOk,
    monitorOk: summary.monitorOk,
    tunnel: summary.tunnel,
    stalledTaskIds: summary.stalledTasks.map((task) => task.taskId),
  });
}

export function isHealthy(summary) {
  return (
    summary.serverOk &&
    summary.monitorOk &&
    summary.tunnel !== "down" &&
    summary.stalledTasks.length === 0
  );
}

export function alertMessage(instanceId, summary) {
  const problems = [];
  if (!summary.serverOk) problems.push("MCP server unavailable");
  if (!summary.monitorOk) problems.push("task monitor unavailable");
  if (summary.tunnel === "down") problems.push("secure tunnel unavailable");
  if (summary.stalledTasks.length > 0) {
    const first = summary.stalledTasks[0];
    problems.push(
      summary.stalledTasks.length === 1
        ? `task stalled: ${first.title}`
        : `${summary.stalledTasks.length} tasks stalled`,
    );
  }
  return {
    title: `Cokacremote alert · ${instanceId}`,
    body: problems.join(" · ") || "State changed",
    url: "/",
    tag: `cokacremote-${instanceId}`,
  };
}

export function recoveryMessage(instanceId) {
  return {
    title: `Cokacremote recovered · ${instanceId}`,
    body: "Server, task monitor, and tunnel are healthy.",
    url: "/",
    tag: `cokacremote-${instanceId}`,
  };
}

export function offlineMessage(instanceId, ageMs) {
  const seconds = Math.max(0, Math.round(ageMs / 1000));
  return {
    title: `Cokacremote offline · ${instanceId}`,
    body: `No watcher heartbeat for ${seconds}s.`,
    url: "/",
    tag: `cokacremote-${instanceId}`,
  };
}

export function validSnapshot(value) {
  return (
    value &&
    typeof value === "object" &&
    value.schemaVersion === 1 &&
    typeof value.instanceId === "string" &&
    value.instanceId.length > 0 &&
    value.instanceId.length <= 128 &&
    typeof value.hostname === "string" &&
    value.hostname.length <= 255 &&
    value.server &&
    typeof value.server === "object" &&
    value.monitor &&
    typeof value.monitor === "object" &&
    value.tunnel &&
    typeof value.tunnel === "object"
  );
}
