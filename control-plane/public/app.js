const $ = (id) => document.getElementById(id);

const PROFILE_FILES = [
  ".config",
  "profile.env",
  "diy-part1.sh",
  "diy-part2.sh",
  "required-packages.txt",
  "watch-sources.txt"
];

const ACTIVE_BUILD_STATUSES = new Set([
  "queued",
  "in_progress",
  "requested",
  "waiting",
  "pending"
]);

const editorState = {
  repo: null,
  profileId: "",
  baseRefSha: "",
  original: {},
  files: {},
  currentFile: ".config",
  previewValid: false
};

const buildState = {
  repo: null,
  profileId: "",
  requestId: "",
  pollTimer: null,
  pollAttempts: 0,
  activeRunId: 0
};

const MAX_BUILD_POLL_ATTEMPTS = 480;

function showError(message = "") {
  const node = $("error");
  node.hidden = !message;
  node.textContent = message;
}

function showWriteResult(message = "", url = "") {
  const node = $("write-result");
  node.hidden = !message;
  node.replaceChildren();
  if (!message) return;
  node.append(document.createTextNode(message));
  if (url) {
    node.append(document.createTextNode(" "));
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = "打开 Pull Request";
    node.append(link);
  }
}

function showBuildResult(message = "") {
  const node = $("build-result");
  node.hidden = !message;
  node.textContent = message;
}

async function request(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const headers = {
    Accept: "application/json",
    ...(options.headers || {})
  };
  if (!["GET", "HEAD"].includes(method)) {
    headers["X-OpenWrt-NG-CSRF"] = "1";
  }
  if (options.body !== undefined && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(path, {
    ...options,
    method,
    headers
  });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const suffix = body.reason ? ` · ${body.reason}` : "";
    const error = new Error(
      (body.error || `HTTP ${response.status}`) + suffix
    );
    error.code = body.error || "";
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function saveCurrentEditorFile() {
  if (!editorState.profileId) return;
  editorState.files[editorState.currentFile] = $("editor-content").value;
}

function setPreviewStale() {
  editorState.previewValid = false;
  $("create-pr").disabled = true;
  $("preview-card").hidden = true;
  showWriteResult();
}

function changedFiles() {
  saveCurrentEditorFile();
  return PROFILE_FILES.filter(
    (name) => editorState.original[name] !== editorState.files[name]
  );
}

function compactDiff(name, before, after) {
  const oldLines = String(before).split("\n");
  const newLines = String(after).split("\n");
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] ===
      newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const contextStart = Math.max(0, prefix - 3);
  const oldEnd = Math.max(prefix, oldLines.length - suffix);
  const newEnd = Math.max(prefix, newLines.length - suffix);
  const lines = [`--- a/${name}`, `+++ b/${name}`];

  for (let i = contextStart; i < prefix; i += 1) {
    lines.push(" " + oldLines[i]);
  }

  const removed = oldLines.slice(prefix, oldEnd);
  const added = newLines.slice(prefix, newEnd);
  const cap = 160;
  for (const line of removed.slice(0, cap)) lines.push("-" + line);
  if (removed.length > cap) {
    lines.push(`-… 省略 ${removed.length - cap} 行`);
  }
  for (const line of added.slice(0, cap)) lines.push("+" + line);
  if (added.length > cap) {
    lines.push(`+… 省略 ${added.length - cap} 行`);
  }

  const suffixStart = oldLines.length - suffix;
  for (
    let i = suffixStart;
    i < Math.min(oldLines.length, suffixStart + 3);
    i += 1
  ) {
    lines.push(" " + oldLines[i]);
  }
  return lines.join("\n");
}

function canWriteRepo(repo) {
  return (
    repo?.permissions?.contents === "write" &&
    repo?.permissions?.pullRequests === "write"
  );
}

function canReadActions(repo) {
  return ["read", "write"].includes(repo?.permissions?.actions);
}

function canRunRepo(repo) {
  return repo?.permissions?.actions === "write";
}

function clearBuildPolling() {
  if (buildState.pollTimer) {
    clearTimeout(buildState.pollTimer);
    buildState.pollTimer = null;
  }
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function buildStatusLabel(run) {
  if (run.status !== "completed") {
    const labels = {
      queued: "排队中",
      in_progress: "运行中",
      requested: "等待中",
      waiting: "等待中",
      pending: "等待中"
    };
    return labels[run.status] || run.status || "未知";
  }

  const conclusions = {
    success: "成功",
    failure: "失败",
    cancelled: "已取消",
    skipped: "已跳过",
    timed_out: "超时",
    action_required: "需要操作",
    neutral: "中性"
  };
  return conclusions[run.conclusion] || run.conclusion || "已完成";
}

function statusClass(run) {
  if (run.status !== "completed") return "status-running";
  if (run.conclusion === "success") return "status-success";
  if (run.conclusion === "failure" || run.conclusion === "timed_out") {
    return "status-failure";
  }
  return "status-neutral";
}

async function loadBuildDetail(runId) {
  const repo = buildState.repo;
  if (!repo || !runId) return null;

  const data = await request(
    `/api/v1/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/builds/${runId}`
  );
  const run = data.run;
  buildState.activeRunId = run.id;

  $("build-detail").hidden = false;
  $("build-detail-title").textContent =
    `#${run.runNumber} · ${buildStatusLabel(run)}`;
  $("build-summary-link").href = run.summaryUrl || run.url;

  const jobs = $("build-jobs");
  jobs.replaceChildren();
  const jobsTitle = document.createElement("h4");
  jobsTitle.textContent = "Jobs";
  jobs.appendChild(jobsTitle);
  if (!run.jobs.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "暂时还没有 Job 信息。";
    jobs.appendChild(empty);
  } else {
    for (const job of run.jobs) {
      const row = document.createElement("a");
      row.className = "build-link-row";
      row.href = job.url || run.url;
      row.target = "_blank";
      row.rel = "noreferrer";
      const strong = document.createElement("strong");
      strong.textContent = job.name;
      const span = document.createElement("span");
      span.textContent =
        job.status === "completed"
          ? (job.conclusion || "completed")
          : job.status;
      row.append(strong, span);
      jobs.appendChild(row);
    }
  }

  const artifacts = $("build-artifacts");
  artifacts.replaceChildren();
  const artifactsTitle = document.createElement("h4");
  artifactsTitle.textContent = "Artifacts";
  artifacts.appendChild(artifactsTitle);
  const availableArtifacts = run.artifacts.filter((item) => !item.expired);
  if (!availableArtifacts.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "当前没有可下载 Artifact。";
    artifacts.appendChild(empty);
  } else {
    for (const artifact of availableArtifacts) {
      const row = document.createElement("a");
      row.className = "build-link-row";
      row.href = artifact.url;
      row.target = "_blank";
      row.rel = "noreferrer";
      const strong = document.createElement("strong");
      strong.textContent = artifact.name;
      const span = document.createElement("span");
      span.textContent =
        `${Math.max(1, Math.round(artifact.sizeBytes / 1024))} KiB`;
      row.append(strong, span);
      artifacts.appendChild(row);
    }
  }

  const release = $("build-release");
  release.replaceChildren();
  const releaseTitle = document.createElement("h4");
  releaseTitle.textContent = "Release";
  release.appendChild(releaseTitle);
  if (run.release) {
    const link = document.createElement("a");
    link.className = "build-link-row";
    link.href = run.release.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    const strong = document.createElement("strong");
    strong.textContent = run.release.name || run.release.tag;
    const span = document.createElement("span");
    span.textContent = formatTime(run.release.publishedAt);
    link.append(strong, span);
    release.appendChild(link);
  } else {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent =
      run.status === "completed"
        ? "本次运行没有匹配到 Release。"
        : "运行完成后如成功发布，会在这里显示。";
    release.appendChild(empty);
  }

  return run;
}

function finishBuildPolling(run) {
  clearBuildPolling();
  buildState.requestId = "";
  buildState.activeRunId = 0;
  buildState.pollAttempts = 0;
  showBuildResult(
    `构建 #${run.runNumber} 已完成：${buildStatusLabel(run)}。`
  );
}

async function pollActiveBuild() {
  if (!buildState.activeRunId) return;
  const run = await loadBuildDetail(buildState.activeRunId);
  if (!run) return;

  buildState.pollAttempts += 1;
  showBuildResult(
    `构建 #${run.runNumber}：${buildStatusLabel(run)}。`
  );

  if (ACTIVE_BUILD_STATUSES.has(run.status)) {
    scheduleBuildPoll(15000);
  } else {
    finishBuildPolling(run);
  }
}

function scheduleBuildPoll(delay = 5000) {
  clearBuildPolling();
  if (
    (!buildState.activeRunId && !buildState.requestId) ||
    buildState.pollAttempts >= MAX_BUILD_POLL_ATTEMPTS
  ) {
    return;
  }

  buildState.pollTimer = setTimeout(async () => {
    try {
      if (buildState.activeRunId) {
        await pollActiveBuild();
      } else {
        await loadBuildRuns({
          requestId: buildState.requestId,
          polling: true
        });
      }
    } catch (error) {
      buildState.pollAttempts += 1;
      showBuildResult(
        `状态刷新暂时失败，将继续自动重试：${error.message}`
      );
      scheduleBuildPoll(5000);
    }
  }, delay);
}

async function loadBuildRuns(options = {}) {
  const repo = buildState.repo;
  if (!repo || !buildState.profileId) return;

  const requestId = options.requestId || "";
  const params = new URLSearchParams({
    profile: buildState.profileId,
    limit: "10"
  });
  if (requestId) params.set("request_id", requestId);

  const data = await request(
    `/api/v1/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/builds?${params}`
  );
  const root = $("build-runs");
  root.replaceChildren();

  if (!data.runs.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = requestId
      ? "已提交到 GitHub，正在等待 Actions Run 建立…"
      : "这个 Profile 暂无 Builder 运行记录。";
    root.appendChild(empty);

    if (requestId) {
      buildState.pollAttempts += 1;
      scheduleBuildPoll(2500);
    }
    return;
  }

  for (const run of data.runs) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "build-item";

    const left = document.createElement("span");
    const strong = document.createElement("strong");
    strong.textContent = `#${run.runNumber} · ${run.displayTitle}`;
    const small = document.createElement("small");
    small.textContent =
      `${formatTime(run.createdAt)} · ${run.headSha.slice(0, 12)}`;
    left.append(strong, small);

    const status = document.createElement("span");
    status.className = `status-pill ${statusClass(run)}`;
    status.textContent = buildStatusLabel(run);

    button.append(left, status);
    button.addEventListener("click", () =>
      loadBuildDetail(run.id).catch((error) => showError(error.message))
    );
    root.appendChild(button);
  }

  const first = data.runs[0];
  if (requestId) {
    buildState.activeRunId = first.id;
    await pollActiveBuild();
    return;
  }

  if (ACTIVE_BUILD_STATUSES.has(first.status)) {
    buildState.activeRunId = first.id;
    buildState.pollAttempts = 0;
    await pollActiveBuild();
  }
}

async function setupBuildControl(repo, profileId) {
  clearBuildPolling();
  buildState.repo = repo;
  buildState.profileId = profileId;
  buildState.requestId = "";
  buildState.pollAttempts = 0;
  buildState.activeRunId = 0;

  $("build-card").hidden = false;
  $("build-title").textContent = `${repo.fullName} · ${profileId}`;
  $("build-meta").textContent =
    "固定触发 OpenWrt NG Builder；Control Plane 不接受任意 workflow 或 ref。";
  $("publish-release").checked = false;
  $("build-detail").hidden = true;
  showBuildResult();

  const readable = canReadActions(repo);
  const ready = canRunRepo(repo);
  $("actions-permission").textContent = ready
    ? "Actions 可调度"
    : readable
      ? "Actions 只读"
      : "需 Actions 权限";
  $("trigger-build").disabled = !ready;
  $("refresh-builds").disabled = !readable;

  if (!readable) {
    const root = $("build-runs");
    root.replaceChildren();
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent =
      "当前 GitHub App 未授予 Actions 权限；Profile 编辑与 PR 功能仍可正常使用。";
    root.appendChild(note);
    return;
  }

  await loadBuildRuns();
}

async function openProfile(repo, profileId) {
  showError();
  showWriteResult();
  await setupBuildControl(repo, profileId);

  const data = await request(
    `/api/v1/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/profiles/${encodeURIComponent(profileId)}`
  );

  editorState.repo = repo;
  editorState.profileId = profileId;
  editorState.baseRefSha = data.baseRefSha;
  editorState.currentFile = ".config";
  editorState.original = {};
  editorState.files = {};
  editorState.previewValid = false;

  for (const name of PROFILE_FILES) {
    const fileContent = data.profile.files[name]?.content || "";
    editorState.original[name] = fileContent;
    editorState.files[name] = fileContent;
  }

  $("editor-card").hidden = false;
  $("editor-title").textContent = `${repo.fullName} · ${profileId}`;
  $("editor-meta").textContent =
    `基线：${data.defaultBranch}@${data.baseRefSha.slice(0, 12)} · 保存时只创建新分支和 Pull Request`;

  const select = $("file-select");
  select.replaceChildren();
  for (const name of PROFILE_FILES) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    select.appendChild(option);
  }
  select.value = editorState.currentFile;
  $("editor-content").value = editorState.files[editorState.currentFile];

  const writeReady = canWriteRepo(repo);
  $("write-permission").textContent = writeReady
    ? "可创建 PR"
    : "只读：需 Contents + Pull requests 写权限";
  $("preview-change").disabled = !writeReady;
  $("editor-content").readOnly = !writeReady;
  $("create-pr").disabled = true;
  $("preview-card").hidden = true;
  $("editor-card").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function loadProfiles(repo) {
  showError();
  clearBuildPolling();
  $("editor-card").hidden = true;
  $("build-card").hidden = true;
  const data = await request(
    `/api/v1/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/profiles`
  );
  $("profile-card").hidden = false;
  $("profile-title").textContent = repo.fullName + " · Profiles";
  const root = $("profiles");
  root.textContent = "";

  if (!data.profiles.length) {
    root.textContent = "仓库中没有 profiles/ 目录或没有可用 Profile。";
    return;
  }

  for (const profile of data.profiles) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "profile-item";
    const strong = document.createElement("strong");
    strong.textContent = profile.id;
    const code = document.createElement("code");
    code.textContent = profile.path;
    button.append(strong, code);
    button.addEventListener("click", () =>
      openProfile(repo, profile.id).catch((error) => showError(error.message))
    );
    root.appendChild(button);
  }
}

async function init() {
  showError();
  const publicConfig = await request("/api/v1/config");
  const installLink = $("install-app");
  const loginAction = $("login-action");
  const setupStatus = $("setup-status");

  if (!publicConfig.configured) {
    loginAction.hidden = true;
    setupStatus.textContent =
      "Worker 已上线，但 GitHub App Secret 尚未配置。完成 GitHub App 创建后再启用登录。";
    $("repo-card").hidden = true;
    return;
  }

  setupStatus.hidden = true;
  loginAction.hidden = false;
  installLink.href = publicConfig.githubAppInstallUrl;

  const session = await request("/api/v1/session");

  if (!session.authenticated) {
    $("login-card").hidden = false;
    $("repo-card").hidden = true;
    return;
  }

  $("login-card").hidden = true;
  $("repo-card").hidden = false;
  const avatar = document.createElement("img");
  avatar.src = session.user.avatarUrl;
  avatar.alt = "";
  avatar.width = 28;
  avatar.height = 28;
  const login = document.createElement("strong");
  login.textContent = session.user.login;
  $("user-box").replaceChildren(avatar, login);

  const data = await request("/api/v1/repositories");
  const root = $("repositories");
  root.textContent = "";

  for (const repo of data.repositories) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "repo-item";
    const title = document.createElement("strong");
    title.textContent = repo.fullName;
    const meta = document.createElement("span");
    meta.textContent =
      (repo.private ? "Private" : "Public") +
      " · " +
      repo.defaultBranch +
      " · contents:" +
      repo.permissions.contents +
      " · pull-requests:" +
      repo.permissions.pullRequests +
      " · actions:" +
      repo.permissions.actions;
    button.append(title, meta);
    button.addEventListener("click", () =>
      loadProfiles(repo).catch((error) => showError(error.message))
    );
    root.appendChild(button);
  }

  installLink.hidden = false;
  if (!data.repositories.length) {
    root.textContent = "当前 GitHub App 安装范围内没有可访问仓库。";
  }
}

$("file-select").addEventListener("change", () => {
  saveCurrentEditorFile();
  editorState.currentFile = $("file-select").value;
  $("editor-content").value = editorState.files[editorState.currentFile] || "";
});

$("editor-content").addEventListener("input", setPreviewStale);

$("preview-change").addEventListener("click", () => {
  const names = changedFiles();
  if (!names.length) {
    showError("当前没有需要提交的变更。");
    $("preview-card").hidden = true;
    $("create-pr").disabled = true;
    return;
  }

  showError();
  const preview = names
    .map((name) =>
      compactDiff(name, editorState.original[name], editorState.files[name])
    )
    .join("\n\n");
  $("diff-preview").textContent = preview;
  $("preview-card").hidden = false;
  editorState.previewValid = true;
  $("create-pr").disabled = !canWriteRepo(editorState.repo);
});

$("create-pr").addEventListener("click", async () => {
  saveCurrentEditorFile();
  if (!editorState.previewValid) {
    showError("内容已变化，请重新预览后再创建 Pull Request。");
    return;
  }

  const button = $("create-pr");
  button.disabled = true;
  button.textContent = "正在创建…";
  showError();
  showWriteResult();

  try {
    const repo = editorState.repo;
    const result = await request(
      `/api/v1/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/profiles/${encodeURIComponent(editorState.profileId)}/pull-request`,
      {
        method: "POST",
        body: JSON.stringify({
          baseRefSha: editorState.baseRefSha,
          files: editorState.files
        })
      }
    );
    showWriteResult(
      `已创建分支 ${result.branch}，默认分支未被直接修改。`,
      result.pullRequest.url
    );
    editorState.previewValid = false;
    $("preview-card").hidden = true;
  } catch (error) {
    showError(error.message);
    button.disabled = false;
  } finally {
    button.textContent = "创建分支并发起 PR";
  }
});

$("trigger-build").addEventListener("click", async () => {
  const repo = buildState.repo;
  if (!repo || !buildState.profileId || !canRunRepo(repo)) return;

  const button = $("trigger-build");
  button.disabled = true;
  button.textContent = "正在提交…";
  showError();
  showBuildResult();

  try {
    const result = await request(
      `/api/v1/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/profiles/${encodeURIComponent(buildState.profileId)}/builds`,
      {
        method: "POST",
        body: JSON.stringify({
          publishRelease: $("publish-release").checked
        })
      }
    );

    buildState.requestId = result.requestId;
    buildState.activeRunId = Number(result.runId || 0);
    buildState.pollAttempts = 0;

    if (buildState.activeRunId) {
      showBuildResult(
        `GitHub 已创建 Run ${buildState.activeRunId}，正在读取运行状态…`
      );
      await pollActiveBuild();
    } else {
      showBuildResult(
        `已提交 Builder 请求 ${result.requestId}，正在等待 GitHub 建立运行记录…`
      );
      await loadBuildRuns({ requestId: result.requestId });
    }
  } catch (error) {
    if (error.code === "build_already_active" && error.body?.activeRun) {
      const run = error.body.activeRun;
      showError(
        `这个 Profile 已有构建 #${run.runNumber} 正在${buildStatusLabel(run)}，不会重复触发。`
      );
      await loadBuildDetail(run.id);
    } else {
      showError(error.message);
    }
  } finally {
    button.textContent = "开始构建";
    button.disabled = !canRunRepo(repo);
  }
});

$("refresh-builds").addEventListener("click", () => {
  clearBuildPolling();
  buildState.requestId = "";
  buildState.pollAttempts = 0;
  loadBuildRuns().catch((error) => showError(error.message));
});

$("logout").addEventListener("click", async () => {
  clearBuildPolling();
  await request("/api/v1/logout", { method: "POST" });
  location.reload();
});

init().catch((error) => showError(error.message));
