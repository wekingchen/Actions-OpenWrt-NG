import {
  BuildControlError,
  ConfigStudioError,
  GitHubAppClient,
  ProfileWriteError,
  githubErrorReason
} from "./lib/github.mjs";
import { D1ControlPlaneStore } from "./lib/d1-store.mjs";
import {
  ProfileTemplateError,
  buildProfileTemplateFiles,
  profileFilesObject
} from "./lib/profile-template.mjs";
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

function positiveSeconds(env, name, fallback) {
  const parsed = Number(value(env, name) || fallback);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed * 1000
    : fallback * 1000;
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
    sessionTtlMs: positiveSeconds(
      env,
      "SESSION_TTL_SECONDS",
      604800
    ),
    sessionIdleTtlMs: positiveSeconds(
      env,
      "SESSION_IDLE_TTL_SECONDS",
      86400
    ),
    configured: Boolean(
      clientId &&
      clientSecret &&
      githubAppSlug &&
      encryptionSecret.length >= 32 &&
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

function validMutationRequest(request, origin) {
  return (
    request.headers.get("origin") === origin &&
    request.headers.get("x-openwrt-ng-csrf") === "1"
  );
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

      let pending;
      try {
        pending = await deps.store.consumeOAuthState(hashOpaque(state));
      } catch (error) {
        console.error("OAuth callback state store failed", error);
        return json(500, { error: "oauth_state_store_failed" });
      }
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

      let token;
      try {
        token = await deps.github.exchangeCode(code, pending.verifier);
      } catch (error) {
        console.error("GitHub OAuth code exchange failed", error);
        return json(
          502,
          {
            error: "github_oauth_exchange_failed",
            reason: githubErrorReason(error)
          },
          {
            "Set-Cookie": oauthCookie("", {
              secure: config.secureCookie,
              maxAge: 0
            })
          }
        );
      }

      let user;
      try {
        user = await deps.github.getUser(token.accessToken);
      } catch (error) {
        console.error("GitHub user lookup failed", error);
        return json(502, {
          error: "github_user_lookup_failed",
          reason: githubErrorReason(error)
        });
      }
      if (!user?.login) {
        return json(502, { error: "invalid_github_user" });
      }

      const opaqueSession = randomToken(32);
      const sessionExpiresAt = Date.now() + config.sessionTtlMs;
      try {
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
      } catch (error) {
        console.error("OAuth callback session store failed", error);
        return json(500, { error: "oauth_session_store_failed" });
      }

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

      let avatarUrl = session.avatarUrl || "";
      if (!avatarUrl) {
        try {
          const user = await deps.github.getUser(session.accessToken);
          avatarUrl = user?.avatar_url || "";
        } catch (error) {
          console.warn("GitHub avatar refresh failed", error);
        }
      }

      return json(200, {
        authenticated: true,
        user: {
          login: session.userLogin,
          avatarUrl
        },
        expiresAt: new Date(session.sessionExpiresAt).toISOString()
      });
    }

    if (request.method === "POST" && url.pathname === "/api/v1/logout") {
      if (!validMutationRequest(request, config.origin)) {
        return json(403, { error: "csrf_validation_failed" });
      }
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
      request.method === "POST" &&
      url.pathname === "/api/v1/profile-templates/preview"
    ) {
      if (!validMutationRequest(request, config.origin)) {
        return json(403, { error: "csrf_validation_failed" });
      }
      const session = await authenticatedSession();
      if (!session) {
        return json(401, { error: "authentication_required" });
      }

      let payload;
      try {
        payload = await request.json();
      } catch {
        return json(400, { error: "invalid_json" });
      }

      try {
        const files = buildProfileTemplateFiles(payload);
        return json(200, {
          profileId: payload.profileId,
          files: files.map((file) => ({
            path: file.path,
            content: file.text,
            mode: file.mode
          }))
        });
      } catch (error) {
        if (error instanceof ProfileTemplateError) {
          return json(error.status, {
            error: error.code,
            validationErrors: error.validationErrors
          });
        }
        throw error;
      }
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
      return json(200, {
        owner,
        repo,
        baselineProfileId:
          profiles.find((profile) => profile.baseline)?.id || "",
        profiles
      });
    }

    if (request.method === "POST" && profileMatch) {
      if (!validMutationRequest(request, config.origin)) {
        return json(403, { error: "csrf_validation_failed" });
      }
      const session = await authenticatedSession();
      if (!session) {
        return json(401, { error: "authentication_required" });
      }

      let payload;
      try {
        payload = await request.json();
      } catch {
        return json(400, { error: "invalid_json" });
      }

      const owner = decodeURIComponent(profileMatch[1]);
      const repo = decodeURIComponent(profileMatch[2]);
      try {
        const files = buildProfileTemplateFiles(payload);
        const result = await deps.github.createNewProfilePullRequest(
          session.accessToken,
          owner,
          repo,
          payload.profileId,
          profileFilesObject(files)
        );
        return json(201, {
          profileId: payload.profileId,
          ...result
        });
      } catch (error) {
        if (error instanceof ProfileTemplateError) {
          return json(error.status, {
            error: error.code,
            validationErrors: error.validationErrors
          });
        }
        if (error instanceof ProfileWriteError) {
          return json(error.status, { error: error.code });
        }
        if (error?.name === "GitHubRequestError") {
          return json(502, {
            error: "github_profile_write_failed",
            reason: githubErrorReason(error)
          });
        }
        throw error;
      }
    }


    const profileDetailMatch = url.pathname.match(
      /^\/api\/v1\/repositories\/([^/]+)\/([^/]+)\/profiles\/([^/]+)$/
    );
    if (request.method === "GET" && profileDetailMatch) {
      const session = await authenticatedSession();
      if (!session) {
        return json(401, { error: "authentication_required" });
      }
      const owner = decodeURIComponent(profileDetailMatch[1]);
      const repo = decodeURIComponent(profileDetailMatch[2]);
      const profileId = decodeURIComponent(profileDetailMatch[3]);
      try {
        const detail = await deps.github.getProfile(
          session.accessToken,
          owner,
          repo,
          profileId
        );
        return json(200, detail);
      } catch (error) {
        if (error instanceof ProfileWriteError) {
          return json(error.status, { error: error.code });
        }
        throw error;
      }
    }

    if (request.method === "DELETE" && profileDetailMatch) {
      if (!validMutationRequest(request, config.origin)) {
        return json(403, { error: "csrf_validation_failed" });
      }
      const session = await authenticatedSession();
      if (!session) {
        return json(401, { error: "authentication_required" });
      }

      let payload;
      try {
        payload = await request.json();
      } catch {
        return json(400, { error: "invalid_json" });
      }

      const owner = decodeURIComponent(profileDetailMatch[1]);
      const repo = decodeURIComponent(profileDetailMatch[2]);
      const profileId = decodeURIComponent(profileDetailMatch[3]);
      try {
        const result = await deps.github.deleteProfilePullRequest(
          session.accessToken,
          owner,
          repo,
          profileId,
          payload
        );
        return json(201, result);
      } catch (error) {
        if (error instanceof ProfileWriteError) {
          return json(error.status, { error: error.code });
        }
        if (error?.name === "GitHubRequestError") {
          return json(502, {
            error: "github_profile_delete_failed",
            reason: githubErrorReason(error)
          });
        }
        throw error;
      }
    }


    const profileLifecycleMatch = url.pathname.match(
      /^\/api\/v1\/repositories\/([^/]+)\/([^/]+)\/profiles\/([^/]+)\/(copy|rename)$/
    );
    if (request.method === "POST" && profileLifecycleMatch) {
      if (!validMutationRequest(request, config.origin)) {
        return json(403, { error: "csrf_validation_failed" });
      }
      const session = await authenticatedSession();
      if (!session) return json(401, { error: "authentication_required" });

      let payload;
      try {
        payload = await request.json();
      } catch {
        return json(400, { error: "invalid_json" });
      }

      const owner = decodeURIComponent(profileLifecycleMatch[1]);
      const repo = decodeURIComponent(profileLifecycleMatch[2]);
      const profileId = decodeURIComponent(profileLifecycleMatch[3]);
      const action = profileLifecycleMatch[4];
      try {
        const result = action === "copy"
          ? await deps.github.copyProfilePullRequest(
              session.accessToken, owner, repo, profileId, payload
            )
          : await deps.github.renameProfilePullRequest(
              session.accessToken, owner, repo, profileId, payload
            );
        return json(201, result);
      } catch (error) {
        if (error instanceof ProfileWriteError) {
          return json(error.status, { error: error.code });
        }
        if (error?.name === "GitHubRequestError") {
          return json(502, {
            error: "github_profile_write_failed",
            reason: githubErrorReason(error)
          });
        }
        throw error;
      }
    }


    const profileBaselineMatch = url.pathname.match(
      /^\/api\/v1\/repositories\/([^/]+)\/([^/]+)\/profiles\/([^/]+)\/baseline$/
    );
    if (request.method === "POST" && profileBaselineMatch) {
      if (!validMutationRequest(request, config.origin)) {
        return json(403, { error: "csrf_validation_failed" });
      }
      const session = await authenticatedSession();
      if (!session) {
        return json(401, { error: "authentication_required" });
      }

      let payload;
      try {
        payload = await request.json();
      } catch {
        return json(400, { error: "invalid_json" });
      }

      const owner = decodeURIComponent(profileBaselineMatch[1]);
      const repo = decodeURIComponent(profileBaselineMatch[2]);
      const profileId = decodeURIComponent(profileBaselineMatch[3]);
      try {
        const result = await deps.github.setBaselineProfilePullRequest(
          session.accessToken,
          owner,
          repo,
          profileId,
          payload
        );
        return json(201, result);
      } catch (error) {
        if (error instanceof ProfileWriteError) {
          return json(error.status, { error: error.code });
        }
        if (error?.name === "GitHubRequestError") {
          return json(502, {
            error: "github_profile_write_failed",
            reason: githubErrorReason(error)
          });
        }
        throw error;
      }
    }


    const profileWriteMatch = url.pathname.match(
      /^\/api\/v1\/repositories\/([^/]+)\/([^/]+)\/profiles\/([^/]+)\/pull-request$/
    );
    if (request.method === "POST" && profileWriteMatch) {
      if (!validMutationRequest(request, config.origin)) {
        return json(403, { error: "csrf_validation_failed" });
      }
      const session = await authenticatedSession();
      if (!session) {
        return json(401, { error: "authentication_required" });
      }
      let payload;
      try {
        payload = await request.json();
      } catch {
        return json(400, { error: "invalid_json" });
      }
      const owner = decodeURIComponent(profileWriteMatch[1]);
      const repo = decodeURIComponent(profileWriteMatch[2]);
      const profileId = decodeURIComponent(profileWriteMatch[3]);
      try {
        const result = await deps.github.createProfilePullRequest(
          session.accessToken,
          owner,
          repo,
          profileId,
          payload
        );
        return json(201, result);
      } catch (error) {
        if (error instanceof ProfileWriteError) {
          return json(error.status, { error: error.code });
        }
        if (error?.name === "GitHubRequestError") {
          return json(502, {
            error: "github_profile_write_failed",
            reason: githubErrorReason(error)
          });
        }
        throw error;
      }
    }


    const configStudioRootMatch = url.pathname.match(
      /^\/api\/v1\/repositories\/([^/]+)\/([^/]+)\/config-studio$/
    );
    if (request.method === "POST" && configStudioRootMatch) {
      if (!validMutationRequest(request, config.origin)) {
        return json(403, { error: "csrf_validation_failed" });
      }
      const session = await authenticatedSession();
      if (!session) return json(401, { error: "authentication_required" });
      let payload;
      try {
        payload = await request.json();
      } catch {
        return json(400, { error: "invalid_json" });
      }
      const owner = decodeURIComponent(configStudioRootMatch[1]);
      const repo = decodeURIComponent(configStudioRootMatch[2]);
      try {
        const result = await deps.github.startConfigStudio(
          session.accessToken,
          owner,
          repo,
          payload
        );
        return json(202, result);
      } catch (error) {
        if (error instanceof ConfigStudioError) {
          return json(error.status, { error: error.code });
        }
        if (error?.name === "GitHubRequestError") {
          return json(502, {
            error: "github_config_studio_failed",
            reason: githubErrorReason(error)
          });
        }
        throw error;
      }
    }

    const configStudioSessionMatch = url.pathname.match(
      /^\/api\/v1\/repositories\/([^/]+)\/([^/]+)\/config-studio\/([0-9a-f]{16})$/
    );
    if (request.method === "GET" && configStudioSessionMatch) {
      const session = await authenticatedSession();
      if (!session) return json(401, { error: "authentication_required" });
      const owner = decodeURIComponent(configStudioSessionMatch[1]);
      const repo = decodeURIComponent(configStudioSessionMatch[2]);
      const requestId = configStudioSessionMatch[3];
      try {
        const result = await deps.github.getConfigStudioSession(
          session.accessToken,
          owner,
          repo,
          requestId
        );
        return json(200, result);
      } catch (error) {
        if (error instanceof ConfigStudioError) {
          return json(error.status, { error: error.code });
        }
        throw error;
      }
    }
    if (request.method === "DELETE" && configStudioSessionMatch) {
      if (!validMutationRequest(request, config.origin)) {
        return json(403, { error: "csrf_validation_failed" });
      }
      const session = await authenticatedSession();
      if (!session) return json(401, { error: "authentication_required" });
      const owner = decodeURIComponent(configStudioSessionMatch[1]);
      const repo = decodeURIComponent(configStudioSessionMatch[2]);
      const requestId = configStudioSessionMatch[3];
      try {
        const result = await deps.github.deleteConfigStudioSession(
          session.accessToken,
          owner,
          repo,
          requestId
        );
        return json(200, result);
      } catch (error) {
        if (error instanceof ConfigStudioError) {
          return json(error.status, { error: error.code });
        }
        throw error;
      }
    }

    const configStudioResolveMatch = url.pathname.match(
      /^\/api\/v1\/repositories\/([^/]+)\/([^/]+)\/config-studio\/([0-9a-f]{16})\/resolve$/
    );
    if (request.method === "POST" && configStudioResolveMatch) {
      if (!validMutationRequest(request, config.origin)) {
        return json(403, { error: "csrf_validation_failed" });
      }
      const session = await authenticatedSession();
      if (!session) return json(401, { error: "authentication_required" });
      let payload;
      try {
        payload = await request.json();
      } catch {
        return json(400, { error: "invalid_json" });
      }
      const owner = decodeURIComponent(configStudioResolveMatch[1]);
      const repo = decodeURIComponent(configStudioResolveMatch[2]);
      const requestId = configStudioResolveMatch[3];
      try {
        const result = await deps.github.submitConfigStudioSelection(
          session.accessToken,
          owner,
          repo,
          requestId,
          payload
        );
        return json(202, result);
      } catch (error) {
        if (error instanceof ConfigStudioError) {
          return json(error.status, { error: error.code });
        }
        throw error;
      }
    }

    const configStudioApplyMatch = url.pathname.match(
      /^\/api\/v1\/repositories\/([^/]+)\/([^/]+)\/config-studio\/([0-9a-f]{16})\/apply\/([^/]+)$/
    );
    if (request.method === "POST" && configStudioApplyMatch) {
      if (!validMutationRequest(request, config.origin)) {
        return json(403, { error: "csrf_validation_failed" });
      }
      const session = await authenticatedSession();
      if (!session) return json(401, { error: "authentication_required" });
      const owner = decodeURIComponent(configStudioApplyMatch[1]);
      const repo = decodeURIComponent(configStudioApplyMatch[2]);
      const requestId = configStudioApplyMatch[3];
      const profileId = decodeURIComponent(configStudioApplyMatch[4]);
      try {
        const result = await deps.github.applyConfigStudioToProfile(
          session.accessToken,
          owner,
          repo,
          requestId,
          profileId
        );
        return json(201, result);
      } catch (error) {
        if (error instanceof ConfigStudioError) {
          return json(error.status, { error: error.code });
        }
        if (error instanceof ProfileWriteError) {
          return json(error.status, { error: error.code });
        }
        if (error?.name === "GitHubRequestError") {
          return json(502, {
            error: "github_config_studio_apply_failed",
            reason: githubErrorReason(error)
          });
        }
        throw error;
      }
    }


    const buildsMatch = url.pathname.match(
      /^\/api\/v1\/repositories\/([^/]+)\/([^/]+)\/builds$/
    );
    if (request.method === "GET" && buildsMatch) {
      const session = await authenticatedSession();
      if (!session) return json(401, { error: "authentication_required" });
      const owner = decodeURIComponent(buildsMatch[1]);
      const repo = decodeURIComponent(buildsMatch[2]);
      try {
        const runs = await deps.github.listBuilderRuns(
          session.accessToken,
          owner,
          repo,
          {
            profileId: url.searchParams.get("profile") || "",
            requestId: url.searchParams.get("request_id") || "",
            limit: url.searchParams.get("limit") || 10
          }
        );
        return json(200, { owner, repo, runs });
      } catch (error) {
        if (error instanceof BuildControlError) {
          return json(error.status, { error: error.code });
        }
        if (error?.name === "GitHubRequestError") {
          return json(502, {
            error: "github_build_status_failed",
            reason: githubErrorReason(error)
          });
        }
        throw error;
      }
    }

    const artifactDownloadMatch = url.pathname.match(
      /^\/api\/v1\/repositories\/([^/]+)\/([^/]+)\/builds\/(\d+)\/artifacts\/(\d+)\/download$/
    );
    if (request.method === "GET" && artifactDownloadMatch) {
      const session = await authenticatedSession();
      if (!session) return json(401, { error: "authentication_required" });
      const owner = decodeURIComponent(artifactDownloadMatch[1]);
      const repo = decodeURIComponent(artifactDownloadMatch[2]);
      try {
        const location = await deps.github.getBuilderArtifactDownloadUrl(
          session.accessToken,
          owner,
          repo,
          artifactDownloadMatch[3],
          artifactDownloadMatch[4]
        );
        return redirect(location);
      } catch (error) {
        if (error instanceof BuildControlError) {
          return json(error.status, { error: error.code });
        }
        if (error?.name === "GitHubRequestError") {
          return json(502, {
            error: "github_artifact_download_failed",
            reason: githubErrorReason(error)
          });
        }
        throw error;
      }
    }

    const buildControlMatch = url.pathname.match(
      /^\/api\/v1\/repositories\/([^/]+)\/([^/]+)\/builds\/(\d+)\/(cancel|rerun)$/
    );
    if (request.method === "POST" && buildControlMatch) {
      if (!validMutationRequest(request, config.origin)) {
        return json(403, { error: "csrf_validation_failed" });
      }
      const session = await authenticatedSession();
      if (!session) return json(401, { error: "authentication_required" });

      const owner = decodeURIComponent(buildControlMatch[1]);
      const repo = decodeURIComponent(buildControlMatch[2]);
      const runId = buildControlMatch[3];
      const action = buildControlMatch[4];
      try {
        const result = action === "cancel"
          ? await deps.github.cancelBuilderRun(
              session.accessToken, owner, repo, runId
            )
          : await deps.github.rerunBuilderRun(
              session.accessToken, owner, repo, runId
            );
        return json(202, result);
      } catch (error) {
        if (error instanceof BuildControlError) {
          return json(error.status, { error: error.code });
        }
        if (error?.name === "GitHubRequestError") {
          return json(502, {
            error: "github_builder_control_failed",
            reason: githubErrorReason(error)
          });
        }
        throw error;
      }
    }


    const buildDetailMatch = url.pathname.match(
      /^\/api\/v1\/repositories\/([^/]+)\/([^/]+)\/builds\/(\d+)$/
    );
    if (request.method === "GET" && buildDetailMatch) {
      const session = await authenticatedSession();
      if (!session) return json(401, { error: "authentication_required" });
      const owner = decodeURIComponent(buildDetailMatch[1]);
      const repo = decodeURIComponent(buildDetailMatch[2]);
      try {
        const run = await deps.github.getBuilderRun(
          session.accessToken,
          owner,
          repo,
          buildDetailMatch[3]
        );
        return json(200, { owner, repo, run });
      } catch (error) {
        if (error instanceof BuildControlError) {
          return json(error.status, { error: error.code });
        }
        if (error?.name === "GitHubRequestError") {
          return json(502, {
            error: "github_build_status_failed",
            reason: githubErrorReason(error)
          });
        }
        throw error;
      }
    }

    const buildTriggerMatch = url.pathname.match(
      /^\/api\/v1\/repositories\/([^/]+)\/([^/]+)\/profiles\/([^/]+)\/builds$/
    );
    if (request.method === "POST" && buildTriggerMatch) {
      if (!validMutationRequest(request, config.origin)) {
        return json(403, { error: "csrf_validation_failed" });
      }
      const session = await authenticatedSession();
      if (!session) return json(401, { error: "authentication_required" });

      let payload;
      try {
        payload = await request.json();
      } catch {
        return json(400, { error: "invalid_json" });
      }

      const owner = decodeURIComponent(buildTriggerMatch[1]);
      const repo = decodeURIComponent(buildTriggerMatch[2]);
      const profileId = decodeURIComponent(buildTriggerMatch[3]);
      try {
        const result = await deps.github.triggerBuilder(
          session.accessToken,
          owner,
          repo,
          profileId,
          payload
        );
        return json(202, result);
      } catch (error) {
        if (error instanceof BuildControlError) {
          const body = { error: error.code };
          if (error.activeRun) body.activeRun = error.activeRun;
          return json(error.status, body);
        }
        if (error?.name === "GitHubRequestError") {
          return json(502, {
            error: "github_builder_dispatch_failed",
            reason: githubErrorReason(error)
          });
        }
        throw error;
      }
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
