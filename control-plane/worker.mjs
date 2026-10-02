import { GitHubAppClient } from "./lib/github.mjs";
import { D1ControlPlaneStore } from "./lib/d1-store.mjs";
import {
  hashOpaque,
  oauthCookie,
  parseCookies,
  randomToken,
  safeReturnTo,
  sessionCookie,
  sha256Base64Url
} from "./lib/security.mjs";

function value(env, name) {
  return String(env?.[name] || "").trim();
}

export function runtimeConfig(request, env) {
  const url = new URL(request.url);
  const clientId = value(env, "GITHUB_APP_CLIENT_ID");
  const clientSecret = value(env, "GITHUB_APP_CLIENT_SECRET");
  const githubAppSlug = value(env, "GITHUB_APP_SLUG");
  const encryptionSecret = value(env, "TOKEN_ENCRYPTION_KEY");

  return {
    origin: url.origin,
    secureCookie: url.protocol === "https:",
    clientId,
    clientSecret,
    githubAppSlug,
    encryptionSecret,
    apiVersion: value(env, "GITHUB_API_VERSION") || "2022-11-28",
    sessionTtlMs:
      Number(value(env, "SESSION_TTL_SECONDS") || 604800) * 1000,
    sessionIdleTtlMs:
      Number(value(env, "SESSION_IDLE_TTL_SECONDS") || 86400) * 1000,
    configured: Boolean(
      clientId &&
      clientSecret &&
      githubAppSlug &&
      encryptionSecret &&
      env?.DB
    )
  };
}

function securityHeaders(headers) {
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Frame-Options", "DENY");
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' https://avatars.githubusercontent.com data:; " +
      "style-src 'self'; script-src 'self'; connect-src 'self'; " +
      "base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://github.com"
  );
  return headers;
}

function json(status, body, extraHeaders = {}) {
  const headers = securityHeaders(new Headers(extraHeaders));
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
}

function redirect(location, cookies = []) {
  const headers = securityHeaders(new Headers({
    Location: location,
    "Cache-Control": "no-store"
  }));
  for (const cookie of Array.isArray(cookies) ? cookies : [cookies]) {
    if (cookie) headers.append("Set-Cookie", cookie);
  }
  return new Response(null, { status: 302, headers });
}

function withSecurityHeaders(response) {
  const headers = securityHeaders(new Headers(response.headers));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function sessionToken(request) {
  return parseCookies(request.headers.get("cookie") || "").ong_session || "";
}

function createDependencies(request, env, config, overrides = {}) {
  if (overrides.store && overrides.github) return overrides;
  if (!config.configured) return overrides;

  const store =
    overrides.store ||
    new D1ControlPlaneStore(env.DB, config.encryptionSecret);
  const github =
    overrides.github ||
    new GitHubAppClient(
      {
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        redirectUri: config.origin + "/api/v1/auth/callback",
        apiVersion: config.apiVersion
      },
      overrides.fetchImpl || fetch
    );
  return { ...overrides, store, github };
}

export async function handleControlPlaneRequest(
  request,
  env,
  overrides = {}
) {
  const url = new URL(request.url);
  const config = runtimeConfig(request, env);
  const deps = createDependencies(request, env, config, overrides);

  async function authenticatedSession() {
    if (!config.configured || !deps.store) return null;
    const opaque = sessionToken(request);
    if (!opaque) return null;

    let session = await deps.store.getSession(
      hashOpaque(opaque),
      Date.now(),
      config.sessionIdleTtlMs
    );
    if (!session) return null;

    const refreshSoon =
      session.githubExpiresAt &&
      session.githubExpiresAt <= Date.now() + 60_000;

    if (refreshSoon) {
      if (
        !session.refreshToken ||
        (session.refreshExpiresAt &&
          session.refreshExpiresAt <= Date.now())
      ) {
        await deps.store.deleteSession(session.sessionHash);
        return null;
      }

      const token = await deps.github.refreshUserToken(session.refreshToken);
      await deps.store.updateSessionTokens(session.sessionHash, token);
      session = await deps.store.getSession(
        session.sessionHash,
        Date.now(),
        config.sessionIdleTtlMs
      );
    }

    return session;
  }

  try {
    if (request.method === "GET" && url.pathname === "/api/v1/health") {
      return json(200, {
        ok: true,
        version: 1,
        runtime: "cloudflare-workers",
        configured: config.configured
      });
    }

    if (request.method === "GET" && url.pathname === "/api/v1/config") {
      return json(200, {
        configured: config.configured,
        githubAppInstallUrl: config.githubAppSlug
          ? "https://github.com/apps/" +
            encodeURIComponent(config.githubAppSlug) +
            "/installations/new"
          : ""
      });
    }

    if (url.pathname.startsWith("/api/") && !config.configured) {
      return json(503, { error: "control_plane_not_configured" });
    }

    if (request.method === "GET" && url.pathname === "/api/v1/auth/start") {
      await deps.store.purgeExpired();
      const state = randomToken(32);
      const verifier = randomToken(48);
      const browserNonce = randomToken(32);
      const returnTo = safeReturnTo(url.searchParams.get("return_to"));

      await deps.store.createOAuthState({
        stateHash: hashOpaque(state),
        browserHash: hashOpaque(browserNonce),
        verifier,
        returnTo,
        expiresAt: Date.now() + 10 * 60 * 1000
      });

      return redirect(
        deps.github.authorizeUrl({
          state,
          codeChallenge: sha256Base64Url(verifier)
        }),
        oauthCookie(browserNonce, {
          secure: config.secureCookie,
          maxAge: 600
        })
      );
    }

    if (
      request.method === "GET" &&
      url.pathname === "/api/v1/auth/callback"
    ) {
      const code = url.searchParams.get("code") || "";
      const state = url.searchParams.get("state") || "";
      if (!code || !state) {
        return json(400, { error: "missing_oauth_parameters" });
      }

      const browserNonce =
        parseCookies(request.headers.get("cookie") || "").ong_oauth || "";
      if (!browserNonce) {
        return json(400, { error: "missing_oauth_browser_binding" });
      }

      const pending = await deps.store.consumeOAuthState(hashOpaque(state));
      if (!pending) {
        return json(
          400,
          { error: "invalid_or_expired_state" },
          {
            "Set-Cookie": oauthCookie("", {
              secure: config.secureCookie,
              maxAge: 0
            })
          }
        );
      }
      if (pending.browserHash !== hashOpaque(browserNonce)) {
        return json(
          400,
          { error: "oauth_browser_binding_mismatch" },
          {
            "Set-Cookie": oauthCookie("", {
              secure: config.secureCookie,
              maxAge: 0
            })
          }
        );
      }

      const token = await deps.github.exchangeCode(code, pending.verifier);
      const user = await deps.github.getUser(token.accessToken);
      if (!user?.login) {
        return json(502, { error: "invalid_github_user" });
      }

      const opaqueSession = randomToken(32);
      const sessionExpiresAt = Date.now() + config.sessionTtlMs;
      await deps.store.createSession({
        sessionHash: hashOpaque(opaqueSession),
        userLogin: user.login,
        avatarUrl: user.avatar_url || "",
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        githubExpiresAt: token.expiresAt,
        refreshExpiresAt: token.refreshExpiresAt,
        sessionExpiresAt
      });

      return redirect(pending.returnTo, [
        sessionCookie(opaqueSession, {
          secure: config.secureCookie,
          maxAge: Math.floor(config.sessionTtlMs / 1000)
        }),
        oauthCookie("", {
          secure: config.secureCookie,
          maxAge: 0
        })
      ]);
    }

    if (request.method === "GET" && url.pathname === "/api/v1/session") {
      const session = await authenticatedSession();
      if (!session) return json(200, { authenticated: false });

      return json(200, {
        authenticated: true,
        user: {
          login: session.userLogin,
          avatarUrl: session.avatarUrl
        },
        expiresAt: new Date(session.sessionExpiresAt).toISOString()
      });
    }

    if (request.method === "POST" && url.pathname === "/api/v1/logout") {
      const opaque = sessionToken(request);
      if (opaque) await deps.store.deleteSession(hashOpaque(opaque));
      return new Response(null, {
        status: 204,
        headers: securityHeaders(new Headers({
          "Cache-Control": "no-store",
          "Set-Cookie": sessionCookie("", {
            secure: config.secureCookie,
            maxAge: 0
          })
        }))
      });
    }

    if (
      request.method === "GET" &&
      url.pathname === "/api/v1/repositories"
    ) {
      const session = await authenticatedSession();
      if (!session) {
        return json(401, { error: "authentication_required" });
      }
      const repositories = await deps.github.listRepositories(
        session.accessToken
      );
      return json(200, { repositories });
    }

    const profileMatch = url.pathname.match(
      /^\/api\/v1\/repositories\/([^/]+)\/([^/]+)\/profiles$/
    );
    if (request.method === "GET" && profileMatch) {
      const session = await authenticatedSession();
      if (!session) {
        return json(401, { error: "authentication_required" });
      }
      const owner = decodeURIComponent(profileMatch[1]);
      const repo = decodeURIComponent(profileMatch[2]);
      const profiles = await deps.github.listProfiles(
        session.accessToken,
        owner,
        repo
      );
      return json(200, { owner, repo, profiles });
    }

    if (env?.ASSETS) {
      return withSecurityHeaders(await env.ASSETS.fetch(request));
    }
    return json(404, { error: "not_found" });
  } catch (error) {
    console.error("Control Plane request failed", error);
    return json(500, { error: "internal_error" });
  }
}

export default {
  fetch(request, env, ctx) {
    return handleControlPlaneRequest(request, env, { ctx });
  }
};
