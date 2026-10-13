import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppConfig } from "./config.js";
import { registerExecTools } from "./exec-tools.js";
import { FileService } from "./file-service.js";
import { registerFileTools } from "./file-tools.js";
import { ProcessManager } from "./process-manager.js";
import { TaskMonitor } from "./task-monitor.js";
import { registerTaskTools } from "./task-tools.js";

export interface McpServices {
  processManager: ProcessManager;
  fileService: FileService;
  taskMonitor: TaskMonitor;
}

export function createServices(config: AppConfig): McpServices {
  const processManager = new ProcessManager({
    maxRetainedOutputBytes: config.maxRetainedProcessOutputBytes,
    processRetentionMs: config.processRetentionMs,
    maxProcesses: config.maxProcesses,
    defaultMaxOutputBytes: config.maxOutputBytes,
  });
  const fileService = new FileService({
    defaultCwd: config.defaultCwd,
    maxChunkBytes: config.maxFileChunkBytes,
    maxEditFileBytes: config.maxEditFileBytes,
    maxOutputBytes: config.maxOutputBytes,
  });
  return {
    processManager,
    fileService,
    taskMonitor: new TaskMonitor(processManager, { stallMs: config.taskStallMs }),
  };
}

export function createMcpServer(config: AppConfig, services: McpServices): McpServer {
  const server = new McpServer(
    {
      name: "cokacremote",
      version: "0.1.0",
    },
    {
      instructions:
        "MANDATORY TASK LIFECYCLE: For each NEW user-requested work sequence using Cokacremote, call task_begin exactly once BEFORE the first operational Cokacremote tool. Supply both the current userRequest and a short specific title in the user's language. Reapply this rule after switching to/from other MCPs, after a new user request in a long chat, and when the transport session changes. After all host actions and verification are finished, call task_complete before composing the final user-facing response; a deliberately persistent verified service may continue running. These lifecycle calls remain the intended user-request boundary. If you forget task_begin and the MCP response states that the server already performed a task_begin-equivalent start, DO NOT call task_begin again for that work; you MUST call task_complete once after verification. Server fallback cannot infer userRequest/title and may track continuation across sessions as separate work. This MCP cannot automatically read the user's prompt or infer a reliable task title. The server grants unrestricted host development access: use exec_command/run_script for shell, build, test, Git and processes; use file tools for files; poll long commands with read_process/write_stdin. An unattended detached process does not itself prove ChatGPT remains active.",
      capabilities: { logging: {} },
    },
  );

  registerTaskTools(server, config, services.taskMonitor);
  registerExecTools(
    server,
    config,
    services.processManager,
    services.fileService,
    services.taskMonitor,
  );
  registerFileTools(server, config, services.fileService);
  return server;
}
