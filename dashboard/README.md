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

## 5. Point a watcher at the deployed API

Configure each Cokacremote host:

```text
COKACREMOTE_WATCHER_REMOTE_URL=https://<worker-domain>/api/heartbeat
COKACREMOTE_WATCHER_REMOTE_TOKEN=<INGEST_TOKEN>
```

Each installation must use a unique `COKACREMOTE_WATCHER_INSTANCE_ID`.

## 6. iPhone PWA / notifications

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
