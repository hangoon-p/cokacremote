CREATE TABLE IF NOT EXISTS instances (
  instance_id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  status_key TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL,
  offline_notified INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_instances_last_seen
  ON instances(last_seen_at);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_occurred
  ON events(occurred_at DESC);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  subscription_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
