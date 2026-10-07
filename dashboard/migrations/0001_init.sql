CREATE TABLE IF NOT EXISTS instances (
  instance_id TEXT PRIMARY KEY,
  snapshot_json TEXT NOT NULL,
  status_key TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL,
  offline_notified INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  subscription_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
