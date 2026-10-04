import { strFromU8, unzipSync } from "fflate";

const GITHUB_API = "https://api.github.com";
const GITHUB_OAUTH = "https://github.com/login/oauth";

export const PROFILE_FILES = Object.freeze([
  ".config",
  "profile.env",
  "diy-part1.sh",
  "diy-part2.sh",
  "required-packages.txt",
  "watch-sources.txt",
  "feeds.conf"
]);

export const REQUIRED_PROFILE_FILES = Object.freeze([
  ".config",
  "profile.env"
]);

export const PROFILE_MERGE_POLICIES = Object.freeze([
  "immediate",
  "after-checks",
  "manual"
]);

export function normalizeProfileMergePolicy(value = "immediate") {
  const policy = String(value || "immediate").trim().toLowerCase();
  if (!PROFILE_MERGE_POLICIES.includes(policy)) {
    throw new Error(
      "PROFILE_MERGE_POLICY must be immediate, after-checks or manual"
    );
  }
  return policy;
}

const PROFILE_FILE_MODES = Object.freeze({
  ".config": "100644",
  "profile.env": "100644",
  "diy-part1.sh": "100755",
  "diy-part2.sh": "100755",
  "required-packages.txt": "100644",
  "watch-sources.txt": "100644",
  "feeds.conf": "100644"
});

const PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BUILDER_WORKFLOW = "build-openwrt.yml";
const RELEASE_EXISTING_WORKFLOW = "release-existing.yml";
const UPDATE_CHECKER_WORKFLOW = "update-checker.yml";
const CONFIG_STUDIO_WORKFLOW = "config-studio.yml";
const CONFIG_STUDIO_ID_RE = /^[0-9a-f]{16}$/;
const CONFIG_STUDIO_BRANCH_PREFIX = "openwrt-ng/config-session-";
const ACTIVE_BUILD_STATUSES = new Set([
  "queued",
  "in_progress",
  "requested",
  "waiting",
  "pending"
]);
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

export class BuildControlError extends Error {
  constructor(code, status = 400, message = code) {
    super(message);
    this.name = "BuildControlError";
    this.code = code;
    this.status = status;
  }
}

export class ConfigStudioError extends Error {
  constructor(code, status = 400, message = code) {
    super(message);
    this.name = "ConfigStudioError";
    this.code = code;
    this.status = status;
  }
}

function configStudioRunMode(run) {
  const title = String(run?.display_title || run?.name || "");
  return title.includes("Config · resolve ·") ? "resolve" : "catalog";
}

const CONFIG_STUDIO_PROGRESS_LABELS = Object.freeze({
  "校验会话并读取请求": "读取配置请求",
  "安装配置解析依赖": "安装配置工具",
  "加载 Profile 上下文": "加载 Profile",
  "运行 Profile Preflight": "运行 Profile 预检",
  "准备 OpenWrt 源码": "拉取并准备 OpenWrt 源码",
  "应用源码预处理与额外 Feeds": "应用源码预处理与额外 Feeds",
  "更新 Feeds": "更新 Feeds",
  "安装 Feeds": "安装 Feeds",
  "由 Kconfig 生成最终配置": "运行 Kconfig / make defconfig",
  "生成可视化菜单数据": "生成图形菜单数据",
  "上传受控配置结果": "上传配置结果"
});

const SUCCESSFUL_ACTION_CONCLUSIONS = new Set([
  "success",
  "skipped",
  "neutral"
]);

function summarizeActionSteps(steps, currentDetail = "") {
  const safeSteps = Array.isArray(steps) ? steps : [];
  if (!safeSteps.length) return null;

  const completed = safeSteps.filter(
    (step) => step.status === "completed"
  ).length;
  const currentIndex = safeSteps.findIndex(
    (step) => step.status !== "completed"
  );
  const current =
    currentIndex >= 0 ? safeSteps[currentIndex] : safeSteps[safeSteps.length - 1];
  const failed = safeSteps.find(
    (step) =>
      step.status === "completed" &&
      step.conclusion &&
      !SUCCESSFUL_ACTION_CONCLUSIONS.has(step.conclusion)
  );
  const percent = failed
    ? Math.floor((Math.max(0, completed - 1) / safeSteps.length) * 100)
    : Math.floor((completed / safeSteps.length) * 100);

  return {
    completed,
    total: safeSteps.length,
    percent: Math.max(0, Math.min(100, percent)),
    current: failed?.name || current?.name || "",
    currentDetail: failed?.detail || currentDetail || current?.detail || "",
    failed: failed?.name || "",
    steps: safeSteps
  };
}

export function configStudioProgressFromJobs(jobs) {
  const safeJobs = Array.isArray(jobs) ? jobs : [];
  const job =
    safeJobs.find((item) => item?.name === "解析 OpenWrt 配置") ||
    safeJobs[0];
  const rawSteps = Array.isArray(job?.steps) ? job.steps : [];
  const steps = rawSteps
    .filter((step) => CONFIG_STUDIO_PROGRESS_LABELS[step?.name])
    .map((step) => ({
      name: CONFIG_STUDIO_PROGRESS_LABELS[step.name],
      detail: String(step.name || ""),
      status: String(step.status || "pending"),
      conclusion: String(step.conclusion || "")
    }));
  const rawCurrent =
    rawSteps.find((step) => step?.status === "in_progress") ||
    rawSteps.find(
      (step) =>
        step?.status === "completed" &&
        step?.conclusion &&
        !SUCCESSFUL_ACTION_CONCLUSIONS.has(String(step.conclusion))
    );
  return summarizeActionSteps(steps, String(rawCurrent?.name || ""));
}

const BUILDER_PROGRESS_STAGES = Object.freeze([
  ["构建前快速预检", "静态预检", "预检 Profile"],
  ["编译 OpenWrt 固件", "准备 OpenWrt 源码", "准备 OpenWrt 源码"],
  ["编译 OpenWrt 固件", "更新 Feeds", "更新 Feeds"],
  ["编译 OpenWrt 固件", "安装 Feeds", "安装 Feeds"],
  ["编译 OpenWrt 固件", "恢复编译缓存", "恢复编译缓存"],
  ["编译 OpenWrt 固件", "下载软件包源码", "下载软件包源码"],
  ["编译 OpenWrt 固件", "编译固件", "编译固件"],
  ["编译 OpenWrt 固件", "校验固件 Manifest", "校验固件"],
  ["编译 OpenWrt 固件", "上传固件目录", "上传固件产物"],
  ["发布 OpenWrt 固件", "发布固件到 Release", "发布 Release"],
  ["清理旧 Workflow 运行记录", "清理 Workflow 历史", "清理运行记录"]
]);

export function builderProgressFromJobs(jobs) {
  const safeJobs = Array.isArray(jobs) ? jobs : [];
  const jobMap = new Map(
    safeJobs.map((job) => [String(job?.name || ""), job])
  );
  const steps = BUILDER_PROGRESS_STAGES.map(
    ([jobName, stepName, label]) => {
      const job = jobMap.get(jobName);
      const rawSteps = Array.isArray(job?.steps) ? job.steps : [];
      const step = rawSteps.find((item) => item?.name === stepName);
      if (step) {
        return {
          name: label,
          detail: String(step.name || ""),
          status: String(step.status || "pending"),
          conclusion: String(step.conclusion || "")
        };
      }
      if (job?.status === "completed" && job?.conclusion === "skipped") {
        return {
          name: label,
          detail: stepName,
          status: "completed",
          conclusion: "skipped"
        };
      }
      return {
        name: label,
        detail: stepName,
        status: "pending",
        conclusion: ""
      };
    }
  );

  const rawCurrent = safeJobs
    .flatMap((job) => (Array.isArray(job?.steps) ? job.steps : []))
    .find((step) => step?.status === "in_progress");
  const rawFailed = safeJobs
    .flatMap((job) => (Array.isArray(job?.steps) ? job.steps : []))
    .find(
      (step) =>
        step?.status === "completed" &&
        step?.conclusion &&
        !SUCCESSFUL_ACTION_CONCLUSIONS.has(String(step.conclusion))
    );
  const summary = summarizeActionSteps(
    steps,
    String(rawFailed?.name || rawCurrent?.name || "")
  );
  if (!summary) return null;
  if (rawFailed) {
    summary.failed = String(rawFailed.name || summary.failed || "构建步骤");
    summary.current = summary.failed;
    summary.currentDetail = summary.failed;
  }
  return summary;
}

export function selectConfigStudioRun(
  runs,
  requestId,
  expectedMode = "catalog",
  afterRunId = 0
) {
  const safeRuns = Array.isArray(runs) ? runs : [];
  const threshold = Number(afterRunId || 0);
  return safeRuns.find((item) => {
    const title = String(item?.display_title || item?.name || "");
    return (
      title.includes(`cs:${requestId}`) &&
      configStudioRunMode(item) === expectedMode &&
      Number(item?.id || 0) > threshold
    );
  });
}

function managedWorkflowProgressFromJobs(jobs) {
  const safeJobs = Array.isArray(jobs) ? jobs : [];
  const ignored = /^(Set up job|Complete job|Post |检出仓库$)/;
  const steps = [];

  for (const job of safeJobs) {
    const rawSteps = Array.isArray(job?.steps) ? job.steps : [];
    const visible = rawSteps.filter(
      (step) => step?.name && !ignored.test(String(step.name))
    );
    if (visible.length) {
      for (const step of visible) {
        steps.push({
          name: String(step.name || ""),
          detail: String(job?.name || ""),
          status: String(step.status || "pending"),
          conclusion: String(step.conclusion || "")
        });
      }
      continue;
    }
    steps.push({
      name: String(job?.name || "Workflow"),
      detail: String(job?.name || ""),
      status: String(job?.status || "pending"),
      conclusion: String(job?.conclusion || "")
    });
  }

  return summarizeActionSteps(steps);
}

function basicWorkflowRun(run, jobs = []) {
  return {
    id: Number(run?.id || 0),
    runNumber: Number(run?.run_number || 0),
    runAttempt: Number(run?.run_attempt || 1),
    displayTitle: run?.display_title || run?.name || "",
    status: run?.status || "unknown",
    conclusion: run?.conclusion || "",
    event: run?.event || "",
    headBranch: run?.head_branch || "",
    headSha: run?.head_sha || "",
    createdAt: run?.created_at || "",
    updatedAt: run?.updated_at || "",
    runStartedAt: run?.run_started_at || "",
    url: run?.html_url || "",
    progress: managedWorkflowProgressFromJobs(jobs),
    jobs: (Array.isArray(jobs) ? jobs : []).map((job) => ({
      id: Number(job?.id || 0),
      name: job?.name || "",
      status: job?.status || "unknown",
      conclusion: job?.conclusion || "",
      startedAt: job?.started_at || "",
      completedAt: job?.completed_at || "",
      url: job?.html_url || "",
      steps: (Array.isArray(job?.steps) ? job.steps : []).map((step) => ({
        name: step?.name || "",
        status: step?.status || "unknown",
        conclusion: step?.conclusion || ""
      }))
    }))
  };
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

function parseConfigStudioArtifact(zipBytes) {
  let files;
  try {
    files = unzipSync(zipBytes);
  } catch {
    throw new ConfigStudioError("config_studio_artifact_invalid", 502);
  }

  const parseJson = (name, optional = false) => {
    const bytes = files[name];
    if (!bytes) {
      if (optional) return null;
      throw new ConfigStudioError("config_studio_artifact_incomplete", 502);
    }
    try {
      return JSON.parse(strFromU8(bytes));
    } catch {
      throw new ConfigStudioError("config_studio_result_invalid", 502);
    }
  };

  return {
    status: parseJson("status.json"),
    catalog: parseJson("catalog.json"),
    result: parseJson("result.json", true)
  };
}

function profileEnvValue(content, key) {
  const line = String(content || "")
    .split(/\r?\n/)
    .find((item) => item.trim().startsWith(key + "="));
  if (!line) return "";
  let value = line.slice(line.indexOf("=") + 1).trim();
  if (
    value.length >= 2 &&
    ((value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"')))
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

function configStudioBranch(requestId) {
  return CONFIG_STUDIO_BRANCH_PREFIX + requestId;
}


function byteLength(value) {
  return new TextEncoder().encode(String(value)).byteLength;
}

function validateProfileFilesPayload(submitted) {
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
}

function profileActionLabel(action) {
  if (action === "create") return "create";
  if (action === "copy") return "copy";
  if (action === "rename") return "rename";
  if (action === "restore") return "restore";
  if (action === "delete") return "delete";
  if (action === "baseline") return "set-baseline";
  return "update";
}

function rewriteProfileFiles(files, sourceProfileId, targetProfileId) {
  const from = `profiles/${sourceProfileId}/`;
  const to = `profiles/${targetProfileId}/`;
  return Object.fromEntries(
    PROFILE_FILES.map((name) => [
      name,
      String(files[name] || "").split(from).join(to)
    ])
  );
}

function branchSlug(profileId) {
  const slug = String(profileId)
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return slug || "profile";
}

function shortNonce(length = 8) {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, length);
  }
  return (String(Date.now()) + Math.random().toString(16).slice(2))
    .replace(/[^0-9a-f]/gi, "")
    .slice(0, length);
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
    this.profileMergePolicy = normalizeProfileMergePolicy(
      config.profileMergePolicy || "immediate"
    );
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

  async graphql(query, variables, token) {
    const response = await this.fetchImpl(GITHUB_API + "/graphql", {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        "User-Agent": "OpenWrt-NG-Control-Plane"
      },
      body: JSON.stringify({ query, variables })
    });

    const text = await response.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {};
    }
    if (!response.ok) throw asJsonError(response, body);
    if (Array.isArray(body?.errors) && body.errors.length) {
      const error = new Error(
        String(body.errors[0]?.message || "GitHub GraphQL request failed")
      );
      error.name = "GitHubGraphQLError";
      error.githubError = "github_graphql_error";
      throw error;
    }
    return body?.data || {};
  }

  async enableProfileAutoMerge(token, pull, commitSha, profileId, action) {
    const pullRequestId = String(pull?.node_id || "");
    if (!pullRequestId) {
      const error = new Error("Pull Request node_id is unavailable");
      error.githubError = "auto_merge_unavailable";
      throw error;
    }

    const data = await this.graphql(
      `mutation EnableProfileAutoMerge(
        $pullRequestId: ID!,
        $expectedHeadOid: GitObjectID!,
        $mergeMethod: PullRequestMergeMethod!,
        $commitHeadline: String!,
        $commitBody: String!
      ) {
        enablePullRequestAutoMerge(input: {
          pullRequestId: $pullRequestId,
          expectedHeadOid: $expectedHeadOid,
          mergeMethod: $mergeMethod,
          commitHeadline: $commitHeadline,
          commitBody: $commitBody
        }) {
          pullRequest {
            id
            autoMergeRequest {
              enabledAt
              mergeMethod
            }
          }
        }
      }`,
      {
        pullRequestId,
        expectedHeadOid: commitSha,
        mergeMethod: "SQUASH",
        commitHeadline:
          "profile(" +
          profileId +
          "): " +
          profileActionLabel(action) +
          " via Control Plane",
        commitBody:
          "由 OpenWrt NG Control Plane 设置 after-checks 自动合并；GitHub 将在仓库必需检查与审核满足后执行。"
      },
      token
    );

    const request =
      data?.enablePullRequestAutoMerge?.pullRequest?.autoMergeRequest;
    if (!request) {
      const error = new Error("GitHub did not enable auto-merge");
      error.githubError = "auto_merge_unavailable";
      throw error;
    }
    return request;
  }

  async apiBytes(path, token) {
    const response = await this.fetchImpl(GITHUB_API + path, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer " + token,
        "X-GitHub-Api-Version": this.apiVersion,
        "User-Agent": "OpenWrt-NG-Control-Plane"
      },
      redirect: "follow"
    });
    if (!response.ok) {
      let body = {};
      try {
        body = await response.json();
      } catch {}
      throw asJsonError(response, body);
    }
    return new Uint8Array(await response.arrayBuffer());
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
                installation.permissions?.pull_requests || "none",
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

  async resolveBaselineProfileId(
    token,
    owner,
    repo,
    profiles = null,
    state = null
  ) {
    const safeOwner = encodeSegment(owner);
    const safeRepo = encodeSegment(repo);
    const currentState = state || await this.repositoryState(token, owner, repo);
    let items = profiles;

    if (!Array.isArray(items)) {
      let body;
      try {
        body = await this.api(
          `/repos/${safeOwner}/${safeRepo}/contents/profiles?ref=${encodeSegment(currentState.defaultBranch)}`,
          token
        );
      } catch (error) {
        if (error?.httpStatus === 404) return "";
        throw error;
      }
      items = Array.isArray(body)
        ? body
            .filter(
              (item) =>
                item?.type === "dir" &&
                PROFILE_ID_RE.test(item.name || "")
            )
            .map((item) => ({ id: item.name }))
        : [];
    }

    const ids = items
      .map((item) => String(item?.id || ""))
      .filter((id) => PROFILE_ID_RE.test(id))
      .sort((a, b) => a.localeCompare(b));
    if (!ids.length) return "";

    try {
      const marker = await this.api(
        `/repos/${safeOwner}/${safeRepo}/contents/profiles/.baseline?ref=${encodeSegment(currentState.defaultBranch)}`,
        token
      );
      if (marker?.encoding !== "base64" || typeof marker.content !== "string") {
        throw new ProfileWriteError("invalid_baseline_profile", 409);
      }
      const baseline = decodeBase64Utf8(marker.content).trim();
      if (!PROFILE_ID_RE.test(baseline) || !ids.includes(baseline)) {
        throw new ProfileWriteError("invalid_baseline_profile", 409);
      }
      return baseline;
    } catch (error) {
      if (error instanceof ProfileWriteError) throw error;
      if (error?.httpStatus !== 404) throw error;
    }

    if (ids.includes("default")) return "default";
    return ids[0];
  }

  async listProfiles(token, owner, repo) {
    const safeOwner = encodeSegment(owner);
    const safeRepo = encodeSegment(repo);
    const state = await this.repositoryState(token, owner, repo);
    let body;
    try {
      body = await this.api(
        `/repos/${safeOwner}/${safeRepo}/contents/profiles?ref=${encodeSegment(state.defaultBranch)}`,
        token
      );
    } catch (error) {
      if (error?.httpStatus === 404) return [];
      throw error;
    }

    if (!Array.isArray(body)) return [];
    const profiles = body
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

    const baselineProfileId = await this.resolveBaselineProfileId(
      token,
      owner,
      repo,
      profiles,
      state
    );
    return profiles.map((profile) => ({
      ...profile,
      baseline: profile.id === baselineProfileId
    }));
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

    const baselineProfileId = await this.resolveBaselineProfileId(
      token,
      owner,
      repo,
      null,
      state
    );

    return {
      owner,
      repo,
      defaultBranch: state.defaultBranch,
      baseRefSha: state.baseRefSha,
      baselineProfileId,
      profile: {
        id: profileId,
        path: `profiles/${profileId}`,
        baseline: profileId === baselineProfileId,
        files
      }
    };
  }


  async listDeletedProfiles(token, owner, repo, options = {}) {
    const safeOwner = encodeSegment(owner);
    const safeRepo = encodeSegment(repo);
    const limit = Math.min(30, Math.max(1, Number(options.limit) || 10));
    const currentProfiles = await this.listProfiles(token, owner, repo);
    const currentIds = new Set(currentProfiles.map((item) => item.id));
    const commits = await this.api(
      `/repos/${safeOwner}/${safeRepo}/commits?per_page=100`,
      token
    );

    const deleted = [];
    const seen = new Set();
    const pattern = /^profile\(([A-Za-z0-9][A-Za-z0-9._-]{0,63})\): delete via Control Plane(?:\s+\(#\d+\))?/;

    for (const commit of Array.isArray(commits) ? commits : []) {
      const message = String(commit?.commit?.message || "").split("\n", 1)[0];
      const match = message.match(pattern);
      if (!match) continue;
      const profileId = match[1];
      if (currentIds.has(profileId) || seen.has(profileId)) continue;
      const sha = String(commit?.sha || "");
      if (!/^[0-9a-f]{40}$/i.test(sha)) continue;

      seen.add(profileId);
      deleted.push({
        id: profileId,
        deletionCommitSha: sha,
        deletedAt:
          commit?.commit?.committer?.date ||
          commit?.commit?.author?.date ||
          "",
        commitUrl: commit?.html_url || "",
        message
      });
      if (deleted.length >= limit) break;
    }

    return deleted;
  }

  async restoreDeletedProfilePullRequest(
    token,
    owner,
    repo,
    profileId,
    payload = {}
  ) {
    if (!PROFILE_ID_RE.test(String(profileId || ""))) {
      throw new ProfileWriteError("invalid_profile_id", 400);
    }
    const deletionCommitSha = String(payload.deletionCommitSha || "").trim();
    if (!/^[0-9a-f]{40}$/i.test(deletionCommitSha)) {
      throw new ProfileWriteError("invalid_deletion_commit", 400);
    }

    const safeOwner = encodeSegment(owner);
    const safeRepo = encodeSegment(repo);
    const safeProfile = encodeSegment(profileId);
    const state = await this.repositoryState(token, owner, repo);

    try {
      const current = await this.api(
        `/repos/${safeOwner}/${safeRepo}/contents/profiles/${safeProfile}?ref=${encodeSegment(state.baseRefSha)}`,
        token
      );
      if (Array.isArray(current)) {
        throw new ProfileWriteError("profile_already_exists", 409);
      }
    } catch (error) {
      if (error instanceof ProfileWriteError) throw error;
      if (error?.httpStatus !== 404) throw error;
    }

    const deletion = await this.api(
      `/repos/${safeOwner}/${safeRepo}/commits/${encodeSegment(deletionCommitSha)}`,
      token
    );
    const title = String(deletion?.commit?.message || "").split("\n", 1)[0];
    const expected =
      `profile(${profileId}): delete via Control Plane`;
    if (!title.startsWith(expected)) {
      throw new ProfileWriteError("deletion_commit_mismatch", 409);
    }
    const parentSha = String(deletion?.parents?.[0]?.sha || "");
    if (!/^[0-9a-f]{40}$/i.test(parentSha)) {
      throw new ProfileWriteError("deleted_profile_snapshot_unavailable", 410);
    }

    const files = Object.fromEntries(
      PROFILE_FILES.map((name) => [name, ""])
    );
    const restoredFiles = [];
    for (const name of PROFILE_FILES) {
      let body;
      try {
        body = await this.api(
          `/repos/${safeOwner}/${safeRepo}/contents/profiles/${safeProfile}/${encodeSegment(name)}?ref=${encodeSegment(parentSha)}`,
          token
        );
      } catch (error) {
        if (error?.httpStatus === 404) {
          if (REQUIRED_PROFILE_FILES.includes(name)) {
            throw new ProfileWriteError(
              "deleted_profile_snapshot_incomplete",
              410
            );
          }
          continue;
        }
        throw error;
      }
      if (body?.encoding !== "base64" || typeof body.content !== "string") {
        throw new ProfileWriteError("unsupported_profile_file", 502);
      }
      files[name] = decodeBase64Utf8(body.content);
      restoredFiles.push(name);
    }
    validateProfileFilesPayload(files);

    const latest = await this.repositoryState(token, owner, repo);
    if (latest.baseRefSha !== state.baseRefSha) {
      throw new ProfileWriteError("repository_changed", 409);
    }

    return this.createProfileFilesPullRequest(
      token,
      owner,
      repo,
      {
        profileId,
        state: latest,
        files,
        changedFiles: restoredFiles,
        action: "restore"
      }
    );
  }


  async listBuilderRuns(token, owner, repo, options = {}) {
    const safeOwner = encodeSegment(owner);
    const safeRepo = encodeSegment(repo);
    const profileId = String(options.profileId || "").trim();
    const requestId = String(options.requestId || "").trim();
    const limit = Math.min(100, Math.max(1, Number(options.limit) || 10));

    if (profileId && !PROFILE_ID_RE.test(profileId)) {
      throw new BuildControlError("invalid_profile_id", 400);
    }
    if (requestId && !/^[0-9a-f]{8,32}$/i.test(requestId)) {
      throw new BuildControlError("invalid_build_request_id", 400);
    }

    const body = await this.api(
      `/repos/${safeOwner}/${safeRepo}/actions/workflows/${BUILDER_WORKFLOW}/runs?per_page=100`,
      token
    );
    const runs = Array.isArray(body.workflow_runs) ? body.workflow_runs : [];

    return runs
      .filter((run) => {
        const title = String(run.display_title || run.name || "");
        if (profileId) {
          const prefix = `Build · ${profileId}`;
          if (title !== prefix && !title.startsWith(prefix + " · ")) {
            return false;
          }
        }
        if (requestId && !title.includes(`cp:${requestId}`)) return false;
        return true;
      })
      .slice(0, limit)
      .map((run) => ({
        id: Number(run.id),
        runNumber: Number(run.run_number || 0),
        displayTitle: run.display_title || run.name || "",
        status: run.status || "unknown",
        conclusion: run.conclusion || "",
        event: run.event || "",
        headBranch: run.head_branch || "",
        headSha: run.head_sha || "",
        createdAt: run.created_at || "",
        updatedAt: run.updated_at || "",
        url: run.html_url || ""
      }));
  }

  async triggerBuilder(token, owner, repo, profileId, payload = {}) {
    if (!PROFILE_ID_RE.test(String(profileId || ""))) {
      throw new BuildControlError("invalid_profile_id", 400);
    }
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      Object.keys(payload).some((key) => key !== "publishRelease")
    ) {
      throw new BuildControlError("invalid_build_request", 400);
    }
    if (typeof payload.publishRelease !== "boolean") {
      throw new BuildControlError("invalid_publish_release", 400);
    }

    const state = await this.repositoryState(token, owner, repo);
    const safeOwner = encodeSegment(owner);
    const safeRepo = encodeSegment(repo);
    const safeProfile = encodeSegment(profileId);

    try {
      const profile = await this.api(
        `/repos/${safeOwner}/${safeRepo}/contents/profiles/${safeProfile}?ref=${encodeSegment(state.defaultBranch)}`,
        token
      );
      if (!Array.isArray(profile)) {
        throw new BuildControlError("profile_not_found", 404);
      }
    } catch (error) {
      if (error instanceof BuildControlError) throw error;
      if (error?.httpStatus === 404) {
        throw new BuildControlError("profile_not_found", 404);
      }
      throw error;
    }

    const recent = await this.listBuilderRuns(token, owner, repo, {
      profileId,
      limit: 20
    });
    const active = recent.find((run) => ACTIVE_BUILD_STATUSES.has(run.status));
    if (active) {
      const error = new BuildControlError("build_already_active", 409);
      error.activeRun = active;
      throw error;
    }

    const requestId = shortNonce(16);
    const dispatched = await this.api(
      `/repos/${safeOwner}/${safeRepo}/actions/workflows/${BUILDER_WORKFLOW}/dispatches`,
      token,
      {
        method: "POST",
        body: {
          ref: state.defaultBranch,
          return_run_details: true,
          inputs: {
            profile: profileId,
            publish_release: payload.publishRelease === true,
            control_plane_request_id: requestId
          }
        }
      }
    );

    return {
      accepted: true,
      requestId,
      profileId,
      publishRelease: payload.publishRelease === true,
      ref: state.defaultBranch,
      runId: Number(dispatched?.workflow_run_id || 0),
      runUrl: dispatched?.html_url || ""
    };
  }

  async getBuilderRun(token, owner, repo, runId) {
    const numericRunId = Number(runId);
    if (!Number.isSafeInteger(numericRunId) || numericRunId <= 0) {
      throw new BuildControlError("invalid_run_id", 400);
    }

    const safeOwner = encodeSegment(owner);
    const safeRepo = encodeSegment(repo);
    const run = await this.api(
      `/repos/${safeOwner}/${safeRepo}/actions/runs/${numericRunId}`,
      token
    );
    const workflowPath = String(run.path || "").split("@", 1)[0];
    if (workflowPath !== ".github/workflows/" + BUILDER_WORKFLOW) {
      throw new BuildControlError("not_builder_run", 404);
    }

    const [jobsBody, artifactsBody, releases] = await Promise.all([
      this.api(
        `/repos/${safeOwner}/${safeRepo}/actions/runs/${numericRunId}/jobs?per_page=100`,
        token
      ),
      this.api(
        `/repos/${safeOwner}/${safeRepo}/actions/runs/${numericRunId}/artifacts?per_page=100`,
        token
      ),
      run.status === "completed"
        ? this.api(
            `/repos/${safeOwner}/${safeRepo}/releases?per_page=100`,
            token
          )
        : Promise.resolve([])
    ]);

    const jobs = Array.isArray(jobsBody.jobs) ? jobsBody.jobs : [];
    const artifacts = Array.isArray(artifactsBody.artifacts)
      ? artifactsBody.artifacts
      : [];
    const release = Array.isArray(releases)
      ? (
          releases.find(
            (item) =>
              String(item.target_commitish || "") === String(run.head_sha || "") &&
              String(item.tag_name || "").endsWith(`-${run.run_number}`)
          ) ||
          releases.find((item) => {
            const body = String(item?.body || "");
            const marker = `- 原 Run ID: ${numericRunId}`;
            return body.includes(marker);
          })
        )
      : null;
    const releaseBundle = artifacts.find(
      (artifact) =>
        String(artifact?.name || "") ===
        `OpenWrt_NG_release_bundle_${numericRunId}`
    );
    const buildJob = jobs.find(
      (job) => String(job?.name || "") === "编译 OpenWrt 固件"
    );
    const buildSucceeded =
      String(buildJob?.conclusion || "") === "success";
    const releaseRecoveryEligible =
      run.status === "completed" &&
      buildSucceeded &&
      !release &&
      Boolean(releaseBundle) &&
      !Boolean(releaseBundle?.expired);
    let releaseRecoveryReason = "";
    if (run.status !== "completed" || !buildSucceeded) {
      releaseRecoveryReason = "build_not_successful";
    } else if (release) {
      releaseRecoveryReason = "release_already_exists";
    } else if (!releaseBundle) {
      releaseRecoveryReason = "release_bundle_missing";
    } else if (releaseBundle.expired) {
      releaseRecoveryReason = "release_bundle_expired";
    }

    return {
      id: numericRunId,
      runNumber: Number(run.run_number || 0),
      runAttempt: Number(run.run_attempt || 1),
      displayTitle: run.display_title || run.name || "",
      status: run.status || "unknown",
      conclusion: run.conclusion || "",
      event: run.event || "",
      headBranch: run.head_branch || "",
      headSha: run.head_sha || "",
      createdAt: run.created_at || "",
      updatedAt: run.updated_at || "",
      runStartedAt: run.run_started_at || "",
      url: run.html_url || "",
      summaryUrl: run.html_url || "",
      progress: builderProgressFromJobs(jobs),
      jobs: jobs.map((job) => ({
        id: Number(job.id),
        name: job.name || "",
        status: job.status || "unknown",
        conclusion: job.conclusion || "",
        startedAt: job.started_at || "",
        completedAt: job.completed_at || "",
        url: job.html_url || "",
        steps: (Array.isArray(job.steps) ? job.steps : []).map((step) => ({
          name: step.name || "",
          status: step.status || "unknown",
          conclusion: step.conclusion || ""
        }))
      })),
      artifacts: artifacts.map((artifact) => ({
        id: Number(artifact.id),
        name: artifact.name || "",
        sizeBytes: Number(artifact.size_in_bytes || 0),
        expired: Boolean(artifact.expired),
        createdAt: artifact.created_at || "",
        expiresAt: artifact.expires_at || "",
        url:
          `https://github.com/${owner}/${repo}/actions/runs/${numericRunId}/artifacts/${artifact.id}`
      })),
      release: release
        ? {
            tag: release.tag_name || "",
            name: release.name || release.tag_name || "",
            url: release.html_url || "",
            publishedAt: release.published_at || "",
            recovered: String(release.body || "").includes(
              `- 原 Run ID: ${numericRunId}`
            )
          }
        : null,
      releaseRecoveryEligible,
      releaseRecoveryReason
    };
  }

  async cancelBuilderRun(token, owner, repo, runId) {
    const numericRunId = Number(runId);
    if (!Number.isSafeInteger(numericRunId) || numericRunId <= 0) {
      throw new BuildControlError("invalid_run_id", 400);
    }

    const safeOwner = encodeSegment(owner);
    const safeRepo = encodeSegment(repo);
    const run = await this.api(
      `/repos/${safeOwner}/${safeRepo}/actions/runs/${numericRunId}`,
      token
    );
    const workflowPath = String(run.path || "").split("@", 1)[0];
    if (workflowPath !== ".github/workflows/" + BUILDER_WORKFLOW) {
      throw new BuildControlError("not_builder_run", 404);
    }
    if (!ACTIVE_BUILD_STATUSES.has(String(run.status || ""))) {
      throw new BuildControlError("build_not_active", 409);
    }

    try {
      await this.api(
        `/repos/${safeOwner}/${safeRepo}/actions/runs/${numericRunId}/cancel`,
        token,
        { method: "POST" }
      );
    } catch (error) {
      if (error?.httpStatus !== 409) throw error;
    }

    return {
      accepted: true,
      action: "cancel",
      runId: numericRunId,
      runNumber: Number(run.run_number || 0),
      url: run.html_url || ""
    };
  }

  async rerunBuilderRun(token, owner, repo, runId) {
    const numericRunId = Number(runId);
    if (!Number.isSafeInteger(numericRunId) || numericRunId <= 0) {
      throw new BuildControlError("invalid_run_id", 400);
    }

    const safeOwner = encodeSegment(owner);
    const safeRepo = encodeSegment(repo);
    const run = await this.api(
      `/repos/${safeOwner}/${safeRepo}/actions/runs/${numericRunId}`,
      token
    );
    const workflowPath = String(run.path || "").split("@", 1)[0];
    if (workflowPath !== ".github/workflows/" + BUILDER_WORKFLOW) {
      throw new BuildControlError("not_builder_run", 404);
    }
    if (String(run.status || "") !== "completed") {
      throw new BuildControlError("build_not_completed", 409);
    }

    await this.api(
      `/repos/${safeOwner}/${safeRepo}/actions/runs/${numericRunId}/rerun`,
      token,
      { method: "POST" }
    );

    return {
      accepted: true,
      action: "rerun",
      runId: numericRunId,
      runNumber: Number(run.run_number || 0),
      nextAttempt: Number(run.run_attempt || 1) + 1,
      url: run.html_url || ""
    };
  }

  async getManagedWorkflowRun(
    token,
    owner,
    repo,
    runId,
    workflowFile
  ) {
    const numericRunId = Number(runId);
    if (!Number.isSafeInteger(numericRunId) || numericRunId <= 0) {
      throw new BuildControlError("invalid_run_id", 400);
    }
    const safeOwner = encodeSegment(owner);
    const safeRepo = encodeSegment(repo);
    const run = await this.api(
      `/repos/${safeOwner}/${safeRepo}/actions/runs/${numericRunId}`,
      token
    );
    const workflowPath = String(run.path || "").split("@", 1)[0];
    if (workflowPath !== ".github/workflows/" + workflowFile) {
      throw new BuildControlError("unexpected_workflow_run", 404);
    }
    const jobsBody = await this.api(
      `/repos/${safeOwner}/${safeRepo}/actions/runs/${numericRunId}/jobs?per_page=100`,
      token
    );
    const jobs = Array.isArray(jobsBody?.jobs) ? jobsBody.jobs : [];
    return basicWorkflowRun(run, jobs);
  }

  async triggerReleaseExisting(token, owner, repo, sourceRunId) {
    const numericSourceRunId = Number(sourceRunId);
    if (!Number.isSafeInteger(numericSourceRunId) || numericSourceRunId <= 0) {
      throw new BuildControlError("invalid_run_id", 400);
    }
    const source = await this.getBuilderRun(
      token,
      owner,
      repo,
      numericSourceRunId
    );
    if (!source.releaseRecoveryEligible) {
      throw new BuildControlError(
        source.releaseRecoveryReason || "release_existing_unavailable",
        409
      );
    }

    const safeOwner = encodeSegment(owner);
    const safeRepo = encodeSegment(repo);
    const activeBody = await this.api(
      `/repos/${safeOwner}/${safeRepo}/actions/workflows/${RELEASE_EXISTING_WORKFLOW}/runs?event=workflow_dispatch&per_page=50`,
      token
    );
    const active = (Array.isArray(activeBody?.workflow_runs)
      ? activeBody.workflow_runs
      : []
    ).find((run) => {
      const title = String(run?.display_title || run?.name || "");
      return (
        title.includes(`source:${numericSourceRunId}`) &&
        ACTIVE_BUILD_STATUSES.has(String(run?.status || ""))
      );
    });
    if (active) {
      const error = new BuildControlError("release_existing_already_active", 409);
      error.activeRun = {
        id: Number(active.id || 0),
        runNumber: Number(active.run_number || 0),
        status: active.status || "unknown",
        url: active.html_url || ""
      };
      throw error;
    }

    const state = await this.repositoryState(token, owner, repo);
    const dispatched = await this.api(
      `/repos/${safeOwner}/${safeRepo}/actions/workflows/${RELEASE_EXISTING_WORKFLOW}/dispatches`,
      token,
      {
        method: "POST",
        body: {
          ref: state.defaultBranch,
          return_run_details: true,
          inputs: { run_id: String(numericSourceRunId) }
        }
      }
    );
    return {
      accepted: true,
      sourceRunId: numericSourceRunId,
      ref: state.defaultBranch,
      runId: Number(dispatched?.workflow_run_id || 0),
      runUrl: dispatched?.html_url || ""
    };
  }

  async getReleaseExistingRun(token, owner, repo, runId) {
    return this.getManagedWorkflowRun(
      token,
      owner,
      repo,
      runId,
      RELEASE_EXISTING_WORKFLOW
    );
  }

  async triggerUpdateChecker(token, owner, repo, payload = {}) {
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      Object.keys(payload).some(
        (key) => !["profileId", "force"].includes(key)
      )
    ) {
      throw new BuildControlError("invalid_update_check_request", 400);
    }
    const profileId = String(payload.profileId || "").trim();
    const force = payload.force === true;
    if (profileId && !PROFILE_ID_RE.test(profileId)) {
      throw new BuildControlError("invalid_profile_id", 400);
    }
    if (payload.force !== undefined && typeof payload.force !== "boolean") {
      throw new BuildControlError("invalid_update_check_force", 400);
    }
    if (profileId) {
      try {
        await this.getProfile(token, owner, repo, profileId);
      } catch (error) {
        if (error instanceof ProfileWriteError) {
          throw new BuildControlError(error.code, error.status);
        }
        throw error;
      }
    }

    const safeOwner = encodeSegment(owner);
    const safeRepo = encodeSegment(repo);
    const runsBody = await this.api(
      `/repos/${safeOwner}/${safeRepo}/actions/workflows/${UPDATE_CHECKER_WORKFLOW}/runs?per_page=20`,
      token
    );
    const active = (Array.isArray(runsBody?.workflow_runs)
      ? runsBody.workflow_runs
      : []
    ).find((run) => ACTIVE_BUILD_STATUSES.has(String(run?.status || "")));
    if (active) {
      const error = new BuildControlError("update_check_already_active", 409);
      error.activeRun = {
        id: Number(active.id || 0),
        runNumber: Number(active.run_number || 0),
        status: active.status || "unknown",
        url: active.html_url || ""
      };
      throw error;
    }

    const state = await this.repositoryState(token, owner, repo);
    const dispatched = await this.api(
      `/repos/${safeOwner}/${safeRepo}/actions/workflows/${UPDATE_CHECKER_WORKFLOW}/dispatches`,
      token,
      {
        method: "POST",
        body: {
          ref: state.defaultBranch,
          return_run_details: true,
          inputs: {
            profile: profileId,
            force
          }
        }
      }
    );
    return {
      accepted: true,
      profileId,
      force,
      ref: state.defaultBranch,
      runId: Number(dispatched?.workflow_run_id || 0),
      runUrl: dispatched?.html_url || ""
    };
  }

  async getUpdateCheckerRun(token, owner, repo, runId) {
    return this.getManagedWorkflowRun(
      token,
      owner,
      repo,
      runId,
      UPDATE_CHECKER_WORKFLOW
    );
  }


  async getBuilderArtifactDownloadUrl(
    token,
    owner,
    repo,
    runId,
    artifactId
  ) {
    const numericRunId = Number(runId);
    const numericArtifactId = Number(artifactId);
    if (!Number.isSafeInteger(numericRunId) || numericRunId <= 0) {
      throw new BuildControlError("invalid_run_id", 400);
    }
    if (!Number.isSafeInteger(numericArtifactId) || numericArtifactId <= 0) {
      throw new BuildControlError("invalid_artifact_id", 400);
    }

    const safeOwner = encodeSegment(owner);
    const safeRepo = encodeSegment(repo);
    const run = await this.api(
      `/repos/${safeOwner}/${safeRepo}/actions/runs/${numericRunId}`,
      token
    );
    const workflowPath = String(run.path || "").split("@", 1)[0];
    if (workflowPath !== ".github/workflows/" + BUILDER_WORKFLOW) {
      throw new BuildControlError("not_builder_run", 404);
    }

    const artifactsBody = await this.api(
      `/repos/${safeOwner}/${safeRepo}/actions/runs/${numericRunId}/artifacts?per_page=100`,
      token
    );
    const artifacts = Array.isArray(artifactsBody.artifacts)
      ? artifactsBody.artifacts
      : [];
    const artifact = artifacts.find(
      (item) => Number(item.id) === numericArtifactId
    );
    if (!artifact) {
      throw new BuildControlError("artifact_not_found", 404);
    }
    if (artifact.expired) {
      throw new BuildControlError("artifact_expired", 410);
    }

    const response = await this.fetchImpl(
      `${GITHUB_API}/repos/${safeOwner}/${safeRepo}/actions/artifacts/${numericArtifactId}/zip`,
      {
        method: "GET",
        redirect: "manual",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: "Bearer " + token,
          "X-GitHub-Api-Version": this.apiVersion,
          "User-Agent": "OpenWrt-NG-Control-Plane"
        }
      }
    );

    const location = response.headers.get("location") || "";
    if (response.status >= 300 && response.status < 400 && location) {
      const resolved = new URL(location, GITHUB_API);
      if (resolved.protocol !== "https:") {
        throw new BuildControlError("artifact_download_unavailable", 502);
      }
      return resolved.toString();
    }
    if (response.status === 410) {
      throw new BuildControlError("artifact_expired", 410);
    }

    let body = {};
    const text = await response.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { message: response.statusText || "Artifact download failed" };
      }
    }
    if (!response.ok) throw asJsonError(response, body);
    throw new BuildControlError("artifact_download_unavailable", 502);
  }

  async readBranchTextFile(token, owner, repo, branchName, path, optional = false) {
    const safeOwner = encodeSegment(owner);
    const safeRepo = encodeSegment(repo);
    try {
      const body = await this.api(
        `/repos/${safeOwner}/${safeRepo}/contents/${path
          .split("/")
          .map(encodeSegment)
          .join("/")}?ref=${encodeSegment(branchName)}`,
        token
      );
      if (body?.encoding !== "base64" || typeof body.content !== "string") {
        throw new ConfigStudioError("config_studio_file_unavailable", 502);
      }
      return decodeBase64Utf8(body.content);
    } catch (error) {
      if (optional && error?.httpStatus === 404) return null;
      if (error?.httpStatus === 404) {
        throw new ConfigStudioError("config_studio_session_not_found", 404);
      }
      throw error;
    }
  }

  async commitConfigStudioFiles(
    token,
    owner,
    repo,
    branchName,
    files,
    message
  ) {
    const safeOwner = encodeSegment(owner);
    const safeRepo = encodeSegment(repo);
    const ref = await this.api(
      `/repos/${safeOwner}/${safeRepo}/git/ref/${refPath(branchName)}`,
      token
    );
    const headSha = ref?.object?.sha || "";
    if (!/^[0-9a-f]{40}$/i.test(headSha)) {
      throw new ConfigStudioError("config_studio_branch_unavailable", 502);
    }
    const commit = await this.api(
      `/repos/${safeOwner}/${safeRepo}/git/commits/${headSha}`,
      token
    );
    if (!commit?.tree?.sha) {
      throw new ConfigStudioError("repository_tree_unavailable", 502);
    }

    const treeEntries = [];
    for (const [path, value] of Object.entries(files)) {
      const entry =
        value && typeof value === "object" && !Array.isArray(value)
          ? value
          : { content: value };
      const mode = String(entry.mode || "100644");
      if (!["100644", "100755"].includes(mode)) {
        throw new ConfigStudioError("invalid_config_studio_file_mode", 400);
      }
      const blob = await this.api(
        `/repos/${safeOwner}/${safeRepo}/git/blobs`,
        token,
        {
          method: "POST",
          body: { content: String(entry.content ?? ""), encoding: "utf-8" }
        }
      );
      treeEntries.push({
        path,
        mode,
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
          base_tree: commit.tree.sha,
          tree: treeEntries
        }
      }
    );
    const nextCommit = await this.api(
      `/repos/${safeOwner}/${safeRepo}/git/commits`,
      token,
      {
        method: "POST",
        body: {
          message,
          tree: tree.sha,
          parents: [headSha]
        }
      }
    );
    await this.api(
      `/repos/${safeOwner}/${safeRepo}/git/refs/${refPath(branchName)}`,
      token,
      {
        method: "PATCH",
        body: { sha: nextCommit.sha, force: false }
      }
    );
    return nextCommit.sha;
  }

  async dispatchConfigStudio(
    token,
    owner,
    repo,
    defaultBranch,
    mode,
    requestId,
    branchName
  ) {
    const safeOwner = encodeSegment(owner);
    const safeRepo = encodeSegment(repo);
    const response = await this.api(
      `/repos/${safeOwner}/${safeRepo}/actions/workflows/${CONFIG_STUDIO_WORKFLOW}/dispatches`,
      token,
      {
        method: "POST",
        body: {
          ref: defaultBranch,
          return_run_details: true,
          inputs: {
            mode,
            request_id: requestId,
            session_branch: branchName
          }
        }
      }
    );
    return {
      runId: Number(response?.workflow_run_id || 0),
      runUrl: response?.html_url || ""
    };
  }

  async startConfigStudio(token, owner, repo, payload = {}) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new ConfigStudioError("invalid_config_studio_request", 400);
    }

    let profileId = String(payload.profileId || "").trim();
    let sourceRepo = String(payload.sourceRepo || "").trim();
    let sourceBranch = String(payload.sourceBranch || "").trim();
    let adapter = String(payload.adapter || "direct-openwrt").trim();
    let baseConfig = String(payload.baseConfig || "");
    let extraFeeds = String(payload.extraFeeds || "");
    let profileSnapshot = null;
    const state = await this.repositoryState(token, owner, repo);

    if (profileId) {
      if (!PROFILE_ID_RE.test(profileId)) {
        throw new ConfigStudioError("invalid_profile_id", 400);
      }
      const current = await this.getProfile(token, owner, repo, profileId);
      if (current.baseRefSha !== state.baseRefSha) {
        throw new ConfigStudioError("repository_changed", 409);
      }

      if (payload.profileFiles !== undefined && payload.profileFiles !== null) {
        try {
          validateProfileFilesPayload(payload.profileFiles);
        } catch (error) {
          if (error instanceof ProfileWriteError) {
            throw new ConfigStudioError(error.code, error.status);
          }
          throw error;
        }
        const requestedBaseRef = String(payload.baseRefSha || "").trim();
        if (!/^[0-9a-f]{40}$/i.test(requestedBaseRef)) {
          throw new ConfigStudioError("invalid_base_ref", 400);
        }
        if (requestedBaseRef !== current.baseRefSha) {
          throw new ConfigStudioError("repository_changed", 409);
        }
        profileSnapshot = Object.fromEntries(
          PROFILE_FILES.map((name) => [name, String(payload.profileFiles[name])])
        );
      }

      const files = profileSnapshot || Object.fromEntries(
        PROFILE_FILES.map((name) => [
          name,
          current.profile.files[name]?.content || ""
        ])
      );
      const env = files["profile.env"] || "";
      sourceRepo = profileEnvValue(env, "SOURCE_REPO");
      sourceBranch = profileEnvValue(env, "SOURCE_BRANCH");
      adapter = profileEnvValue(env, "ADAPTER") || "direct-openwrt";
      baseConfig = files[".config"] || "";
      extraFeeds = files["feeds.conf"] || "";
    }

    if (!sourceRepo || /[\r\n]/.test(sourceRepo) || sourceRepo.length > 1000) {
      throw new ConfigStudioError("invalid_source_repo", 400);
    }
    if (
      !sourceBranch ||
      /[\r\n]/.test(sourceBranch) ||
      sourceBranch.length > 255
    ) {
      throw new ConfigStudioError("invalid_source_branch", 400);
    }
    if (!/^[A-Za-z0-9._-]+$/.test(adapter)) {
      throw new ConfigStudioError("invalid_adapter", 400);
    }
    if (byteLength(baseConfig) > MAX_PROFILE_FILE_BYTES) {
      throw new ConfigStudioError("config_studio_base_config_too_large", 413);
    }
    if (byteLength(extraFeeds) > 256 * 1024) {
      throw new ConfigStudioError("config_studio_extra_feeds_too_large", 413);
    }

    const requestId = shortNonce(16);
    if (!CONFIG_STUDIO_ID_RE.test(requestId)) {
      throw new ConfigStudioError("config_studio_request_id_failed", 500);
    }
    const branchName = configStudioBranch(requestId);
    const safeOwner = encodeSegment(owner);
    const safeRepo = encodeSegment(repo);

    await this.api(
      `/repos/${safeOwner}/${safeRepo}/git/refs`,
      token,
      {
        method: "POST",
        body: {
          ref: `refs/heads/${branchName}`,
          sha: state.baseRefSha
        }
      }
    );

    const request = {
      version: 1,
      requestId,
      profileId,
      sourceRepo,
      sourceBranch,
      adapter,
      baseConfig,
      extraFeeds,
      baseRefSha: state.baseRefSha,
      selection: { values: {} },
      pendingMode: "catalog",
      afterRunId: 0,
      profileSnapshot: Boolean(profileSnapshot)
    };
    const root = `.openwrt-ng/config-studio/${requestId}`;
    try {
      const sessionFiles = {
        [`${root}/request.json`]: JSON.stringify(request)
      };
      if (profileSnapshot) {
        for (const name of PROFILE_FILES) {
          sessionFiles[`profiles/${profileId}/${name}`] = {
            content: profileSnapshot[name],
            mode: PROFILE_FILE_MODES[name]
          };
        }
      }
      await this.commitConfigStudioFiles(
        token,
        owner,
        repo,
        branchName,
        sessionFiles,
        `config-studio(${requestId}): start session`
      );
      const dispatched = await this.dispatchConfigStudio(
        token,
        owner,
        repo,
        state.defaultBranch,
        "catalog",
        requestId,
        branchName
      );
      return {
        accepted: true,
        requestId,
        branch: branchName,
        profileId,
        sourceRepo,
        sourceBranch,
        adapter,
        extraFeeds,
        profileSnapshot: Boolean(profileSnapshot),
        ref: state.defaultBranch,
        ...dispatched
      };
    } catch (error) {
      try {
        await this.api(
          `/repos/${safeOwner}/${safeRepo}/git/refs/${refPath(branchName)}`,
          token,
          { method: "DELETE" }
        );
      } catch (cleanupError) {
        console.error("Failed to clean Config Studio branch", cleanupError);
      }
      throw error;
    }
  }

  async getConfigStudioSession(token, owner, repo, requestId) {
    if (!CONFIG_STUDIO_ID_RE.test(String(requestId || ""))) {
      throw new ConfigStudioError("invalid_config_studio_request_id", 400);
    }
    const branchName = configStudioBranch(requestId);
    const root = `.openwrt-ng/config-studio/${requestId}`;
    const requestText = await this.readBranchTextFile(
      token,
      owner,
      repo,
      branchName,
      `${root}/request.json`
    );
    let request;
    try {
      request = JSON.parse(requestText);
    } catch {
      throw new ConfigStudioError("config_studio_request_invalid", 502);
    }

    const safeOwner = encodeSegment(owner);
    const safeRepo = encodeSegment(repo);
    const runsBody = await this.api(
      `/repos/${safeOwner}/${safeRepo}/actions/workflows/${CONFIG_STUDIO_WORKFLOW}/runs?event=workflow_dispatch&per_page=50`,
      token
    );
    const runs = Array.isArray(runsBody.workflow_runs)
      ? runsBody.workflow_runs
      : [];
    const expectedMode =
      request.pendingMode === "resolve" ? "resolve" : "catalog";
    const afterRunId = Number(request.afterRunId || 0);
    const run = selectConfigStudioRun(
      runs,
      requestId,
      expectedMode,
      afterRunId
    );

    let status = {
      status: expectedMode === "resolve" ? "resolving" : "preparing",
      mode: expectedMode,
      requestId
    };
    let catalog = null;
    let result = null;
    let progress = null;

    if (run) {
      const mode = configStudioRunMode(run);
      try {
        const jobsBody = await this.api(
          `/repos/${safeOwner}/${safeRepo}/actions/runs/${Number(run.id)}/jobs?per_page=20`,
          token
        );
        progress = configStudioProgressFromJobs(
          Array.isArray(jobsBody.jobs) ? jobsBody.jobs : []
        );
      } catch (progressError) {
        console.error("Failed to read Config Studio progress", progressError);
      }
      if (run.status !== "completed") {
        status = {
          status: mode === "resolve" ? "resolving" : "preparing",
          mode,
          requestId
        };
      } else if (run.conclusion !== "success") {
        status = { status: "failed", mode, requestId };
      } else {
        const artifactsBody = await this.api(
          `/repos/${safeOwner}/${safeRepo}/actions/runs/${Number(run.id)}/artifacts?per_page=100`,
          token
        );
        const artifacts = Array.isArray(artifactsBody.artifacts)
          ? artifactsBody.artifacts
          : [];
        const artifact = artifacts.find(
          (item) =>
            item.name === `OpenWrt_Config_Studio_${requestId}` &&
            !item.expired
        );
        if (artifact) {
          const size = Number(artifact.size_in_bytes || 0);
          if (size > 25 * 1024 * 1024) {
            throw new ConfigStudioError("config_studio_artifact_too_large", 502);
          }
          const zipBytes = await this.apiBytes(
            `/repos/${safeOwner}/${safeRepo}/actions/artifacts/${Number(artifact.id)}/zip`,
            token
          );
          const parsed = parseConfigStudioArtifact(zipBytes);
          status = parsed.status;
          catalog = parsed.catalog;
          result = parsed.result;
        } else {
          status = {
            status: expectedMode === "resolve" ? "resolving" : "preparing",
            mode: expectedMode,
            requestId
          };
        }
      }
    }

    return {
      requestId,
      branch: branchName,
      profileId: request.profileId || "",
      sourceRepo: request.sourceRepo || "",
      sourceBranch: request.sourceBranch || "",
      adapter: request.adapter || "direct-openwrt",
      extraFeeds: request.extraFeeds || "",
      status,
      run: run
        ? {
            id: Number(run.id || 0),
            status: run.status || "unknown",
            conclusion: run.conclusion || "",
            url: run.html_url || "",
            startedAt: run.run_started_at || run.created_at || "",
            updatedAt: run.updated_at || ""
          }
        : null,
      progress,
      catalog,
      result
    };
  }

  async submitConfigStudioSelection(
    token,
    owner,
    repo,
    requestId,
    payload = {}
  ) {
    if (!CONFIG_STUDIO_ID_RE.test(String(requestId || ""))) {
      throw new ConfigStudioError("invalid_config_studio_request_id", 400);
    }
    const values = payload?.values;
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      throw new ConfigStudioError("invalid_config_studio_selection", 400);
    }
    const entries = Object.entries(values);
    if (entries.length > 20000) {
      throw new ConfigStudioError("config_studio_selection_too_large", 413);
    }
    for (const [symbol, value] of entries) {
      if (!/^CONFIG_[A-Za-z0-9_.+@/-]+$/.test(symbol)) {
        throw new ConfigStudioError("invalid_config_symbol", 400);
      }
      if (byteLength(String(value)) > 4096) {
        throw new ConfigStudioError("config_value_too_large", 413);
      }
    }

    const branchName = configStudioBranch(requestId);
    const root = `.openwrt-ng/config-studio/${requestId}`;
    const requestText = await this.readBranchTextFile(
      token,
      owner,
      repo,
      branchName,
      `${root}/request.json`
    );
    let request;
    try {
      request = JSON.parse(requestText);
    } catch {
      throw new ConfigStudioError("config_studio_request_invalid", 502);
    }
    const current = await this.getConfigStudioSession(
      token,
      owner,
      repo,
      requestId
    );
    if (current.run && ACTIVE_BUILD_STATUSES.has(current.run.status)) {
      throw new ConfigStudioError("config_studio_run_active", 409);
    }

    // When the user continues adjusting after a resolved round, use that
    // resolved .config as the next seed. This mirrors repeated menuconfig
    // sessions and prevents accepted choices from falling back to the
    // repository's original baseConfig on the next resolve.
    if (
      current.status?.status === "resolved" &&
      typeof current.result?.finalConfig === "string" &&
      current.result.finalConfig
    ) {
      request.baseConfig = current.result.finalConfig;
    }
    const previousRequest = { ...request };
    request.selection = { values: Object.fromEntries(entries) };
    request.pendingMode = "resolve";
    request.afterRunId = Number(current.run?.id || request.afterRunId || 0);

    await this.commitConfigStudioFiles(
      token,
      owner,
      repo,
      branchName,
      {
        [`${root}/request.json`]: JSON.stringify(request)
      },
      `config-studio(${requestId}): submit selection`
    );
    const state = await this.repositoryState(token, owner, repo);
    let dispatched;
    try {
      dispatched = await this.dispatchConfigStudio(
        token,
        owner,
        repo,
        state.defaultBranch,
        "resolve",
        requestId,
        branchName
      );
    } catch (error) {
      try {
        await this.commitConfigStudioFiles(
          token,
          owner,
          repo,
          branchName,
          {
            [`${root}/request.json`]: JSON.stringify(previousRequest)
          },
          `config-studio(${requestId}): rollback failed resolve dispatch`
        );
      } catch (rollbackError) {
        console.error("Failed to rollback Config Studio request", rollbackError);
      }
      throw error;
    }
    return {
      accepted: true,
      requestId,
      branch: branchName,
      ...dispatched
    };
  }

  async deleteConfigStudioSession(token, owner, repo, requestId) {
    if (!CONFIG_STUDIO_ID_RE.test(String(requestId || ""))) {
      throw new ConfigStudioError("invalid_config_studio_request_id", 400);
    }
    const safeOwner = encodeSegment(owner);
    const safeRepo = encodeSegment(repo);
    const branchName = configStudioBranch(requestId);
    try {
      await this.api(
        `/repos/${safeOwner}/${safeRepo}/git/refs/${refPath(branchName)}`,
        token,
        { method: "DELETE" }
      );
    } catch (error) {
      if (error?.httpStatus !== 404) throw error;
    }
    return { deleted: true, requestId };
  }

  async applyConfigStudioToProfile(
    token,
    owner,
    repo,
    requestId,
    profileId
  ) {
    if (!PROFILE_ID_RE.test(String(profileId || ""))) {
      throw new ConfigStudioError("invalid_profile_id", 400);
    }
    const session = await this.getConfigStudioSession(
      token,
      owner,
      repo,
      requestId
    );
    if (!session.result?.finalConfig) {
      throw new ConfigStudioError("config_studio_not_resolved", 409);
    }
    if (session.profileId && session.profileId !== profileId) {
      throw new ConfigStudioError("config_studio_profile_mismatch", 409);
    }

    const current = await this.getProfile(token, owner, repo, profileId);
    const root = `.openwrt-ng/config-studio/${requestId}`;
    const requestText = await this.readBranchTextFile(
      token,
      owner,
      repo,
      session.branch,
      `${root}/request.json`
    );
    const request = JSON.parse(requestText);
    if (request.baseRefSha && request.baseRefSha !== current.baseRefSha) {
      throw new ConfigStudioError("repository_changed", 409);
    }

    const files = {};
    if (request.profileSnapshot) {
      for (const name of PROFILE_FILES) {
        files[name] = await this.readBranchTextFile(
          token,
          owner,
          repo,
          session.branch,
          `profiles/${profileId}/${name}`
        );
      }
    } else {
      for (const name of PROFILE_FILES) {
        files[name] = current.profile.files[name]?.content || "";
      }
    }
    files[".config"] = session.result.finalConfig;
    const result = await this.createProfilePullRequest(
      token,
      owner,
      repo,
      profileId,
      {
        baseRefSha: current.baseRefSha,
        files
      }
    );
    await this.deleteConfigStudioSession(token, owner, repo, requestId);
    return result;
  }

  async listConfigStudioSessionsForProfile(
    token,
    owner,
    repo,
    profileId
  ) {
    if (!PROFILE_ID_RE.test(String(profileId || ""))) {
      throw new ProfileWriteError("invalid_profile_id", 400);
    }

    const safeOwner = encodeSegment(owner);
    const safeRepo = encodeSegment(repo);
    let refs;
    try {
      refs = await this.api(
        `/repos/${safeOwner}/${safeRepo}/git/matching-refs/${refPath(CONFIG_STUDIO_BRANCH_PREFIX)}`,
        token
      );
    } catch (error) {
      if (error?.httpStatus === 404) return [];
      throw error;
    }

    const sessions = [];
    for (const ref of Array.isArray(refs) ? refs : []) {
      const fullRef = String(ref?.ref || "");
      const branchName = fullRef.replace(/^refs\/heads\//, "");
      if (!branchName.startsWith(CONFIG_STUDIO_BRANCH_PREFIX)) continue;
      const requestId = branchName.slice(CONFIG_STUDIO_BRANCH_PREFIX.length);
      if (!CONFIG_STUDIO_ID_RE.test(requestId)) continue;

      const root = `.openwrt-ng/config-studio/${requestId}`;
      let requestText;
      try {
        requestText = await this.readBranchTextFile(
          token, owner, repo, branchName, `${root}/request.json`, true
        );
      } catch (error) {
        console.error("Failed to inspect Config Studio session", error);
        continue;
      }
      if (!requestText) continue;
      try {
        const request = JSON.parse(requestText);
        if (String(request?.profileId || "") === profileId) {
          sessions.push({ requestId, branch: branchName });
        }
      } catch {
        console.error("Invalid Config Studio request while cleaning profile");
      }
    }
    return sessions;
  }

  async cleanupConfigStudioSessionsForProfile(
    token,
    owner,
    repo,
    profileId
  ) {
    const sessions = await this.listConfigStudioSessionsForProfile(
      token, owner, repo, profileId
    );
    if (!sessions.length) {
      return {
        sessionsFound: 0,
        branchesDeleted: 0,
        canceledRuns: [],
        cancelFailedRuns: [],
        branchDeleteFailures: [],
        runLookupFailed: false
      };
    }

    const safeOwner = encodeSegment(owner);
    const safeRepo = encodeSegment(repo);
    let runs = [];
    let runLookupFailed = false;
    try {
      const body = await this.api(
        `/repos/${safeOwner}/${safeRepo}/actions/workflows/${CONFIG_STUDIO_WORKFLOW}/runs?event=workflow_dispatch&per_page=100`,
        token
      );
      runs = Array.isArray(body?.workflow_runs) ? body.workflow_runs : [];
    } catch (error) {
      runLookupFailed = true;
      console.error("Failed to list Config Studio runs for profile cleanup", error);
    }

    const canceledRuns = [];
    const cancelFailedRuns = [];
    const branchDeleteFailures = [];
    let branchesDeleted = 0;
    for (const session of sessions) {
      for (const run of runs) {
        const title = String(run?.display_title || run?.name || "");
        if (
          title.includes(`cs:${session.requestId}`) &&
          ACTIVE_BUILD_STATUSES.has(String(run?.status || ""))
        ) {
          const runId = Number(run?.id || 0);
          if (!Number.isSafeInteger(runId) || runId <= 0) continue;
          try {
            await this.api(
              `/repos/${safeOwner}/${safeRepo}/actions/runs/${runId}/cancel`,
              token,
              { method: "POST" }
            );
            canceledRuns.push(runId);
          } catch (error) {
            if (error?.httpStatus !== 409) {
              cancelFailedRuns.push(runId);
              console.error("Failed to cancel Config Studio run", error);
            }
          }
        }
      }

      try {
        await this.api(
          `/repos/${safeOwner}/${safeRepo}/git/refs/${refPath(session.branch)}`,
          token,
          { method: "DELETE" }
        );
        branchesDeleted += 1;
      } catch (error) {
        if (error?.httpStatus === 404) {
          branchesDeleted += 1;
        } else {
          branchDeleteFailures.push(session.requestId);
          console.error("Failed to delete Config Studio session branch", error);
        }
      }
    }

    return {
      sessionsFound: sessions.length,
      branchesDeleted,
      canceledRuns,
      cancelFailedRuns,
      branchDeleteFailures,
      runLookupFailed
    };
  }

  async deleteProfileBranch(token, owner, repo, branchName) {
    const safeOwner = encodeSegment(owner);
    const safeRepo = encodeSegment(repo);
    try {
      await this.api(
        "/repos/" +
          safeOwner +
          "/" +
          safeRepo +
          "/git/refs/" +
          refPath(branchName),
        token,
        { method: "DELETE" }
      );
      return true;
    } catch (error) {
      if (error?.httpStatus === 404) return true;
      console.error("Failed to clean up Control Plane profile branch", error);
      return false;
    }
  }

  async cleanupSupersededProfilePullRequests(
    token,
    owner,
    repo,
    profileId,
    defaultBranch
  ) {
    const safeOwner = encodeSegment(owner);
    const safeRepo = encodeSegment(repo);
    const prefix =
      "openwrt-ng/profile-" + branchSlug(profileId) + "-";
    let pulls;
    try {
      pulls = await this.api(
        "/repos/" +
          safeOwner +
          "/" +
          safeRepo +
          "/pulls?state=open&base=" +
          encodeURIComponent(defaultBranch) +
          "&per_page=100",
        token
      );
    } catch (error) {
      console.error("Failed to list superseded Control Plane PRs", error);
      return [];
    }

    const repoFullName = (owner + "/" + repo).toLowerCase();
    const cleaned = [];
    for (const pull of Array.isArray(pulls) ? pulls : []) {
      const number = Number(pull?.number || 0);
      const branchName = String(pull?.head?.ref || "");
      const headRepo = String(pull?.head?.repo?.full_name || "").toLowerCase();
      const title = String(pull?.title || "");
      const body = String(pull?.body || "");
      if (
        !Number.isInteger(number) ||
        number <= 0 ||
        !branchName.startsWith(prefix) ||
        (headRepo && headRepo !== repoFullName) ||
        !title.startsWith("profile(" + profileId + "): ") ||
        !body.startsWith("由 OpenWrt NG Control Plane 创建。")
      ) {
        continue;
      }

      try {
        await this.api(
          "/repos/" + safeOwner + "/" + safeRepo + "/pulls/" + number,
          token,
          {
            method: "PATCH",
            body: { state: "closed" }
          }
        );
        const branchDeleted = await this.deleteProfileBranch(
          token,
          owner,
          repo,
          branchName
        );
        cleaned.push({ number, branch: branchName, branchDeleted });
      } catch (error) {
        console.error(
          "Failed to clean up superseded Control Plane profile PR",
          error
        );
      }
    }
    return cleaned;
  }

  async finalizeProfilePullRequest(
    token,
    owner,
    repo,
    profileId,
    state,
    branchName,
    commitSha,
    action,
    pull
  ) {
    const safeOwner = encodeSegment(owner);
    const safeRepo = encodeSegment(repo);
    const number = Number(pull?.number || 0);
    const mergePolicy = this.profileMergePolicy;
    let merged = false;
    let autoMergeEnabled = false;
    let mergeCommitSha = "";
    let mergeReason = "";

    if (mergePolicy === "manual") {
      mergeReason = "manual_review_required";
    } else if (mergePolicy === "after-checks") {
      try {
        await this.enableProfileAutoMerge(
          token,
          pull,
          commitSha,
          profileId,
          action
        );
        autoMergeEnabled = true;
        mergeReason = "auto_merge_enabled";
      } catch (error) {
        mergeReason = githubErrorReason(error);
      }
    } else {
      try {
        const merge = await this.api(
          "/repos/" +
            safeOwner +
            "/" +
            safeRepo +
            "/pulls/" +
            number +
            "/merge",
          token,
          {
            method: "PUT",
            body: {
              merge_method: "squash",
              sha: commitSha,
              commit_title:
                "profile(" +
                profileId +
                "): " +
                profileActionLabel(action) +
                " via Control Plane",
              commit_message:
                "由 OpenWrt NG Control Plane 自动合并；原始 Pull Request 保留用于审计。"
            }
          }
        );
        merged = merge?.merged === true;
        mergeCommitSha = String(merge?.sha || "");
        if (!merged) {
          mergeReason = "github_merge_not_completed";
        }
      } catch (error) {
        mergeReason = githubErrorReason(error);
      }
    }

    const cleanup = {
      branchDeleted: false,
      supersededPullRequests: []
    };
    if (merged) {
      cleanup.branchDeleted = await this.deleteProfileBranch(
        token,
        owner,
        repo,
        branchName
      );
      cleanup.supersededPullRequests =
        await this.cleanupSupersededProfilePullRequests(
          token,
          owner,
          repo,
          profileId,
          state.defaultBranch
        );
    }

    return {
      pullRequest: {
        number,
        url: pull?.html_url || "",
        merged,
        autoMergeEnabled,
        mergePolicy,
        mergeCommitSha,
        mergeReason
      },
      cleanup
    };
  }

  async createProfileFilesPullRequest(
    token,
    owner,
    repo,
    {
      profileId,
      state,
      files,
      changedFiles,
      action = "update"
    }
  ) {
    const safeOwner = encodeSegment(owner);
    const safeRepo = encodeSegment(repo);
    const baseRefSha = state.baseRefSha;

    const baseCommit = await this.api(
      `/repos/${safeOwner}/${safeRepo}/git/commits/${baseRefSha}`,
      token
    );
    if (!baseCommit?.tree?.sha) {
      throw new ProfileWriteError("repository_tree_unavailable", 502);
    }

    const treeEntries = [];
    for (const name of changedFiles) {
      if (action === "delete") {
        treeEntries.push({
          path: `profiles/${profileId}/${name}`,
          mode: PROFILE_FILE_MODES[name],
          type: "blob",
          sha: null
        });
        continue;
      }

      const blob = await this.api(
        `/repos/${safeOwner}/${safeRepo}/git/blobs`,
        token,
        {
          method: "POST",
          body: {
            content: files[name],
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

    const actionLabel = profileActionLabel(action);
    const commit = await this.api(
      `/repos/${safeOwner}/${safeRepo}/git/commits`,
      token,
      {
        method: "POST",
        body: {
          message:
            `profile(${profileId}): ${actionLabel} via Control Plane`,
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
      const titleAction = profileActionLabel(action);
      const pull = await this.api(
        `/repos/${safeOwner}/${safeRepo}/pulls`,
        token,
        {
          method: "POST",
          body: {
            title:
              `profile(${profileId}): ${titleAction} via Control Plane`,
            head: branchName,
            base: state.defaultBranch,
            body:
              "由 OpenWrt NG Control Plane 创建。\n\n" +
              (action === "create"
                ? "新增标准 Profile 文件：\n"
                : action === "delete"
                  ? "删除标准 Profile 文件：\n"
                  : "变更文件：\n") +
              changedFiles
                .map(
                  (name) =>
                    `- \`profiles/${profileId}/${name}\``
                )
                .join("\n") +
              "\n\nProfile 合并策略由 Control Plane 部署配置决定：immediate 会立即尝试 squash 合并；after-checks 交由 GitHub Auto-merge 等待必需检查/审核；manual 只创建 PR。未立即合并的 PR 会保留供后续处理。"
          }
        }
      );

      const finalized = await this.finalizeProfilePullRequest(
        token,
        owner,
        repo,
        profileId,
        state,
        branchName,
        commit.sha,
        action,
        pull
      );

      return {
        branch: branchName,
        commitSha: commit.sha,
        changedFiles,
        action,
        ...finalized
      };
    } catch (error) {
      try {
        await this.api(
          `/repos/${safeOwner}/${safeRepo}/git/refs/${refPath(branchName)}`,
          token,
          { method: "DELETE" }
        );
      } catch (cleanupError) {
        console.error(
          "Failed to clean up branch after PR creation error",
          cleanupError
        );
      }
      throw error;
    }
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
    validateProfileFilesPayload(submitted);

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

    return this.createProfileFilesPullRequest(
      token,
      owner,
      repo,
      {
        profileId,
        state: {
          defaultBranch: current.defaultBranch,
          baseRefSha: current.baseRefSha
        },
        files: submitted,
        changedFiles,
        action: "update"
      }
    );
  }

  async createNewProfilePullRequest(
    token,
    owner,
    repo,
    profileId,
    files
  ) {
    if (!PROFILE_ID_RE.test(String(profileId || ""))) {
      throw new ProfileWriteError("invalid_profile_id", 400);
    }
    validateProfileFilesPayload(files);

    const state = await this.repositoryState(token, owner, repo);
    const safeOwner = encodeSegment(owner);
    const safeRepo = encodeSegment(repo);
    const safeProfile = encodeSegment(profileId);
    const profilePath =
      `/repos/${safeOwner}/${safeRepo}/contents/profiles/${safeProfile}?ref=${encodeSegment(state.baseRefSha)}`;

    try {
      await this.api(profilePath, token);
      throw new ProfileWriteError("profile_already_exists", 409);
    } catch (error) {
      if (error instanceof ProfileWriteError) throw error;
      if (error?.httpStatus !== 404) throw error;
    }

    const latest = await this.repositoryState(token, owner, repo);
    if (latest.baseRefSha !== state.baseRefSha) {
      throw new ProfileWriteError("repository_changed", 409);
    }

    return this.createProfileFilesPullRequest(
      token,
      owner,
      repo,
      {
        profileId,
        state,
        files,
        changedFiles: [...PROFILE_FILES],
        action: "create"
      }
    );
  }

  async copyProfilePullRequest(
    token, owner, repo, sourceProfileId, payload = {}
  ) {
    if (!PROFILE_ID_RE.test(String(sourceProfileId || ""))) {
      throw new ProfileWriteError("invalid_profile_id", 400);
    }
    const targetProfileId = String(payload.targetProfileId || "").trim();
    const baseRefSha = String(payload.baseRefSha || "").trim();
    if (!PROFILE_ID_RE.test(targetProfileId)) {
      throw new ProfileWriteError("invalid_target_profile_id", 400);
    }
    if (targetProfileId === sourceProfileId) {
      throw new ProfileWriteError("profile_target_same_as_source", 400);
    }
    if (!/^[0-9a-f]{40}$/i.test(baseRefSha)) {
      throw new ProfileWriteError("invalid_base_ref", 400);
    }

    const current = await this.getProfile(token, owner, repo, sourceProfileId);
    if (current.baseRefSha !== baseRefSha) {
      throw new ProfileWriteError("repository_changed", 409);
    }

    const safeOwner = encodeSegment(owner);
    const safeRepo = encodeSegment(repo);
    try {
      await this.api(
        `/repos/${safeOwner}/${safeRepo}/contents/profiles/${encodeSegment(targetProfileId)}?ref=${encodeSegment(baseRefSha)}`,
        token
      );
      throw new ProfileWriteError("profile_already_exists", 409);
    } catch (error) {
      if (error instanceof ProfileWriteError) throw error;
      if (error?.httpStatus !== 404) throw error;
    }

    const files = rewriteProfileFiles(
      Object.fromEntries(
        PROFILE_FILES.map((name) => [
          name,
          current.profile.files[name]?.content || ""
        ])
      ),
      sourceProfileId,
      targetProfileId
    );
    const result = await this.createProfileFilesPullRequest(
      token, owner, repo,
      {
        profileId: targetProfileId,
        state: {
          defaultBranch: current.defaultBranch,
          baseRefSha
        },
        files,
        changedFiles: [...PROFILE_FILES],
        action: "copy"
      }
    );
    return {
      ...result,
      sourceProfileId,
      targetProfileId,
      baselineProfileId: current.baselineProfileId
    };
  }

  async renameProfilePullRequest(
    token, owner, repo, sourceProfileId, payload = {}
  ) {
    if (!PROFILE_ID_RE.test(String(sourceProfileId || ""))) {
      throw new ProfileWriteError("invalid_profile_id", 400);
    }
    const targetProfileId = String(payload.targetProfileId || "").trim();
    const baseRefSha = String(payload.baseRefSha || "").trim();
    if (!PROFILE_ID_RE.test(targetProfileId)) {
      throw new ProfileWriteError("invalid_target_profile_id", 400);
    }
    if (targetProfileId === sourceProfileId) {
      throw new ProfileWriteError("profile_target_same_as_source", 400);
    }
    if (!/^[0-9a-f]{40}$/i.test(baseRefSha)) {
      throw new ProfileWriteError("invalid_base_ref", 400);
    }

    const current = await this.getProfile(token, owner, repo, sourceProfileId);
    if (current.baseRefSha !== baseRefSha) {
      throw new ProfileWriteError("repository_changed", 409);
    }

    const recent = await this.listBuilderRuns(token, owner, repo, {
      profileId: sourceProfileId,
      limit: 20
    });
    if (recent.some((run) => ACTIVE_BUILD_STATUSES.has(run.status))) {
      throw new ProfileWriteError("profile_build_active", 409);
    }

    const safeOwner = encodeSegment(owner);
    const safeRepo = encodeSegment(repo);
    try {
      await this.api(
        `/repos/${safeOwner}/${safeRepo}/contents/profiles/${encodeSegment(targetProfileId)}?ref=${encodeSegment(baseRefSha)}`,
        token
      );
      throw new ProfileWriteError("profile_already_exists", 409);
    } catch (error) {
      if (error instanceof ProfileWriteError) throw error;
      if (error?.httpStatus !== 404) throw error;
    }

    const files = rewriteProfileFiles(
      Object.fromEntries(
        PROFILE_FILES.map((name) => [
          name,
          current.profile.files[name]?.content || ""
        ])
      ),
      sourceProfileId,
      targetProfileId
    );
    const baseCommit = await this.api(
      `/repos/${safeOwner}/${safeRepo}/git/commits/${baseRefSha}`,
      token
    );
    if (!baseCommit?.tree?.sha) {
      throw new ProfileWriteError("repository_tree_unavailable", 502);
    }

    const treeEntries = [];
    for (const name of PROFILE_FILES) {
      const blob = await this.api(
        `/repos/${safeOwner}/${safeRepo}/git/blobs`,
        token,
        {
          method: "POST",
          body: { content: files[name], encoding: "utf-8" }
        }
      );
      treeEntries.push({
        path: `profiles/${targetProfileId}/${name}`,
        mode: PROFILE_FILE_MODES[name],
        type: "blob",
        sha: blob.sha
      });
      if (current.profile.files[name]?.exists) {
        treeEntries.push({
          path: `profiles/${sourceProfileId}/${name}`,
          mode: PROFILE_FILE_MODES[name],
          type: "blob",
          sha: null
        });
      }
    }

    if (current.profile.baseline) {
      const baselineBlob = await this.api(
        `/repos/${safeOwner}/${safeRepo}/git/blobs`,
        token,
        {
          method: "POST",
          body: { content: targetProfileId + "\n", encoding: "utf-8" }
        }
      );
      treeEntries.push({
        path: "profiles/.baseline",
        mode: "100644",
        type: "blob",
        sha: baselineBlob.sha
      });
    }

    const tree = await this.api(
      `/repos/${safeOwner}/${safeRepo}/git/trees`,
      token,
      {
        method: "POST",
        body: { base_tree: baseCommit.tree.sha, tree: treeEntries }
      }
    );
    const commit = await this.api(
      `/repos/${safeOwner}/${safeRepo}/git/commits`,
      token,
      {
        method: "POST",
        body: {
          message: `profile(${sourceProfileId}): rename to ${targetProfileId} via Control Plane`,
          tree: tree.sha,
          parents: [baseRefSha]
        }
      }
    );

    const branchName =
      `openwrt-ng/profile-${branchSlug(sourceProfileId)}-${Date.now()}-${shortNonce()}`;
    await this.api(
      `/repos/${safeOwner}/${safeRepo}/git/refs`,
      token,
      {
        method: "POST",
        body: { ref: `refs/heads/${branchName}`, sha: commit.sha }
      }
    );

    try {
      const pull = await this.api(
        `/repos/${safeOwner}/${safeRepo}/pulls`,
        token,
        {
          method: "POST",
          body: {
            title: `profile(${sourceProfileId}): rename to ${targetProfileId} via Control Plane`,
            head: branchName,
            base: current.defaultBranch,
            body:
              "由 OpenWrt NG Control Plane 创建。\n\n" +
              `将 Profile ${sourceProfileId} 原子重命名为 ${targetProfileId}。\n\n` +
              "同一 commit 会写入新目录并删除旧目录；Profile 内部路径同步重写。" +
              (current.profile.baseline
                ? "\n\n当前 Profile 是基准，profiles/.baseline 会在同一 commit 中同步更新。"
                : "")
          }
        }
      );
      const finalized = await this.finalizeProfilePullRequest(
        token, owner, repo, sourceProfileId,
        { defaultBranch: current.defaultBranch, baseRefSha },
        branchName, commit.sha, "rename", pull
      );

      let configStudioCleanup = {
        sessionsFound: 0,
        branchesDeleted: 0,
        canceledRuns: [],
        cancelFailedRuns: [],
        branchDeleteFailures: [],
        runLookupFailed: false
      };
      if (finalized.pullRequest?.merged) {
        configStudioCleanup = await this.cleanupConfigStudioSessionsForProfile(
          token, owner, repo, sourceProfileId
        );
      }

      return {
        branch: branchName,
        commitSha: commit.sha,
        changedFiles: treeEntries.map((entry) => entry.path),
        action: "rename",
        sourceProfileId,
        targetProfileId,
        baselineProfileId: current.profile.baseline
          ? targetProfileId
          : current.baselineProfileId,
        configStudioCleanup,
        ...finalized
      };
    } catch (error) {
      try {
        await this.api(
          `/repos/${safeOwner}/${safeRepo}/git/refs/${refPath(branchName)}`,
          token,
          { method: "DELETE" }
        );
      } catch (cleanupError) {
        console.error("Failed to clean branch after rename PR error", cleanupError);
      }
      throw error;
    }
  }

  async setBaselineProfilePullRequest(
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
    if (!/^[0-9a-f]{40}$/i.test(baseRefSha)) {
      throw new ProfileWriteError("invalid_base_ref", 400);
    }

    const current = await this.getProfile(token, owner, repo, profileId);
    if (current.baseRefSha !== baseRefSha) {
      throw new ProfileWriteError("repository_changed", 409);
    }
    if (current.profile.baseline) {
      throw new ProfileWriteError("no_changes", 400);
    }

    const safeOwner = encodeSegment(owner);
    const safeRepo = encodeSegment(repo);
    const baseCommit = await this.api(
      `/repos/${safeOwner}/${safeRepo}/git/commits/${current.baseRefSha}`,
      token
    );
    if (!baseCommit?.tree?.sha) {
      throw new ProfileWriteError("repository_tree_unavailable", 502);
    }

    const blob = await this.api(
      `/repos/${safeOwner}/${safeRepo}/git/blobs`,
      token,
      {
        method: "POST",
        body: {
          content: profileId + "\n",
          encoding: "utf-8"
        }
      }
    );
    const tree = await this.api(
      `/repos/${safeOwner}/${safeRepo}/git/trees`,
      token,
      {
        method: "POST",
        body: {
          base_tree: baseCommit.tree.sha,
          tree: [{
            path: "profiles/.baseline",
            mode: "100644",
            type: "blob",
            sha: blob.sha
          }]
        }
      }
    );
    const commit = await this.api(
      `/repos/${safeOwner}/${safeRepo}/git/commits`,
      token,
      {
        method: "POST",
        body: {
          message: `profile(${profileId}): set-baseline via Control Plane`,
          tree: tree.sha,
          parents: [current.baseRefSha]
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
            title: `profile(${profileId}): set-baseline via Control Plane`,
            head: branchName,
            base: current.defaultBranch,
            body:
              "由 OpenWrt NG Control Plane 创建。\n\n" +
              `将仓库基准 Profile 切换为 \`${profileId}\`：\n` +
              "- `profiles/.baseline`\n\n" +
              "未显式指定 Profile 的 Builder / profile.sh 会从该指针解析基准。"
          }
        }
      );

      const finalized = await this.finalizeProfilePullRequest(
        token,
        owner,
        repo,
        profileId,
        {
          defaultBranch: current.defaultBranch,
          baseRefSha: current.baseRefSha
        },
        branchName,
        commit.sha,
        "baseline",
        pull
      );

      return {
        branch: branchName,
        commitSha: commit.sha,
        changedFiles: ["profiles/.baseline"],
        action: "baseline",
        baselineProfileId: profileId,
        ...finalized
      };
    } catch (error) {
      try {
        await this.api(
          `/repos/${safeOwner}/${safeRepo}/git/refs/${refPath(branchName)}`,
          token,
          { method: "DELETE" }
        );
      } catch (cleanupError) {
        console.error(
          "Failed to clean up branch after baseline PR creation error",
          cleanupError
        );
      }
      throw error;
    }
  }

  async deleteProfilePullRequest(
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
    if (!/^[0-9a-f]{40}$/i.test(baseRefSha)) {
      throw new ProfileWriteError("invalid_base_ref", 400);
    }

    const current = await this.getProfile(token, owner, repo, profileId);
    if (current.baseRefSha !== baseRefSha) {
      throw new ProfileWriteError("repository_changed", 409);
    }
    if (current.profile.baseline) {
      throw new ProfileWriteError("protected_profile", 409);
    }

    const recent = await this.listBuilderRuns(token, owner, repo, {
      profileId,
      limit: 20
    });
    if (recent.some((run) => ACTIVE_BUILD_STATUSES.has(run.status))) {
      throw new ProfileWriteError("profile_build_active", 409);
    }

    const changedFiles = PROFILE_FILES.filter(
      (name) => current.profile.files[name]?.exists
    );
    if (!changedFiles.length) {
      throw new ProfileWriteError("profile_not_found", 404);
    }

    const result = await this.createProfileFilesPullRequest(
      token,
      owner,
      repo,
      {
        profileId,
        state: {
          defaultBranch: current.defaultBranch,
          baseRefSha: current.baseRefSha
        },
        files: {},
        changedFiles,
        action: "delete"
      }
    );

    let configStudioCleanup = {
      sessionsFound: 0,
      branchesDeleted: 0,
      canceledRuns: [],
      cancelFailedRuns: [],
      branchDeleteFailures: [],
      runLookupFailed: false
    };
    if (result.pullRequest?.merged) {
      configStudioCleanup =
        await this.cleanupConfigStudioSessionsForProfile(
          token,
          owner,
          repo,
          profileId
        );
    }

    return {
      ...result,
      configStudioCleanup
    };
  }

}
