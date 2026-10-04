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
      sha: "abc",
      baseline: true
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
      baselineProfileId: "default",
      profile: {
        id: profileId,
        path: "profiles/default",
        baseline: true,
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
          },
          "feeds.conf": {
            path: "profiles/default/feeds.conf",
            sha: "feeds",
            exists: true,
            content: "src-git demo https://github.com/example/demo.git;main\n"
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
  async cancelBuilderRun(token, owner, repo, runId) {
    assert.equal(token, "ghu_worker_access");
    assert.equal(owner, "acme");
    assert.equal(repo, "router");
    assert.equal(String(runId), "123");
    return {
      accepted: true,
      action: "cancel",
      runId: 123,
      runNumber: 9,
      url: "https://github.com/acme/router/actions/runs/123"
    };
  },
  async rerunBuilderRun(token, owner, repo, runId) {
    assert.equal(token, "ghu_worker_access");
    assert.equal(owner, "acme");
    assert.equal(repo, "router");
    assert.equal(String(runId), "123");
    return {
      accepted: true,
      action: "rerun",
      runId: 123,
      runNumber: 9,
      nextAttempt: 2,
      url: "https://github.com/acme/router/actions/runs/123"
    };
  },
  async getBuilderArtifactDownloadUrl(token, owner, repo, runId, artifactId) {
    assert.equal(token, "ghu_worker_access");
    assert.equal(owner, "acme");
    assert.equal(repo, "router");
    assert.equal(String(runId), "123");
    assert.equal(String(artifactId), "77");
    return "https://downloads.example.test/worker/77.zip";
  },
  async startConfigStudio(token, owner, repo, payload) {
    assert.equal(token, "ghu_worker_access");
    assert.equal(owner, "acme");
    assert.equal(repo, "router");
    assert.equal(payload.profileId, "default");
    return {
      accepted: true,
      requestId: "aabbccddeeff0011",
      branch: "openwrt-ng/config-session-aabbccddeeff0011",
      profileId: "default",
      runId: 456,
      runUrl: "https://github.com/acme/router/actions/runs/456"
    };
  },
  async getConfigStudioSession(token, owner, repo, requestId) {
    assert.equal(token, "ghu_worker_access");
    assert.equal(owner, "acme");
    assert.equal(repo, "router");
    assert.equal(requestId, "aabbccddeeff0011");
    return {
      requestId,
      branch: "openwrt-ng/config-session-aabbccddeeff0011",
      profileId: "default",
      status: { status: "ready", mode: "catalog", requestId },
      run: {
        id: 456,
        status: "completed",
        conclusion: "success",
        url: "https://github.com/acme/router/actions/runs/456"
      },
      catalog: {
        version: 1,
        targets: [],
        packages: [],
        packageCategories: [],
        features: []
      },
      result: null
    };
  },
  async submitConfigStudioSelection(token, owner, repo, requestId, payload) {
    assert.equal(token, "ghu_worker_access");
    assert.equal(owner, "acme");
    assert.equal(repo, "router");
    assert.equal(requestId, "aabbccddeeff0011");
    assert.equal(payload.values.CONFIG_PACKAGE_luci, "y");
    return {
      accepted: true,
      requestId,
      branch: "openwrt-ng/config-session-aabbccddeeff0011",
      runId: 457,
      runUrl: "https://github.com/acme/router/actions/runs/457"
    };
  },
  async applyConfigStudioToProfile(token, owner, repo, requestId, profileId) {
    assert.equal(token, "ghu_worker_access");
    assert.equal(owner, "acme");
    assert.equal(repo, "router");
    assert.equal(requestId, "aabbccddeeff0011");
    assert.equal(profileId, "default");
    return {
      branch: "openwrt-ng/profile-default-config-studio",
      commitSha: "e".repeat(40),
      changedFiles: [".config"],
      action: "update",
      pullRequest: {
        number: 11,
        url: "https://github.com/acme/router/pull/11",
        merged: true,
        mergeCommitSha: "e".repeat(40),
        mergeReason: ""
      },
      cleanup: {
        branchDeleted: true,
        supersededPullRequests: []
      }
    };
  },
  async deleteConfigStudioSession(token, owner, repo, requestId) {
    assert.equal(token, "ghu_worker_access");
    assert.equal(owner, "acme");
    assert.equal(repo, "router");
    assert.equal(requestId, "aabbccddeeff0011");
    return { deleted: true, requestId };
  },

  async createNewProfilePullRequest(token, owner, repo, profileId, files) {
    assert.equal(token, "ghu_worker_access");
    assert.equal(owner, "acme");
    assert.equal(repo, "router");
    assert.equal(profileId, "new-profile");
    assert.equal(files[".config"], "CONFIG_TARGET_x86=y\n");
    assert.match(files["profile.env"], /PROFILE_NAME='New Profile'/);
    return {
      branch: "openwrt-ng/profile-new-profile-test",
      commitSha: "c".repeat(40),
      changedFiles: [
        ".config",
        "profile.env",
        "diy-part1.sh",
        "diy-part2.sh",
        "required-packages.txt",
        "watch-sources.txt",
        "feeds.conf"
      ],
      action: "create",
      pullRequest: {
        number: 8,
        url: "https://github.com/acme/router/pull/8",
        merged: true,
        mergeCommitSha: "c".repeat(40),
        mergeReason: ""
      },
      cleanup: {
        branchDeleted: true,
        supersededPullRequests: []
      }
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
        url: "https://github.com/acme/router/pull/7",
        merged: true,
        mergeCommitSha: "b".repeat(40),
        mergeReason: ""
      },
      cleanup: {
        branchDeleted: true,
        supersededPullRequests: []
      }
    };
  },
  async copyProfilePullRequest(token, owner, repo, profileId, payload) {
    assert.equal(token, "ghu_worker_access");
    assert.equal(owner, "acme");
    assert.equal(repo, "router");
    assert.equal(profileId, "default");
    assert.equal(payload.baseRefSha, "a".repeat(40));
    assert.equal(payload.targetProfileId, "default-copy");
    return {
      branch: "openwrt-ng/profile-default-copy",
      commitSha: "2".repeat(40),
      changedFiles: [".config", "profile.env"],
      action: "copy",
      sourceProfileId: "default",
      targetProfileId: "default-copy",
      baselineProfileId: "default",
      pullRequest: {
        number: 12,
        url: "https://github.com/acme/router/pull/12",
        merged: true,
        mergeCommitSha: "2".repeat(40),
        mergeReason: ""
      },
      cleanup: { branchDeleted: true, supersededPullRequests: [] }
    };
  },
  async renameProfilePullRequest(token, owner, repo, profileId, payload) {
    assert.equal(token, "ghu_worker_access");
    assert.equal(owner, "acme");
    assert.equal(repo, "router");
    assert.equal(profileId, "default");
    assert.equal(payload.baseRefSha, "a".repeat(40));
    assert.equal(payload.targetProfileId, "default-renamed");
    return {
      branch: "openwrt-ng/profile-default-rename",
      commitSha: "3".repeat(40),
      changedFiles: ["profiles/default/.config", "profiles/default-renamed/.config"],
      action: "rename",
      sourceProfileId: "default",
      targetProfileId: "default-renamed",
      baselineProfileId: "default-renamed",
      configStudioCleanup: {
        sessionsFound: 1,
        branchesDeleted: 1,
        canceledRuns: [456],
        cancelFailedRuns: [],
        branchDeleteFailures: [],
        runLookupFailed: false
      },
      pullRequest: {
        number: 13,
        url: "https://github.com/acme/router/pull/13",
        merged: true,
        mergeCommitSha: "3".repeat(40),
        mergeReason: ""
      },
      cleanup: { branchDeleted: true, supersededPullRequests: [] }
    };
  },
  async setBaselineProfilePullRequest(token, owner, repo, profileId, payload) {
    assert.equal(token, "ghu_worker_access");
    assert.equal(owner, "acme");
    assert.equal(repo, "router");
    assert.equal(profileId, "other-profile");
    assert.equal(payload.baseRefSha, "a".repeat(40));
    return {
      branch: "openwrt-ng/profile-other-profile-baseline",
      commitSha: "f".repeat(40),
      changedFiles: ["profiles/.baseline"],
      action: "baseline",
      baselineProfileId: "other-profile",
      pullRequest: {
        number: 10,
        url: "https://github.com/acme/router/pull/10",
        merged: true,
        mergeCommitSha: "1".repeat(40),
        mergeReason: ""
      },
      cleanup: {
        branchDeleted: true,
        supersededPullRequests: []
      }
    };
  },
  async listDeletedProfiles(token, owner, repo, options = {}) {
    assert.equal(token, "ghu_worker_access");
    assert.equal(owner, "acme");
    assert.equal(repo, "router");
    assert.equal(Number(options.limit), 10);
    return [{
      id: "old-profile",
      deletionCommitSha: "7".repeat(40),
      deletedAt: "2026-10-04T10:00:00Z",
      commitUrl: "https://github.com/acme/router/commit/" + "7".repeat(40),
      message: "profile(old-profile): delete via Control Plane"
    }];
  },
  async restoreDeletedProfilePullRequest(token, owner, repo, profileId, payload) {
    assert.equal(token, "ghu_worker_access");
    assert.equal(owner, "acme");
    assert.equal(repo, "router");
    assert.equal(profileId, "old-profile");
    assert.equal(payload.deletionCommitSha, "7".repeat(40));
    return {
      branch: "openwrt-ng/profile-old-profile-restore",
      commitSha: "6".repeat(40),
      changedFiles: [
        ".config",
        "profile.env",
        "diy-part1.sh",
        "diy-part2.sh",
        "required-packages.txt",
        "watch-sources.txt",
        "feeds.conf"
      ],
      action: "restore",
      pullRequest: {
        number: 14,
        url: "https://github.com/acme/router/pull/14",
        merged: true,
        mergeCommitSha: "6".repeat(40),
        mergeReason: ""
      },
      cleanup: {
        branchDeleted: true,
        supersededPullRequests: []
      }
    };
  },
  async triggerReleaseExisting(token, owner, repo, sourceRunId) {
    assert.equal(token, "ghu_worker_access");
    assert.equal(owner, "acme");
    assert.equal(repo, "router");
    assert.equal(String(sourceRunId), "123");
    return {
      accepted: true,
      sourceRunId: 123,
      ref: "main",
      runId: 333,
      runUrl: "https://github.com/acme/router/actions/runs/333"
    };
  },
  async getReleaseExistingRun(token, owner, repo, runId) {
    assert.equal(token, "ghu_worker_access");
    assert.equal(owner, "acme");
    assert.equal(repo, "router");
    assert.equal(String(runId), "333");
    return {
      id: 333,
      runNumber: 77,
      runAttempt: 1,
      displayTitle: "Release Existing · source:123",
      status: "in_progress",
      conclusion: "",
      event: "workflow_dispatch",
      headBranch: "main",
      headSha: "a".repeat(40),
      createdAt: "2026-10-04T11:00:00Z",
      updatedAt: "2026-10-04T11:01:00Z",
      runStartedAt: "2026-10-04T11:00:10Z",
      url: "https://github.com/acme/router/actions/runs/333",
      progress: {
        completed: 1,
        total: 2,
        percent: 50,
        current: "发布 Release",
        currentDetail: "发布已有构建",
        failed: "",
        steps: []
      },
      jobs: []
    };
  },
  async triggerUpdateChecker(token, owner, repo, payload) {
    assert.equal(token, "ghu_worker_access");
    assert.equal(owner, "acme");
    assert.equal(repo, "router");
    assert.equal(payload.profileId, "default");
    assert.equal(payload.force, true);
    return {
      accepted: true,
      profileId: "default",
      force: true,
      ref: "main",
      runId: 444,
      runUrl: "https://github.com/acme/router/actions/runs/444"
    };
  },
  async getUpdateCheckerRun(token, owner, repo, runId) {
    assert.equal(token, "ghu_worker_access");
    assert.equal(owner, "acme");
    assert.equal(repo, "router");
    assert.equal(String(runId), "444");
    return {
      id: 444,
      runNumber: 31,
      runAttempt: 1,
      displayTitle: "Update Checker · profile:default · force:true",
      status: "in_progress",
      conclusion: "",
      event: "workflow_dispatch",
      headBranch: "main",
      headSha: "a".repeat(40),
      createdAt: "2026-10-04T11:02:00Z",
      updatedAt: "2026-10-04T11:03:00Z",
      runStartedAt: "2026-10-04T11:02:10Z",
      url: "https://github.com/acme/router/actions/runs/444",
      progress: {
        completed: 1,
        total: 2,
        percent: 50,
        current: "比较上游状态",
        currentDetail: "检查上游状态",
        failed: "",
        steps: []
      },
      jobs: []
    };
  },

  async deleteProfilePullRequest(token, owner, repo, profileId, payload) {
    assert.equal(token, "ghu_worker_access");
    assert.equal(owner, "acme");
    assert.equal(repo, "router");
    assert.equal(profileId, "old-profile");
    assert.equal(payload.baseRefSha, "a".repeat(40));
    return {
      branch: "openwrt-ng/profile-old-profile-delete",
      commitSha: "d".repeat(40),
      changedFiles: [
        ".config",
        "profile.env",
        "diy-part1.sh",
        "diy-part2.sh",
        "required-packages.txt",
        "watch-sources.txt",
        "feeds.conf"
      ],
      action: "delete",
      pullRequest: {
        number: 9,
        url: "https://github.com/acme/router/pull/9",
        merged: true,
        mergeCommitSha: "e".repeat(40),
        mergeReason: ""
      },
      cleanup: {
        branchDeleted: true,
        supersededPullRequests: []
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
assert.equal(
  sessionBody.user.avatarUrl,
  "https://avatars.githubusercontent.com/u/1?v=4"
);
assert.equal(JSON.stringify(sessionBody).includes("ghu_"), false);

for (const stored of deps.store.sessions.values()) {
  stored.avatarUrl = "";
}
const refreshedAvatarSession = await handleControlPlaneRequest(
  new Request("https://worker.example/api/v1/session", {
    headers: { Cookie: sessionCookie }
  }),
  configuredEnv,
  deps
);
const refreshedAvatarBody = await refreshedAvatarSession.json();
assert.equal(
  refreshedAvatarBody.user.avatarUrl,
  "https://avatars.githubusercontent.com/u/1?v=4"
);

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
const profilesBody = await profiles.json();
assert.equal(profilesBody.baselineProfileId, "default");
assert.deepEqual(profilesBody.profiles, [{
  id: "default",
  path: "profiles/default",
  sha: "abc",
  baseline: true
}]);


const templateInput = {
  profileId: "new-profile",
  profileName: "New Profile",
  sourceRepo: "https://github.com/openwrt/openwrt",
  sourceBranch: "main",
  adapter: "direct-openwrt",
  configText: "CONFIG_TARGET_x86=y\n",
  autoUpdate: false,
  uploadRelease: true,
  uploadFirmware: true,
  maximizeSpace: false,
  streamLog: true,
  requiredPackages: "",
  watchSources: "",
  extraFeeds: "src-git --force helloworld https://github.com/fw876/helloworld.git"
};

const rejectedTemplatePreview = await handleControlPlaneRequest(
  new Request(
    "https://worker.example/api/v1/profile-templates/preview",
    {
      method: "POST",
      headers: {
        Cookie: sessionCookie,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(templateInput)
    }
  ),
  configuredEnv,
  deps
);
assert.equal(rejectedTemplatePreview.status, 403);

const oversizedTemplatePreview = await handleControlPlaneRequest(
  new Request(
    "https://worker.example/api/v1/profile-templates/preview",
    {
      method: "POST",
      headers: {
        Cookie: sessionCookie,
        Origin: "https://worker.example",
        "X-OpenWrt-NG-CSRF": "1",
        "Content-Type": "application/json",
        "Content-Length": String(6 * 1024 * 1024)
      },
      body: "{}"
    }
  ),
  configuredEnv,
  deps
);
assert.equal(oversizedTemplatePreview.status, 413);
assert.deepEqual(await oversizedTemplatePreview.json(), {
  error: "request_body_too_large"
});

const templatePreview = await handleControlPlaneRequest(
  new Request(
    "https://worker.example/api/v1/profile-templates/preview",
    {
      method: "POST",
      headers: {
        Cookie: sessionCookie,
        Origin: "https://worker.example",
        "X-OpenWrt-NG-CSRF": "1",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(templateInput)
    }
  ),
  configuredEnv,
  deps
);
assert.equal(templatePreview.status, 200);
const templatePreviewBody = await templatePreview.json();
assert.equal(templatePreviewBody.profileId, "new-profile");
assert.equal(templatePreviewBody.files.length, 7);
assert.ok(
  templatePreviewBody.files.every((file) =>
    file.path.startsWith("profiles/new-profile/")
  )
);

const createProfile = await handleControlPlaneRequest(
  new Request(
    "https://worker.example/api/v1/repositories/acme/router/profiles",
    {
      method: "POST",
      headers: {
        Cookie: sessionCookie,
        Origin: "https://worker.example",
        "X-OpenWrt-NG-CSRF": "1",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(templateInput)
    }
  ),
  configuredEnv,
  deps
);
assert.equal(createProfile.status, 201);
const createProfileBody = await createProfile.json();
assert.equal(createProfileBody.profileId, "new-profile");
assert.equal(createProfileBody.action, "create");
assert.equal(createProfileBody.pullRequest.number, 8);
assert.equal(createProfileBody.pullRequest.merged, true);

const deletedProfiles = await handleControlPlaneRequest(
  new Request(
    "https://worker.example/api/v1/repositories/acme/router/profiles/deleted?limit=10",
    { headers: { Cookie: sessionCookie } }
  ),
  configuredEnv,
  deps
);
assert.equal(deletedProfiles.status, 200);
const deletedProfilesBody = await deletedProfiles.json();
assert.equal(deletedProfilesBody.profiles[0].id, "old-profile");
assert.equal(
  deletedProfilesBody.profiles[0].deletionCommitSha,
  "7".repeat(40)
);

const restoreProfile = await handleControlPlaneRequest(
  new Request(
    "https://worker.example/api/v1/repositories/acme/router/profiles/old-profile/restore",
    {
      method: "POST",
      headers: {
        Cookie: sessionCookie,
        Origin: "https://worker.example",
        "X-OpenWrt-NG-CSRF": "1",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ deletionCommitSha: "7".repeat(40) })
    }
  ),
  configuredEnv,
  deps
);
assert.equal(restoreProfile.status, 201);
const restoreProfileBody = await restoreProfile.json();
assert.equal(restoreProfileBody.action, "restore");
assert.equal(restoreProfileBody.pullRequest.number, 14);

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
assert.equal(detailBody.baselineProfileId, "default");
assert.equal(detailBody.profile.baseline, true);
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
  "watch-sources.txt": "",
  "feeds.conf": ""
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
const writeBody = await write.json();
assert.equal(writeBody.pullRequest.number, 7);
assert.equal(writeBody.pullRequest.merged, true);

const copyProfile = await handleControlPlaneRequest(
  new Request(
    "https://worker.example/api/v1/repositories/acme/router/profiles/default/copy",
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
        targetProfileId: "default-copy"
      })
    }
  ),
  configuredEnv,
  deps
);
assert.equal(copyProfile.status, 201);
const copyProfileBody = await copyProfile.json();
assert.equal(copyProfileBody.action, "copy");
assert.equal(copyProfileBody.targetProfileId, "default-copy");

const renameProfile = await handleControlPlaneRequest(
  new Request(
    "https://worker.example/api/v1/repositories/acme/router/profiles/default/rename",
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
        targetProfileId: "default-renamed"
      })
    }
  ),
  configuredEnv,
  deps
);
assert.equal(renameProfile.status, 201);
const renameProfileBody = await renameProfile.json();
assert.equal(renameProfileBody.action, "rename");
assert.equal(renameProfileBody.targetProfileId, "default-renamed");
assert.equal(renameProfileBody.configStudioCleanup.sessionsFound, 1);
assert.equal(renameProfileBody.configStudioCleanup.branchesDeleted, 1);
assert.deepEqual(renameProfileBody.configStudioCleanup.cancelFailedRuns, []);
assert.deepEqual(renameProfileBody.configStudioCleanup.branchDeleteFailures, []);
assert.equal(renameProfileBody.configStudioCleanup.runLookupFailed, false);

const rejectedBaseline = await handleControlPlaneRequest(
  new Request(
    "https://worker.example/api/v1/repositories/acme/router/profiles/other-profile/baseline",
    {
      method: "POST",
      headers: {
        Cookie: sessionCookie,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ baseRefSha: "a".repeat(40) })
    }
  ),
  configuredEnv,
  deps
);
assert.equal(rejectedBaseline.status, 403);

const baselineProfile = await handleControlPlaneRequest(
  new Request(
    "https://worker.example/api/v1/repositories/acme/router/profiles/other-profile/baseline",
    {
      method: "POST",
      headers: {
        Cookie: sessionCookie,
        Origin: "https://worker.example",
        "X-OpenWrt-NG-CSRF": "1",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ baseRefSha: "a".repeat(40) })
    }
  ),
  configuredEnv,
  deps
);
assert.equal(baselineProfile.status, 201);
const baselineProfileBody = await baselineProfile.json();
assert.equal(baselineProfileBody.action, "baseline");
assert.equal(baselineProfileBody.baselineProfileId, "other-profile");
assert.equal(baselineProfileBody.pullRequest.number, 10);

const rejectedDelete = await handleControlPlaneRequest(
  new Request(
    "https://worker.example/api/v1/repositories/acme/router/profiles/old-profile",
    {
      method: "DELETE",
      headers: {
        Cookie: sessionCookie,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ baseRefSha: "a".repeat(40) })
    }
  ),
  configuredEnv,
  deps
);
assert.equal(rejectedDelete.status, 403);
assert.deepEqual(await rejectedDelete.json(), {
  error: "csrf_validation_failed"
});

const deleteProfile = await handleControlPlaneRequest(
  new Request(
    "https://worker.example/api/v1/repositories/acme/router/profiles/old-profile",
    {
      method: "DELETE",
      headers: {
        Cookie: sessionCookie,
        Origin: "https://worker.example",
        "X-OpenWrt-NG-CSRF": "1",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ baseRefSha: "a".repeat(40) })
    }
  ),
  configuredEnv,
  deps
);
assert.equal(deleteProfile.status, 201);
const deleteProfileBody = await deleteProfile.json();
assert.equal(deleteProfileBody.action, "delete");
assert.equal(deleteProfileBody.pullRequest.number, 9);
assert.equal(deleteProfileBody.pullRequest.merged, true);

const rejectedConfigStudio = await handleControlPlaneRequest(
  new Request(
    "https://worker.example/api/v1/repositories/acme/router/config-studio",
    {
      method: "POST",
      headers: {
        Cookie: sessionCookie,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ profileId: "default" })
    }
  ),
  configuredEnv,
  deps
);
assert.equal(rejectedConfigStudio.status, 403);

const configStudioStart = await handleControlPlaneRequest(
  new Request(
    "https://worker.example/api/v1/repositories/acme/router/config-studio",
    {
      method: "POST",
      headers: {
        Cookie: sessionCookie,
        Origin: "https://worker.example",
        "X-OpenWrt-NG-CSRF": "1",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ profileId: "default" })
    }
  ),
  configuredEnv,
  deps
);
assert.equal(configStudioStart.status, 202);
assert.equal((await configStudioStart.json()).requestId, "aabbccddeeff0011");

const configStudioStatus = await handleControlPlaneRequest(
  new Request(
    "https://worker.example/api/v1/repositories/acme/router/config-studio/aabbccddeeff0011",
    { headers: { Cookie: sessionCookie } }
  ),
  configuredEnv,
  deps
);
assert.equal(configStudioStatus.status, 200);
assert.equal((await configStudioStatus.json()).status.status, "ready");

const configStudioResolve = await handleControlPlaneRequest(
  new Request(
    "https://worker.example/api/v1/repositories/acme/router/config-studio/aabbccddeeff0011/resolve",
    {
      method: "POST",
      headers: {
        Cookie: sessionCookie,
        Origin: "https://worker.example",
        "X-OpenWrt-NG-CSRF": "1",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        values: { CONFIG_PACKAGE_luci: "y" }
      })
    }
  ),
  configuredEnv,
  deps
);
assert.equal(configStudioResolve.status, 202);
assert.equal((await configStudioResolve.json()).runId, 457);

const configStudioApply = await handleControlPlaneRequest(
  new Request(
    "https://worker.example/api/v1/repositories/acme/router/config-studio/aabbccddeeff0011/apply/default",
    {
      method: "POST",
      headers: {
        Cookie: sessionCookie,
        Origin: "https://worker.example",
        "X-OpenWrt-NG-CSRF": "1",
        "Content-Type": "application/json"
      },
      body: "{}"
    }
  ),
  configuredEnv,
  deps
);
assert.equal(configStudioApply.status, 201);
const configStudioApplyBody = await configStudioApply.json();
assert.equal(configStudioApplyBody.pullRequest.number, 11);
assert.equal(configStudioApplyBody.pullRequest.merged, true);

const configStudioDelete = await handleControlPlaneRequest(
  new Request(
    "https://worker.example/api/v1/repositories/acme/router/config-studio/aabbccddeeff0011",
    {
      method: "DELETE",
      headers: {
        Cookie: sessionCookie,
        Origin: "https://worker.example",
        "X-OpenWrt-NG-CSRF": "1"
      }
    }
  ),
  configuredEnv,
  deps
);
assert.equal(configStudioDelete.status, 200);
assert.equal((await configStudioDelete.json()).deleted, true);

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

const cancelBuild = await handleControlPlaneRequest(
  new Request(
    "https://worker.example/api/v1/repositories/acme/router/builds/123/cancel",
    {
      method: "POST",
      headers: {
        Cookie: sessionCookie,
        Origin: "https://worker.example",
        "X-OpenWrt-NG-CSRF": "1"
      },
      body: "{}"
    }
  ),
  configuredEnv,
  deps
);
assert.equal(cancelBuild.status, 202);
assert.equal((await cancelBuild.json()).action, "cancel");

const rerunBuild = await handleControlPlaneRequest(
  new Request(
    "https://worker.example/api/v1/repositories/acme/router/builds/123/rerun",
    {
      method: "POST",
      headers: {
        Cookie: sessionCookie,
        Origin: "https://worker.example",
        "X-OpenWrt-NG-CSRF": "1"
      },
      body: "{}"
    }
  ),
  configuredEnv,
  deps
);
assert.equal(rerunBuild.status, 202);
const rerunBuildBody = await rerunBuild.json();
assert.equal(rerunBuildBody.action, "rerun");
assert.equal(rerunBuildBody.nextAttempt, 2);

const releaseExisting = await handleControlPlaneRequest(
  new Request(
    "https://worker.example/api/v1/repositories/acme/router/builds/123/release-existing",
    {
      method: "POST",
      headers: {
        Cookie: sessionCookie,
        Origin: "https://worker.example",
        "X-OpenWrt-NG-CSRF": "1"
      },
      body: "{}"
    }
  ),
  configuredEnv,
  deps
);
assert.equal(releaseExisting.status, 202);
const releaseExistingBody = await releaseExisting.json();
assert.equal(releaseExistingBody.sourceRunId, 123);
assert.equal(releaseExistingBody.runId, 333);

const releaseExistingRun = await handleControlPlaneRequest(
  new Request(
    "https://worker.example/api/v1/repositories/acme/router/release-existing/runs/333",
    { headers: { Cookie: sessionCookie } }
  ),
  configuredEnv,
  deps
);
assert.equal(releaseExistingRun.status, 200);
assert.equal(
  (await releaseExistingRun.json()).run.displayTitle,
  "Release Existing · source:123"
);

const updateChecker = await handleControlPlaneRequest(
  new Request(
    "https://worker.example/api/v1/repositories/acme/router/update-checker",
    {
      method: "POST",
      headers: {
        Cookie: sessionCookie,
        Origin: "https://worker.example",
        "X-OpenWrt-NG-CSRF": "1",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ profileId: "default", force: true })
    }
  ),
  configuredEnv,
  deps
);
assert.equal(updateChecker.status, 202);
const updateCheckerBody = await updateChecker.json();
assert.equal(updateCheckerBody.profileId, "default");
assert.equal(updateCheckerBody.runId, 444);

const updateCheckerRun = await handleControlPlaneRequest(
  new Request(
    "https://worker.example/api/v1/repositories/acme/router/update-checker/runs/444",
    { headers: { Cookie: sessionCookie } }
  ),
  configuredEnv,
  deps
);
assert.equal(updateCheckerRun.status, 200);
assert.equal(
  (await updateCheckerRun.json()).run.displayTitle,
  "Update Checker · profile:default · force:true"
);

const artifactDownload = await handleControlPlaneRequest(
  new Request(
    "https://worker.example/api/v1/repositories/acme/router/builds/123/artifacts/77/download",
    {
      headers: { Cookie: sessionCookie },
      redirect: "manual"
    }
  ),
  configuredEnv,
  deps
);
assert.equal(artifactDownload.status, 302);
assert.equal(
  artifactDownload.headers.get("location"),
  "https://downloads.example.test/worker/77.zip"
);

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
