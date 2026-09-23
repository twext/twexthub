ALTER TABLE users
  ADD COLUMN is_private BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE versions
  ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'
    CHECK (visibility IN ('public', 'unlisted', 'private')),
  ADD COLUMN manifest_source TEXT,
  ADD COLUMN sources JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN twext_version TEXT,
  ADD COLUMN readme TEXT;

CREATE INDEX versions_visibility_status_idx
  ON versions (status, visibility)
  WHERE status = 'published' AND visibility = 'public';