CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  verifier_cipher TEXT NOT NULL,
  return_to TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  session_hash TEXT PRIMARY KEY,
  user_login TEXT NOT NULL,
  avatar_url TEXT NOT NULL,
  access_cipher TEXT NOT NULL,
  refresh_cipher TEXT,
  github_expires_at INTEGER,
  refresh_expires_at INTEGER,
  session_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_expiry_idx
  ON sessions(session_expires_at);

CREATE INDEX IF NOT EXISTS oauth_states_expiry_idx
  ON oauth_states(expires_at);
