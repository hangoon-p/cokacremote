import {
  collectWatcherSnapshot,
  loadWatcherConfig,
  sendSnapshot,
  writeSnapshotAtomic,
  type WatcherConfig,
} from "./watcher-core.js";

function statusSummary(snapshot: Awaited<ReturnType<typeof collectWatcherSnapshot>>): string {
  const taskState = snapshot.monitor.state;
  const tasks = Array.isArray(taskState?.tasks) ? taskState.tasks : [];
  const working = tasks.filter(
    (task) =>
      task &&
      typeof task === "object" &&
      (task as Record<string, unknown>).status === "WORKING",
  ).length;
  const stalled = tasks.filter(
    (task) =>
      task &&
      typeof task === "object" &&
      (task as Record<string, unknown>).status === "STALLED",
  ).length;
  const tunnel =
    snapshot.tunnel.source === "none"
      ? "not-configured"
      : snapshot.tunnel.ok
        ? "ok"
        : "down";
  return [
    `server=${snapshot.server.ok ? "ok" : "down"}`,
    `monitor=${snapshot.monitor.ok ? "ok" : "unavailable"}`,
    `tunnel=${tunnel}`,
    `working=${working}`,
    `stalled=${stalled}`,
  ].join(" ");
}

export async function runWatcherCycle(config: WatcherConfig): Promise<void> {
  const snapshot = await collectWatcherSnapshot(config);
  await writeSnapshotAtomic(config.snapshotFile, snapshot);
  const delivery = await sendSnapshot(config, snapshot);
  const deliveryText = delivery.configured
    ? delivery.ok
      ? `remote=ok(${delivery.status})`
      : `remote=failed(${delivery.status ?? "network"}:${delivery.error ?? "unknown"})`
    : "remote=disabled";
  console.log(
    `[watcher] ${snapshot.collectedAt} ${statusSummary(snapshot)} ${deliveryText}`,
  );
}

async function main(): Promise<void> {
  const config = loadWatcherConfig();
  const once =
    ["1", "true", "yes", "on"].includes(
      (process.env.COKACREMOTE_WATCHER_ONCE || "").toLowerCase(),
    );

  console.log(
    `[watcher] starting instance=${config.instanceId} intervalMs=${config.intervalMs} snapshot=${config.snapshotFile}`,
  );

  if (once) {
    await runWatcherCycle(config);
    return;
  }

  let stopped = false;
  let cycleRunning = false;
  const stop = (signal: string) => {
    if (!stopped) {
      stopped = true;
      console.log(`[watcher] received ${signal}; stopping`);
    }
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  while (!stopped) {
    if (!cycleRunning) {
      cycleRunning = true;
      try {
        await runWatcherCycle(config);
      } catch (error) {
        console.error(
          "[watcher] cycle failed:",
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        cycleRunning = false;
      }
    }
    if (stopped) {
      break;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, config.intervalMs);
    });
  }
}

main().catch((error) => {
  console.error(
    "[watcher] fatal:",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
