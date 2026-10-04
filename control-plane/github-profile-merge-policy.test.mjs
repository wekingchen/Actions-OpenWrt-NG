import assert from "node:assert/strict";
import {
  GitHubAppClient,
  normalizeProfileMergePolicy
} from "./lib/github.mjs";

const baseConfig = {
  clientId: "client",
  clientSecret: "secret",
  redirectUri: "https://example.invalid/callback",
  apiVersion: "2022-11-28"
};

const pull = {
  number: 42,
  html_url: "https://github.com/acme/router/pull/42",
  node_id: "PR_kwDOtest"
};
const state = { defaultBranch: "main" };
const commitSha = "a".repeat(40);

assert.equal(normalizeProfileMergePolicy(""), "immediate");
assert.equal(normalizeProfileMergePolicy("IMMEDIATE"), "immediate");
assert.equal(normalizeProfileMergePolicy("after-checks"), "after-checks");
assert.equal(normalizeProfileMergePolicy("manual"), "manual");
assert.throws(
  () => normalizeProfileMergePolicy("later"),
  /PROFILE_MERGE_POLICY/
);

function clientFor(policy) {
  const client = new GitHubAppClient(
    { ...baseConfig, profileMergePolicy: policy },
    async () => {
      throw new Error("unexpected fetch");
    }
  );
  client.deleteProfileBranch = async () => true;
  client.cleanupSupersededProfilePullRequests = async () => [];
  return client;
}

{
  const client = clientFor("immediate");
  let mergeCalls = 0;
  client.api = async (path, token, options) => {
    assert.equal(token, "token");
    assert.match(path, /\/pulls\/42\/merge$/);
    assert.equal(options.method, "PUT");
    assert.equal(options.body.merge_method, "squash");
    mergeCalls++;
    return { merged: true, sha: "b".repeat(40) };
  };

  const result = await client.finalizeProfilePullRequest(
    "token",
    "acme",
    "router",
    "default",
    state,
    "openwrt-ng/profile-default-1-a",
    commitSha,
    "update",
    pull
  );
  assert.equal(mergeCalls, 1);
  assert.equal(result.pullRequest.merged, true);
  assert.equal(result.pullRequest.autoMergeEnabled, false);
  assert.equal(result.pullRequest.mergePolicy, "immediate");
  assert.equal(result.pullRequest.mergeCommitSha, "b".repeat(40));
  assert.equal(result.cleanup.branchDeleted, true);
}

{
  const client = clientFor("manual");
  client.api = async () => {
    throw new Error("manual policy must not call merge endpoint");
  };
  const result = await client.finalizeProfilePullRequest(
    "token",
    "acme",
    "router",
    "default",
    state,
    "openwrt-ng/profile-default-1-b",
    commitSha,
    "update",
    pull
  );
  assert.equal(result.pullRequest.merged, false);
  assert.equal(result.pullRequest.autoMergeEnabled, false);
  assert.equal(result.pullRequest.mergePolicy, "manual");
  assert.equal(result.pullRequest.mergeReason, "manual_review_required");
  assert.equal(result.cleanup.branchDeleted, false);
}

{
  const client = clientFor("after-checks");
  let enabled = 0;
  client.enableProfileAutoMerge = async (
    token,
    actualPull,
    actualSha,
    profileId,
    action
  ) => {
    assert.equal(token, "token");
    assert.equal(actualPull.node_id, pull.node_id);
    assert.equal(actualSha, commitSha);
    assert.equal(profileId, "default");
    assert.equal(action, "update");
    enabled++;
    return { enabledAt: "2026-10-05T00:00:00Z", mergeMethod: "SQUASH" };
  };
  const result = await client.finalizeProfilePullRequest(
    "token",
    "acme",
    "router",
    "default",
    state,
    "openwrt-ng/profile-default-1-c",
    commitSha,
    "update",
    pull
  );
  assert.equal(enabled, 1);
  assert.equal(result.pullRequest.merged, false);
  assert.equal(result.pullRequest.autoMergeEnabled, true);
  assert.equal(result.pullRequest.mergePolicy, "after-checks");
  assert.equal(result.pullRequest.mergeReason, "auto_merge_enabled");
  assert.equal(result.cleanup.branchDeleted, false);
}

{
  const client = clientFor("after-checks");
  client.enableProfileAutoMerge = async () => {
    const error = new Error("auto merge disabled");
    error.githubError = "auto_merge_unavailable";
    throw error;
  };
  const result = await client.finalizeProfilePullRequest(
    "token",
    "acme",
    "router",
    "default",
    state,
    "openwrt-ng/profile-default-1-d",
    commitSha,
    "update",
    pull
  );
  assert.equal(result.pullRequest.merged, false);
  assert.equal(result.pullRequest.autoMergeEnabled, false);
  assert.equal(result.pullRequest.mergeReason, "auto_merge_unavailable");
}

{
  const client = clientFor("after-checks");
  let captured = null;
  client.graphql = async (query, variables, token) => {
    captured = { query, variables, token };
    return {
      enablePullRequestAutoMerge: {
        pullRequest: {
          autoMergeRequest: {
            enabledAt: "2026-10-05T00:00:00Z",
            mergeMethod: "SQUASH"
          }
        }
      }
    };
  };
  const request = await client.enableProfileAutoMerge(
    "token",
    pull,
    commitSha,
    "default",
    "update"
  );
  assert.equal(request.mergeMethod, "SQUASH");
  assert.equal(captured.variables.pullRequestId, pull.node_id);
  assert.equal(captured.variables.expectedHeadOid, commitSha);
  assert.equal(captured.variables.mergeMethod, "SQUASH");
}

console.log("Profile merge policy tests passed.");
