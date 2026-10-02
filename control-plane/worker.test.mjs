import assert from "node:assert/strict";
import { hashOpaque } from "./lib/security.mjs";
import { handleControlPlaneRequest } from "./worker.mjs";

class MemoryStore {
  constructor() {
    this.states = new Map();
    this.sessions = new Map();
  }

  async purgeExpired() {}

  async createOAuthState(value) {
    this.states.set(value.stateHash, value);
  }

  async consumeOAuthState(stateHash) {
    const value = this.states.get(stateHash) || null;
    this.states.delete(stateHash);
    return value;
  }

  async createSession(value) {
    this.sessions.set(value.sessionHash, {
      sessionHash: value.sessionHash,
      userLogin: value.userLogin,
      avatarUrl: value.avatarUrl,
      accessToken: value.accessToken,
      refreshToken: value.refreshToken,
      githubExpiresAt: value.githubExpiresAt,
      refreshExpiresAt: value.refreshExpiresAt,
      sessionExpiresAt: value.sessionExpiresAt,
      createdAt: Date.now(),
      lastSeen: Date.now()
    });
  }

  async getSession(sessionHash) {
    return this.sessions.get(sessionHash) || null;
  }

  async updateSessionTokens(sessionHash, token) {
    const current = this.sessions.get(sessionHash);
    this.sessions.set(sessionHash, {
      ...current,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      githubExpiresAt: token.expiresAt,
      refreshExpiresAt: token.refreshExpiresAt
    });
  }

  async deleteSession(sessionHash) {
    this.sessions.delete(sessionHash);
  }
}

const github = {
  authorizeUrl({ state, codeChallenge }) {
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  },
  async exchangeCode(code, verifier) {
    assert.equal(code, "test-code");
    assert.ok(verifier);
    return {
      accessToken: "ghu_worker_access",
      refreshToken: "ghr_worker_refresh",
      expiresAt: Date.now() + 3_600_000,
      refreshExpiresAt: Date.now() + 86_400_000
    };
  },
  async getUser() {
    return {
      login: "worker-user",
      avatar_url: "https://avatars.githubusercontent.com/u/1?v=4"
    };
  },
  async refreshUserToken() {
    throw new Error("refresh should not be needed in this test");
  },
  async listRepositories(token) {
    assert.equal(token, "ghu_worker_access");
    return [{
      installationId: 101,
      owner: "acme",
      name: "router",
      fullName: "acme/router",
      defaultBranch: "main",
      private: false,
      permissions: {
        contents: "read",
        actions: "none"
      }
    }];
  },
  async listProfiles(token, owner, repo) {
    assert.equal(token, "ghu_worker_access");
    assert.equal(owner, "acme");
    assert.equal(repo, "router");
    return [{
      id: "default",
      path: "profiles/default",
      sha: "abc"
    }];
  }
};

const configuredEnv = {
  DB: {},
  GITHUB_APP_CLIENT_ID: "Iv1.worker",
  GITHUB_APP_CLIENT_SECRET: "client-secret",
  GITHUB_APP_SLUG: "openwrt-ng-worker-test",
  TOKEN_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
  SESSION_TTL_SECONDS: "3600",
  SESSION_IDLE_TTL_SECONDS: "900",
  ASSETS: {
    async fetch() {
      return new Response("<html>asset</html>", {
        headers: { "content-type": "text/html" }
      });
    }
  }
};

const store = new MemoryStore();
const deps = { store, github };

const bootstrapHealth = await handleControlPlaneRequest(
  new Request("https://worker.example/api/v1/health"),
  { ASSETS: configuredEnv.ASSETS }
);
assert.deepEqual(await bootstrapHealth.json(), {
  ok: true,
  version: 1,
  runtime: "cloudflare-workers",
  configured: false
});

const bootstrapAuth = await handleControlPlaneRequest(
  new Request("https://worker.example/api/v1/auth/start"),
  { ASSETS: configuredEnv.ASSETS }
);
assert.equal(bootstrapAuth.status, 503);

const asset = await handleControlPlaneRequest(
  new Request("https://worker.example/"),
  { ASSETS: configuredEnv.ASSETS }
);
assert.equal(asset.status, 200);
assert.match(await asset.text(), /asset/);
assert.equal(asset.headers.get("x-frame-options"), "DENY");

const config = await handleControlPlaneRequest(
  new Request("https://worker.example/api/v1/config"),
  configuredEnv,
  deps
);
assert.deepEqual(await config.json(), {
  configured: true,
  githubAppInstallUrl:
    "https://github.com/apps/openwrt-ng-worker-test/installations/new"
});

const csrfStart = await handleControlPlaneRequest(
  new Request("https://worker.example/api/v1/auth/start?return_to=/"),
  configuredEnv,
  deps
);
const csrfLocation = new URL(csrfStart.headers.get("location"));
const csrfState = csrfLocation.searchParams.get("state");
const csrfCallback = await handleControlPlaneRequest(
  new Request(
    "https://worker.example/api/v1/auth/callback?code=test-code&state=" +
      encodeURIComponent(csrfState)
  ),
  configuredEnv,
  deps
);
assert.equal(csrfCallback.status, 400);
assert.deepEqual(await csrfCallback.json(), {
  error: "missing_oauth_browser_binding"
});


const failingStore = new MemoryStore();
const failingGithub = {
  ...github,
  async exchangeCode() {
    const error = new Error("GitHub request failed");
    error.githubError = "incorrect_client_credentials";
    throw error;
  }
};

const failingStart = await handleControlPlaneRequest(
  new Request("https://worker.example/api/v1/auth/start?return_to=/"),
  configuredEnv,
  { store: failingStore, github: failingGithub }
);
const failingLocation = new URL(failingStart.headers.get("location"));
const failingState = failingLocation.searchParams.get("state");
const failingOAuthCookie = failingStart.headers
  .get("set-cookie")
  .split(";", 1)[0];

const failingCallback = await handleControlPlaneRequest(
  new Request(
    "https://worker.example/api/v1/auth/callback?code=test-code&state=" +
      encodeURIComponent(failingState),
    { headers: { Cookie: failingOAuthCookie } }
  ),
  configuredEnv,
  { store: failingStore, github: failingGithub }
);
assert.equal(failingCallback.status, 502);
assert.deepEqual(await failingCallback.json(), {
  error: "github_oauth_exchange_failed",
  reason: "incorrect_client_credentials"
});

const start = await handleControlPlaneRequest(
  new Request("https://worker.example/api/v1/auth/start?return_to=/"),
  configuredEnv,
  deps
);
assert.equal(start.status, 302);
const location = new URL(start.headers.get("location"));
assert.equal(location.hostname, "github.com");
assert.equal(location.searchParams.get("code_challenge_method"), "S256");
const state = location.searchParams.get("state");
assert.ok(state);
const oauthSetCookie = start.headers.get("set-cookie");
assert.match(oauthSetCookie, /ong_oauth=/);
assert.match(oauthSetCookie, /Secure/);
const oauthCookie = oauthSetCookie.split(";", 1)[0];

const callback = await handleControlPlaneRequest(
  new Request(
    "https://worker.example/api/v1/auth/callback?code=test-code&state=" +
      encodeURIComponent(state),
    { headers: { Cookie: oauthCookie } }
  ),
  configuredEnv,
  deps
);
assert.equal(callback.status, 302);
assert.equal(callback.headers.get("location"), "/");
const setCookies =
  typeof callback.headers.getSetCookie === "function"
    ? callback.headers.getSetCookie()
    : [callback.headers.get("set-cookie")].filter(Boolean);
const sessionSetCookie = setCookies.find((item) =>
  item.startsWith("ong_session=")
);
assert.ok(sessionSetCookie);
assert.doesNotMatch(
  setCookies.join("\n"),
  /ghu_worker_access|ghr_worker_refresh/
);
const sessionCookie = sessionSetCookie.split(";", 1)[0];

const session = await handleControlPlaneRequest(
  new Request("https://worker.example/api/v1/session", {
    headers: { Cookie: sessionCookie }
  }),
  configuredEnv,
  deps
);
const sessionBody = await session.json();
assert.equal(sessionBody.authenticated, true);
assert.equal(sessionBody.user.login, "worker-user");
assert.equal(JSON.stringify(sessionBody).includes("ghu_"), false);

const repos = await handleControlPlaneRequest(
  new Request("https://worker.example/api/v1/repositories", {
    headers: { Cookie: sessionCookie }
  }),
  configuredEnv,
  deps
);
const reposBody = await repos.json();
assert.equal(reposBody.repositories[0].fullName, "acme/router");

const profiles = await handleControlPlaneRequest(
  new Request(
    "https://worker.example/api/v1/repositories/acme/router/profiles",
    { headers: { Cookie: sessionCookie } }
  ),
  configuredEnv,
  deps
);
assert.deepEqual((await profiles.json()).profiles, [{
  id: "default",
  path: "profiles/default",
  sha: "abc"
}]);

const opaque = sessionCookie.split("=", 2)[1];
assert.ok(store.sessions.has(hashOpaque(decodeURIComponent(opaque))));

const logout = await handleControlPlaneRequest(
  new Request("https://worker.example/api/v1/logout", {
    method: "POST",
    headers: { Cookie: sessionCookie }
  }),
  configuredEnv,
  deps
);
assert.equal(logout.status, 204);
assert.equal(store.sessions.size, 0);

console.log("Cloudflare Worker Control Plane tests passed.");
