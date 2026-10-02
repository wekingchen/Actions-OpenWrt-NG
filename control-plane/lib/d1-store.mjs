import { decryptString, encryptString } from "./security.mjs";

export class D1ControlPlaneStore {
  constructor(db, encryptionSecret) {
    if (!db) throw new Error("D1 binding DB is required");
    this.db = db;
    this.encryptionSecret = encryptionSecret;
  }

  async purgeExpired(now = Date.now()) {
    await this.db.batch([
      this.db.prepare("DELETE FROM oauth_states WHERE expires_at <= ?").bind(now),
      this.db.prepare("DELETE FROM sessions WHERE session_expires_at <= ?").bind(now)
    ]);
  }

  async createOAuthState({
    stateHash,
    browserHash,
    verifier,
    returnTo,
    expiresAt
  }) {
    await this.db.prepare(`
      INSERT OR REPLACE INTO oauth_states(
        state_hash, browser_hash, verifier_cipher, return_to, expires_at
      ) VALUES (?, ?, ?, ?, ?)
    `).bind(
      stateHash,
      browserHash,
      encryptString(verifier, this.encryptionSecret),
      returnTo,
      expiresAt
    ).run();
  }

  async consumeOAuthState(stateHash, now = Date.now()) {
    const row = await this.db.prepare(`
      DELETE FROM oauth_states
      WHERE state_hash = ? AND expires_at > ?
      RETURNING browser_hash, verifier_cipher, return_to, expires_at
    `).bind(stateHash, now).first();

    if (!row) return null;
    return {
      browserHash: row.browser_hash,
      verifier: decryptString(row.verifier_cipher, this.encryptionSecret),
      returnTo: row.return_to,
      expiresAt: row.expires_at
    };
  }

  async createSession({
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
    await this.db.prepare(`
      INSERT OR REPLACE INTO sessions(
        session_hash, user_login, avatar_url,
        access_cipher, refresh_cipher,
        github_expires_at, refresh_expires_at,
        session_expires_at, created_at, last_seen
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
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
    ).run();
  }

  async getSession(sessionHash, now = Date.now(), idleTtlMs = 0) {
    const row = await this.db.prepare(`
      SELECT *
      FROM sessions
      WHERE session_hash = ?
    `).bind(sessionHash).first();

    if (!row) return null;
    const idleExpired =
      idleTtlMs > 0 && Number(row.last_seen) + idleTtlMs <= now;
    if (Number(row.session_expires_at) <= now || idleExpired) {
      await this.deleteSession(sessionHash);
      return null;
    }

    await this.db.prepare(
      "UPDATE sessions SET last_seen = ? WHERE session_hash = ?"
    ).bind(now, sessionHash).run();

    return {
      sessionHash: row.session_hash,
      userLogin: row.user_login,
      avatarUrl: row.avatar_url,
      accessToken: decryptString(row.access_cipher, this.encryptionSecret),
      refreshToken: row.refresh_cipher
        ? decryptString(row.refresh_cipher, this.encryptionSecret)
        : "",
      githubExpiresAt: Number(row.github_expires_at || 0),
      refreshExpiresAt: Number(row.refresh_expires_at || 0),
      sessionExpiresAt: Number(row.session_expires_at),
      createdAt: Number(row.created_at),
      lastSeen: now
    };
  }

  async updateSessionTokens(sessionHash, token, now = Date.now()) {
    await this.db.prepare(`
      UPDATE sessions
      SET access_cipher = ?,
          refresh_cipher = ?,
          github_expires_at = ?,
          refresh_expires_at = ?,
          last_seen = ?
      WHERE session_hash = ?
    `).bind(
      encryptString(token.accessToken, this.encryptionSecret),
      token.refreshToken
        ? encryptString(token.refreshToken, this.encryptionSecret)
        : null,
      token.expiresAt || null,
      token.refreshExpiresAt || null,
      now,
      sessionHash
    ).run();
  }

  async deleteSession(sessionHash) {
    await this.db.prepare(
      "DELETE FROM sessions WHERE session_hash = ?"
    ).bind(sessionHash).run();
  }
}
