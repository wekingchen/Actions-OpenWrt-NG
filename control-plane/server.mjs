import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BuildControlError,
  GitHubAppClient,
  ProfileWriteError,
  githubErrorReason
} from "./lib/github.mjs";
import {
  hashOpaque,
  oauthCookie,
  parseCookies,
  randomToken,
  safeReturnTo,
  sessionCookie,
  sha256Base64Url
} from "./lib/security.mjs";
import { ControlPlaneStore } from "./lib/store.mjs";
import {
  ProfileTemplateError,
  buildProfileTemplateFiles,
  profileFilesObject
} from "./lib/profile-template.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "public");

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function loadConfigFromEnv() {
  const origin = new URL(
    process.env.CONTROL_PLANE_ORIGIN || "http://127.0.0.1:8787"
  );
  const allowLocal =
    process.env.CONTROL_PLANE_ALLOW_INSECURE_LOCALHOST === "true" &&
    ["127.0.0.1", "localhost", "::1"].includes(origin.hostname);

  if (origin.protocol !== "https:" && !allowLocal) {
    throw new Error("CONTROL_PLANE_ORIGIN must use HTTPS outside local development");
  }
  if (origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("CONTROL_PLANE_ORIGIN must contain only scheme, host and port");
  }

  return {
    origin: origin.origin,
    secureCookie: origin.protocol === "https:",
    clientId: requiredEnv("GITHUB_APP_CLIENT_ID"),
    clientSecret: requiredEnv("GITHUB_APP_CLIENT_SECRET"),
    encryptionSecret: requiredEnv("TOKEN_ENCRYPTION_KEY"),
    dbPath: process.env.CONTROL_PLANE_DB || "./control-plane.db",
    port: Number(process.env.PORT || 8787),
    apiVersion: process.env.GITHUB_API_VERSION || "2022-11-28",
    githubAppSlug: requiredEnv("GITHUB_APP_SLUG"),
    sessionTtlMs:
      Number(process.env.SESSION_TTL_SECONDS || 604800) * 1000,
    sessionIdleTtlMs:
      Number(process.env.SESSION_IDLE_TTL_SECONDS || 86400) * 1000
  };
}

function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": payload.length,
    "Cache-Control": "no-store"
  });
  res.end(payload);
}

function redirect(res, location, cookies = []) {
  const headers = {
    Location: location,
    "Cache-Control": "no-store"
  };
  const list = Array.isArray(cookies) ? cookies.filter(Boolean) : [cookies].filter(Boolean);
  if (list.length) headers["Set-Cookie"] = list;
  res.writeHead(302, headers);
  res.end();
}

function securityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' https://avatars.githubusercontent.com data:; " +
      "style-src 'self'; script-src 'self'; connect-src 'self'; " +
      "base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://github.com"
  );
}

function sessionTokenFromRequest(req) {
  return parseCookies(req.headers.cookie || "").ong_session || "";
}

function validMutationRequest(req, origin) {
  return (
    req.headers.origin === origin &&
    req.headers["x-openwrt-ng-csrf"] === "1"
  );
}

async function readJsonBody(req, limit = 5 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) {
      const error = new Error("request_body_too_large");
      error.status = 413;
      throw error;
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    const error = new Error("invalid_json");
    error.status = 400;
    throw error;
  }
}

export function createControlPlaneHandler({ config, store, github }) {
  async function authenticatedSession(req) {
    const opaque = sessionTokenFromRequest(req);
    if (!opaque) return null;

    let session = store.getSession(
      hashOpaque(opaque),
      Date.now(),
      config.sessionIdleTtlMs
    );
    if (!session) return null;

    const refreshSoon =
      session.githubExpiresAt &&
      session.githubExpiresAt <= Date.now() + 60_000;

    if (refreshSoon) {
      if (!session.refreshToken) {
        store.deleteSession(session.sessionHash);
        return null;
      }
      if (
        session.refreshExpiresAt &&
        session.refreshExpiresAt <= Date.now()
      ) {
        store.deleteSession(session.sessionHash);
        return null;
      }

      const token = await github.refreshUserToken(session.refreshToken);
      store.updateSessionTokens(session.sessionHash, token);
      session = store.getSession(
        session.sessionHash,
        Date.now(),
        config.sessionIdleTtlMs
      );
    }

    return session;
  }

  return async function handler(req, res) {
    securityHeaders(res);
    const url = new URL(req.url || "/", config.origin);

    try {
      if (req.method === "GET" && url.pathname === "/api/v1/health") {
        return json(res, 200, {
          ok: true,
          version: 1,
          runtime: "self-hosted-node",
          configured: true
        });
      }

      if (req.method === "GET" && url.pathname === "/api/v1/auth/start") {
        store.purgeExpired();
        const state = randomToken(32);
        const verifier = randomToken(48);
        const browserNonce = randomToken(32);
        const returnTo = safeReturnTo(url.searchParams.get("return_to"));
        store.createOAuthState({
          stateHash: hashOpaque(state),
          browserHash: hashOpaque(browserNonce),
          verifier,
          returnTo,
          expiresAt: Date.now() + 10 * 60 * 1000
        });

        return redirect(
          res,
          github.authorizeUrl({
            state,
            codeChallenge: sha256Base64Url(verifier)
          }),
          oauthCookie(browserNonce, {
            secure: config.secureCookie,
            maxAge: 600
          })
        );
      }

      if (req.method === "GET" && url.pathname === "/api/v1/auth/callback") {
        const code = url.searchParams.get("code") || "";
        const state = url.searchParams.get("state") || "";
        if (!code || !state) {
          return json(res, 400, { error: "missing_oauth_parameters" });
        }

        const browserNonce = parseCookies(req.headers.cookie || "").ong_oauth || "";
        if (!browserNonce) {
          return json(res, 400, { error: "missing_oauth_browser_binding" });
        }

        const pending = store.consumeOAuthState(hashOpaque(state));
        if (!pending) {
          res.setHeader("Set-Cookie", oauthCookie("", {
            secure: config.secureCookie,
            maxAge: 0
          }));
          return json(res, 400, { error: "invalid_or_expired_state" });
        }
        if (pending.browserHash !== hashOpaque(browserNonce)) {
          res.setHeader("Set-Cookie", oauthCookie("", {
            secure: config.secureCookie,
            maxAge: 0
          }));
          return json(res, 400, { error: "oauth_browser_binding_mismatch" });
        }

        const token = await github.exchangeCode(code, pending.verifier);
        const user = await github.getUser(token.accessToken);
        if (!user?.login) {
          return json(res, 502, { error: "invalid_github_user" });
        }

        const opaqueSession = randomToken(32);
        const sessionExpiresAt = Date.now() + config.sessionTtlMs;
        store.createSession({
          sessionHash: hashOpaque(opaqueSession),
          userLogin: user.login,
          avatarUrl: user.avatar_url || "",
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          githubExpiresAt: token.expiresAt,
          refreshExpiresAt: token.refreshExpiresAt,
          sessionExpiresAt
        });

        return redirect(
          res,
          pending.returnTo,
          [
            sessionCookie(opaqueSession, {
              secure: config.secureCookie,
              maxAge: Math.floor(config.sessionTtlMs / 1000)
            }),
            oauthCookie("", {
              secure: config.secureCookie,
              maxAge: 0
            })
          ]
        );
      }

      if (req.method === "GET" && url.pathname === "/api/v1/config") {
        return json(res, 200, {
          configured: true,
          githubAppInstallUrl:
            "https://github.com/apps/" +
            encodeURIComponent(config.githubAppSlug) +
            "/installations/new"
        });
      }

      if (req.method === "GET" && url.pathname === "/api/v1/session") {
        const session = await authenticatedSession(req);
        if (!session) {
          return json(res, 200, { authenticated: false });
        }
        let avatarUrl = session.avatarUrl || "";
        if (!avatarUrl) {
          try {
            const user = await github.getUser(session.accessToken);
            avatarUrl = user?.avatar_url || "";
          } catch (error) {
            console.warn("GitHub avatar refresh failed", error);
          }
        }

        return json(res, 200, {
          authenticated: true,
          user: {
            login: session.userLogin,
            avatarUrl
          },
          expiresAt: new Date(session.sessionExpiresAt).toISOString()
        });
      }

      if (req.method === "POST" && url.pathname === "/api/v1/logout") {
        if (!validMutationRequest(req, config.origin)) {
          return json(res, 403, { error: "csrf_validation_failed" });
        }
        const opaque = sessionTokenFromRequest(req);
        if (opaque) store.deleteSession(hashOpaque(opaque));
        res.setHeader(
          "Set-Cookie",
          sessionCookie("", {
            secure: config.secureCookie,
            maxAge: 0
          })
        );
        res.writeHead(204, { "Cache-Control": "no-store" });
        return res.end();
      }

      if (
        req.method === "POST" &&
        url.pathname === "/api/v1/profile-templates/preview"
      ) {
        if (!validMutationRequest(req, config.origin)) {
          return json(res, 403, { error: "csrf_validation_failed" });
        }
        const session = await authenticatedSession(req);
        if (!session) {
          return json(res, 401, { error: "authentication_required" });
        }

        let payload;
        try {
          payload = await readJsonBody(req);
        } catch (error) {
          return json(res, error.status || 400, {
            error: error.message || "invalid_json"
          });
        }

        try {
          const files = buildProfileTemplateFiles(payload);
          return json(res, 200, {
            profileId: payload.profileId,
            files: files.map((file) => ({
              path: file.path,
              content: file.text,
              mode: file.mode
            }))
          });
        } catch (error) {
          if (error instanceof ProfileTemplateError) {
            return json(res, error.status, {
              error: error.code,
              validationErrors: error.validationErrors
            });
          }
          throw error;
        }
      }

      if (req.method === "GET" && url.pathname === "/api/v1/repositories") {
        const session = await authenticatedSession(req);
        if (!session) return json(res, 401, { error: "authentication_required" });
        const repositories = await github.listRepositories(session.accessToken);
        return json(res, 200, { repositories });
      }

      const profileMatch = url.pathname.match(
        /^\/api\/v1\/repositories\/([^/]+)\/([^/]+)\/profiles$/
      );
      if (req.method === "GET" && profileMatch) {
        const session = await authenticatedSession(req);
        if (!session) return json(res, 401, { error: "authentication_required" });
        const owner = decodeURIComponent(profileMatch[1]);
        const repo = decodeURIComponent(profileMatch[2]);
        const profiles = await github.listProfiles(
          session.accessToken,
          owner,
          repo
        );
        return json(res, 200, { owner, repo, profiles });
      }

      if (req.method === "POST" && profileMatch) {
        if (!validMutationRequest(req, config.origin)) {
          return json(res, 403, { error: "csrf_validation_failed" });
        }
        const session = await authenticatedSession(req);
        if (!session) {
          return json(res, 401, { error: "authentication_required" });
        }

        let payload;
        try {
          payload = await readJsonBody(req);
        } catch (error) {
          return json(res, error.status || 400, {
            error: error.message || "invalid_json"
          });
        }

        const owner = decodeURIComponent(profileMatch[1]);
        const repo = decodeURIComponent(profileMatch[2]);
        try {
          const files = buildProfileTemplateFiles(payload);
          const result = await github.createNewProfilePullRequest(
            session.accessToken,
            owner,
            repo,
            payload.profileId,
            profileFilesObject(files)
          );
          return json(res, 201, {
            profileId: payload.profileId,
            ...result
          });
        } catch (error) {
          if (error instanceof ProfileTemplateError) {
            return json(res, error.status, {
              error: error.code,
              validationErrors: error.validationErrors
            });
          }
          if (error instanceof ProfileWriteError) {
            return json(res, error.status, { error: error.code });
          }
          if (error?.name === "GitHubRequestError") {
            return json(res, 502, {
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
      if (req.method === "GET" && profileDetailMatch) {
        const session = await authenticatedSession(req);
        if (!session) return json(res, 401, { error: "authentication_required" });
        const owner = decodeURIComponent(profileDetailMatch[1]);
        const repo = decodeURIComponent(profileDetailMatch[2]);
        const profileId = decodeURIComponent(profileDetailMatch[3]);
        try {
          const detail = await github.getProfile(
            session.accessToken,
            owner,
            repo,
            profileId
          );
          return json(res, 200, detail);
        } catch (error) {
          if (error instanceof ProfileWriteError) {
            return json(res, error.status, { error: error.code });
          }
          throw error;
        }
      }

      const profileWriteMatch = url.pathname.match(
        /^\/api\/v1\/repositories\/([^/]+)\/([^/]+)\/profiles\/([^/]+)\/pull-request$/
      );
      if (req.method === "POST" && profileWriteMatch) {
        if (!validMutationRequest(req, config.origin)) {
          return json(res, 403, { error: "csrf_validation_failed" });
        }
        const session = await authenticatedSession(req);
        if (!session) return json(res, 401, { error: "authentication_required" });

        let payload;
        try {
          payload = await readJsonBody(req);
        } catch (error) {
          return json(res, error.status || 400, { error: error.message || "invalid_json" });
        }

        const owner = decodeURIComponent(profileWriteMatch[1]);
        const repo = decodeURIComponent(profileWriteMatch[2]);
        const profileId = decodeURIComponent(profileWriteMatch[3]);
        try {
          const result = await github.createProfilePullRequest(
            session.accessToken,
            owner,
            repo,
            profileId,
            payload
          );
          return json(res, 201, result);
        } catch (error) {
          if (error instanceof ProfileWriteError) {
            return json(res, error.status, { error: error.code });
          }
          if (error?.name === "GitHubRequestError") {
            return json(res, 502, {
              error: "github_profile_write_failed",
              reason: githubErrorReason(error)
            });
          }
          throw error;
        }
      }


      const buildsMatch = url.pathname.match(
        /^\/api\/v1\/repositories\/([^/]+)\/([^/]+)\/builds$/
      );
      if (req.method === "GET" && buildsMatch) {
        const session = await authenticatedSession(req);
        if (!session) return json(res, 401, { error: "authentication_required" });
        const owner = decodeURIComponent(buildsMatch[1]);
        const repo = decodeURIComponent(buildsMatch[2]);
        try {
          const runs = await github.listBuilderRuns(
            session.accessToken,
            owner,
            repo,
            {
              profileId: url.searchParams.get("profile") || "",
              requestId: url.searchParams.get("request_id") || "",
              limit: url.searchParams.get("limit") || 10
            }
          );
          return json(res, 200, { owner, repo, runs });
        } catch (error) {
          if (error instanceof BuildControlError) {
            return json(res, error.status, { error: error.code });
          }
          if (error?.name === "GitHubRequestError") {
            return json(res, 502, {
              error: "github_build_status_failed",
              reason: githubErrorReason(error)
            });
          }
          throw error;
        }
      }

      const buildDetailMatch = url.pathname.match(
        /^\/api\/v1\/repositories\/([^/]+)\/([^/]+)\/builds\/(\d+)$/
      );
      if (req.method === "GET" && buildDetailMatch) {
        const session = await authenticatedSession(req);
        if (!session) return json(res, 401, { error: "authentication_required" });
        const owner = decodeURIComponent(buildDetailMatch[1]);
        const repo = decodeURIComponent(buildDetailMatch[2]);
        try {
          const run = await github.getBuilderRun(
            session.accessToken,
            owner,
            repo,
            buildDetailMatch[3]
          );
          return json(res, 200, { owner, repo, run });
        } catch (error) {
          if (error instanceof BuildControlError) {
            return json(res, error.status, { error: error.code });
          }
          if (error?.name === "GitHubRequestError") {
            return json(res, 502, {
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
      if (req.method === "POST" && buildTriggerMatch) {
        if (!validMutationRequest(req, config.origin)) {
          return json(res, 403, { error: "csrf_validation_failed" });
        }
        const session = await authenticatedSession(req);
        if (!session) return json(res, 401, { error: "authentication_required" });

        let payload;
        try {
          payload = await readJsonBody(req);
        } catch (error) {
          return json(res, error.status || 400, {
            error: error.message || "invalid_json"
          });
        }

        const owner = decodeURIComponent(buildTriggerMatch[1]);
        const repo = decodeURIComponent(buildTriggerMatch[2]);
        const profileId = decodeURIComponent(buildTriggerMatch[3]);
        try {
          const result = await github.triggerBuilder(
            session.accessToken,
            owner,
            repo,
            profileId,
            payload
          );
          return json(res, 202, result);
        } catch (error) {
          if (error instanceof BuildControlError) {
            const body = { error: error.code };
            if (error.activeRun) body.activeRun = error.activeRun;
            return json(res, error.status, body);
          }
          if (error?.name === "GitHubRequestError") {
            return json(res, 502, {
              error: "github_builder_dispatch_failed",
              reason: githubErrorReason(error)
            });
          }
          throw error;
        }
      }

      const staticFiles = {
        "/": ["index.html", "text/html; charset=utf-8"],
        "/app.js": ["app.js", "text/javascript; charset=utf-8"],
        "/style.css": ["style.css", "text/css; charset=utf-8"],
        "/assets/app.js": ["app.js", "text/javascript; charset=utf-8"],
        "/assets/style.css": ["style.css", "text/css; charset=utf-8"]
      };
      const staticFile = staticFiles[url.pathname];
      if (req.method === "GET" && staticFile) {
        const payload = await readFile(join(publicDir, staticFile[0]));
        res.writeHead(200, {
          "Content-Type": staticFile[1],
          "Content-Length": payload.length,
          "Cache-Control": "no-store"
        });
        return res.end(payload);
      }

      return json(res, 404, { error: "not_found" });
    } catch (error) {
      console.error(error);
      return json(res, 500, { error: "internal_error" });
    }
  };
}

export function createApplication(config, options = {}) {
  const store =
    options.store ||
    new ControlPlaneStore(config.dbPath, config.encryptionSecret);
  const github =
    options.github ||
    new GitHubAppClient(
      {
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        redirectUri: config.origin + "/api/v1/auth/callback",
        apiVersion: config.apiVersion
      },
      options.fetchImpl
    );
  return {
    store,
    github,
    handler: createControlPlaneHandler({ config, store, github })
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  const config = loadConfigFromEnv();
  const app = createApplication(config);
  const server = createServer(app.handler);
  server.listen(config.port, "0.0.0.0", () => {
    console.log(
      `OpenWrt NG Control Plane listening on :${config.port} origin=${config.origin}`
    );
  });
}
