import { AsyncLocalStorage } from "node:async_hooks";
import type { TaskMonitor } from "./task-monitor.js";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { errorMessage } from "./errors.js";

interface LifecycleReminderContext {
  taskMonitor: TaskMonitor;
  chatSession: string;
  taskId: string;
}

const lifecycleReminderContext = new AsyncLocalStorage<LifecycleReminderContext>();

// Scope a reminder to this specific MCP request without altering any tool's
// payload contract or adding lifecycle-related parameters to every tool.
export function withLifecycleReminderContext<T>(
  context: LifecycleReminderContext,
  action: () => T,
): T {
  return lifecycleReminderContext.run(context, action);
}

export const SERVER_TASK_BEGIN_NOTICE =
  "[MCP task lifecycle notice] task_begin was not received for this monitored " +
  "work. The MCP server has already performed the task_begin-equivalent start: " +
  "status is WORKING. Do NOT issue another task_begin for this same work. " +
  "After all work and verification, call task_complete exactly once. " +
  "The original tool action was already executed: use its result normally and " +
  "do not repeat the action. The server does not know the user's request/title; " +
  "this fallback cannot prove a new user-request boundary if transport sessions changed.";

function attachLifecycleReminder(result: CallToolResult): CallToolResult {
  const context = lifecycleReminderContext.getStore();
  if (!context?.taskMonitor.takeServerBeginNotice(context.chatSession, context.taskId)) {
    return result;
  }
  return {
    ...result,
    // structuredContent, isError and the original content blocks are unchanged.
    content: [...result.content, { type: "text", text: SERVER_TASK_BEGIN_NOTICE }],
  };
}

export function successResult(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

export function errorResult(error: unknown): CallToolResult {
  const data = { error: errorMessage(error) };
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
    isError: true,
  };
}

export async function runTool(
  operation: () => Promise<Record<string, unknown>> | Record<string, unknown>,
): Promise<CallToolResult> {
  // Only create a server-started WORKING task after the MCP SDK has dispatched
  // a real registered tool to its handler. Invalid tool names/schema requests
  // must not spawn phantom WORKING/STALLED alerts.
  const context = lifecycleReminderContext.getStore();
  if (context) {
    context.taskMonitor.beginOnMissingMarker(context.chatSession, context.taskId);
  }
  let result: CallToolResult;
  try {
    result = successResult(await operation());
  } catch (error) {
    result = errorResult(error);
  }
  return attachLifecycleReminder(result);
}
