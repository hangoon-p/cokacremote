import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { AppConfig } from "./config.js";
import type { TaskMonitor } from "./task-monitor.js";
import { runTool } from "./tool-result.js";
import { TOOL_ANNOTATIONS, toolAuthMetadata } from "./tool-metadata.js";

export const TASK_LIFECYCLE_TOOLS = new Set(["task_begin", "task_complete"]);

export function registerTaskTools(
  server: McpServer,
  config: AppConfig,
  taskMonitor: TaskMonitor,
): void {
  const authMetadata = toolAuthMetadata(config);

  server.registerTool(
    "task_begin",
    {
      title: "Begin monitored work",
      description:
        "Start monitoring the current user-requested work sequence. Call this exactly once before the first operational Cokacremote tool call for a new user request. Pass the user's current instruction in userRequest so the dashboard can identify the work. Repeated identical calls are idempotent.",
      inputSchema: {
        userRequest: z
          .string()
          .min(1)
          .max(50_000)
          .describe("The current user's request or instruction being worked on."),
        title: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("Optional short task title suitable for a dashboard."),
      },
      annotations: TOOL_ANNOTATIONS.additiveIdempotentClosed,
      _meta: authMetadata,
    },
    async ({ userRequest, title }, extra) =>
      runTool(() => {
        const chatSession = taskMonitor.requireChatSession(extra._meta, extra.sessionId);
        return taskMonitor.begin(chatSession, userRequest, title) as unknown as Record<
          string,
          unknown
        >;
      }),
  );

  server.registerTool(
    "task_complete",
    {
      title: "Complete monitored work",
      description:
        "Mark MCP-side work for the current user request complete. Call this only after every required Cokacremote action and verification is finished, and immediately before composing the final user-facing response. Do not call it while host-side work or a tracked process is still running.",
      inputSchema: {
        summary: z
          .string()
          .max(4000)
          .optional()
          .describe("Optional concise summary of the completed MCP-side work."),
      },
      annotations: TOOL_ANNOTATIONS.additiveIdempotentClosed,
      _meta: authMetadata,
    },
    async ({ summary }, extra) =>
      runTool(() => {
        const chatSession = taskMonitor.requireChatSession(extra._meta, extra.sessionId);
        return taskMonitor.complete(chatSession, summary) as unknown as Record<string, unknown>;
      }),
  );
}
