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

  it("does not stall while a tracked managed process is still running", async () => {
    manager = createManager();
    const monitor = new TaskMonitor(manager, { stallMs: 1000, emit: () => {} });
    monitor.begin("chat-a", "Run a background process");

    const sessionId = manager.start({
      executable: process.execPath,
      args: ["-e", "setTimeout(() => {}, 250)"],
      commandForDisplay: "background test process",
      cwd: process.cwd(),
    });
    monitor.trackProcess("chat-a", sessionId);

    monitor.refresh(Date.now() + 10_000);
    expect(monitor.current("chat-a")).toMatchObject({
      status: "WORKING",
      runningProcesses: 1,
    });

    await manager.waitForExit(sessionId, 2000);
    const ended = manager.list().find((process) => process.sessionId === sessionId);
    expect(ended?.endedAt).toEqual(expect.any(String));

    monitor.refresh(Date.parse(ended!.endedAt!) + 1001);
    expect(monitor.current("chat-a")).toMatchObject({
      status: "STALLED",
      runningProcesses: 0,
      stalledReason: "inactivity_timeout",
    });
  });

  it("refuses completion while a tracked managed process is running", async () => {
    manager = createManager();
    const monitor = new TaskMonitor(manager, { stallMs: 1000, emit: () => {} });
    monitor.begin("chat-a", "Run and verify a process");

    const sessionId = manager.start({
      executable: process.execPath,
      args: ["-e", "setTimeout(() => {}, 250)"],
      commandForDisplay: "completion guard process",
      cwd: process.cwd(),
    });
    monitor.trackProcess("chat-a", sessionId);

    expect(() => monitor.complete("chat-a")).toThrow(
      "tracked processes are still running",
    );

    await manager.waitForExit(sessionId, 2000);
    expect(monitor.complete("chat-a").status).toBe("COMPLETED");
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
