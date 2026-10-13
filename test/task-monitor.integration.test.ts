import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig, type AppConfig } from "../src/config.js";
import { startHttpServer, type RunningHttpServer } from "../src/http-server.js";
import { createServices } from "../src/mcp-server.js";

interface JsonRpcResponse {
  result?: {
    structuredContent?: Record<string, unknown>;
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
}

interface MonitorTask {
  taskId: string;
  chatSession: string;
  status: "OBSERVED" | "INACTIVE" | "WORKING" | "COMPLETED" | "STALLED";
  explicitStart: boolean;
  serverStarted?: boolean;
  userRequest?: string;
  title?: string;
  projectName?: string;
  summary?: string;
  lastTool?: string;
  activeCalls: number;
  trackedProcesses: number;
  runningProcesses: number;
}

interface MonitorState {
  stallMs: number;
  tasks: MonitorTask[];
}

describe("task monitor HTTP integration", () => {
  let temporaryDirectory: string;
  let config: AppConfig;
  let running: RunningHttpServer;
  let endpoint: URL;
  let monitorEndpoint: URL;

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "cokacremote-monitor-test-"));
    config = loadConfig(
      {
        MCP_AUTH_TOKEN: "monitor-test-secret",
        MCP_HOST: "127.0.0.1",
        MCP_DEFAULT_CWD: temporaryDirectory,
        MCP_TASK_STALL_MS: "1000",
      },
      temporaryDirectory,
    );
    config.port = 0;
    running = await startHttpServer(config, createServices(config));
    const address = running.httpServer.address() as AddressInfo;
    endpoint = new URL(`http://127.0.0.1:${address.port}${config.endpoint}`);
    monitorEndpoint = new URL("/monitor", endpoint);
  });

  afterAll(async () => {
    await running.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  const post = async (
    body: unknown,
    chatSession?: string,
  ): Promise<Response> => {
    const normalized =
      chatSession && body && typeof body === "object" && !Array.isArray(body)
        ? {
            ...(body as Record<string, unknown>),
            params: {
              ...(((body as Record<string, unknown>).params as Record<string, unknown>) ?? {}),
              _meta: { "openai/session": chatSession },
            },
          }
        : body;
    return fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: "Bearer monitor-test-secret",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify(normalized),
    });
  };

  const readMonitor = async (): Promise<MonitorState> => {
    const response = await fetch(monitorEndpoint, {
      headers: { authorization: "Bearer monitor-test-secret" },
    });
    expect(response.status).toBe(200);
    return (await response.json()) as MonitorState;
  };

  it("exposes lifecycle tools to raw MCP clients", async () => {
    const response = await post({ jsonrpc: "2.0", id: 77, method: "tools/list", params: {} });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result?: { tools?: Array<{ name: string; inputSchema?: { required?: string[] } }> }
    };
    expect(body.result?.tools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["task_begin", "task_complete"]),
    );
    const begin = body.result?.tools?.find((tool) => tool.name === "task_begin");
    expect(begin?.inputSchema?.required).toEqual(expect.arrayContaining(["userRequest", "title"]));
  });

  it("extracts project context without retaining raw command arguments", async () => {
    const projectPath = path.join(temporaryDirectory, "dev", "monitor-context-demo");
    await mkdir(projectPath, { recursive: true });
    const response = await post({
      jsonrpc: "2.0",
      id: 78,
      method: "tools/call",
      params: { name: "list_directory", arguments: { path: projectPath } },
    }, "chat-project-context-demo");
    expect(response.status).toBe(200);
    const state = await readMonitor();
    expect(state.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        chatSession: "chat-project-context-demo",
        projectName: "monitor-context-demo",
        status: "WORKING",
        serverStarted: true,
        explicitStart: false,
      }),
    ]));
  });


  it("adds one non-blocking reminder to implicit tool results and preserves data", async () => {
    const chatSession = "chat-missing-begin-reminder";
    const call = async (id: number, name: string, arguments_: Record<string, unknown>) => {
      const response = await post({
        jsonrpc: "2.0", id, method: "tools/call",
        params: { name, arguments: arguments_ },
      }, chatSession);
      expect(response.status).toBe(200);
      return (await response.json()) as JsonRpcResponse;
    };
    const first = await call(300, "stat_path", { path: temporaryDirectory });
    expect(first.result?.isError).not.toBe(true);
    expect(first.result?.structuredContent).toMatchObject({ type: "directory" });
    expect(first.result?.content).toHaveLength(2);
    expect(JSON.parse(first.result?.content?.[0]?.text || "{}")).toEqual(first.result?.structuredContent);
    expect(first.result?.content?.[1]?.text).toContain("task_begin was not received");
    expect(first.result?.content?.[1]?.text).toContain("server has already performed");
    expect(first.result?.content?.[1]?.text).toContain("task_complete");

    const subsequent = await call(301, "stat_path", { path: temporaryDirectory });
    expect(subsequent.result?.content).toHaveLength(1);
    expect(subsequent.result?.structuredContent).toEqual(first.result?.structuredContent);

    const begun = await call(302, "task_begin", {
      userRequest: "Check the project directory", title: "Project directory review",
    });
    expect(begun.result?.structuredContent).toMatchObject({ status: "WORKING" });
    expect(begun.result?.content).toHaveLength(1);

    const working = await call(303, "stat_path", { path: temporaryDirectory });
    expect(working.result?.content).toHaveLength(1);

    const completed = await call(304, "task_complete", { summary: "Directory verified" });
    expect(completed.result?.structuredContent).toMatchObject({ status: "COMPLETED" });
    expect(completed.result?.content).toHaveLength(1);

    // An unmarked new operation after a confirmed completion is a new implicit task.
    const newImplicit = await call(305, "stat_path", { path: temporaryDirectory });
    expect(newImplicit.result?.content).toHaveLength(2);
    expect(newImplicit.result?.content?.[1]?.text).toContain("task_complete");
  });

  it("attaches the reminder even when an implicit tool fails without rewriting the error", async () => {
    const response = await post({
      jsonrpc: "2.0", id: 310, method: "tools/call",
      params: { name: "stat_path", arguments: { path: path.join(temporaryDirectory, "missing-file") } },
    }, "chat-implicit-tool-error");
    expect(response.status).toBe(200);
    const payload = (await response.json()) as JsonRpcResponse;
    expect(payload.result?.isError).toBe(true);
    expect(payload.result?.structuredContent?.error).toBeTruthy();
    expect(JSON.parse(payload.result?.content?.[0]?.text || "{}")).toEqual(payload.result?.structuredContent);
    expect(payload.result?.content?.[1]?.text).toContain("task_begin");
  });

  it("does not add a reminder when task_begin was called first", async () => {
    const chatSession = "chat-explicit-no-reminder";
    const beginResponse = await post({
      jsonrpc: "2.0", id: 320, method: "tools/call",
      params: {
        name: "task_begin",
        arguments: { userRequest: "Inspect a file", title: "Inspect file" },
      },
    }, chatSession);
    expect(beginResponse.status).toBe(200);
    const toolResponse = await post({
      jsonrpc: "2.0", id: 321, method: "tools/call",
      params: { name: "stat_path", arguments: { path: temporaryDirectory } },
    }, chatSession);
    expect(toolResponse.status).toBe(200);
    const payload = (await toolResponse.json()) as JsonRpcResponse;
    expect(payload.result?.content).toHaveLength(1);
    expect(payload.result?.structuredContent).toMatchObject({ type: "directory" });
    await post({ jsonrpc: "2.0", id: 322, method: "tools/call",
      params: { name: "task_complete", arguments: {} } }, chatSession);
  });

  it("requires authentication for the monitor endpoint", async () => {
    const response = await fetch(monitorEndpoint);
    expect(response.status).toBe(401);
  });


  it("server-started work can complete without a later task_begin", async () => {
    const chatSession = "chat-fallback-completes-directly";
    const first = await post({
      jsonrpc: "2.0", id: 330, method: "tools/call",
      params: { name: "stat_path", arguments: { path: temporaryDirectory } },
    }, chatSession);
    expect(first.status).toBe(200);
    const firstResult = (await first.json()) as JsonRpcResponse;
    expect(firstResult.result?.content).toHaveLength(2);

    const state = await readMonitor();
    expect(state.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        chatSession, status: "WORKING", explicitStart: false, serverStarted: true,
      }),
    ]));

    const complete = await post({
      jsonrpc: "2.0", id: 331, method: "tools/call",
      params: { name: "task_complete", arguments: { summary: "Finished without explicit begin" } },
    }, chatSession);
    expect(complete.status).toBe(200);
    const result = (await complete.json()) as JsonRpcResponse;
    expect(result.result?.structuredContent).toMatchObject({
      status: "COMPLETED", explicitStart: false, serverStarted: true,
      summary: "Finished without explicit begin",
    });
    expect(result.result?.content).toHaveLength(1);
  });

  it("an unknown MCP tool does not auto-start a stalled-alert eligible task", async () => {
    const chatSession = "chat-invalid-tool-no-autostart";
    const response = await post({
      jsonrpc: "2.0", id: 332, method: "tools/call",
      params: { name: "not_a_registered_tool", arguments: {} },
    }, chatSession);
    expect(response.status).toBe(200);
    const status = await readMonitor();
    const task = status.tasks.find((item) => item.chatSession === chatSession);
    expect(task).toMatchObject({
      status: "OBSERVED", explicitStart: false, serverStarted: false,
    });
  });

  it("tracks explicit begin, operational activity, and explicit completion by ChatGPT session", async () => {
    const chatSession = "chat-monitor-integration-a";

    const beginResponse = await post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "task_begin",
          arguments: {
            userRequest: "Create a monitored file and verify the result",
            title: "Monitor integration",
          },
        },
      },
      chatSession,
    );
    expect(beginResponse.status).toBe(200);
    const begun = (await beginResponse.json()) as JsonRpcResponse;
    expect(begun.result?.structuredContent).toMatchObject({
      chatSession,
      status: "WORKING",
      explicitStart: true,
      title: "Monitor integration",
    });

    const writeResponse = await post(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "write_file",
          arguments: {
            path: "monitor-integration.txt",
            content: "monitor-ok\n",
          },
        },
      },
      chatSession,
    );
    expect(writeResponse.status).toBe(200);

    let state = await readMonitor();
    expect(state.stallMs).toBe(1000);
    expect(state.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chatSession,
          status: "WORKING",
          explicitStart: true,
          userRequest: "Create a monitored file and verify the result",
          title: "Monitor integration",
          lastTool: "write_file",
          activeCalls: 0,
        }),
      ]),
    );

    const completeResponse = await post(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "task_complete",
          arguments: { summary: "File creation verified." },
        },
      },
      chatSession,
    );
    expect(completeResponse.status).toBe(200);
    const completed = (await completeResponse.json()) as JsonRpcResponse;
    expect(completed.result?.structuredContent).toMatchObject({
      chatSession,
      status: "COMPLETED",
      summary: "File creation verified.",
    });

    state = await readMonitor();
    expect(state.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chatSession,
          status: "COMPLETED",
          summary: "File creation verified.",
          lastTool: "write_file",
        }),
      ]),
    );
  });

  it("automatically starts unmarked work and marks it STALLED when completion is omitted", async () => {
    const chatSession = "chat-monitor-integration-stall";
    const response = await post(
      {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "write_file",
          arguments: {
            path: "implicit-stall.txt",
            content: "unfinished\n",
          },
        },
      },
      chatSession,
    );
    expect(response.status).toBe(200);

    let state = await readMonitor();
    expect(state.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chatSession,
          status: "WORKING",
          explicitStart: false,
          serverStarted: true,
          lastTool: "write_file",
        }),
      ]),
    );

    await new Promise((resolve) => setTimeout(resolve, 1150));
    state = await readMonitor();
    expect(state.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chatSession,
          status: "STALLED",
          explicitStart: false,
          serverStarted: true,
        }),
      ]),
    );
  });

  it("exposes aggregate task counts on health without exposing task details", async () => {
    const response = await fetch(new URL("/health", endpoint));
    expect(response.status).toBe(200);
    const health = (await response.json()) as Record<string, unknown>;
    expect(health).toMatchObject({
      status: "ok",
      monitoredStalledTasks: expect.any(Number),
      monitoredWorkingTasks: expect.any(Number),
    });
    expect(health.tasks).toBeUndefined();
  });
});
