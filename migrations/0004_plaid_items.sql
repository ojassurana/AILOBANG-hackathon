-- A bank a user linked through Plaid Link. One row per Plaid Item: one login at
-- one institution, which can hold several accounts.
--
-- `access_token` is never stored in the clear: it is AES-GCM ciphertext under
-- PLAID_TOKEN_KEY, bound to the item and user ids, so a row copied under another
-- user will not decrypt. `accounts` is the JSON list of the item's accounts as
-- they were at link time, for the page to show without calling Plaid.
-- `needs_login` is set when Plaid reports the bank wants the user to sign in
-- again, and cleared when they do.
CREATE TABLE IF NOT EXISTS plaid_items (
  item_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  access_token TEXT NOT NULL,
  institution_id TEXT,
  institution_name TEXT NOT NULL,
  accounts TEXT NOT NULL,
  needs_login INTEGER NOT NULL DEFAULT 0,
  linked_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS plaid_items_user ON plaid_items (user_id);
