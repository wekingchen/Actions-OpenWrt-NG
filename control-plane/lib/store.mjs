import { DatabaseSync } from "node:sqlite";
import { decryptString, encryptString } from "./security.mjs";

export class ControlPlaneStore {
  constructor(path, encryptionSecret) {
    this.encryptionSecret = encryptionSecret;
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS oauth_states (
        state_hash TEXT PRIMARY KEY,
        browser_hash TEXT NOT NULL,
        verifier_cipher TEXT NOT NULL,
        return_to TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;

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
      ) STRICT;

      CREATE INDEX IF NOT EXISTS sessions_expiry_idx
        ON sessions(session_expires_at);
      CREATE INDEX IF NOT EXISTS oauth_states_expiry_idx
        ON oauth_states(expires_at);
    `);
  }

  close() {
    this.db.close();
  }

  purgeExpired(now = Date.now()) {
    this.db.prepare("DELETE FROM oauth_states WHERE expires_at <= ?").run(now);
    this.db.prepare("DELETE FROM sessions WHERE session_expires_at <= ?").run(now);
  }

  createOAuthState({
    stateHash,
    browserHash,
    verifier,
    returnTo,
    expiresAt
  }) {
    this.db.prepare(`
      INSERT OR REPLACE INTO oauth_states(
        state_hash, browser_hash, verifier_cipher, return_to, expires_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      stateHash,
      browserHash,
      encryptString(verifier, this.encryptionSecret),
      returnTo,
      expiresAt
    );
  }

  consumeOAuthState(stateHash, now = Date.now()) {
    const row = this.db.prepare(`
      SELECT state_hash, browser_hash, verifier_cipher, return_to, expires_at
      FROM oauth_states
      WHERE state_hash = ?
    `).get(stateHash);

    this.db.prepare("DELETE FROM oauth_states WHERE state_hash = ?").run(stateHash);

    if (!row || row.expires_at <= now) return null;
    return {
      browserHash: row.browser_hash,
      verifier: decryptString(row.verifier_cipher, this.encryptionSecret),
      returnTo: row.return_to,
      expiresAt: row.expires_at
    };
  }

  createSession({
    sessionHash,
    userLogin,
    avatarUrl,
    accessToken,
    refreshToken,
    githubExpiresAt,
    refreshExpiresAt,
    sessionExpiresAt,
    now = Date.now()
  }) {
    this.db.prepare(`
      INSERT OR REPLACE INTO sessions(
        session_hash, user_login, avatar_url,
        access_cipher, refresh_cipher,
        github_expires_at, refresh_expires_at,
        session_expires_at, created_at, last_seen
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionHash,
      userLogin,
      avatarUrl,
      encryptString(accessToken, this.encryptionSecret),
      refreshToken ? encryptString(refreshToken, this.encryptionSecret) : null,
      githubExpiresAt || null,
      refreshExpiresAt || null,
      sessionExpiresAt,
      now,
      now
    );
  }

  getSession(sessionHash, now = Date.now(), idleTtlMs = 0) {
    const row = this.db.prepare(`
      SELECT *
      FROM sessions
      WHERE session_hash = ?
    `).get(sessionHash);

    if (!row) return null;
    const idleExpired =
      idleTtlMs > 0 && row.last_seen + idleTtlMs <= now;
    if (row.session_expires_at <= now || idleExpired) {
      this.deleteSession(sessionHash);
      return null;
    }

    this.db.prepare(
      "UPDATE sessions SET last_seen = ? WHERE session_hash = ?"
    ).run(now, sessionHash);

    return {
      sessionHash: row.session_hash,
      userLogin: row.user_login,
      avatarUrl: row.avatar_url,
      accessToken: decryptString(row.access_cipher, this.encryptionSecret),
      refreshToken: row.refresh_cipher
        ? decryptString(row.refresh_cipher, this.encryptionSecret)
        : "",
      githubExpiresAt: row.github_expires_at || 0,
      refreshExpiresAt: row.refresh_expires_at || 0,
      sessionExpiresAt: row.session_expires_at,
      createdAt: row.created_at,
      lastSeen: now
    };
  }

  updateSessionTokens(sessionHash, token, now = Date.now()) {
    this.db.prepare(`
      UPDATE sessions
      SET access_cipher = ?,
          refresh_cipher = ?,
          github_expires_at = ?,
          refresh_expires_at = ?,
          last_seen = ?
      WHERE session_hash = ?
    `).run(
      encryptString(token.accessToken, this.encryptionSecret),
      token.refreshToken
        ? encryptString(token.refreshToken, this.encryptionSecret)
        : null,
      token.expiresAt || null,
      token.refreshExpiresAt || null,
      now,
      sessionHash
    );
  }

  deleteSession(sessionHash) {
    this.db.prepare("DELETE FROM sessions WHERE session_hash = ?").run(sessionHash);
  }
}
