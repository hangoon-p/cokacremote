import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  collectWatcherSnapshot,
  loadWatcherConfig,
  readRuntimeState,
  sendSnapshot,
  writeSnapshotAtomic,
  type WatcherConfig,
  type WatcherSnapshot,
} from "../src/watcher-core.js";

describe("independent watcher core", () => {
  let server: Server;
  let baseUrl: string;
  let temporaryDirectory: string;
  let receivedHeartbeat: WatcherSnapshot | undefined;
  let receivedAuthorization: string | undefined;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "cokacremote-watcher-"));
    receivedHeartbeat = undefined;
    receivedAuthorization = undefined;

    server = createServer((request, response) => {
      if (request.url === "/health") {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ status: "ok", service: "cokacremote" }));
        return;
      }
      if (request.url === "/monitor") {
        if (request.headers.authorization !== "Bearer watcher-secret") {
          response.writeHead(401).end("unauthorized");
          return;
        }
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(
            JSON.stringify({
              stallMs: 180000,
              tasks: [
                {
                  taskId: "task-1",
                  chatSession: "chat-1",
                  status: "WORKING",
                  lastTool: "read_file",
                },
              ],
            }),
          );
        return;
      }
      if (request.url === "/tunnel" || request.url === "/") {
        response.writeHead(200, { "content-type": "text/plain" }).end("ok");
        return;
      }
      if (request.url === "/heartbeat" && request.method === "POST") {
        receivedAuthorization = request.headers.authorization;
        const chunks: Buffer[] = [];
        request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        request.on("end", () => {
          receivedHeartbeat = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          response.writeHead(204).end();
        });
        return;
      }
      response.writeHead(404).end("not found");
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  function config(overrides: Partial<WatcherConfig> = {}): WatcherConfig {
    return {
      instanceId: "test-instance",
      hostname: "test-host",
      healthUrl: `${baseUrl}/health`,
      monitorUrl: `${baseUrl}/monitor`,
      authToken: "watcher-secret",
      runtimeStateFile: undefined,
      tunnelHealthUrl: `${baseUrl}/tunnel`,
      remoteUrl: undefined,
      remoteToken: undefined,
      snapshotFile: path.join(temporaryDirectory, "state", "snapshot.json"),
      intervalMs: 30000,
      requestTimeoutMs: 1000,
      ...overrides,
    };
  }

  it("loads generic watcher config without requiring Native launcher files", () => {
    const loaded = loadWatcherConfig(
      {
        COKACREMOTE_WATCHER_INSTANCE_ID: "office-1",
        COKACREMOTE_WATCHER_MCP_BASE_URL: baseUrl,
        COKACREMOTE_WATCHER_AUTH_TOKEN: "watcher-secret",
        COKACREMOTE_WATCHER_INTERVAL_MS: "15000",
      },
      temporaryDirectory,
    );

    expect(loaded).toMatchObject({
      instanceId: "office-1",
      healthUrl: `${baseUrl}/health`,
      monitorUrl: `${baseUrl}/monitor`,
      authToken: "watcher-secret",
      intervalMs: 15000,
      runtimeStateFile: undefined,
    });
  });

  it("collects server, authenticated monitor, runtime, and tunnel state", async () => {
    const address = server.address() as AddressInfo;
    const runtimeStateFile = path.join(temporaryDirectory, "runtime_state.json");
    const now = Date.now();
    await writeFile(
      runtimeStateFile,
      JSON.stringify({
        owner: "native-cokacremote",
        launcher_pid: 11,
        server_pid: 12,
        tunnel_pid: 13,
        mcp_host: "127.0.0.1",
        mcp_port: 18103,
        tunnel_health_host: "127.0.0.1",
        tunnel_health_port: address.port,
        phase: "running",
        updated_at: (now - 2500) / 1000,
      }),
      "utf8",
    );

    const snapshot = await collectWatcherSnapshot(
      config({
        runtimeStateFile,
        tunnelHealthUrl: undefined,
      }),
      now,
    );

    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      instanceId: "test-instance",
      server: {
        ok: true,
        status: 200,
        health: { status: "ok", service: "cokacremote" },
      },
      monitor: {
        ok: true,
        status: 200,
        state: {
          stallMs: 180000,
        },
      },
      runtime: {
        present: true,
        owner: "native-cokacremote",
        launcherPid: 11,
        serverPid: 12,
        tunnelPid: 13,
        phase: "running",
        ageMs: 2500,
      },
      tunnel: {
        ok: true,
        status: 200,
        source: "runtime",
      },
    });
  });

  it("distinguishes monitor authentication failure from server outage", async () => {
    const snapshot = await collectWatcherSnapshot(
      config({ authToken: "wrong-secret" }),
    );

    expect(snapshot.server).toMatchObject({ ok: true, status: 200 });
    expect(snapshot.monitor).toMatchObject({
      ok: false,
      status: 401,
      error: "HTTP 401",
    });
    expect(snapshot.tunnel).toMatchObject({ ok: true, status: 200 });
  });

  it("reports a server connection failure without crashing the watcher cycle", async () => {
    const deadUrl = "http://127.0.0.1:1";
    const snapshot = await collectWatcherSnapshot(
      config({
        healthUrl: `${deadUrl}/health`,
        monitorUrl: `${deadUrl}/monitor`,
        tunnelHealthUrl: undefined,
        requestTimeoutMs: 300,
      }),
    );

    expect(snapshot.server.ok).toBe(false);
    expect(snapshot.monitor.ok).toBe(false);
    expect(snapshot.tunnel).toMatchObject({
      ok: false,
      source: "none",
    });
  });

  it("writes a valid local snapshot atomically", async () => {
    const snapshot = await collectWatcherSnapshot(config());
    const file = path.join(temporaryDirectory, "nested", "watcher-state.json");

    await writeSnapshotAtomic(file, snapshot);

    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      schemaVersion: 1,
      instanceId: "test-instance",
      server: { ok: true },
      monitor: { ok: true },
      tunnel: { ok: true },
    });
  });

  it("posts the complete heartbeat snapshot to the configured remote receiver", async () => {
    const configured = config({
      remoteUrl: `${baseUrl}/heartbeat`,
      remoteToken: "remote-secret",
    });
    const snapshot = await collectWatcherSnapshot(configured);

    const delivery = await sendSnapshot(configured, snapshot);

    expect(delivery).toEqual({
      configured: true,
      ok: true,
      status: 204,
      error: undefined,
    });
    expect(receivedAuthorization).toBe("Bearer remote-secret");
    expect(receivedHeartbeat).toMatchObject({
      schemaVersion: 1,
      instanceId: "test-instance",
      server: { ok: true },
      monitor: { ok: true },
      tunnel: { ok: true },
    });
  });

  it("treats a missing runtime-state file as optional input", async () => {
    const state = await readRuntimeState(
      path.join(temporaryDirectory, "missing-runtime.json"),
    );

    expect(state).toMatchObject({
      present: false,
      error: expect.any(String),
    });
  });
});
