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
  };
}

interface MonitorTask {
  taskId: string;
  chatSession: string;
  status: "OBSERVED" | "INACTIVE" | "WORKING" | "COMPLETED" | "STALLED";
  explicitStart: boolean;
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
    const body = (await response.json()) as { result?: { tools?: Array<{ name: string }> } };
    expect(body.result?.tools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["task_begin", "task_complete"]),
    );
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
        status: "OBSERVED",
      }),
    ]));
  });

  it("requires authentication for the monitor endpoint", async () => {
    const response = await fetch(monitorEndpoint);
    expect(response.status).toBe(401);
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

  it("keeps implicit activity visible as INACTIVE without turning it into STALLED", async () => {
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
          status: "OBSERVED",
          explicitStart: false,
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
          status: "INACTIVE",
          explicitStart: false,
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
