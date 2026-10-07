import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface WatcherConfig {
  instanceId: string;
  hostname: string;
  healthUrl: string;
  monitorUrl: string;
  authToken: string | undefined;
  runtimeStateFile: string | undefined;
  tunnelHealthUrl: string | undefined;
  remoteUrl: string | undefined;
  remoteToken: string | undefined;
  snapshotFile: string;
  intervalMs: number;
  requestTimeoutMs: number;
}

export interface HttpProbe {
  ok: boolean;
  url: string;
  status: number | undefined;
  latencyMs: number;
  error: string | undefined;
}

export interface RuntimeStateSnapshot {
  present: boolean;
  file: string | undefined;
  owner: string | undefined;
  launcherPid: number | undefined;
  serverPid: number | undefined;
  tunnelPid: number | undefined;
  mcpHost: string | undefined;
  mcpPort: number | undefined;
  tunnelHealthHost: string | undefined;
  tunnelHealthPort: number | undefined;
  phase: string | undefined;
  updatedAt: number | undefined;
  ageMs: number | undefined;
  error: string | undefined;
}

export interface ServerSnapshot extends HttpProbe {
  health: Record<string, unknown> | undefined;
}

export interface MonitorSnapshot extends HttpProbe {
  state: Record<string, unknown> | undefined;
}

export interface TunnelSnapshot extends HttpProbe {
  source: "config" | "runtime" | "none";
}

export interface WatcherSnapshot {
  schemaVersion: 1;
  instanceId: string;
  hostname: string;
  collectedAt: string;
  watcher: {
    pid: number;
  };
  runtime: RuntimeStateSnapshot;
  server: ServerSnapshot;
  monitor: MonitorSnapshot;
  tunnel: TunnelSnapshot;
}

interface JsonProbeResult extends HttpProbe {
  json: Record<string, unknown> | undefined;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function envInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
): number {
  if (!value?.trim()) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return parsed;
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function ensureHttpUrl(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must use HTTP or HTTPS`);
  }
  return url.href;
}

export function loadWatcherConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): WatcherConfig {
  const hostname = os.hostname();
  const baseUrl = withoutTrailingSlash(
    env.COKACREMOTE_WATCHER_MCP_BASE_URL?.trim() || "http://127.0.0.1:3000",
  );
  const healthUrl = ensureHttpUrl(
    env.COKACREMOTE_WATCHER_HEALTH_URL?.trim() || `${baseUrl}/health`,
    "COKACREMOTE_WATCHER_HEALTH_URL",
  );
  const monitorUrl = ensureHttpUrl(
    env.COKACREMOTE_WATCHER_MONITOR_URL?.trim() || `${baseUrl}/monitor`,
    "COKACREMOTE_WATCHER_MONITOR_URL",
  );
  const tunnelHealthUrl = env.COKACREMOTE_WATCHER_TUNNEL_HEALTH_URL?.trim();
  const remoteUrl = env.COKACREMOTE_WATCHER_REMOTE_URL?.trim();
  return {
    instanceId:
      env.COKACREMOTE_WATCHER_INSTANCE_ID?.trim() || hostname,
    hostname,
    healthUrl,
    monitorUrl,
    authToken:
      env.COKACREMOTE_WATCHER_AUTH_TOKEN?.trim() ||
      env.MCP_AUTH_TOKEN?.trim() ||
      undefined,
    runtimeStateFile: env.COKACREMOTE_WATCHER_RUNTIME_STATE_FILE?.trim()
      ? path.resolve(cwd, env.COKACREMOTE_WATCHER_RUNTIME_STATE_FILE.trim())
      : undefined,
    tunnelHealthUrl: tunnelHealthUrl
      ? ensureHttpUrl(tunnelHealthUrl, "COKACREMOTE_WATCHER_TUNNEL_HEALTH_URL")
      : undefined,
    remoteUrl: remoteUrl
      ? ensureHttpUrl(remoteUrl, "COKACREMOTE_WATCHER_REMOTE_URL")
      : undefined,
    remoteToken: env.COKACREMOTE_WATCHER_REMOTE_TOKEN?.trim() || undefined,
    snapshotFile: path.resolve(
      cwd,
      env.COKACREMOTE_WATCHER_SNAPSHOT_FILE?.trim() ||
        ".cache/cokacremote-watcher-state.json",
    ),
    intervalMs: envInteger(
      env.COKACREMOTE_WATCHER_INTERVAL_MS,
      30_000,
      "COKACREMOTE_WATCHER_INTERVAL_MS",
      1000,
    ),
    requestTimeoutMs: envInteger(
      env.COKACREMOTE_WATCHER_REQUEST_TIMEOUT_MS,
      5000,
      "COKACREMOTE_WATCHER_REQUEST_TIMEOUT_MS",
      100,
    ),
  };
}

function errorText(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.length > 1000 ? `${value.slice(0, 997)}...` : value;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function probeJson(
  url: string,
  timeoutMs: number,
  authToken?: string,
): Promise<JsonProbeResult> {
  const started = performance.now();
  try {
    const headers = new Headers({ accept: "application/json" });
    if (authToken) {
      headers.set("authorization", `Bearer ${authToken}`);
    }
    const response = await fetchWithTimeout(url, { headers }, timeoutMs);
    const latencyMs = Math.round((performance.now() - started) * 10) / 10;
    let json: Record<string, unknown> | undefined;
    let parseError: string | undefined;
    try {
      const value = await response.json();
      if (value && typeof value === "object" && !Array.isArray(value)) {
        json = value as Record<string, unknown>;
      } else {
        parseError = "Response body was not a JSON object";
      }
    } catch (error) {
      parseError = `Invalid JSON response: ${errorText(error)}`;
    }
    return {
      ok: response.ok && json !== undefined,
      url,
      status: response.status,
      latencyMs,
      error: response.ok ? parseError : `HTTP ${response.status}`,
      json,
    };
  } catch (error) {
    return {
      ok: false,
      url,
      status: undefined,
      latencyMs: Math.round((performance.now() - started) * 10) / 10,
      error: errorText(error),
      json: undefined,
    };
  }
}

async function probeHttp(url: string, timeoutMs: number): Promise<HttpProbe> {
  const started = performance.now();
  try {
    const response = await fetchWithTimeout(
      url,
      { headers: { accept: "text/plain,text/html,*/*" } },
      timeoutMs,
    );
    await response.body?.cancel().catch(() => undefined);
    return {
      ok: response.ok,
      url,
      status: response.status,
      latencyMs: Math.round((performance.now() - started) * 10) / 10,
      error: response.ok ? undefined : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      url,
      status: undefined,
      latencyMs: Math.round((performance.now() - started) * 10) / 10,
      error: errorText(error),
    };
  }
}

export async function readRuntimeState(
  file: string | undefined,
  now = Date.now(),
): Promise<RuntimeStateSnapshot> {
  if (!file) {
    return {
      present: false,
      file: undefined,
      owner: undefined,
      launcherPid: undefined,
      serverPid: undefined,
      tunnelPid: undefined,
      mcpHost: undefined,
      mcpPort: undefined,
      tunnelHealthHost: undefined,
      tunnelHealthPort: undefined,
      phase: undefined,
      updatedAt: undefined,
      ageMs: undefined,
      error: undefined,
    };
  }
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    const updatedAt = finiteNumber(parsed.updated_at);
    const updatedAtMs =
      updatedAt === undefined
        ? undefined
        : updatedAt < 10_000_000_000
          ? updatedAt * 1000
          : updatedAt;
    return {
      present: true,
      file,
      owner: cleanString(parsed.owner),
      launcherPid: integer(parsed.launcher_pid),
      serverPid: integer(parsed.server_pid),
      tunnelPid: integer(parsed.tunnel_pid),
      mcpHost: cleanString(parsed.mcp_host),
      mcpPort: integer(parsed.mcp_port),
      tunnelHealthHost: cleanString(parsed.tunnel_health_host),
      tunnelHealthPort: integer(parsed.tunnel_health_port),
      phase: cleanString(parsed.phase),
      updatedAt,
      ageMs:
        updatedAtMs === undefined ? undefined : Math.max(0, Math.round(now - updatedAtMs)),
      error: undefined,
    };
  } catch (error) {
    return {
      present: false,
      file,
      owner: undefined,
      launcherPid: undefined,
      serverPid: undefined,
      tunnelPid: undefined,
      mcpHost: undefined,
      mcpPort: undefined,
      tunnelHealthHost: undefined,
      tunnelHealthPort: undefined,
      phase: undefined,
      updatedAt: undefined,
      ageMs: undefined,
      error: errorText(error),
    };
  }
}

function runtimeTunnelUrl(runtime: RuntimeStateSnapshot): string | undefined {
  if (!runtime.tunnelHealthHost || runtime.tunnelHealthPort === undefined) {
    return undefined;
  }
  return `http://${runtime.tunnelHealthHost}:${runtime.tunnelHealthPort}/`;
}

export async function collectWatcherSnapshot(
  config: WatcherConfig,
  now = Date.now(),
): Promise<WatcherSnapshot> {
  const runtimePromise = readRuntimeState(config.runtimeStateFile, now);
  const healthPromise = probeJson(config.healthUrl, config.requestTimeoutMs);
  const monitorPromise = probeJson(
    config.monitorUrl,
    config.requestTimeoutMs,
    config.authToken,
  );
  const [runtime, health, monitor] = await Promise.all([
    runtimePromise,
    healthPromise,
    monitorPromise,
  ]);

  const tunnelUrl = config.tunnelHealthUrl || runtimeTunnelUrl(runtime);
  const tunnel =
    tunnelUrl === undefined
      ? {
          ok: false,
          url: "",
          status: undefined,
          latencyMs: 0,
          error: undefined,
          source: "none" as const,
        }
      : {
          ...(await probeHttp(tunnelUrl, config.requestTimeoutMs)),
          source: config.tunnelHealthUrl ? ("config" as const) : ("runtime" as const),
        };

  return {
    schemaVersion: 1,
    instanceId: config.instanceId,
    hostname: config.hostname,
    collectedAt: new Date(now).toISOString(),
    watcher: { pid: process.pid },
    runtime,
    server: {
      ok: health.ok,
      url: health.url,
      status: health.status,
      latencyMs: health.latencyMs,
      error: health.error,
      health: health.json,
    },
    monitor: {
      ok: monitor.ok,
      url: monitor.url,
      status: monitor.status,
      latencyMs: monitor.latencyMs,
      error: monitor.error,
      state: monitor.json,
    },
    tunnel,
  };
}

export async function writeSnapshotAtomic(
  file: string,
  snapshot: WatcherSnapshot,
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

export interface RemoteDeliveryResult {
  configured: boolean;
  ok: boolean;
  status: number | undefined;
  error: string | undefined;
}

export async function sendSnapshot(
  config: WatcherConfig,
  snapshot: WatcherSnapshot,
): Promise<RemoteDeliveryResult> {
  if (!config.remoteUrl) {
    return { configured: false, ok: false, status: undefined, error: undefined };
  }
  try {
    const headers = new Headers({ "content-type": "application/json" });
    if (config.remoteToken) {
      headers.set("authorization", `Bearer ${config.remoteToken}`);
    }
    const response = await fetchWithTimeout(
      config.remoteUrl,
      {
        method: "POST",
        headers,
        body: JSON.stringify(snapshot),
      },
      config.requestTimeoutMs,
    );
    await response.body?.cancel().catch(() => undefined);
    return {
      configured: true,
      ok: response.ok,
      status: response.status,
      error: response.ok ? undefined : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      configured: true,
      ok: false,
      status: undefined,
      error: errorText(error),
    };
  }
}
