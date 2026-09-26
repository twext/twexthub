-- Download events keep a keyed hash of the client address rather than the
-- address itself: the daily aggregate only has to tell clients apart. An
-- unsalted hash of an IPv4 address is reversible in seconds, so the key lives
-- in the database and is created on first use.
ALTER TABLE download_events RENAME COLUMN remote_addr TO ip_hash;

CREATE TABLE registry_secrets (
  name TEXT PRIMARY KEY,
  secret TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Events older than two days are already in extension_daily_downloads, which
-- is all trending and download totals read, so the values that were stored
-- before this migration can be dropped.
UPDATE download_events SET ip_hash = NULL WHERE created_at < now() - interval '2 days';
