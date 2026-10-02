const GITHUB_API = "https://api.github.com";
const GITHUB_OAUTH = "https://github.com/login/oauth";

export const PROFILE_FILES = Object.freeze([
  ".config",
  "profile.env",
  "diy-part1.sh",
  "diy-part2.sh",
  "required-packages.txt",
  "watch-sources.txt"
]);

const PROFILE_FILE_MODES = Object.freeze({
  ".config": "100644",
  "profile.env": "100644",
  "diy-part1.sh": "100755",
  "diy-part2.sh": "100755",
  "required-packages.txt": "100644",
  "watch-sources.txt": "100644"
});

const PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_PROFILE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PROFILE_TOTAL_BYTES = 4 * 1024 * 1024;

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

export class ProfileWriteError extends Error {
  constructor(code, status = 400, message = code) {
    super(message);
    this.name = "ProfileWriteError";
    this.code = code;
    this.status = status;
  }
}

export function githubErrorReason(error) {
  const code =
    error && typeof error.githubError === "string"
      ? error.githubError
      : "";
  if (/^[a-z0-9_]{1,64}$/.test(code)) return code;

  const status = Number(error?.httpStatus || 0);
  if (Number.isInteger(status) && status >= 100 && status <= 599) {
    return `github_http_${status}`;
  }
  return "github_request_failed";
}

async function parseOAuthResponse(response) {
  const text = await response.text();
  if (!text) return {};

  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {}

  const params = new URLSearchParams(text);
  if (![...params.keys()].length) return {};
  return Object.fromEntries(params.entries());
}

function encodeSegment(value) {
  return encodeURIComponent(String(value || ""));
}

function decodeBase64Utf8(value) {
  const binary = atob(String(value || "").replace(/\s+/g, ""));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function byteLength(value) {
  return new TextEncoder().encode(String(value)).byteLength;
}

function branchSlug(profileId) {
  const slug = String(profileId)
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return slug || "profile";
}

function shortNonce() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  }
  return String(Date.now()).slice(-8);
}

function refPath(branchName) {
  return ["heads", ...String(branchName).split("/")]
    .map(encodeSegment)
    .join("/");
}

export class GitHubAppClient {
  constructor(config, fetchImpl = fetch) {
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.redirectUri = config.redirectUri;
    this.apiVersion = config.apiVersion || "2022-11-28";
    this.fetchImpl = (...args) => fetchImpl(...args);
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
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "OpenWrt-NG-Control-Plane"
      },
      body: new URLSearchParams(params)
    });
    const body = await parseOAuthResponse(response);
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

  async api(path, token, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer " + token,
      "X-GitHub-Api-Version": this.apiVersion,
      "User-Agent": "OpenWrt-NG-Control-Plane"
    };
    const init = { method, headers };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }

    const response = await this.fetchImpl(GITHUB_API + path, init);
    if (response.status === 204) {
      if (!response.ok) throw asJsonError(response, {});
      return null;
    }

    const text = await response.text();
    let body = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { message: response.statusText || "Non-JSON GitHub response" };
      }
    }
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
            owner: repo.owner?.login || "",
            name: repo.name || "",
            fullName: repo.full_name || "",
            defaultBranch: repo.default_branch || "main",
            private: Boolean(repo.private),
            permissions: {
              contents: installation.permissions?.contents || "none",
              pullRequests:
                installation.permissions?.pull_requests || "none"
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
    const safeOwner = encodeSegment(owner);
    const safeRepo = encodeSegment(repo);
    let body;
    try {
      body = await this.api(
        `/repos/${safeOwner}/${safeRepo}/contents/profiles`,
        token
      );
    } catch (error) {
      if (error?.httpStatus === 404) return [];
      throw error;
    }

    if (!Array.isArray(body)) return [];
    return body
      .filter(
        (item) =>
          item?.type === "dir" &&
          PROFILE_ID_RE.test(item.name || "")
      )
      .map((item) => ({
        id: item.name,
        path: item.path,
        sha: item.sha || ""
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async repositoryState(token, owner, repo) {
    const safeOwner = encodeSegment(owner);
    const safeRepo = encodeSegment(repo);
    const metadata = await this.api(
      `/repos/${safeOwner}/${safeRepo}`,
      token
    );
    const defaultBranch = metadata.default_branch || "main";
    const head = await this.api(
      `/repos/${safeOwner}/${safeRepo}/commits/${encodeSegment(defaultBranch)}`,
      token
    );
    if (!head?.sha) {
      throw new ProfileWriteError("repository_head_unavailable", 502);
    }
    return {
      defaultBranch,
      baseRefSha: head.sha
    };
  }

  async getProfile(token, owner, repo, profileId) {
    if (!PROFILE_ID_RE.test(String(profileId || ""))) {
      throw new ProfileWriteError("invalid_profile_id", 400);
    }

    const safeOwner = encodeSegment(owner);
    const safeRepo = encodeSegment(repo);
    const safeProfile = encodeSegment(profileId);
    const state = await this.repositoryState(token, owner, repo);
    const basePath =
      `/repos/${safeOwner}/${safeRepo}/contents/profiles/${safeProfile}`;
    const ref = `?ref=${encodeSegment(state.defaultBranch)}`;

    let directory;
    try {
      directory = await this.api(basePath + ref, token);
    } catch (error) {
      if (error?.httpStatus === 404) {
        throw new ProfileWriteError("profile_not_found", 404);
      }
      throw error;
    }
    if (!Array.isArray(directory)) {
      throw new ProfileWriteError("profile_not_found", 404);
    }

    const present = new Map(
      directory
        .filter((item) => item?.type === "file")
        .map((item) => [item.name, item])
    );

    const files = {};
    for (const name of PROFILE_FILES) {
      const listed = present.get(name);
      if (!listed) {
        files[name] = {
          path: `profiles/${profileId}/${name}`,
          sha: "",
          exists: false,
          content: ""
        };
        continue;
      }

      const body = await this.api(
        `${basePath}/${encodeSegment(name)}${ref}`,
        token
      );
      if (body?.encoding !== "base64" || typeof body.content !== "string") {
        throw new ProfileWriteError("unsupported_profile_file", 502);
      }
      files[name] = {
        path: body.path || `profiles/${profileId}/${name}`,
        sha: body.sha || "",
        exists: true,
        content: decodeBase64Utf8(body.content)
      };
    }

    return {
      owner,
      repo,
      defaultBranch: state.defaultBranch,
      baseRefSha: state.baseRefSha,
      profile: {
        id: profileId,
        path: `profiles/${profileId}`,
        files
      }
    };
  }

  async createProfilePullRequest(
    token,
    owner,
    repo,
    profileId,
    payload = {}
  ) {
    if (!PROFILE_ID_RE.test(String(profileId || ""))) {
      throw new ProfileWriteError("invalid_profile_id", 400);
    }

    const baseRefSha = String(payload.baseRefSha || "").trim();
    const submitted = payload.files;
    if (!/^[0-9a-f]{40}$/i.test(baseRefSha)) {
      throw new ProfileWriteError("invalid_base_ref", 400);
    }
    if (!submitted || typeof submitted !== "object" || Array.isArray(submitted)) {
      throw new ProfileWriteError("invalid_profile_files", 400);
    }

    const submittedKeys = Object.keys(submitted);
    if (
      submittedKeys.some((name) => !PROFILE_FILES.includes(name)) ||
      PROFILE_FILES.some((name) => typeof submitted[name] !== "string")
    ) {
      throw new ProfileWriteError("invalid_profile_files", 400);
    }

    let totalBytes = 0;
    for (const name of PROFILE_FILES) {
      const size = byteLength(submitted[name]);
      if (size > MAX_PROFILE_FILE_BYTES) {
        throw new ProfileWriteError("profile_file_too_large", 413);
      }
      totalBytes += size;
    }
    if (totalBytes > MAX_PROFILE_TOTAL_BYTES) {
      throw new ProfileWriteError("profile_payload_too_large", 413);
    }

    const current = await this.getProfile(token, owner, repo, profileId);
    if (current.baseRefSha !== baseRefSha) {
      throw new ProfileWriteError("repository_changed", 409);
    }

    const changedFiles = PROFILE_FILES.filter((name) => {
      const before = current.profile.files[name];
      const after = submitted[name];
      return before.content !== after && (before.exists || after !== "");
    });
    if (!changedFiles.length) {
      throw new ProfileWriteError("no_changes", 400);
    }

    const safeOwner = encodeSegment(owner);
    const safeRepo = encodeSegment(repo);
    const baseCommit = await this.api(
      `/repos/${safeOwner}/${safeRepo}/git/commits/${baseRefSha}`,
      token
    );
    if (!baseCommit?.tree?.sha) {
      throw new ProfileWriteError("repository_tree_unavailable", 502);
    }

    const treeEntries = [];
    for (const name of changedFiles) {
      const blob = await this.api(
        `/repos/${safeOwner}/${safeRepo}/git/blobs`,
        token,
        {
          method: "POST",
          body: {
            content: submitted[name],
            encoding: "utf-8"
          }
        }
      );
      treeEntries.push({
        path: `profiles/${profileId}/${name}`,
        mode: PROFILE_FILE_MODES[name],
        type: "blob",
        sha: blob.sha
      });
    }

    const tree = await this.api(
      `/repos/${safeOwner}/${safeRepo}/git/trees`,
      token,
      {
        method: "POST",
        body: {
          base_tree: baseCommit.tree.sha,
          tree: treeEntries
        }
      }
    );

    const commit = await this.api(
      `/repos/${safeOwner}/${safeRepo}/git/commits`,
      token,
      {
        method: "POST",
        body: {
          message: `profile(${profileId}): update via Control Plane`,
          tree: tree.sha,
          parents: [baseRefSha]
        }
      }
    );

    const branchName =
      `openwrt-ng/profile-${branchSlug(profileId)}-${Date.now()}-${shortNonce()}`;
    await this.api(
      `/repos/${safeOwner}/${safeRepo}/git/refs`,
      token,
      {
        method: "POST",
        body: {
          ref: `refs/heads/${branchName}`,
          sha: commit.sha
        }
      }
    );

    try {
      const pull = await this.api(
        `/repos/${safeOwner}/${safeRepo}/pulls`,
        token,
        {
          method: "POST",
          body: {
            title: `profile(${profileId}): update via Control Plane`,
            head: branchName,
            base: current.defaultBranch,
            body:
              "由 OpenWrt NG Control Plane 创建。\n\n" +
              "变更文件：\n" +
              changedFiles.map((name) => `- \`profiles/${profileId}/${name}\``).join("\n") +
              "\n\n默认分支不会被直接修改，请在 GitHub 中审核差异后再决定是否合并。"
          }
        }
      );

      return {
        branch: branchName,
        commitSha: commit.sha,
        changedFiles,
        pullRequest: {
          number: pull.number,
          url: pull.html_url || ""
        }
      };
    } catch (error) {
      try {
        await this.api(
          `/repos/${safeOwner}/${safeRepo}/git/refs/${refPath(branchName)}`,
          token,
          { method: "DELETE" }
        );
      } catch (cleanupError) {
        console.error("Failed to clean up branch after PR creation error", cleanupError);
      }
      throw error;
    }
  }
}
