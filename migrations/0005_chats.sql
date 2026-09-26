-- Call history. One row per conversation, whether it came from the call page or
-- from dialling in, so "what did I ask it last Tuesday" survives the call.
--
-- `title` is the first thing the caller said, trimmed, and is what the list
-- shows. `updated_at` is what orders the list, and moves when a call is
-- continued rather than only when the chat is created.
--
-- `seconds` accumulates: continuing a chat adds to the call it already had.
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  title TEXT NOT NULL,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  seconds INTEGER NOT NULL DEFAULT 0,
  lines INTEGER NOT NULL DEFAULT 0
);

-- Newest first per user is the only way this table is ever read.
CREATE INDEX IF NOT EXISTS chats_user_updated ON chats (user_id, updated_at DESC);

-- The spoken lines of one chat, in order. A line grows while it is being said,
-- so it is written again as it grows: (chat_id, seq) is replaced, not appended.
CREATE TABLE IF NOT EXISTS chat_lines (
  chat_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (chat_id, seq)
);
