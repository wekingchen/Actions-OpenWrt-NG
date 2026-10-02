import assert from "node:assert/strict";
import { createServer } from "node:http";
import { GitHubAppClient, githubErrorReason } from "./lib/github.mjs";
import {
  decryptString,
  encryptString,
  hashOpaque,
  safeReturnTo,
  sha256Base64Url
} from "./lib/security.mjs";
import { ControlPlaneStore } from "./lib/store.mjs";
import { createControlPlaneHandler } from "./server.mjs";

const secret = "0123456789abcdef0123456789abcdef";
const encrypted = encryptString("ghu_example", secret);
assert.notEqual(encrypted, "ghu_example");
assert.equal(decryptString(encrypted, secret), "ghu_example");
assert.equal(safeReturnTo("/repos?a=1"), "/repos?a=1");
assert.equal(safeReturnTo("https://evil.example"), "/");
assert.equal(safeReturnTo("//evil.example"), "/");
assert.equal(sha256Base64Url("abc").length > 40, true);

const store = new ControlPlaneStore(":memory:", secret);
store.createOAuthState({
  stateHash: hashOpaque("state"),
  verifier: "verifier",
  browserHash: hashOpaque("browser"),
  returnTo: "/",
  expiresAt: Date.now() + 60_000
});
const consumedState = store.consumeOAuthState(hashOpaque("state"));
assert.equal(consumedState.verifier, "verifier");
assert.equal(consumedState.browserHash, hashOpaque("browser"));
assert.equal(store.consumeOAuthState(hashOpaque("state")), null);



const receiverSensitiveClient = new GitHubAppClient(
  {
    clientId: "Iv1.receiver",
    clientSecret: "receiver-secret",
    redirectUri: "https://example.test/api/v1/auth/callback"
  },
  function receiverSensitiveFetch(_url, _options = {}) {
    if (this !== undefined) {
      throw new TypeError("Illegal invocation");
    }
    return Response.json({
      access_token: "ghu_receiver_access",
      token_type: "bearer"
    });
  }
);
const receiverToken = await receiverSensitiveClient.exchangeCode(
  "code",
  "verifier"
);
assert.equal(receiverToken.accessToken, "ghu_receiver_access");

const oauthErrorClient = new GitHubAppClient(
  {
    clientId: "Iv1.bad",
    clientSecret: "bad-secret",
    redirectUri: "https://example.test/api/v1/auth/callback"
  },
  async () =>
    Response.json(
      {
        error: "incorrect_client_credentials",
        error_description: "The client_id and/or client_secret passed are incorrect."
      },
      { status: 200 }
    )
);
await assert.rejects(
  () => oauthErrorClient.exchangeCode("code", "verifier"),
  (error) => {
    assert.equal(githubErrorReason(error), "incorrect_client_credentials");
    return true;
  }
);


let oauthRequestHeaders;
const formOAuthClient = new GitHubAppClient(
  {
    clientId: "Iv1.form",
    clientSecret: "form-secret",
    redirectUri: "https://example.test/api/v1/auth/callback"
  },
  async (_url, options = {}) => {
    oauthRequestHeaders = new Headers(options.headers || {});
    return new Response(
      "access_token=ghu_form_access&token_type=bearer&expires_in=28800&refresh_token=ghr_form_refresh&refresh_token_expires_in=15897600&scope=",
      {
        status: 200,
        headers: { "content-type": "application/x-www-form-urlencoded" }
      }
    );
  }
);
const formToken = await formOAuthClient.exchangeCode("code", "verifier");
assert.equal(formToken.accessToken, "ghu_form_access");
assert.equal(formToken.refreshToken, "ghr_form_refresh");
assert.equal(
  oauthRequestHeaders.get("user-agent"),
  "OpenWrt-NG-Control-Plane"
);


const profileBaseSha = "a".repeat(40);
const profileFileContents = {
  ".config": "CONFIG_TEST=y\n",
  "profile.env": "PROFILE_NAME=\"Test\"\n",
  "diy-part1.sh": "#!/bin/bash\n",
  "diy-part2.sh": "#!/bin/bash\n",
  "required-packages.txt": "",
  "watch-sources.txt": ""
};
const profileCalls = [];
const profileFetch = async (url, options = {}) => {
  const parsed = new URL(String(url));
  const path = parsed.pathname.replace(/^\/repos\/acme\/router/, "");
  const method = String(options.method || "GET").toUpperCase();
  profileCalls.push({ path, method, body: options.body || "" });

  if (method === "GET" && path === "") {
    return Response.json({ default_branch: "main" });
  }
  if (method === "GET" && path === "/commits/main") {
    return Response.json({ sha: profileBaseSha });
  }
  if (
    method === "GET" &&
    path === "/contents/profiles/default" &&
    parsed.searchParams.get("ref") === "main"
  ) {
    return Response.json(
      Object.keys(profileFileContents).map((name) => ({
        type: "file",
        name,
        path: "profiles/default/" + name,
        sha: "old-" + name
      }))
    );
  }
  if (
    method === "GET" &&
    path.startsWith("/contents/profiles/default/") &&
    parsed.searchParams.get("ref") === "main"
  ) {
    const name = decodeURIComponent(
      path.slice("/contents/profiles/default/".length)
    );
    return Response.json({
      type: "file",
      name,
      path: "profiles/default/" + name,
      sha: "old-" + name,
      encoding: "base64",
      content: Buffer.from(profileFileContents[name], "utf8").toString("base64")
    });
  }
  if (method === "GET" && path === "/git/commits/" + profileBaseSha) {
    return Response.json({ sha: profileBaseSha, tree: { sha: "base-tree" } });
  }
  if (method === "POST" && path === "/git/blobs") {
    const body = JSON.parse(options.body);
    return Response.json({
      sha: "blob-" + Buffer.from(body.content).toString("hex").slice(0, 12)
    }, { status: 201 });
  }
  if (method === "POST" && path === "/git/trees") {
    return Response.json({ sha: "new-tree" }, { status: 201 });
  }
  if (method === "POST" && path === "/git/commits") {
    return Response.json({ sha: "b".repeat(40) }, { status: 201 });
  }
  if (method === "POST" && path === "/git/refs") {
    return Response.json({ ref: "refs/heads/openwrt-ng/test" }, { status: 201 });
  }
  if (method === "POST" && path === "/pulls") {
    return Response.json({
      number: 17,
      html_url: "https://github.com/acme/router/pull/17"
    }, { status: 201 });
  }
  if (method === "DELETE" && path.startsWith("/git/refs/heads/")) {
    return new Response(null, { status: 204 });
  }

  return Response.json({ message: "unexpected profile request" }, { status: 500 });
};

const profileClient = new GitHubAppClient(
  {
    clientId: "Iv1.profile",
    clientSecret: "profile-secret",
    redirectUri: "https://example.test/api/v1/auth/callback"
  },
  profileFetch
);
const loadedProfile = await profileClient.getProfile(
  "ghu_profile",
  "acme",
  "router",
  "default"
);
assert.equal(loadedProfile.baseRefSha, profileBaseSha);
assert.equal(
  loadedProfile.profile.files[".config"].content,
  "CONFIG_TEST=y\n"
);

const changedProfileFiles = {
  ...profileFileContents,
  ".config": "CONFIG_TEST=m\n"
};
const createdProfilePr = await profileClient.createProfilePullRequest(
  "ghu_profile",
  "acme",
  "router",
  "default",
  {
    baseRefSha: profileBaseSha,
    files: changedProfileFiles
  }
);
assert.equal(createdProfilePr.pullRequest.number, 17);
assert.deepEqual(createdProfilePr.changedFiles, [".config"]);
assert.match(createdProfilePr.branch, /^openwrt-ng\/profile-default-/);
assert.ok(
  profileCalls.some((call) =>
    call.method === "POST" && call.path === "/git/trees"
  )
);
assert.ok(
  profileCalls.some((call) =>
    call.method === "POST" && call.path === "/pulls"
  )
);

await assert.rejects(
  () =>
    profileClient.createProfilePullRequest(
      "ghu_profile",
      "acme",
      "router",
      "default",
      {
        baseRefSha: "c".repeat(40),
        files: changedProfileFiles
      }
    ),
  (error) => {
    assert.equal(error.code, "repository_changed");
    assert.equal(error.status, 409);
    return true;
  }
);


const builderCalls = [];
const builderFetch = async (url, options = {}) => {
  const parsed = new URL(String(url));
  const path = parsed.pathname.replace(/^\/repos\/acme\/router/, "");
  const method = String(options.method || "GET").toUpperCase();
  builderCalls.push({ path, method, body: options.body || "" });

  if (method === "GET" && path === "") {
    return Response.json({ default_branch: "main" });
  }
  if (method === "GET" && path === "/commits/main") {
    return Response.json({ sha: "d".repeat(40) });
  }
  if (
    method === "GET" &&
    path === "/contents/profiles/default" &&
    parsed.searchParams.get("ref") === "main"
  ) {
    return Response.json([{ type: "file", name: ".config" }]);
  }
  if (
    method === "GET" &&
    path === "/actions/workflows/build-openwrt.yml/runs"
  ) {
    return Response.json({ workflow_runs: [] });
  }
  if (
    method === "POST" &&
    path === "/actions/workflows/build-openwrt.yml/dispatches"
  ) {
    const body = JSON.parse(options.body);
    assert.equal(body.ref, "main");
    assert.equal(body.inputs.profile, "default");
    assert.equal(body.inputs.publish_release, false);
    assert.match(body.inputs.control_plane_request_id, /^[0-9a-f]{16}$/);
    return new Response(null, { status: 204 });
  }
  if (method === "GET" && path === "/actions/runs/123") {
    return Response.json({
      id: 123,
      run_number: 9,
      run_attempt: 1,
      display_title: "Build · default · cp:abcdef1234567890",
      status: "completed",
      conclusion: "success",
      event: "workflow_dispatch",
      path: ".github/workflows/build-openwrt.yml",
      head_branch: "main",
      head_sha: "d".repeat(40),
      created_at: "2026-10-02T00:00:00Z",
      updated_at: "2026-10-02T00:10:00Z",
      run_started_at: "2026-10-02T00:00:10Z",
      html_url: "https://github.com/acme/router/actions/runs/123"
    });
  }
  if (method === "GET" && path === "/actions/runs/123/jobs") {
    return Response.json({
      jobs: [{
        id: 1,
        name: "编译 OpenWrt 固件",
        status: "completed",
        conclusion: "success",
        html_url: "https://github.com/acme/router/actions/runs/123/job/1"
      }]
    });
  }
  if (method === "GET" && path === "/actions/runs/123/artifacts") {
    return Response.json({
      artifacts: [{
        id: 77,
        name: "OpenWrt_firmware_default_20261002",
        size_in_bytes: 12345,
        expired: false,
        created_at: "2026-10-02T00:09:00Z",
        expires_at: "2026-11-01T00:09:00Z"
      }]
    });
  }
  if (method === "GET" && path === "/releases") {
    return Response.json([{
      tag_name: "2026.10.02-0810-9",
      name: "2026.10.02-0810-9",
      target_commitish: "d".repeat(40),
      html_url: "https://github.com/acme/router/releases/tag/2026.10.02-0810-9",
      published_at: "2026-10-02T00:10:00Z"
    }]);
  }

  return Response.json({ message: "unexpected builder request " + path }, { status: 500 });
};

const builderClient = new GitHubAppClient(
  {
    clientId: "Iv1.builder",
    clientSecret: "builder-secret",
    redirectUri: "https://example.test/api/v1/auth/callback"
  },
  builderFetch
);
const dispatched = await builderClient.triggerBuilder(
  "ghu_builder",
  "acme",
  "router",
  "default",
  { publishRelease: false }
);
assert.equal(dispatched.accepted, true);
assert.equal(dispatched.ref, "main");
assert.equal(dispatched.runId, 0);
assert.equal(dispatched.runUrl, "");
assert.match(dispatched.requestId, /^[0-9a-f]{16}$/);

const builderDetail = await builderClient.getBuilderRun(
  "ghu_builder",
  "acme",
  "router",
  123
);
assert.equal(builderDetail.conclusion, "success");
assert.equal(builderDetail.artifacts[0].id, 77);
assert.equal(
  builderDetail.artifacts[0].url,
  "https://github.com/acme/router/actions/runs/123/artifacts/77"
);
assert.equal(builderDetail.release.tag, "2026.10.02-0810-9");
assert.equal(builderDetail.summaryUrl, builderDetail.url);

const calls = [];
const fakeFetch = async (url, options = {}) => {
  calls.push({ url: String(url), options });

  if (String(url).endsWith("/login/oauth/access_token")) {
    return new Response(
      JSON.stringify({
        access_token: "ghu_test_access",
        expires_in: 28_800,
        refresh_token: "ghr_test_refresh",
        refresh_token_expires_in: 15_552_000
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" }
      }
    );
  }

  if (String(url).endsWith("/user")) {
    return Response.json({
      login: "tester",
      avatar_url: "https://avatars.githubusercontent.com/u/1?v=4"
    });
  }

  if (String(url).includes("/user/installations?")) {
    return Response.json({
      installations: [
        {
          id: 101,
          permissions: {
            contents: "write",
            pull_requests: "write",
            actions: "write"
          }
        }
      ]
    });
  }

  if (String(url).includes("/user/installations/101/repositories?")) {
    return Response.json({
      repositories: [
        {
          name: "router",
          full_name: "acme/router",
          private: false,
          default_branch: "main",
          owner: { login: "acme" }
        }
      ]
    });
  }

  if (String(url).endsWith("/repos/acme/router/contents/profiles")) {
    return Response.json([
      { type: "dir", name: "default", path: "profiles/default", sha: "abc" },
      { type: "file", name: "README.md", path: "profiles/README.md", sha: "def" }
    ]);
  }

  const parsed = new URL(String(url));
  const path = parsed.pathname;

  if (path === "/repos/acme/router") {
    return Response.json({ default_branch: "main" });
  }

  if (path === "/repos/acme/router/commits/main") {
    return Response.json({ sha: "d".repeat(40) });
  }

  if (
    path === "/repos/acme/router/contents/profiles/default" &&
    parsed.searchParams.get("ref") === "main"
  ) {
    return Response.json([{ type: "file", name: ".config" }]);
  }

  if (
    path === "/repos/acme/router/actions/workflows/build-openwrt.yml/runs"
  ) {
    return Response.json({
      workflow_runs: [{
        id: 123,
        run_number: 9,
        display_title: "Build · default · cp:abcdef1234567890",
        status: "completed",
        conclusion: "success",
        event: "workflow_dispatch",
        head_branch: "main",
        head_sha: "d".repeat(40),
        created_at: "2026-10-02T00:00:00Z",
        updated_at: "2026-10-02T00:10:00Z",
        html_url: "https://github.com/acme/router/actions/runs/123"
      }]
    });
  }

  if (
    path === "/repos/acme/router/actions/workflows/build-openwrt.yml/dispatches" &&
    String(options.method || "GET").toUpperCase() === "POST"
  ) {
    return new Response(null, { status: 204 });
  }

  if (path === "/repos/acme/router/actions/runs/123") {
    return Response.json({
      id: 123,
      run_number: 9,
      run_attempt: 1,
      display_title: "Build · default · cp:abcdef1234567890",
      status: "completed",
      conclusion: "success",
      event: "workflow_dispatch",
      path: ".github/workflows/build-openwrt.yml",
      head_branch: "main",
      head_sha: "d".repeat(40),
      created_at: "2026-10-02T00:00:00Z",
      updated_at: "2026-10-02T00:10:00Z",
      run_started_at: "2026-10-02T00:00:10Z",
      html_url: "https://github.com/acme/router/actions/runs/123"
    });
  }

  if (path === "/repos/acme/router/actions/runs/123/jobs") {
    return Response.json({ jobs: [] });
  }

  if (path === "/repos/acme/router/actions/runs/123/artifacts") {
    return Response.json({ artifacts: [] });
  }

  if (path === "/repos/acme/router/releases") {
    return Response.json([]);
  }

  throw new Error("Unexpected fake GitHub request: " + url);
};

const config = {
  origin: "http://127.0.0.1",
  secureCookie: false,
  clientId: "Iv1.test",
  clientSecret: "client-secret",
  encryptionSecret: secret,
  sessionTtlMs: 3600_000,
  sessionIdleTtlMs: 900_000,
  githubAppSlug: "openwrt-ng-test",
  apiVersion: "2022-11-28"
};

const github = new GitHubAppClient(
  {
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.origin + "/api/v1/auth/callback",
    apiVersion: config.apiVersion
  },
  fakeFetch
);

const handler = createControlPlaneHandler({ config, store, github });
const server = createServer(handler);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const base = `http://127.0.0.1:${address.port}`;

try {
  const health = await fetch(base + "/api/v1/health");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    ok: true,
    version: 1,
    runtime: "self-hosted-node",
    configured: true
  });

  const publicConfig = await fetch(base + "/api/v1/config");
  assert.deepEqual(await publicConfig.json(), {
    configured: true,
    githubAppInstallUrl:
      "https://github.com/apps/openwrt-ng-test/installations/new"
  });

  const csrfStart = await fetch(base + "/api/v1/auth/start?return_to=/", {
    redirect: "manual"
  });
  const csrfAuthorize = new URL(csrfStart.headers.get("location"));
  const csrfState = csrfAuthorize.searchParams.get("state");
  const csrfCallback = await fetch(
    base +
      "/api/v1/auth/callback?code=test-code&state=" +
      encodeURIComponent(csrfState),
    { redirect: "manual" }
  );
  assert.equal(csrfCallback.status, 400);
  assert.deepEqual(await csrfCallback.json(), {
    error: "missing_oauth_browser_binding"
  });

  const start = await fetch(base + "/api/v1/auth/start?return_to=/", {
    redirect: "manual"
  });
  assert.equal(start.status, 302);
  const authorize = new URL(start.headers.get("location"));
  assert.equal(authorize.hostname, "github.com");
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  const state = authorize.searchParams.get("state");
  assert.ok(state);
  const oauthSetCookie = start.headers.get("set-cookie");
  assert.match(oauthSetCookie, /ong_oauth=/);
  assert.match(oauthSetCookie, /HttpOnly/);
  const oauthCookie = oauthSetCookie.split(";", 1)[0];

  const callback = await fetch(
    base +
      "/api/v1/auth/callback?code=test-code&state=" +
      encodeURIComponent(state),
    {
      redirect: "manual",
      headers: { Cookie: oauthCookie }
    }
  );
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("location"), "/");
  const setCookies =
    typeof callback.headers.getSetCookie === "function"
      ? callback.headers.getSetCookie()
      : [callback.headers.get("set-cookie")].filter(Boolean);
  const sessionSetCookie = setCookies.find((value) =>
    value.startsWith("ong_session=")
  );
  assert.ok(sessionSetCookie);
  assert.match(sessionSetCookie, /HttpOnly/);
  assert.doesNotMatch(
    setCookies.join("\n"),
    /ghu_test_access|ghr_test_refresh/
  );
  const cookie = sessionSetCookie.split(";", 1)[0];

  const session = await fetch(base + "/api/v1/session", {
    headers: { Cookie: cookie }
  });
  const sessionBody = await session.json();
  assert.equal(sessionBody.authenticated, true);
  assert.equal(sessionBody.user.login, "tester");
  assert.equal(JSON.stringify(sessionBody).includes("ghu_"), false);
  assert.equal(JSON.stringify(sessionBody).includes("ghr_"), false);

  const repos = await fetch(base + "/api/v1/repositories", {
    headers: { Cookie: cookie }
  });
  const reposBody = await repos.json();
  assert.equal(reposBody.repositories.length, 1);
  assert.equal(reposBody.repositories[0].fullName, "acme/router");
  assert.equal(reposBody.repositories[0].permissions.contents, "write");
  assert.equal(reposBody.repositories[0].permissions.pullRequests, "write");
  assert.equal(reposBody.repositories[0].permissions.actions, "write");
  assert.equal("installationId" in reposBody.repositories[0], false);
  assert.equal(reposBody.repositories[0].permissions.actions, "write");

  const profiles = await fetch(
    base + "/api/v1/repositories/acme/router/profiles",
    { headers: { Cookie: cookie } }
  );
  const profilesBody = await profiles.json();
  assert.deepEqual(profilesBody.profiles, [
    { id: "default", path: "profiles/default", sha: "abc" }
  ]);

  const builds = await fetch(
    base + "/api/v1/repositories/acme/router/builds?profile=default",
    { headers: { Cookie: cookie } }
  );
  assert.equal(builds.status, 200);
  assert.equal((await builds.json()).runs[0].id, 123);

  const buildDetail = await fetch(
    base + "/api/v1/repositories/acme/router/builds/123",
    { headers: { Cookie: cookie } }
  );
  assert.equal(buildDetail.status, 200);
  assert.equal((await buildDetail.json()).run.id, 123);

  const trigger = await fetch(
    base + "/api/v1/repositories/acme/router/profiles/default/builds",
    {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: "http://127.0.0.1",
        "X-OpenWrt-NG-CSRF": "1",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ publishRelease: false })
    }
  );
  assert.equal(trigger.status, 202);
  assert.equal((await trigger.json()).accepted, true);

  const logout = await fetch(base + "/api/v1/logout", {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: "http://127.0.0.1",
      "X-OpenWrt-NG-CSRF": "1"
    }
  });
  assert.equal(logout.status, 204);

  const afterLogout = await fetch(base + "/api/v1/session", {
    headers: { Cookie: cookie }
  });
  assert.deepEqual(await afterLogout.json(), { authenticated: false });

  const idleStore = new ControlPlaneStore(":memory:", secret);
  idleStore.createSession({
    sessionHash: hashOpaque("idle"),
    userLogin: "idle-user",
    avatarUrl: "",
    accessToken: "ghu_idle",
    refreshToken: "",
    githubExpiresAt: 0,
    refreshExpiresAt: 0,
    sessionExpiresAt: Date.now() + 60_000,
    now: Date.now() - 10_000
  });
  assert.equal(
    idleStore.getSession(hashOpaque("idle"), Date.now(), 5_000),
    null
  );
  idleStore.close();

  assert.ok(
    calls.some((call) =>
      call.url.includes("/user/installations/101/repositories")
    )
  );

  console.log("Control Plane server tests passed.");
} finally {
  await new Promise((resolve) => server.close(resolve));
  store.close();
}
