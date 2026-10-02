const GITHUB_API = "https://api.github.com";
const GITHUB_OAUTH = "https://github.com/login/oauth";

function safeGitHubErrorCode(body) {
  const code =
    body && typeof body === "object" && typeof body.error === "string"
      ? body.error.trim()
      : "";
  return /^[a-z0-9_]{1,64}$/.test(code) ? code : "";
}

function asJsonError(response, body) {
  const detail =
    body && typeof body === "object"
      ? body.message || body.error_description || body.error || response.statusText
      : response.statusText;
  const error = new Error(
    `GitHub request failed: HTTP ${response.status} ${detail || "unknown"}`
  );
  error.name = "GitHubRequestError";
  error.httpStatus = response.status;
  error.githubError = safeGitHubErrorCode(body);
  return error;
}

export function githubErrorReason(error) {
  const code =
    error && typeof error.githubError === "string"
      ? error.githubError
      : "";
  return /^[a-z0-9_]{1,64}$/.test(code)
    ? code
    : "github_request_failed";
}

export class GitHubAppClient {
  constructor(config, fetchImpl = fetch) {
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.redirectUri = config.redirectUri;
    this.apiVersion = config.apiVersion || "2022-11-28";
    this.fetchImpl = fetchImpl;
  }

  authorizeUrl({ state, codeChallenge }) {
    const url = new URL(GITHUB_OAUTH + "/authorize");
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  async tokenRequest(params) {
    const response = await this.fetchImpl(GITHUB_OAUTH + "/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams(params)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.access_token) {
      throw asJsonError(response, body);
    }

    const now = Date.now();
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token || "",
      expiresAt: body.expires_in
        ? now + Number(body.expires_in) * 1000
        : 0,
      refreshExpiresAt: body.refresh_token_expires_in
        ? now + Number(body.refresh_token_expires_in) * 1000
        : 0
    };
  }

  exchangeCode(code, codeVerifier) {
    return this.tokenRequest({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
      redirect_uri: this.redirectUri,
      code_verifier: codeVerifier
    });
  }

  refreshUserToken(refreshToken) {
    return this.tokenRequest({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken
    });
  }

  async api(path, token) {
    const response = await this.fetchImpl(GITHUB_API + path, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer " + token,
        "X-GitHub-Api-Version": this.apiVersion,
        "User-Agent": "OpenWrt-NG-Control-Plane"
      }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw asJsonError(response, body);
    return body;
  }

  getUser(token) {
    return this.api("/user", token);
  }

  async listRepositories(token) {
    const installations = [];
    for (let page = 1; page <= 10; page += 1) {
      const body = await this.api(
        `/user/installations?per_page=100&page=${page}`,
        token
      );
      const items = Array.isArray(body.installations)
        ? body.installations
        : [];
      installations.push(...items);
      if (items.length < 100) break;
    }

    const repos = new Map();
    for (const installation of installations) {
      for (let page = 1; page <= 10; page += 1) {
        const body = await this.api(
          `/user/installations/${installation.id}/repositories?per_page=100&page=${page}`,
          token
        );
        const items = Array.isArray(body.repositories)
          ? body.repositories
          : [];

        for (const repo of items) {
          repos.set(repo.full_name, {
            installationId: installation.id,
            owner: repo.owner?.login || "",
            name: repo.name || "",
            fullName: repo.full_name || "",
            defaultBranch: repo.default_branch || "main",
            private: Boolean(repo.private),
            permissions: {
              contents: installation.permissions?.contents || "none",
              actions: installation.permissions?.actions || "none"
            }
          });
        }

        if (items.length < 100) break;
      }
    }

    return [...repos.values()].sort((a, b) =>
      a.fullName.localeCompare(b.fullName)
    );
  }

  async listProfiles(token, owner, repo) {
    const safeOwner = encodeURIComponent(owner);
    const safeRepo = encodeURIComponent(repo);
    let body;
    try {
      body = await this.api(
        `/repos/${safeOwner}/${safeRepo}/contents/profiles`,
        token
      );
    } catch (error) {
      if (/HTTP 404/.test(String(error.message))) return [];
      throw error;
    }

    if (!Array.isArray(body)) return [];
    return body
      .filter(
        (item) =>
          item?.type === "dir" &&
          /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(item.name || "")
      )
      .map((item) => ({
        id: item.name,
        path: item.path,
        sha: item.sha || ""
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
}
