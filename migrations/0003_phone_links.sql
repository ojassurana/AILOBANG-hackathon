-- A user's linked phone number. One number per user and one user per number,
-- and there is no unlink: a call from this number is treated as that user.
CREATE TABLE IF NOT EXISTS phone_links (
  user_id TEXT PRIMARY KEY,
  phone_number TEXT NOT NULL UNIQUE,
  linked_at TEXT NOT NULL
);

-- The one SMS code a user is waiting on. Only a keyed hash of the code is kept.
-- Times are Unix seconds. `window_start` and `sends_in_window` cap how many
-- texts one user can trigger in an hour.
CREATE TABLE IF NOT EXISTS phone_codes (
  user_id TEXT PRIMARY KEY,
  phone_number TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER NOT NULL,
  window_start INTEGER NOT NULL,
  sends_in_window INTEGER NOT NULL DEFAULT 1
);
