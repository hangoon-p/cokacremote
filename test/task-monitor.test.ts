import { afterEach, describe, expect, it } from "vitest";

import { ProcessManager } from "../src/process-manager.js";
import { chatSessionFromMeta, TaskMonitor } from "../src/task-monitor.js";

function createManager(): ProcessManager {
  return new ProcessManager({
    maxRetainedOutputBytes: 1024 * 1024,
    processRetentionMs: 60_000,
    maxProcesses: 16,
    defaultMaxOutputBytes: 1024 * 1024,
  });
}

describe("TaskMonitor", () => {
  let manager: ProcessManager | undefined;

  afterEach(async () => {
    await manager?.shutdown();
  });

  it("extracts the ChatGPT conversation session from request metadata", () => {
    expect(
      chatSessionFromMeta({
        "openai/session": "chat-session-1",
      }),
    ).toBe("chat-session-1");
    expect(chatSessionFromMeta({}, "transport-session")).toBe("transport-session");
    expect(chatSessionFromMeta({})).toBeUndefined();
  });

  it("moves an explicitly started task from WORKING to COMPLETED", () => {
    manager = createManager();
    const events: Record<string, unknown>[] = [];
    const monitor = new TaskMonitor(manager, {
      stallMs: 1000,
      emit: (event) => events.push(event),
    });

    const started = monitor.begin(
      "chat-a",
      "Update the server and verify it",
      "Server update",
    );
    expect(started).toMatchObject({
      chatSession: "chat-a",
      status: "WORKING",
      explicitStart: true,
      userRequest: "Update the server and verify it",
      title: "Server update",
    });

    const completed = monitor.complete("chat-a", "Update verified");
    expect(completed).toMatchObject({
      taskId: started.taskId,
      status: "COMPLETED",
      summary: "Update verified",
    });
    expect(events.map((event) => event.reason)).toEqual([
      "task_begin",
      "task_complete",
    ]);
  });

  it("marks unfinished work STALLED after the configured inactivity threshold", () => {
    manager = createManager();
    const monitor = new TaskMonitor(manager, { stallMs: 1000, emit: () => {} });

    const started = monitor.begin("chat-a", "Do several MCP operations");
    monitor.toolStarted("chat-a", "read_file");
    monitor.toolFinished("chat-a", "read_file", "completed");

    const lastActivity = Date.parse(monitor.current("chat-a")!.lastActivityAt);
    monitor.refresh(lastActivity + 999);
    expect(monitor.current("chat-a")?.status).toBe("WORKING");

    monitor.refresh(lastActivity + 1000);
    expect(monitor.current("chat-a")).toMatchObject({
      taskId: started.taskId,
      status: "STALLED",
      stalledReason: "inactivity_timeout",
    });
  });

  it("upgrades an implicit task when task_begin arrives late", () => {
    manager = createManager();
    const monitor = new TaskMonitor(manager, { stallMs: 1000, emit: () => {} });

    const implicit = monitor.toolStarted("chat-a", "read_file");
    expect(implicit.status).toBe("OBSERVED");
    monitor.toolFinished("chat-a", "read_file", "completed");
    const explicit = monitor.begin("chat-a", "Inspect the current repository", "Repo inspection");

    expect(explicit).toMatchObject({
      taskId: implicit.taskId,
      status: "WORKING",
      explicitStart: true,
      userRequest: "Inspect the current repository",
      title: "Repo inspection",
    });
    expect(monitor.getState().tasks).toHaveLength(1);
  });

  it("keeps implicit activity visible as INACTIVE instead of completing it", () => {
    manager = createManager();
    const events: Record<string, unknown>[] = [];
    const monitor = new TaskMonitor(manager, {
      stallMs: 1000,
      emit: (event) => events.push(event),
    });

    monitor.toolStarted("chat-a", "read_file");
    monitor.toolFinished("chat-a", "read_file", "completed");
    const lastActivity = Date.parse(monitor.current("chat-a")!.lastActivityAt);

    monitor.refresh(lastActivity + 1000);

    expect(monitor.current("chat-a")).toMatchObject({
      status: "INACTIVE",
      explicitStart: false,
      inactiveReason: "inactivity_timeout",
      stalledAt: undefined,
      stalledReason: undefined,
    });
    expect(events.map((event) => event.reason)).toEqual([
      "implicit_task_start",
      "implicit_activity_inactive",
    ]);
  });

  it("resumes an INACTIVE implicit session as OBSERVED when MCP activity returns", () => {
    manager = createManager();
    const events: Record<string, unknown>[] = [];
    const monitor = new TaskMonitor(manager, {
      stallMs: 1000,
      emit: (event) => events.push(event),
    });

    const started = monitor.toolStarted("chat-a", "read_file");
    monitor.toolFinished("chat-a", "read_file", "completed");
    const lastActivity = Date.parse(monitor.current("chat-a")!.lastActivityAt);
    monitor.refresh(lastActivity + 1000);

    const resumed = monitor.toolStarted("chat-a", "write_file");
    expect(resumed).toMatchObject({
      taskId: started.taskId,
      status: "OBSERVED",
      explicitStart: false,
      inactiveAt: undefined,
      inactiveReason: undefined,
      lastTool: "write_file",
    });
    monitor.toolFinished("chat-a", "write_file", "completed");
    expect(monitor.getState().tasks).toHaveLength(1);
    expect(events.map((event) => event.reason)).toContain("implicit_activity_resumed");
  });

  it("refuses task_complete for unbracketed implicit activity", () => {
    manager = createManager();
    const monitor = new TaskMonitor(manager, { stallMs: 1000, emit: () => {} });
    monitor.toolStarted("chat-a", "read_file");
    monitor.toolFinished("chat-a", "read_file", "completed");

    expect(() => monitor.complete("chat-a")).toThrow("explicit task_begin");
  });

  it("keeps concurrent ChatGPT conversations isolated", () => {
    manager = createManager();
    const monitor = new TaskMonitor(manager, { stallMs: 1000, emit: () => {} });

    const first = monitor.begin("chat-a", "First task");
    const second = monitor.begin("chat-b", "Second task");
    monitor.complete("chat-a");

    expect(monitor.current("chat-a")).toMatchObject({
      taskId: first.taskId,
      status: "COMPLETED",
    });
    expect(monitor.current("chat-b")).toMatchObject({
      taskId: second.taskId,
      status: "WORKING",
    });
  });

  it("marks explicit work STALLED despite a detached process still running", () => {
    manager = createManager();
    const monitor = new TaskMonitor(manager, { stallMs: 1000, emit: () => {} });
    monitor.begin("chat-a", "Launch a persistent service");
    const processId = manager.start({
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      commandForDisplay: "persistent test server",
      cwd: process.cwd(),
    });
    monitor.trackProcess("chat-a", processId);
    const lastActivity = Date.parse(monitor.current("chat-a")!.lastActivityAt);
    monitor.refresh(lastActivity + 1000);
    expect(monitor.current("chat-a")).toMatchObject({
      status: "STALLED",
      stalledReason: "inactivity_timeout",
      runningProcesses: 1,
    });
  });

  it("marks an implicit session INACTIVE with a persistent managed process", () => {
    manager = createManager();
    const monitor = new TaskMonitor(manager, { stallMs: 1000, emit: () => {} });
    const created = monitor.toolStarted("chat-a", "exec_command");
    const processId = manager.start({
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      commandForDisplay: "persistent test server",
      cwd: process.cwd(),
    });
    monitor.trackProcess("chat-a", processId);
    monitor.toolFinished("chat-a", "exec_command", "completed");
    const lastActivity = Date.parse(monitor.current("chat-a")!.lastActivityAt);
    monitor.refresh(lastActivity + 1000);
    expect(monitor.current("chat-a")).toMatchObject({
      taskId: created.taskId,
      status: "INACTIVE",
      activeCalls: 0,
      runningProcesses: 1,
    });
    const resumed = monitor.toolStarted("chat-a", "read_process");
    expect(resumed).toMatchObject({ taskId: created.taskId, status: "OBSERVED" });
    monitor.toolFinished("chat-a", "read_process", "completed");
    expect(monitor.getState().tasks).toHaveLength(1);
  });

  it("does not count background process exit as fresh MCP activity", async () => {
    manager = createManager();
    const monitor = new TaskMonitor(manager, { stallMs: 1000, emit: () => {} });
    monitor.toolStarted("chat-a", "exec_command");
    const processId = manager.start({
      executable: process.execPath,
      args: ["-e", "setTimeout(() => {}, 300)"],
      commandForDisplay: "short background process",
      cwd: process.cwd(),
    });
    monitor.trackProcess("chat-a", processId);
    monitor.toolFinished("chat-a", "exec_command", "completed");
    const lastCallAt = Date.parse(monitor.current("chat-a")!.lastActivityAt);
    await manager.waitForExit(processId, 3000);
    const recordedProcess = manager.list().find((item) => item.sessionId === processId);
    expect(recordedProcess?.running).toBe(false);
    expect(Date.parse(recordedProcess!.endedAt!)).toBeGreaterThanOrEqual(lastCallAt);
    monitor.refresh(lastCallAt + 1000);
    expect(monitor.current("chat-a")).toMatchObject({
      status: "INACTIVE",
      lastActivityAt: new Date(lastCallAt).toISOString(),
      runningProcesses: 0,
    });
  });

  it("does not stall while an MCP request remains in flight", () => {
    manager = createManager();
    const monitor = new TaskMonitor(manager, { stallMs: 1000, emit: () => {} });
    monitor.begin("chat-a", "Wait for a long running MCP call");
    monitor.toolStarted("chat-a", "exec_command");
    const atStart = Date.parse(monitor.current("chat-a")!.lastActivityAt);
    monitor.refresh(atStart + 10000);
    expect(monitor.current("chat-a")).toMatchObject({ status: "WORKING", activeCalls: 1 });
    expect(() => monitor.complete("chat-a")).toThrow("MCP calls are still running");
    monitor.toolFinished("chat-a", "exec_command", "completed");
    const atFinish = Date.parse(monitor.current("chat-a")!.lastActivityAt);
    monitor.refresh(atFinish + 1000);
    expect(monitor.current("chat-a")?.status).toBe("STALLED");
  });

  it("periodic MCP polling keeps a background operation from timing out", () => {
    manager = createManager();
    const monitor = new TaskMonitor(manager, { stallMs: 1000, emit: () => {} });
    monitor.begin("chat-a", "Monitor a background task");
    for (let i = 0; i < 3; i += 1) {
      monitor.toolStarted("chat-a", "read_process");
      monitor.toolFinished("chat-a", "read_process", "completed");
      const activity = Date.parse(monitor.current("chat-a")!.lastActivityAt);
      monitor.refresh(activity + 999);
      expect(monitor.current("chat-a")?.status).toBe("WORKING");
    }
    const finalActivity = Date.parse(monitor.current("chat-a")!.lastActivityAt);
    monitor.refresh(finalActivity + 1000);
    expect(monitor.current("chat-a")?.status).toBe("STALLED");
  });

  it("allows task_complete after launching a persistent service", () => {
    manager = createManager();
    const monitor = new TaskMonitor(manager, { stallMs: 1000, emit: () => {} });
    monitor.begin("chat-a", "Launch and verify a service");
    monitor.toolStarted("chat-a", "exec_command");
    const processId = manager.start({
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      commandForDisplay: "long-lived server",
      cwd: process.cwd(),
    });
    monitor.trackProcess("chat-a", processId);
    expect(() => monitor.complete("chat-a")).toThrow("MCP calls are still running");
    monitor.toolFinished("chat-a", "exec_command", "completed");
    const completed = monitor.complete("chat-a", "Service is running");
    expect(completed).toMatchObject({
      status: "COMPLETED",
      runningProcesses: 1,
      summary: "Service is running",
    });
  });

  it("marks unfinished work superseded when a new user request starts in the same conversation", () => {
    manager = createManager();
    const monitor = new TaskMonitor(manager, { stallMs: 1000, emit: () => {} });

    const first = monitor.begin("chat-a", "First task");
    const second = monitor.begin("chat-a", "Second task");

    const firstSnapshot = monitor
      .getState()
      .tasks.find((task) => task.taskId === first.taskId);
    expect(firstSnapshot).toMatchObject({
      status: "STALLED",
      stalledReason: "superseded_by_new_task",
    });
    expect(second).toMatchObject({
      status: "WORKING",
      userRequest: "Second task",
    });
  });
});
