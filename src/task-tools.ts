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
        "REQUIRED FIRST STEP for each new user request that uses this Cokacremote MCP: call task_begin BEFORE any operational tool. This also applies after switching from another MCP or when the conversation is long/split. Always pass both userRequest (the user's current instruction) and a concise specific title in the user's language; the dashboard cannot infer a missing user request. Repeated identical calls are idempotent.",
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
          .describe("REQUIRED: concise, specific title in the user's language describing this work (not a generic tool label)."),
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
        "REQUIRED LAST STEP for Cokacremote work started by task_begin OR the MCP server's begin-equivalent fallback: call task_complete after every required Cokacremote action and verification and before the final user-facing response. When the server already started work, do NOT call task_begin again for the same work. Do not call it while a required MCP action or its verification is still ongoing. It is valid to complete after launching and verifying an intentionally persistent service; a remaining background process alone is not unfinished ChatGPT work.",
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
