import assert from "node:assert/strict";
import {
  GitHubAppClient,
  ProfileWriteError,
  PROFILE_FILES,
  REQUIRED_PROFILE_FILES
} from "./lib/github.mjs";

const SHA = "a".repeat(40);
const PARENT = "b".repeat(40);
const base64 = (value) => Buffer.from(value, "utf8").toString("base64");

function http404() {
  const error = new Error("not found");
  error.httpStatus = 404;
  return error;
}

function createClient({ missing = new Set(["feeds.conf"]) } = {}) {
  const client = new GitHubAppClient({
    clientId: "client",
    clientSecret: "secret",
    redirectUri: "https://example.invalid/callback"
  });

  client.repositoryState = async () => ({
    defaultBranch: "main",
    baseRefSha: SHA,
    baselineProfileId: "default"
  });

  client.api = async (path) => {
    if (path.includes("/contents/profiles/legacy?ref=")) {
      throw http404();
    }
    if (path.includes("/commits/")) {
      return {
        commit: { message: "profile(legacy): delete via Control Plane" },
        parents: [{ sha: PARENT }]
      };
    }
    for (const name of PROFILE_FILES) {
      if (!path.includes("/contents/profiles/legacy/")) continue;
      if (!path.includes(encodeURIComponent(name))) continue;
      if (missing.has(name)) throw http404();
      return {
        encoding: "base64",
        content: base64(
          name === ".config"
            ? "CONFIG_TEST=y\n"
            : name === "profile.env"
              ? 'PROFILE_NAME="Legacy"\n'
              : "# legacy optional file\n"
        )
      };
    }
    throw new Error("Unexpected API path: " + path);
  };

  let captured = null;
  client.createProfileFilesPullRequest = async (...args) => {
    captured = args[3];
    return { action: "restore", captured };
  };
  return { client, getCaptured: () => captured };
}

{
  const { client, getCaptured } = createClient();
  const result = await client.restoreDeletedProfilePullRequest(
    "token",
    "acme",
    "router",
    "legacy",
    { deletionCommitSha: "c".repeat(40) }
  );
  assert.equal(result.action, "restore");
  const payload = getCaptured();
  assert.ok(payload);
  assert.deepEqual(
    payload.changedFiles,
    PROFILE_FILES.filter((name) => name !== "feeds.conf")
  );
  assert.equal(payload.files["feeds.conf"], "");
  assert.equal(payload.files[".config"], "CONFIG_TEST=y\n");
  assert.equal(payload.files["profile.env"], 'PROFILE_NAME="Legacy"\n');
}

for (const required of REQUIRED_PROFILE_FILES) {
  const { client } = createClient({ missing: new Set([required]) });
  await assert.rejects(
    client.restoreDeletedProfilePullRequest(
      "token",
      "acme",
      "router",
      "legacy",
      { deletionCommitSha: "c".repeat(40) }
    ),
    (error) =>
      error instanceof ProfileWriteError &&
      error.code === "deleted_profile_snapshot_incomplete" &&
      error.status === 410
  );
}

console.log("Deleted Profile optional-file restore tests passed.");
