import { describe, expect, it } from "vitest";
import { projectFromToolArguments } from "../src/task-context.js";

describe("project context from MCP tool arguments", () => {
  it("extracts the project under a dev root across common path fields", () => {
    expect(projectFromToolArguments({ workdir: "D:\\dev\\ksystem-bridge" })).toBe("ksystem-bridge");
    expect(projectFromToolArguments({ path: "D:\\dev\\mcp-cokacremote-native\\src\\task-monitor.ts" })).toBe("mcp-cokacremote-native");
    expect(projectFromToolArguments({ cmd: "git -C /d/dev/ksystem-slip-app status --short" })).toBe("ksystem-slip-app");
  });

  it("does not leak arbitrary paths, command content or secret values", () => {
    expect(projectFromToolArguments({ cmd: "echo secret-token", workdir: "C:\\private\\tokens" })).toBeUndefined();
    expect(projectFromToolArguments({ path: "C:\\Program Files\\app.config" })).toBeUndefined();
    expect(projectFromToolArguments({ path: "D:\\dev\\tools\\x.ps1" })).toBeUndefined();
    expect(projectFromToolArguments(null)).toBeUndefined();
  });
});
