import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createControlPlaneHandler } from "./server.mjs";

const now = Date.now();
const session = {
  sessionHash: "route-test-session",
  userLogin: "route-tester",
  avatarUrl: "",
  accessToken: "ghu_route_test",
  refreshToken: "",
  githubExpiresAt: now + 60 * 60 * 1000,
  refreshExpiresAt: now + 24 * 60 * 60 * 1000,
  sessionExpiresAt: now + 24 * 60 * 60 * 1000
};

const store = {
  getSession() {
    return session;
  },
  deleteSession() {},
  updateSessionTokens() {}
};

const calls = [];
const record = (name, args) => {
  calls.push({ name, args });
};

function writeResult(action, extra = {}) {
  return {
    branch: "openwrt-ng/test-branch",
    commitSha: "a".repeat(40),
    changedFiles: ["profiles/default/.config"],
    action,
    pullRequest: {
      number: 42,
      url: "https://github.com/acme/router/pull/42",
      merged: true,
      mergeCommitSha: "b".repeat(40),
      mergeReason: ""
    },
    cleanup: {
      branchDeleted: true,
      supersededPullRequests: []
    },
    ...extra
  };
}

const progress = {
  completed: 1,
  total: 3,
  percent: 33,
  current: "处理中",
  currentDetail: "真实 Action 步骤",
  failed: "",
  steps: [
    {
      name: "处理中",
      detail: "真实 Action 步骤",
      status: "in_progress",
      conclusion: ""
    }
  ]
};

const managedRun = {
  id: 333,
  runNumber: 7,
  runAttempt: 1,
  displayTitle: "Managed workflow",
  status: "in_progress",
  conclusion: "",
  event: "workflow_dispatch",
  headBranch: "main",
  headSha: "c".repeat(40),
  createdAt: "2026-10-05T00:00:00Z",
  updatedAt: "2026-10-05T00:01:00Z",
  runStartedAt: "2026-10-05T00:00:10Z",
  url: "https://github.com/acme/router/actions/runs/333",
  progress,
  jobs: []
};

const github = {
  async listDeletedProfiles(token, owner, repo, options) {
    record("listDeletedProfiles", { token, owner, repo, options });
    return [{
      id: "old-profile",
      deletionCommitSha: "d".repeat(40),
      deletedAt: "2026-10-04T10:00:00Z",
      commitUrl: "https://github.com/acme/router/commit/" + "d".repeat(40),
      message: "profile(old-profile): delete via Control Plane"
    }];
  },
  async getProfile(token, owner, repo, profileId) {
    record("getProfile", { token, owner, repo, profileId });
    return {
      owner,
      repo,
      defaultBranch: "main",
      baseRefSha: "e".repeat(40),
      baselineProfileId: "default",
      profile: {
        id: profileId,
        path: "profiles/" + profileId,
        baseline: profileId === "default",
        files: {}
      }
    };
  },
  async restoreDeletedProfilePullRequest(token, owner, repo, profileId, payload) {
    record("restoreDeletedProfilePullRequest", { token, owner, repo, profileId, payload });
    return writeResult("restore", { targetProfileId: profileId });
  },
  async copyProfilePullRequest(token, owner, repo, profileId, payload) {
    record("copyProfilePullRequest", { token, owner, repo, profileId, payload });
    return writeResult("copy", {
      sourceProfileId: profileId,
      targetProfileId: payload.targetProfileId,
      baselineProfileId: "default"
    });
  },
  async renameProfilePullRequest(token, owner, repo, profileId, payload) {
    record("renameProfilePullRequest", { token, owner, repo, profileId, payload });
    return writeResult("rename", {
      sourceProfileId: profileId,
      targetProfileId: payload.targetProfileId,
      baselineProfileId: payload.targetProfileId,
      configStudioCleanup: {
        sessionsFound: 1,
        branchesDeleted: 1,
        canceledRuns: [456],
        cancelFailedRuns: [],
        branchDeleteFailures: [],
        runLookupFailed: false
      }
    });
  },
  async setBaselineProfilePullRequest(token, owner, repo, profileId, payload) {
    record("setBaselineProfilePullRequest", { token, owner, repo, profileId, payload });
    return writeResult("baseline", { baselineProfileId: profileId });
  },
  async deleteProfilePullRequest(token, owner, repo, profileId, payload) {
    record("deleteProfilePullRequest", { token, owner, repo, profileId, payload });
    return writeResult("delete", {
      sourceProfileId: profileId,
      configStudioCleanup: {
        sessionsFound: 1,
        branchesDeleted: 1,
        canceledRuns: [456],
        cancelFailedRuns: [],
        branchDeleteFailures: [],
        runLookupFailed: false
      }
    });
  },
  async startConfigStudio(token, owner, repo, payload) {
    record("startConfigStudio", { token, owner, repo, payload });
    return {
      accepted: true,
      requestId: "aabbccddeeff0011",
      branch: "openwrt-ng/config-session-aabbccddeeff0011",
      profileId: payload.profileId || "",
      sourceRepo: "",
      sourceBranch: "",
      adapter: "direct-openwrt",
      ref: "main",
      runId: 301,
      runUrl: "https://github.com/acme/router/actions/runs/301"
    };
  },
  async getConfigStudioSession(token, owner, repo, requestId) {
    record("getConfigStudioSession", { token, owner, repo, requestId });
    return {
      requestId,
      branch: "openwrt-ng/config-session-" + requestId,
      profileId: "default",
      sourceRepo: "https://github.com/openwrt/openwrt",
      sourceBranch: "main",
      adapter: "direct-openwrt",
      status: { status: "preparing", mode: "catalog", requestId },
      run: {
        id: 301,
        status: "in_progress",
        conclusion: "",
        url: "https://github.com/acme/router/actions/runs/301",
        updatedAt: "2026-10-05T00:01:00Z"
      },
      progress,
      catalog: null,
      result: null
    };
  },
  async deleteConfigStudioSession(token, owner, repo, requestId) {
    record("deleteConfigStudioSession", { token, owner, repo, requestId });
    return { deleted: true, requestId };
  },
  async submitConfigStudioSelection(token, owner, repo, requestId, payload) {
    record("submitConfigStudioSelection", { token, owner, repo, requestId, payload });
    return {
      accepted: true,
      requestId,
      branch: "openwrt-ng/config-session-" + requestId,
      runId: 302,
      runUrl: "https://github.com/acme/router/actions/runs/302"
    };
  },
  async applyConfigStudioToProfile(token, owner, repo, requestId, profileId) {
    record("applyConfigStudioToProfile", { token, owner, repo, requestId, profileId });
    return writeResult("update", { targetProfileId: profileId });
  },
  async cancelBuilderRun(token, owner, repo, runId) {
    record("cancelBuilderRun", { token, owner, repo, runId });
    return {
      accepted: true,
      action: "cancel",
      runId: Number(runId),
      runNumber: 9,
      url: "https://github.com/acme/router/actions/runs/" + runId
    };
  },
  async rerunBuilderRun(token, owner, repo, runId) {
    record("rerunBuilderRun", { token, owner, repo, runId });
    return {
      accepted: true,
      action: "rerun",
      runId: Number(runId),
      runNumber: 9,
      nextAttempt: 2,
      url: "https://github.com/acme/router/actions/runs/" + runId
    };
  },
  async triggerReleaseExisting(token, owner, repo, sourceRunId) {
    record("triggerReleaseExisting", { token, owner, repo, sourceRunId });
    return {
      accepted: true,
      sourceRunId: Number(sourceRunId),
      ref: "main",
      runId: 333,
      runUrl: managedRun.url
    };
  },
  async getReleaseExistingRun(token, owner, repo, runId) {
    record("getReleaseExistingRun", { token, owner, repo, runId });
    return { ...managedRun, id: Number(runId) };
  },
  async triggerUpdateChecker(token, owner, repo, payload) {
    record("triggerUpdateChecker", { token, owner, repo, payload });
    return {
      accepted: true,
      profileId: payload.profileId || "",
      force: payload.force === true,
      ref: "main",
      runId: 444,
      runUrl: "https://github.com/acme/router/actions/runs/444"
    };
  },
  async getUpdateCheckerRun(token, owner, repo, runId) {
    record("getUpdateCheckerRun", { token, owner, repo, runId });
    return { ...managedRun, id: Number(runId), runNumber: 8 };
  }
};

const config = {
  origin: "http://127.0.0.1",
  secureCookie: false,
  sessionTtlMs: 3600_000,
  sessionIdleTtlMs: 900_000
};

const handler = createControlPlaneHandler({ config, store, github });
const server = createServer(handler);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const base = `http://127.0.0.1:${address.port}`;

const readHeaders = { Cookie: "ong_session=route-session" };
const mutationHeaders = {
  ...readHeaders,
  Origin: config.origin,
  "X-OpenWrt-NG-CSRF": "1",
  "Content-Type": "application/json"
};

async function read(path) {
  return fetch(base + path, { headers: readHeaders });
}

async function mutate(path, body = {}, method = "POST") {
  return fetch(base + path, {
    method,
    headers: mutationHeaders,
    body: JSON.stringify(body)
  });
}

try {
  const deleted = await read("/api/v1/repositories/acme/router/profiles/deleted?limit=10");
  assert.equal(deleted.status, 200);
  assert.equal((await deleted.json()).profiles[0].id, "old-profile");

  const detail = await read("/api/v1/repositories/acme/router/profiles/default");
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).profile.baseline, true);

  const restore = await mutate(
    "/api/v1/repositories/acme/router/profiles/old-profile/restore",
    { deletionCommitSha: "d".repeat(40) }
  );
  assert.equal(restore.status, 201);
  assert.equal((await restore.json()).action, "restore");

  const copy = await mutate(
    "/api/v1/repositories/acme/router/profiles/default/copy",
    { baseRefSha: "e".repeat(40), targetProfileId: "default-copy" }
  );
  assert.equal(copy.status, 201);
  assert.equal((await copy.json()).action, "copy");

  const rename = await mutate(
    "/api/v1/repositories/acme/router/profiles/default/rename",
    { baseRefSha: "e".repeat(40), targetProfileId: "default-renamed" }
  );
  assert.equal(rename.status, 201);
  assert.equal((await rename.json()).configStudioCleanup.sessionsFound, 1);

  const baseline = await mutate(
    "/api/v1/repositories/acme/router/profiles/other-profile/baseline",
    { baseRefSha: "e".repeat(40) }
  );
  assert.equal(baseline.status, 201);
  assert.equal((await baseline.json()).baselineProfileId, "other-profile");

  const remove = await mutate(
    "/api/v1/repositories/acme/router/profiles/old-profile",
    { baseRefSha: "e".repeat(40) },
    "DELETE"
  );
  assert.equal(remove.status, 201);
  assert.equal((await remove.json()).action, "delete");

  const studioStart = await mutate(
    "/api/v1/repositories/acme/router/config-studio",
    { profileId: "default" }
  );
  assert.equal(studioStart.status, 202);
  assert.equal((await studioStart.json()).requestId, "aabbccddeeff0011");

  const studioStatus = await read(
    "/api/v1/repositories/acme/router/config-studio/aabbccddeeff0011"
  );
  assert.equal(studioStatus.status, 200);
  const studioStatusBody = await studioStatus.json();
  assert.equal(studioStatusBody.progress.percent, 33);

  const studioResolve = await mutate(
    "/api/v1/repositories/acme/router/config-studio/aabbccddeeff0011/resolve",
    { values: { CONFIG_IPV6: "y" } }
  );
  assert.equal(studioResolve.status, 202);
  assert.equal((await studioResolve.json()).runId, 302);

  const studioApply = await mutate(
    "/api/v1/repositories/acme/router/config-studio/aabbccddeeff0011/apply/default"
  );
  assert.equal(studioApply.status, 201);
  assert.equal((await studioApply.json()).action, "update");

  const studioDelete = await mutate(
    "/api/v1/repositories/acme/router/config-studio/aabbccddeeff0011",
    {},
    "DELETE"
  );
  assert.equal(studioDelete.status, 200);
  assert.equal((await studioDelete.json()).deleted, true);

  const cancel = await mutate(
    "/api/v1/repositories/acme/router/builds/123/cancel"
  );
  assert.equal(cancel.status, 202);
  assert.equal((await cancel.json()).action, "cancel");

  const rerun = await mutate(
    "/api/v1/repositories/acme/router/builds/123/rerun"
  );
  assert.equal(rerun.status, 202);
  assert.equal((await rerun.json()).nextAttempt, 2);

  const release = await mutate(
    "/api/v1/repositories/acme/router/builds/123/release-existing"
  );
  assert.equal(release.status, 202);
  assert.equal((await release.json()).runId, 333);

  const releaseRun = await read(
    "/api/v1/repositories/acme/router/release-existing/runs/333"
  );
  assert.equal(releaseRun.status, 200);
  assert.equal((await releaseRun.json()).run.progress.percent, 33);

  const checker = await mutate(
    "/api/v1/repositories/acme/router/update-checker",
    { profileId: "default", force: true }
  );
  assert.equal(checker.status, 202);
  assert.equal((await checker.json()).runId, 444);

  const checkerRun = await read(
    "/api/v1/repositories/acme/router/update-checker/runs/444"
  );
  assert.equal(checkerRun.status, 200);
  assert.equal((await checkerRun.json()).run.id, 444);

  const called = new Set(calls.map((item) => item.name));
  for (const name of [
    "listDeletedProfiles",
    "getProfile",
    "restoreDeletedProfilePullRequest",
    "copyProfilePullRequest",
    "renameProfilePullRequest",
    "setBaselineProfilePullRequest",
    "deleteProfilePullRequest",
    "startConfigStudio",
    "getConfigStudioSession",
    "submitConfigStudioSelection",
    "applyConfigStudioToProfile",
    "deleteConfigStudioSession",
    "cancelBuilderRun",
    "rerunBuilderRun",
    "triggerReleaseExisting",
    "getReleaseExistingRun",
    "triggerUpdateChecker",
    "getUpdateCheckerRun"
  ]) {
    assert.ok(called.has(name), `自托管路由未覆盖 GitHub 能力：${name}`);
  }

  console.log(`Self-hosted route tests passed: calls=${calls.length}`);
} finally {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
