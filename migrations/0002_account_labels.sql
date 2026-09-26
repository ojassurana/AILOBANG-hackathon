-- Cached display labels for connected accounts.
--
-- Composio does not return a profile for every toolkit: Google connections carry
-- only tokens and scopes, so the owning account has to be resolved by calling the
-- provider through Composio's proxy. That is a live request, so the answer is
-- cached here against the connection id, which is never reused.
CREATE TABLE IF NOT EXISTS account_labels (
  connected_account_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  resolved_at TEXT NOT NULL
);
