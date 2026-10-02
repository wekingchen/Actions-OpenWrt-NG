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
          permissions: { contents: "read", actions: "read" }
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
  assert.deepEqual(await health.json(), { ok: true, version: 1 });

  const publicConfig = await fetch(base + "/api/v1/config");
  assert.deepEqual(await publicConfig.json(), {
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
  assert.equal(reposBody.repositories[0].permissions.contents, "read");

  const profiles = await fetch(
    base + "/api/v1/repositories/acme/router/profiles",
    { headers: { Cookie: cookie } }
  );
  const profilesBody = await profiles.json();
  assert.deepEqual(profilesBody.profiles, [
    { id: "default", path: "profiles/default", sha: "abc" }
  ]);

  const logout = await fetch(base + "/api/v1/logout", {
    method: "POST",
    headers: { Cookie: cookie }
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
