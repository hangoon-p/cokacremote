import { randomUUID } from "node:crypto";

import type { ProcessManager } from "./process-manager.js";

export type TaskStatus = "WORKING" | "COMPLETED" | "STALLED";

export interface TaskSnapshot {
  taskId: string;
  chatSession: string;
  status: TaskStatus;
  explicitStart: boolean;
  userRequest: string | undefined;
  title: string | undefined;
  summary: string | undefined;
  startedAt: string;
  lastActivityAt: string;
  completedAt: string | undefined;
  stalledAt: string | undefined;
  stalledReason: string | undefined;
  lastTool: string | undefined;
  activeCalls: number;
  trackedProcesses: number;
  runningProcesses: number;
}

export interface TaskMonitorState {
  stallMs: number;
  tasks: TaskSnapshot[];
}

interface TaskRecord {
  taskId: string;
  chatSession: string;
  status: TaskStatus;
  explicitStart: boolean;
  userRequest: string | undefined;
  title: string | undefined;
  summary: string | undefined;
  startedAt: number;
  lastActivityAt: number;
  completedAt: number | undefined;
  stalledAt: number | undefined;
  stalledReason: string | undefined;
  lastTool: string | undefined;
  activeCalls: number;
  processSessionIds: Set<string>;
}

export interface TaskMonitorOptions {
  stallMs: number;
  maxTasks?: number;
  emit?: ((event: Record<string, unknown>) => void) | undefined;
}

function iso(value: number | undefined): string | undefined {
  return value === undefined ? undefined : new Date(value).toISOString();
}

function metaValue(meta: unknown, key: string): unknown {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return undefined;
  }
  return (meta as Record<string, unknown>)[key];
}

export function chatSessionFromMeta(
  meta: unknown,
  transportSessionId?: string,
): string | undefined {
  const openAiSession = metaValue(meta, "openai/session");
  if (typeof openAiSession === "string" && openAiSession.trim()) {
    return openAiSession.trim();
  }
  if (transportSessionId?.trim()) {
    return transportSessionId.trim();
  }
  return undefined;
}

export class TaskMonitor {
  readonly #processManager: ProcessManager;
  readonly #stallMs: number;
  readonly #maxTasks: number;
  readonly #emit: (event: Record<string, unknown>) => void;
  readonly #currentBySession = new Map<string, TaskRecord>();
  readonly #tasks: TaskRecord[] = [];

  constructor(processManager: ProcessManager, options: TaskMonitorOptions) {
    this.#processManager = processManager;
    this.#stallMs = options.stallMs;
    this.#maxTasks = options.maxTasks ?? 100;
    this.#emit =
      options.emit ??
      ((event) => {
        console.log(JSON.stringify(event));
      });
  }

  requireChatSession(meta: unknown, transportSessionId?: string): string {
    const chatSession = chatSessionFromMeta(meta, transportSessionId);
    if (!chatSession) {
      throw new Error(
        "A stable client session is required. ChatGPT supplies _meta[\"openai/session\"] on tool calls.",
      );
    }
    return chatSession;
  }

  begin(chatSession: string, userRequest: string, title?: string): TaskSnapshot {
    const now = Date.now();
    const existing = this.#currentBySession.get(chatSession);
    if (
      existing?.status === "WORKING" &&
      existing.explicitStart &&
      existing.userRequest === userRequest
    ) {
      existing.lastActivityAt = now;
      if (title?.trim()) {
        existing.title = title.trim();
      }
      return this.#snapshot(existing);
    }

    if (existing?.status === "WORKING" && !existing.explicitStart) {
      existing.explicitStart = true;
      existing.userRequest = userRequest;
      existing.title = title?.trim() || existing.title;
      existing.lastActivityAt = now;
      this.#emitState(existing, "task_begin_late");
      return this.#snapshot(existing);
    }

    if (existing?.status === "WORKING") {
      this.#markStalled(existing, now, "superseded_by_new_task");
    }

    const task = this.#createTask(chatSession, now, {
      explicitStart: true,
      userRequest,
      title: title?.trim() || undefined,
    });
    this.#emitState(task, "task_begin");
    return this.#snapshot(task);
  }

  toolStarted(chatSession: string, toolName: string): TaskSnapshot {
    const now = Date.now();
    let task = this.#currentBySession.get(chatSession);
    if (!task || task.status !== "WORKING") {
      task = this.#createTask(chatSession, now, { explicitStart: false });
      this.#emitState(task, "implicit_task_start");
    }
    task.activeCalls += 1;
    task.lastActivityAt = now;
    task.lastTool = toolName;
    return this.#snapshot(task);
  }

  toolFinished(
    chatSession: string,
    toolName: string,
    outcome: "completed" | "aborted",
  ): TaskSnapshot | undefined {
    const task = this.#currentBySession.get(chatSession);
    if (!task || task.status !== "WORKING") {
      return task ? this.#snapshot(task) : undefined;
    }
    task.activeCalls = Math.max(0, task.activeCalls - 1);
    task.lastActivityAt = Date.now();
    task.lastTool = toolName;
    if (outcome === "aborted") {
      this.#emitState(task, "tool_request_aborted");
    }
    return this.#snapshot(task);
  }

  trackProcess(chatSession: string, processSessionId: string): void {
    const task = this.#currentBySession.get(chatSession);
    if (!task || task.status !== "WORKING") {
      return;
    }
    task.processSessionIds.add(processSessionId);
  }

  complete(chatSession: string, summary?: string): TaskSnapshot {
    const task = this.#currentBySession.get(chatSession);
    if (!task) {
      throw new Error("No active monitored task exists for this ChatGPT session.");
    }
    if (task.status === "COMPLETED") {
      return this.#snapshot(task);
    }
    if (task.status === "STALLED") {
      throw new Error(
        "The current monitored task is already STALLED. Start or resume work with task_begin before completing it.",
      );
    }

    const processState = this.#processState(task);
    if (task.activeCalls > 0 || processState.runningProcesses > 0) {
      throw new Error(
        "Cannot mark the task complete while MCP calls or tracked processes are still running.",
      );
    }

    const now = Date.now();
    task.status = "COMPLETED";
    task.completedAt = now;
    task.lastActivityAt = Math.max(task.lastActivityAt, processState.lastProcessActivityAt ?? 0, now);
    task.summary = summary?.trim() || undefined;
    this.#emitState(task, "task_complete");
    return this.#snapshot(task);
  }

  refresh(now = Date.now()): TaskMonitorState {
    for (const task of this.#currentBySession.values()) {
      if (task.status !== "WORKING") {
        continue;
      }
      const processState = this.#processState(task);
      if (processState.lastProcessActivityAt !== undefined) {
        task.lastActivityAt = Math.max(task.lastActivityAt, processState.lastProcessActivityAt);
      }
      if (task.activeCalls > 0 || processState.runningProcesses > 0) {
        continue;
      }
      if (now - task.lastActivityAt >= this.#stallMs) {
        this.#markStalled(task, now, "inactivity_timeout");
      }
    }
    return this.getState();
  }

  getState(): TaskMonitorState {
    return {
      stallMs: this.#stallMs,
      tasks: this.#tasks.map((task) => this.#snapshot(task)),
    };
  }

  current(chatSession: string): TaskSnapshot | undefined {
    const task = this.#currentBySession.get(chatSession);
    return task ? this.#snapshot(task) : undefined;
  }

  #createTask(
    chatSession: string,
    now: number,
    input: {
      explicitStart: boolean;
      userRequest?: string | undefined;
      title?: string | undefined;
    },
  ): TaskRecord {
    const task: TaskRecord = {
      taskId: randomUUID(),
      chatSession,
      status: "WORKING",
      explicitStart: input.explicitStart,
      userRequest: input.userRequest,
      title: input.title,
      summary: undefined,
      startedAt: now,
      lastActivityAt: now,
      completedAt: undefined,
      stalledAt: undefined,
      stalledReason: undefined,
      lastTool: undefined,
      activeCalls: 0,
      processSessionIds: new Set(),
    };
    this.#currentBySession.set(chatSession, task);
    this.#tasks.push(task);
    while (this.#tasks.length > this.#maxTasks) {
      const removed = this.#tasks.shift();
      if (removed && this.#currentBySession.get(removed.chatSession) === removed) {
        this.#currentBySession.delete(removed.chatSession);
      }
    }
    return task;
  }

  #processState(task: TaskRecord): {
    runningProcesses: number;
    lastProcessActivityAt: number | undefined;
  } {
    if (task.processSessionIds.size === 0) {
      return { runningProcesses: 0, lastProcessActivityAt: undefined };
    }
    const tracked = new Set(task.processSessionIds);
    let runningProcesses = 0;
    let lastProcessActivityAt: number | undefined;
    for (const process of this.#processManager.list()) {
      if (!tracked.has(process.sessionId)) {
        continue;
      }
      if (process.running) {
        runningProcesses += 1;
      }
      const activity = process.endedAt
        ? Date.parse(process.endedAt)
        : Date.parse(process.startedAt);
      if (Number.isFinite(activity)) {
        lastProcessActivityAt = Math.max(lastProcessActivityAt ?? 0, activity);
      }
    }
    return { runningProcesses, lastProcessActivityAt };
  }

  #markStalled(task: TaskRecord, now: number, reason: string): void {
    if (task.status !== "WORKING") {
      return;
    }
    task.status = "STALLED";
    task.stalledAt = now;
    task.stalledReason = reason;
    this.#emitState(task, reason);
  }

  #snapshot(task: TaskRecord): TaskSnapshot {
    const processState = this.#processState(task);
    return {
      taskId: task.taskId,
      chatSession: task.chatSession,
      status: task.status,
      explicitStart: task.explicitStart,
      userRequest: task.userRequest,
      title: task.title,
      summary: task.summary,
      startedAt: new Date(task.startedAt).toISOString(),
      lastActivityAt: new Date(task.lastActivityAt).toISOString(),
      completedAt: iso(task.completedAt),
      stalledAt: iso(task.stalledAt),
      stalledReason: task.stalledReason,
      lastTool: task.lastTool,
      activeCalls: task.activeCalls,
      trackedProcesses: task.processSessionIds.size,
      runningProcesses: processState.runningProcesses,
    };
  }

  #emitState(task: TaskRecord, reason: string): void {
    const snapshot = this.#snapshot(task);
    this.#emit({
      event: "task_state",
      reason,
      taskId: snapshot.taskId,
      chatSession: snapshot.chatSession,
      status: snapshot.status,
      explicitStart: snapshot.explicitStart,
      title: snapshot.title,
      lastTool: snapshot.lastTool,
      startedAt: snapshot.startedAt,
      lastActivityAt: snapshot.lastActivityAt,
      completedAt: snapshot.completedAt,
      stalledAt: snapshot.stalledAt,
      activeCalls: snapshot.activeCalls,
      trackedProcesses: snapshot.trackedProcesses,
      runningProcesses: snapshot.runningProcesses,
    });
  }
}
