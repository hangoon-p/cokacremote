import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  createOAuthMetadata,
  mcpAuthRouter,
  type AuthRouterOptions,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import express, { type Request, type Response } from "express";

import { createBearerAuth, createHostValidation } from "./auth.js";
import type { AppConfig } from "./config.js";
import { errorMessage } from "./errors.js";
import { createMcpServer, type McpServices } from "./mcp-server.js";
import { OAUTH_SCOPES, RemoteDevOAuthProvider } from "./oauth.js";
import { TASK_LIFECYCLE_TOOLS } from "./task-tools.js";

interface ActiveRequest {
  server: ReturnType<typeof createMcpServer>;
}

export interface RunningHttpServer {
  httpServer: HttpServer;
  close: () => Promise<void>;
}

function rpcError(response: Response, status: number, message: string): void {
  response.status(status).json({
    jsonrpc: "2.0",
    error: { code: -32000, message },
    id: null,
  });
}

function rpcMethod(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const method = (body as { method?: unknown }).method;
  return typeof method === "string" ? method : undefined;
}

function rpcToolName(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const params = (body as { params?: unknown }).params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }
  const name = (params as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

function rpcParams(body: unknown): Record<string, unknown> | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const params = (body as { params?: unknown }).params;
  return params && typeof params === "object" && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : undefined;
}

function rpcOpenAiSession(body: unknown): string | undefined {
  const meta = rpcParams(body)?._meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return undefined;
  }
  const session = (meta as Record<string, unknown>)["openai/session"];
  return typeof session === "string" && session.trim() ? session.trim() : undefined;
}

function rpcProcessSessionId(body: unknown): string | undefined {
  const arguments_ = rpcParams(body)?.arguments;
  if (!arguments_ || typeof arguments_ !== "object" || Array.isArray(arguments_)) {
    return undefined;
  }
  const sessionId = (arguments_ as Record<string, unknown>).sessionId;
  return typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : undefined;
}

export async function startHttpServer(
  config: AppConfig,
  services: McpServices,
): Promise<RunningHttpServer> {
  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxyHops > 0) {
    app.set("trust proxy", config.trustProxyHops);
  }
  app.use((request, response, next) => {
    if (request.path !== config.endpoint) {
      next();
      return;
    }
    const requestId = randomUUID();
    const startedAt = performance.now();
    let logged = false;
    response.set("X-Request-Id", requestId);
    const logCompletion = (outcome: "completed" | "aborted") => {
      if (logged) {
        return;
      }
      logged = true;
      console.log(
        JSON.stringify({
          event: "mcp_request",
          requestId,
          upstreamRequestId: request.get("x-request-id") || undefined,
          upstreamOpenAiSession: request.get("x-openai-session") || undefined,
          metaOpenAiSession: rpcOpenAiSession(request.body),
          httpMethod: request.method,
          rpcMethod: rpcMethod(request.body),
          toolName: rpcToolName(request.body),
          status: response.statusCode,
          outcome,
          durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
        }),
      );
    };
    response.once("finish", () => logCompletion("completed"));
    response.once("close", () => {
      if (!response.writableEnded) {
        logCompletion("aborted");
      }
    });
    next();
  });
  app.use(createHostValidation(config));

  const activeRequests = new Set<ActiveRequest>();
  let activeMcpRequests = 0;
  const oauthProvider = config.oauthEnabled ? new RemoteDevOAuthProvider(config) : undefined;
  if (oauthProvider) {
    app.get("/.well-known/oauth-protected-resource", (_request, response) => {
      response.set("Access-Control-Allow-Origin", "*").json({
        resource: oauthProvider.resourceUrl.href,
        authorization_servers: [oauthProvider.issuerUrl.href],
        scopes_supported: [...OAUTH_SCOPES],
        bearer_methods_supported: ["header"],
        resource_name: "cokacremote",
      });
    });
    const oauthRouterOptions = {
      provider: oauthProvider,
      issuerUrl: oauthProvider.issuerUrl,
      resourceServerUrl: oauthProvider.resourceUrl,
      scopesSupported: [...OAUTH_SCOPES],
      resourceName: "cokacremote",
    } satisfies AuthRouterOptions;
    const oauthMetadata = {
      ...createOAuthMetadata(oauthRouterOptions),
      revocation_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    };
    const issuerPath = oauthProvider.issuerUrl.pathname.replace(/\/$/, "");
    const oauthMetadataPath = `/.well-known/oauth-authorization-server${issuerPath}`;
    app.use((request, response, next) => {
      if (
        (request.method === "GET" || request.method === "HEAD") &&
        request.path === oauthMetadataPath
      ) {
        response.set("Access-Control-Allow-Origin", "*").json(oauthMetadata);
        return;
      }
      next();
    });
    app.use(mcpAuthRouter(oauthRouterOptions));
  }
  const authenticate = createBearerAuth(config, oauthProvider);
  const parseMcpJson = express.json({ limit: config.maxRequestBody });

  app.get("/health", (_request, response) => {
    const monitor = services.taskMonitor.refresh();
    response.json({
      status: "ok",
      service: "cokacremote",
      version: "0.1.0",
      transportMode: "stateless-json",
      activeMcpSessions: 0,
      activeMcpRequests,
      managedProcesses: services.processManager.list().length,
      monitoredWorkingTasks: monitor.tasks.filter((task) => task.status === "WORKING").length,
      monitoredStalledTasks: monitor.tasks.filter((task) => task.status === "STALLED").length,
      unrestrictedHostAccess: true,
      oauthEnabled: config.oauthEnabled,
    });
  });

  app.get("/monitor", authenticate, (_request, response) => {
    response.set("Cache-Control", "no-store").json(services.taskMonitor.refresh());
  });

  const postHandler = async (request: Request, response: Response): Promise<void> => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = createMcpServer(config, services);
    const activeRequest = { server };
    activeRequests.add(activeRequest);
    activeMcpRequests += 1;
    let closed = false;
    const closeRequest = async (): Promise<void> => {
      if (closed) {
        return;
      }
      closed = true;
      activeRequests.delete(activeRequest);
      activeMcpRequests = Math.max(0, activeMcpRequests - 1);
      await server.close().catch((error) => {
        console.error("Failed to close MCP request:", errorMessage(error));
      });
    };
    response.once("finish", () => void closeRequest());
    response.once("close", () => void closeRequest());
    try {
      transport.onerror = (error) => {
        console.error("MCP transport error:", errorMessage(error));
      };
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      console.error("MCP POST failed:", errorMessage(error));
      if (!response.headersSent) {
        rpcError(response, 500, "Internal MCP server error");
      }
      await closeRequest();
    }
  };

  const methodNotAllowed = (_request: Request, response: Response): void => {
    response.set("Allow", "POST");
    rpcError(response, 405, "Stateless MCP accepts POST requests only");
  };

  const trackToolActivity = (
    request: Request,
    response: Response,
    next: express.NextFunction,
  ): void => {
    const toolName = rpcToolName(request.body);
    const chatSession = rpcOpenAiSession(request.body);
    if (
      !toolName ||
      !chatSession ||
      TASK_LIFECYCLE_TOOLS.has(toolName)
    ) {
      next();
      return;
    }

    services.taskMonitor.toolStarted(chatSession, toolName);
    const processSessionId = rpcProcessSessionId(request.body);
    if (processSessionId) {
      services.taskMonitor.trackProcess(chatSession, processSessionId);
    }

    let finished = false;
    const finish = (outcome: "completed" | "aborted") => {
      if (finished) {
        return;
      }
      finished = true;
      services.taskMonitor.toolFinished(chatSession, toolName, outcome);
    };
    response.once("finish", () => finish("completed"));
    response.once("close", () => {
      if (!response.writableEnded) {
        finish("aborted");
      }
    });
    next();
  };

  app.post(
    config.endpoint,
    authenticate,
    parseMcpJson,
    trackToolActivity,
    (request, response) => {
      void postHandler(request, response);
    },
  );
  app.get(config.endpoint, authenticate, methodNotAllowed);
  app.delete(config.endpoint, authenticate, methodNotAllowed);

  app.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      _next: express.NextFunction,
    ) => {
      if (!response.headersSent) {
        rpcError(response, 400, `Invalid request body: ${errorMessage(error)}`);
      }
    },
  );

  const cleanupInterval = setInterval(() => {
    services.processManager.prune();
  }, Math.min(config.processRetentionMs, 60_000));
  cleanupInterval.unref();

  const monitorInterval = setInterval(
    () => {
      services.taskMonitor.refresh();
    },
    Math.min(5000, Math.max(1000, Math.floor(config.taskStallMs / 4))),
  );
  monitorInterval.unref();

  const httpServer = await new Promise<HttpServer>((resolve, reject) => {
    const listeningServer = app.listen(config.port, config.host, () => resolve(listeningServer));
    listeningServer.once("error", reject);
  });

  const close = async (): Promise<void> => {
    clearInterval(cleanupInterval);
    clearInterval(monitorInterval);
    const requests = [...activeRequests];
    activeRequests.clear();
    activeMcpRequests = 0;
    await Promise.allSettled(requests.map((request) => request.server.close()));
    await services.processManager.shutdown();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
  };

  return { httpServer, close };
}
