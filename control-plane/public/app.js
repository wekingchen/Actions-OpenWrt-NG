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

const createState = {
  repo: null,
  previewFiles: [],
  previewValid: false
};

const repositoryState = {
  repositories: [],
  selectedFullName: ""
};

function iconSvg(name) {
  const paths = {
    repo: '<path d="M4 5.5h6l1.5 2H20v11H4z"/><path d="M4 9h16"/>',
    profile: '<path d="M7 4h10l3 3v13H4V7z"/><path d="M8 11h8M8 15h8"/>',
    arrow: '<path d="M5 12h14M14 7l5 5-5 5"/>',
    chevron: '<path d="m7 9 5 5 5-5"/>'
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || ""}</svg>`;
}

const SOURCE_PRESETS = Object.freeze({
  lean: {
    repo: "https://github.com/coolsnowwolf/lede",
    branch: "master"
  },
  openwrt: {
    repo: "https://github.com/openwrt/openwrt",
    branch: "main"
  },
  immortalwrt: {
    repo: "https://github.com/immortalwrt/immortalwrt",
    branch: "master"
  }
});

const MAX_BUILD_POLL_ATTEMPTS = 480;

const ERROR_MESSAGES = {
  control_plane_not_configured:
    "Control Plane 尚未完成 GitHub App 配置，请先完成部署与 Secret 同步。",
  authentication_required:
    "登录状态已失效，请重新使用 GitHub 登录。",
  csrf_validation_failed:
    "安全校验失败。请刷新页面后重试，不要从其他站点提交此操作。",
  invalid_json:
    "请求内容格式无效，请刷新页面后重试。",
  invalid_profile_id:
    "Profile ID 不符合规则，请检查目录名称。",
  profile_not_found:
    "该 Profile 不存在、已移动，或当前默认分支中不可用。",
  profile_already_exists:
    "这个 Profile ID 已经存在，请换一个 ID，或直接编辑已有 Profile。",
  invalid_profile_template:
    "新 Profile 参数没有通过服务端校验。",
  repository_head_unavailable:
    "暂时无法读取仓库默认分支的最新提交，请稍后重试。",
  repository_changed:
    "仓库默认分支在操作期间已经更新。请重新加载或重新预览，确认最新状态后再提交。",
  no_changes:
    "当前内容与仓库一致，没有需要创建 Pull Request 的变更。",
  invalid_profile_files:
    "Profile 文件集合不符合标准结构，已拒绝写入。",
  profile_file_too_large:
    "单个 Profile 文件过大，已拒绝提交。",
  profile_payload_too_large:
    "本次 Profile 变更总大小过大，已拒绝提交。",
  github_profile_write_failed:
    "GitHub 未能完成 Profile 分支 / Pull Request 写入。",
  github_build_status_failed:
    "暂时无法从 GitHub 读取 Builder 状态。",
  github_builder_dispatch_failed:
    "GitHub 未能启动 Builder，请检查 Actions 权限与 workflow 是否存在。",
  build_already_active:
    "这个 Profile 已经有构建在运行，本次不会重复排队。",
  invalid_build_request:
    "Builder 请求包含不允许的字段，已拒绝执行。",
  invalid_publish_release:
    "Release 开关值无效，请刷新页面后重试。",
  not_builder_run:
    "该 Actions Run 不是 OpenWrt NG Builder 运行。",
  github_oauth_exchange_failed:
    "GitHub 登录授权交换失败，请重新登录。",
  github_user_lookup_failed:
    "GitHub 登录成功，但暂时无法读取用户信息。",
  internal_error:
    "Control Plane 发生内部错误，请稍后重试。"
};

const REASON_MESSAGES = {
  github_http_401:
    "GitHub 授权可能已失效，请退出后重新登录。",
  github_http_403:
    "GitHub 拒绝了该操作，请检查 GitHub App 是否已授予对应仓库和权限。",
  github_http_404:
    "GitHub 未找到目标资源，请确认 App 已安装到该仓库。",
  github_http_422:
    "GitHub 拒绝了请求参数，请检查仓库当前状态。",
  incorrect_client_credentials:
    "GitHub App Client ID / Client Secret 不正确，请检查 Worker Secret。"
};

function friendlyError(value = "") {
  const raw =
    value && typeof value === "object"
      ? String(value.message || value.code || "")
      : String(value || "");
  if (!raw) return "";

  const [code, reason] = raw.split(" · ", 2);
  const primary = ERROR_MESSAGES[code] || code;
  const secondary = reason ? REASON_MESSAGES[reason] || reason : "";
  const validationErrors =
    value &&
    typeof value === "object" &&
    Array.isArray(value.body?.validationErrors)
      ? value.body.validationErrors.filter(Boolean)
      : [];
  const validation =
    validationErrors.length > 0 ? " " + validationErrors.join(" ") : "";
  return (secondary ? primary + " " + secondary : primary) + validation;
}

function showError(message = "") {
  const node = $("error");
  const text = friendlyError(message);
  node.hidden = !text;
  node.textContent = text;
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

function showNewProfileResult(message = "", url = "") {
  const node = $("new-profile-result");
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

function readNewProfileInput() {
  return {
    profileId: $("new-profile-id").value.trim(),
    profileName: $("new-profile-name").value.trim(),
    sourceRepo: $("new-source-repo").value.trim(),
    sourceBranch: $("new-source-branch").value.trim(),
    adapter: $("new-adapter").value,
    configText: $("new-config-text").value,
    autoUpdate: $("new-auto-update").checked,
    uploadRelease: $("new-upload-release").checked,
    uploadFirmware: $("new-upload-firmware").checked,
    maximizeSpace: $("new-maximize-space").checked,
    streamLog: $("new-stream-log").checked,
    requiredPackages: $("new-required-packages").value,
    watchSources: $("new-watch-sources").value
  };
}

function invalidateNewProfilePreview() {
  createState.previewFiles = [];
  createState.previewValid = false;
  $("new-profile-create").disabled = true;
  $("new-profile-preview-card").hidden = true;
  showNewProfileResult();
}

function renderNewProfilePreview() {
  const select = $("new-profile-preview-file");
  select.replaceChildren();
  for (const file of createState.previewFiles) {
    const option = document.createElement("option");
    option.value = file.path;
    option.textContent = file.path.split("/").pop();
    select.appendChild(option);
  }
  const selected =
    createState.previewFiles.find((file) => file.path === select.value) ||
    createState.previewFiles[0];
  $("new-profile-preview-content").textContent = selected?.content || "";
  $("new-profile-preview-card").hidden = !selected;
}

function resetNewProfileForm() {
  $("new-profile-form").reset();
  $("new-profile-id").value = "my-openwrt";
  $("new-profile-name").value = "My OpenWrt";
  $("new-source-preset").value = "lean";
  $("new-source-repo").value = SOURCE_PRESETS.lean.repo;
  $("new-source-branch").value = SOURCE_PRESETS.lean.branch;
  $("new-adapter").value = "direct-openwrt";
  $("new-upload-release").checked = true;
  $("new-upload-firmware").checked = true;
  $("new-stream-log").checked = true;
  $("new-config-file").value = "";
  $("new-config-text").value = "";
  $("new-required-packages").value = "";
  $("new-watch-sources").value = "";
  invalidateNewProfilePreview();
}

function openNewProfileForm() {
  const repo = createState.repo;
  if (!repo || !canWriteRepo(repo)) {
    showError(
      "新建 Profile 需要 Contents 与 Pull requests 写权限，请先调整 GitHub App。"
    );
    return;
  }
  showError();
  resetNewProfileForm();
  $("editor-card").hidden = true;
  $("build-card").hidden = true;
  $("new-profile-card").hidden = false;
  $("new-profile-title").textContent = repo.fullName + " · 新建 Profile";
  $("new-profile-card").scrollIntoView({
    behavior: "smooth",
    block: "start"
  });
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

function canReadRepo(repo) {
  return ["read", "write"].includes(repo?.permissions?.contents);
}

function canWriteRepo(repo) {
  return (
    repo?.permissions?.contents === "write" &&
    repo?.permissions?.pullRequests === "write"
  );
}

function repositoryCapabilityText(repo) {
  const read = canReadRepo(repo) ? "Profile 可读取" : "缺少 Contents";
  const edit = canWriteRepo(repo) ? "可编辑 / PR" : "编辑只读";
  const build = canRunRepo(repo) ? "Builder 可运行" : "Builder 不可运行";
  return [read, edit, build].join(" · ");
}

function setMetric(id, value, captionId, caption) {
  const valueNode = $(id);
  const captionNode = $(captionId);
  if (valueNode) valueNode.textContent = value;
  if (captionNode) captionNode.textContent = caption;
}

function updateRepositoryOverview(repo) {
  $("summary-grid").hidden = false;
  const capability = canWriteRepo(repo) && canRunRepo(repo)
    ? "完整"
    : canReadRepo(repo)
      ? "受限"
      : "不可用";
  setMetric(
    "metric-capability",
    capability,
    "metric-capability-caption",
    repositoryCapabilityText(repo)
  );
}

function updateBuildOverview(run) {
  if (!run) {
    setMetric(
      "metric-build-status",
      "暂无",
      "metric-build-caption",
      "当前 Profile 没有运行记录"
    );
    return;
  }
  setMetric(
    "metric-build-status",
    buildStatusLabel(run),
    "metric-build-caption",
    `#${run.runNumber} · ${formatTime(run.updatedAt || run.createdAt)}`
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
  updateBuildOverview(run);

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
    updateBuildOverview(null);
    const empty = document.createElement("div");
    empty.className = "empty-state build-empty";

    const title = document.createElement("strong");
    title.textContent = requestId
      ? "正在等待 GitHub 建立运行记录"
      : "还没有构建记录";
    const detail = document.createElement("span");
    detail.textContent = requestId
      ? "Builder 请求已提交，页面会自动继续刷新。"
      : "可以直接从这里发起这个 Profile 的第一次构建。";
    empty.append(title, detail);

    if (!requestId && canRunRepo(repo)) {
      const action = document.createElement("button");
      action.type = "button";
      action.className = "button primary compact-action";
      action.textContent = "发起构建";
      action.addEventListener("click", () => $("trigger-build").click());
      empty.appendChild(action);
    }

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
      loadBuildDetail(run.id).catch((error) => showError(error))
    );
    root.appendChild(button);
  }

  const first = data.runs[0];
  updateBuildOverview(first);
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
  $("new-profile-card").hidden = true;
  invalidateNewProfilePreview();
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
  createState.repo = repo;
  repositoryState.selectedFullName = repo.fullName;
  $("current-repo-label").textContent = repo.fullName;
  $("repo-panel-title").textContent = "当前仓库";
  $("repo-switcher").value = repo.fullName;
  setMetric(
    "metric-build-status",
    "暂无",
    "metric-build-caption",
    "选择 Profile 后显示"
  );
  $("editor-card").hidden = true;
  $("build-card").hidden = true;
  $("new-profile-card").hidden = true;
  $("new-profile-open").disabled = !canWriteRepo(repo);
  $("new-profile-open").title = canWriteRepo(repo)
    ? "在此仓库通过 Pull Request 新建标准 Profile"
    : "需要 Contents 与 Pull requests 写权限";
  const data = await request(
    `/api/v1/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/profiles`
  );
  $("profile-card").hidden = false;
  $("profile-title").textContent = repo.fullName;
  setMetric(
    "metric-profile-count",
    String(data.profiles.length),
    "metric-profile-caption",
    data.profiles.length
      ? `${repo.name} 中可用的标准 Profile`
      : "当前仓库没有可用 Profile"
  );
  updateRepositoryOverview(repo);

  const root = $("profiles");
  root.textContent = "";

  if (!data.profiles.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML =
      "<strong>还没有 Profile</strong><span>可以从右上角创建第一套标准构建配置。</span>";
    root.appendChild(empty);
    return;
  }

  for (const profile of data.profiles) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "profile-item";

    const leading = document.createElement("span");
    leading.className = "list-leading";
    const icon = document.createElement("span");
    icon.className = "list-icon";
    icon.innerHTML = iconSvg("profile");
    const copy = document.createElement("span");
    copy.className = "list-copy";
    const strong = document.createElement("strong");
    strong.textContent = profile.id;
    const meta = document.createElement("small");
    meta.textContent = profile.path;
    copy.append(strong, meta);
    leading.append(icon, copy);

    const action = document.createElement("span");
    action.className = "list-action";
    action.textContent = "打开 →";

    button.append(leading, action);
    button.addEventListener("click", () => {
      for (const item of root.querySelectorAll(".profile-item")) {
        item.classList.remove("selected");
        item.removeAttribute("aria-current");
      }
      button.classList.add("selected");
      button.setAttribute("aria-current", "true");
      openProfile(repo, profile.id).catch((error) => showError(error));
    });
    root.appendChild(button);
  }
}

async function selectRepository(repo) {
  if (!repo) return;
  const root = $("repositories");
  for (const item of root.querySelectorAll(".repo-item")) {
    const selected = item.dataset.repoFullName === repo.fullName;
    item.classList.toggle("selected", selected);
    if (selected) item.setAttribute("aria-current", "true");
    else item.removeAttribute("aria-current");
  }
  await loadProfiles(repo);
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

  const userBox = $("user-box");
  const avatar = document.createElement("img");
  avatar.src = session.user.avatarUrl;
  avatar.alt = `${session.user.login} 的 GitHub 头像`;
  avatar.width = 32;
  avatar.height = 32;
  avatar.referrerPolicy = "no-referrer";
  avatar.addEventListener("error", () => {
    const fallback = document.createElement("span");
    fallback.className = "user-avatar-fallback";
    fallback.textContent = session.user.login.slice(0, 1).toUpperCase();
    avatar.replaceWith(fallback);
  }, { once: true });
  const login = document.createElement("strong");
  login.textContent = session.user.login;
  const caret = document.createElement("span");
  caret.className = "user-caret";
  caret.innerHTML = iconSvg("chevron");
  userBox.replaceChildren(avatar, login, caret);
  userBox.hidden = false;
  $("account-login").textContent = session.user.login;

  const data = await request("/api/v1/repositories");
  repositoryState.repositories = data.repositories;
  const root = $("repositories");
  root.textContent = "";

  const switcher = $("repo-switcher");
  switcher.replaceChildren();
  if (data.repositories.length > 1) {
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "选择仓库";
    switcher.appendChild(placeholder);
  }
  for (const repo of data.repositories) {
    const option = document.createElement("option");
    option.value = repo.fullName;
    option.textContent = repo.fullName;
    switcher.appendChild(option);
  }
  $("repo-switcher-wrap").hidden = !data.repositories.length;

  for (const repo of data.repositories) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "repo-item";
    button.dataset.repoFullName = repo.fullName;

    const leading = document.createElement("span");
    leading.className = "list-leading";
    const icon = document.createElement("span");
    icon.className = "list-icon repo-icon";
    icon.innerHTML = iconSvg("repo");

    const copy = document.createElement("span");
    copy.className = "list-copy";
    const title = document.createElement("strong");
    title.textContent = repo.fullName;

    const chips = document.createElement("span");
    chips.className = "repo-chips";
    for (const value of [
      repo.private ? "Private" : "Public",
      repo.defaultBranch
    ]) {
      const chip = document.createElement("span");
      chip.className = "repo-chip";
      chip.textContent = value;
      chips.appendChild(chip);
    }
    const capability = document.createElement("span");
    capability.className =
      "repo-chip repo-capability " +
      (canWriteRepo(repo) && canRunRepo(repo) ? "ready" : "limited");
    capability.textContent =
      canWriteRepo(repo) && canRunRepo(repo) ? "完整能力" : "权限受限";
    chips.appendChild(capability);

    copy.append(title, chips);
    leading.append(icon, copy);

    const action = document.createElement("span");
    action.className = "repo-enter";
    const actionText = document.createElement("span");
    actionText.textContent = "进入工作区";
    const actionIcon = document.createElement("span");
    actionIcon.innerHTML = iconSvg("arrow");
    action.append(actionText, actionIcon);

    button.title =
      "contents:" +
      repo.permissions.contents +
      " · pull-requests:" +
      repo.permissions.pullRequests +
      " · actions:" +
      repo.permissions.actions;
    button.append(leading, action);
    button.addEventListener("click", () => {
      selectRepository(repo).catch((error) => showError(error));
    });
    root.appendChild(button);
  }

  installLink.hidden = false;
  if (!data.repositories.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML =
      "<strong>还没有可访问仓库</strong><span>请从头像菜单调整 GitHub App 的仓库授权范围。</span>";
    root.appendChild(empty);
    $("current-repo-label").textContent = "暂无仓库";
  } else if (data.repositories.length === 1) {
    await selectRepository(data.repositories[0]);
  }
}
for (const item of document.querySelectorAll(".sidebar-nav .nav-item")) {
  item.addEventListener("click", () => {
    for (const nav of document.querySelectorAll(".sidebar-nav .nav-item")) {
      nav.classList.remove("active");
    }
    item.classList.add("active");
  });
}

$("repo-switcher").addEventListener("change", () => {
  const repo = repositoryState.repositories.find(
    (item) => item.fullName === $("repo-switcher").value
  );
  if (repo) selectRepository(repo).catch((error) => showError(error));
});

$("user-box").addEventListener("click", (event) => {
  event.stopPropagation();
  const dropdown = $("account-dropdown");
  dropdown.hidden = !dropdown.hidden;
  $("user-box").setAttribute("aria-expanded", String(!dropdown.hidden));
});

document.addEventListener("click", (event) => {
  if (!$("account-menu").contains(event.target)) {
    $("account-dropdown").hidden = true;
    $("user-box").setAttribute("aria-expanded", "false");
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    $("account-dropdown").hidden = true;
    $("user-box").setAttribute("aria-expanded", "false");
  }
});

$("new-profile-open").addEventListener("click", openNewProfileForm);

$("new-profile-close").addEventListener("click", () => {
  $("new-profile-card").hidden = true;
  invalidateNewProfilePreview();
});

$("new-source-preset").addEventListener("change", () => {
  const preset = SOURCE_PRESETS[$("new-source-preset").value];
  if (preset) {
    $("new-source-repo").value = preset.repo;
    $("new-source-branch").value = preset.branch;
  }
  invalidateNewProfilePreview();
});

for (const id of ["new-source-repo", "new-source-branch"]) {
  $(id).addEventListener("input", () => {
    const currentRepo = $("new-source-repo").value.trim();
    const currentBranch = $("new-source-branch").value.trim();
    const match = Object.entries(SOURCE_PRESETS).find(([, preset]) =>
      preset.repo === currentRepo && preset.branch === currentBranch
    );
    $("new-source-preset").value = match?.[0] || "custom";
  });
}

$("new-config-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) {
    showError(".config 不能超过 2 MiB。");
    event.target.value = "";
    return;
  }
  $("new-config-text").value = await file.text();
  invalidateNewProfilePreview();
});

for (const id of [
  "new-profile-id",
  "new-profile-name",
  "new-source-repo",
  "new-source-branch",
  "new-adapter",
  "new-config-text",
  "new-auto-update",
  "new-upload-release",
  "new-upload-firmware",
  "new-maximize-space",
  "new-stream-log",
  "new-required-packages",
  "new-watch-sources"
]) {
  $(id).addEventListener("input", invalidateNewProfilePreview);
  $(id).addEventListener("change", invalidateNewProfilePreview);
}

$("new-profile-preview-file").addEventListener("change", () => {
  const selected = createState.previewFiles.find(
    (file) => file.path === $("new-profile-preview-file").value
  );
  $("new-profile-preview-content").textContent = selected?.content || "";
});

$("new-profile-preview").addEventListener("click", async () => {
  showError();
  showNewProfileResult();
  const button = $("new-profile-preview");
  button.disabled = true;
  button.textContent = "正在校验…";
  try {
    const data = await request("/api/v1/profile-templates/preview", {
      method: "POST",
      body: JSON.stringify(readNewProfileInput())
    });
    createState.previewFiles = data.files || [];
    createState.previewValid = createState.previewFiles.length === 6;
    renderNewProfilePreview();
    $("new-profile-create").disabled =
      !createState.previewValid || !canWriteRepo(createState.repo);
  } catch (error) {
    invalidateNewProfilePreview();
    showError(error);
  } finally {
    button.disabled = false;
    button.textContent = "预览标准文件";
  }
});

$("new-profile-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!createState.repo || !canWriteRepo(createState.repo)) return;
  if (!createState.previewValid) {
    showError("内容已经变化，请重新预览标准文件后再创建 Pull Request。");
    return;
  }

  const button = $("new-profile-create");
  button.disabled = true;
  button.textContent = "正在创建…";
  showError();
  showNewProfileResult();

  try {
    const repo = createState.repo;
    const result = await request(
      `/api/v1/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/profiles`,
      {
        method: "POST",
        body: JSON.stringify(readNewProfileInput())
      }
    );
    showNewProfileResult(
      `已为 Profile ${result.profileId} 创建独立分支；默认分支未被直接修改。`,
      result.pullRequest.url
    );
    createState.previewValid = false;
    $("new-profile-preview-card").hidden = true;
  } catch (error) {
    showError(error);
    button.disabled = false;
  } finally {
    button.textContent = "创建分支并发起 PR";
  }
});

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
    showError(error);
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
      showError(error);
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
  loadBuildRuns().catch((error) => showError(error));
});

$("logout").addEventListener("click", async () => {
  clearBuildPolling();
  await request("/api/v1/logout", { method: "POST" });
  location.reload();
});

init().catch((error) => showError(error));
