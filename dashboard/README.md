# Cokacremote Monitor Dashboard

Cloudflare Workers + D1 + static PWA backend for the Cokacremote watcher.

## What it does

- receives outbound watcher heartbeats at `POST /api/heartbeat`,
- stores only the latest snapshot per Cokacremote instance in D1,
- marks an instance offline when heartbeat is absent,
- serves the mobile dashboard as a PWA,
- stores Web Push subscriptions and sends state-change/offline notifications.

D1 is intentionally used as a minimal persistent state store rather than as an event/history database. The schema contains only `instances` and `push_subscriptions`; no monitoring history is retained server-side.

The office PC never needs an inbound Internet port.

## 1. Install

```bash
cd dashboard
npm ci
```

## 2. Create D1

```bash
npx wrangler d1 create cokacremote-monitor
```

Copy the returned database UUID into `wrangler.jsonc` as `database_id`, then apply migrations:

```bash
npm run d1:remote
```

For local development:

```bash
npm run d1:local
```

## 3. Configure secrets

Use separate long random tokens for ingest and dashboard access:

```bash
npx wrangler secret put INGEST_TOKEN
npx wrangler secret put DASHBOARD_TOKEN
```

Generate a VAPID key pair locally:

```bash
node scripts/generate-vapid.mjs
```

Store the generated keys and a VAPID subject:

```bash
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT
```

A VAPID subject can be a `mailto:` address or an HTTPS URL you control.

Never commit secret values. For local Wrangler development, place them in `.dev.vars`.

## 4. Deploy

```bash
npm run deploy
```

The Worker and `public/` PWA assets are deployed together. The Cron Trigger runs every minute and checks for missing heartbeats. `OFFLINE_AFTER_SECONDS` defaults to 120 seconds in `wrangler.jsonc`.

## 5. Configure each monitored Cokacremote host

After pulling a version that contains the watcher, install/build the root project before restarting the host launcher:

```bash
npm ci
npm run build
```

The compiled watcher entry point is:

```text
node dist/src/watcher.js
```

Create machine-local watcher configuration. The repository `.env.example` documents all supported variables; a typical persistent host uses values equivalent to:

```text
COKACREMOTE_WATCHER_INSTANCE_ID=<unique-host-id>
COKACREMOTE_WATCHER_MCP_BASE_URL=http://127.0.0.1:<local-mcp-port>
COKACREMOTE_WATCHER_RUNTIME_STATE_FILE=<optional-launcher-runtime-state-json>
COKACREMOTE_WATCHER_INTERVAL_MS=30000
COKACREMOTE_WATCHER_REQUEST_TIMEOUT_MS=5000
COKACREMOTE_WATCHER_SNAPSHOT_FILE=<machine-local-snapshot-path>
COKACREMOTE_WATCHER_REMOTE_URL=https://<worker-domain>/api/heartbeat
COKACREMOTE_WATCHER_REMOTE_TOKEN=<INGEST_TOKEN>
```

Each installation **must** use a unique `COKACREMOTE_WATCHER_INSTANCE_ID`. The same deployed Worker/D1 and the same ingest endpoint can receive heartbeats from multiple hosts.

Keep the environment file and `INGEST_TOKEN` machine-local. Do not commit them.

Important: `dist/src/watcher.js` reads `process.env`; it does **not** automatically load a file named `.env.watcher`. If a host stores watcher settings in a local env file, its launcher/service manager must load that file and inject those values into the watcher process environment.

## 6. Integrate the watcher into the host launcher/supervisor

For a persistent installation, starting only the MCP server is incomplete. The top-level host launcher/service supervisor should manage the watcher as part of the Cokacremote runtime.

Recommended process model:

```text
host launcher / tray / service supervisor
├─ MCP + tunnel launcher/process tree
└─ watcher: node dist/src/watcher.js
```

The watcher should be a **sibling managed process**, not a child whose lifetime is tied to the MCP server process. This is important because the watcher must remain alive while the MCP server is restarting or down so it can report that outage to the external dashboard.

Launcher/supervisor requirements:

1. Load the normal MCP environment and the machine-local watcher environment separately.
2. Start `node dist/src/watcher.js` from the repository/application root after the compiled `dist/` output exists.
3. Keep the watcher alive even when the MCP server or secure tunnel is temporarily unavailable.
4. If the watcher exits unexpectedly, restart the watcher independently.
5. Restarting only the MCP server/tunnel must **not** terminate the watcher.
6. A full launcher/service shutdown may stop both the MCP/tunnel runtime and watcher.
7. Keep watcher output in a separate log where possible. A healthy external delivery cycle contains `remote=ok(200)`.
8. Treat "MCP/tunnel healthy but watcher down" as a degraded host state rather than fully healthy.
9. After `git pull` changes TypeScript sources, run `npm ci` when dependencies changed and always run `npm run build` before restarting the managed runtime.

Conceptually, a launcher should do the equivalent of:

```text
watcherEnv = operatingSystemEnvironment + loadMachineLocalWatcherEnv()
ensureRunning(
  executable = node,
  args = ["dist/src/watcher.js"],
  cwd = applicationRoot,
  env = watcherEnv
)
```

On Windows this can be implemented by the same tray/service supervisor that owns the MCP+tunnel launcher. On Linux it can be a separate systemd unit or another supervisor-managed process. The exact launcher implementation can remain machine-specific; the lifecycle rules above are the required contract.

### One-cycle validation

For troubleshooting, inject the same watcher environment and run one collection/delivery cycle:

```text
COKACREMOTE_WATCHER_ONCE=1
node dist/src/watcher.js
```

A healthy result should report local server/monitor/tunnel state and, when remote delivery is configured, `remote=ok(200)`.

## 7. Add another Cokacremote host to the same dashboard

A new host does **not** require another Worker, D1 database, migration, or dashboard deployment.

For each additional host:

1. Pull the monitored Cokacremote version and build it.
2. Give the host a new `COKACREMOTE_WATCHER_INSTANCE_ID`.
3. Point `COKACREMOTE_WATCHER_REMOTE_URL` at the existing `/api/heartbeat` endpoint.
4. Provision the existing `INGEST_TOKEN` securely as a machine-local secret.
5. Integrate the watcher into that host's launcher/supervisor using the rules above.
6. Confirm the watcher log shows `remote=ok(200)`.
7. Confirm the new instance appears as a separate card in the PWA dashboard.

## 8. iPhone PWA / notifications

1. Open the deployed dashboard URL in Safari.
2. Add it to the Home Screen.
3. Launch it from the Home Screen.
4. Enter `DASHBOARD_TOKEN`.
5. Tap **알림 켜기** and grant notification permission.
6. Use **테스트** to verify Web Push.

The read token is stored only in the browser's local storage. Static PWA assets are public, but status/push APIs require the dashboard token.

## Local validation

```bash
npm test
npm run deploy:dry
npm run d1:local
npm run dev
```

For local API testing create `.dev.vars`:

```text
INGEST_TOKEN=replace-with-local-ingest-token
DASHBOARD_TOKEN=replace-with-local-dashboard-token
```

Web Push secrets are optional for status/heartbeat testing.
