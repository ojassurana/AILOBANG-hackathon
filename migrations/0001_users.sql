-- One row per WorkOS user, keyed by the WorkOS user id.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  profile_picture_url TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  organization_id TEXT,
  sign_in_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_sign_in_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users (email);
CREATE INDEX IF NOT EXISTS users_created_at_idx ON users (created_at DESC);
