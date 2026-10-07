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
        "This server is an unrestricted remote development environment. Tools operate directly on the host with the MCP service process's full OS permissions. Use exec_command for shell, build, test, package, Git, service, and log workflows; run_script for complete Bash, Node.js, or Python scripts; and the file tools for direct file operations. Poll long-running commands with read_process or write_stdin. For each new user-requested work sequence that will use Cokacremote tools, call task_begin exactly once before the first operational tool call, include the current user's request, and always provide a short human-readable dashboard title in the user's language (normally about 8-24 characters/words, specific enough to recognize the work). After all host-side work and verification are finished, call task_complete immediately before composing the final user-facing response. Never call task_complete while work or a tracked process remains.",
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
