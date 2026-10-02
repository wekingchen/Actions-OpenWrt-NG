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
      owner: "acme",
      name: "router",
      fullName: "acme/router",
      defaultBranch: "main",
      private: false,
      permissions: {
        contents: "write",
        pullRequests: "write",
        actions: "write"
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
  },
  async getProfile(token, owner, repo, profileId) {
    assert.equal(token, "ghu_worker_access");
    assert.equal(owner, "acme");
    assert.equal(repo, "router");
    assert.equal(profileId, "default");
    return {
      owner,
      repo,
      defaultBranch: "main",
      baseRefSha: "a".repeat(40),
      profile: {
        id: profileId,
        path: "profiles/default",
        files: {
          ".config": {
            path: "profiles/default/.config",
            sha: "cfg",
            exists: true,
            content: "CONFIG_TEST=y\n"
          },
          "profile.env": {
            path: "profiles/default/profile.env",
            sha: "env",
            exists: true,
            content: "PROFILE_NAME=\"Test\"\n"
          },
          "diy-part1.sh": {
            path: "profiles/default/diy-part1.sh",
            sha: "d1",
            exists: true,
            content: "#!/bin/bash\n"
          },
          "diy-part2.sh": {
            path: "profiles/default/diy-part2.sh",
            sha: "d2",
            exists: true,
            content: "#!/bin/bash\n"
          },
          "required-packages.txt": {
            path: "profiles/default/required-packages.txt",
            sha: "req",
            exists: true,
            content: ""
          },
          "watch-sources.txt": {
            path: "profiles/default/watch-sources.txt",
            sha: "watch",
            exists: true,
            content: ""
          }
        }
      }
    };
  },
  async listBuilderRuns(token, owner, repo, options = {}) {
    assert.equal(token, "ghu_worker_access");
    assert.equal(owner, "acme");
    assert.equal(repo, "router");
    if (options.requestId) {
      assert.equal(options.requestId, "abcdef1234567890");
    }
    return [{
      id: 123,
      runNumber: 9,
      displayTitle: "Build · default · cp:abcdef1234567890",
      status: "completed",
      conclusion: "success",
      event: "workflow_dispatch",
      headBranch: "main",
      headSha: "d".repeat(40),
      createdAt: "2026-10-02T00:00:00Z",
      updatedAt: "2026-10-02T00:10:00Z",
      url: "https://github.com/acme/router/actions/runs/123"
    }];
  },
  async triggerBuilder(token, owner, repo, profileId, payload) {
    assert.equal(token, "ghu_worker_access");
    assert.equal(owner, "acme");
    assert.equal(repo, "router");
    assert.equal(profileId, "default");
    assert.equal(payload.publishRelease, false);
    return {
      accepted: true,
      requestId: "abcdef1234567890",
      profileId: "default",
      publishRelease: false,
      ref: "main",
      runId: 0,
      runUrl: ""
    };
  },
  async getBuilderRun(token, owner, repo, runId) {
    assert.equal(token, "ghu_worker_access");
    assert.equal(owner, "acme");
    assert.equal(repo, "router");
    assert.equal(String(runId), "123");
    return {
      id: 123,
      runNumber: 9,
      runAttempt: 1,
      displayTitle: "Build · default · cp:abcdef1234567890",
      status: "completed",
      conclusion: "success",
      event: "workflow_dispatch",
      headBranch: "main",
      headSha: "d".repeat(40),
      createdAt: "2026-10-02T00:00:00Z",
      updatedAt: "2026-10-02T00:10:00Z",
      runStartedAt: "2026-10-02T00:00:10Z",
      url: "https://github.com/acme/router/actions/runs/123",
      summaryUrl: "https://github.com/acme/router/actions/runs/123",
      jobs: [],
      artifacts: [],
      release: null
    };
  },
  async createProfilePullRequest(token, owner, repo, profileId, payload) {
    assert.equal(token, "ghu_worker_access");
    assert.equal(owner, "acme");
    assert.equal(repo, "router");
    assert.equal(profileId, "default");
    assert.equal(payload.baseRefSha, "a".repeat(40));
    assert.equal(payload.files[".config"], "CONFIG_TEST=m\n");
    return {
      branch: "openwrt-ng/profile-default-test",
      commitSha: "b".repeat(40),
      changedFiles: [".config"],
      pullRequest: {
        number: 7,
        url: "https://github.com/acme/router/pull/7"
      }
    };
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
assert.equal("installationId" in reposBody.repositories[0], false);
assert.deepEqual(reposBody.repositories[0].permissions, {
  contents: "write",
  pullRequests: "write",
  actions: "write"
});

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


const detail = await handleControlPlaneRequest(
  new Request(
    "https://worker.example/api/v1/repositories/acme/router/profiles/default",
    { headers: { Cookie: sessionCookie } }
  ),
  configuredEnv,
  deps
);
const detailBody = await detail.json();
assert.equal(detail.status, 200);
assert.equal(detailBody.baseRefSha, "a".repeat(40));
assert.equal(detailBody.profile.files[".config"].content, "CONFIG_TEST=y\n");

const rejectedWrite = await handleControlPlaneRequest(
  new Request(
    "https://worker.example/api/v1/repositories/acme/router/profiles/default/pull-request",
    {
      method: "POST",
      headers: {
        Cookie: sessionCookie,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        baseRefSha: "a".repeat(40),
        files: {
          ".config": "CONFIG_TEST=m\n"
        }
      })
    }
  ),
  configuredEnv,
  deps
);
assert.equal(rejectedWrite.status, 403);
assert.deepEqual(await rejectedWrite.json(), {
  error: "csrf_validation_failed"
});

const writeFiles = {
  ".config": "CONFIG_TEST=m\n",
  "profile.env": "PROFILE_NAME=\"Test\"\n",
  "diy-part1.sh": "#!/bin/bash\n",
  "diy-part2.sh": "#!/bin/bash\n",
  "required-packages.txt": "",
  "watch-sources.txt": ""
};
const write = await handleControlPlaneRequest(
  new Request(
    "https://worker.example/api/v1/repositories/acme/router/profiles/default/pull-request",
    {
      method: "POST",
      headers: {
        Cookie: sessionCookie,
        Origin: "https://worker.example",
        "X-OpenWrt-NG-CSRF": "1",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        baseRefSha: "a".repeat(40),
        files: writeFiles
      })
    }
  ),
  configuredEnv,
  deps
);
assert.equal(write.status, 201);
assert.equal((await write.json()).pullRequest.number, 7);

const builds = await handleControlPlaneRequest(
  new Request(
    "https://worker.example/api/v1/repositories/acme/router/builds?profile=default&request_id=abcdef1234567890",
    { headers: { Cookie: sessionCookie } }
  ),
  configuredEnv,
  deps
);
assert.equal(builds.status, 200);
assert.equal((await builds.json()).runs[0].id, 123);

const buildDetail = await handleControlPlaneRequest(
  new Request(
    "https://worker.example/api/v1/repositories/acme/router/builds/123",
    { headers: { Cookie: sessionCookie } }
  ),
  configuredEnv,
  deps
);
assert.equal(buildDetail.status, 200);
assert.equal((await buildDetail.json()).run.id, 123);

const rejectedBuild = await handleControlPlaneRequest(
  new Request(
    "https://worker.example/api/v1/repositories/acme/router/profiles/default/builds",
    {
      method: "POST",
      headers: {
        Cookie: sessionCookie,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ publishRelease: false })
    }
  ),
  configuredEnv,
  deps
);
assert.equal(rejectedBuild.status, 403);

const build = await handleControlPlaneRequest(
  new Request(
    "https://worker.example/api/v1/repositories/acme/router/profiles/default/builds",
    {
      method: "POST",
      headers: {
        Cookie: sessionCookie,
        Origin: "https://worker.example",
        "X-OpenWrt-NG-CSRF": "1",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ publishRelease: false })
    }
  ),
  configuredEnv,
  deps
);
assert.equal(build.status, 202);
assert.equal((await build.json()).requestId, "abcdef1234567890");

const opaque = sessionCookie.split("=", 2)[1];
assert.ok(store.sessions.has(hashOpaque(decodeURIComponent(opaque))));

const logout = await handleControlPlaneRequest(
  new Request("https://worker.example/api/v1/logout", {
    method: "POST",
    headers: {
      Cookie: sessionCookie,
      Origin: "https://worker.example",
      "X-OpenWrt-NG-CSRF": "1"
    }
  }),
  configuredEnv,
  deps
);
assert.equal(logout.status, 204);
assert.equal(store.sessions.size, 0);

console.log("Cloudflare Worker Control Plane tests passed.");
