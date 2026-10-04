const $ = (id) => document.getElementById(id);

const PROFILE_FILES = [
  ".config",
  "profile.env",
  "diy-part1.sh",
  "diy-part2.sh",
  "required-packages.txt",
  "watch-sources.txt",
  "feeds.conf"
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
  previewValid: false,
  loadVersion: 0
};

const buildState = {
  repo: null,
  requestId: "",
  pollTimer: null,
  pollAttempts: 0,
  hasActiveRuns: false,
  activeRunId: 0,
  detailRunId: 0,
  generation: 0
};

const buildDialogState = {
  repo: null,
  profileId: "",
  releaseAllowed: false,
  requestVersion: 0,
  restoreFocus: null
};

const deleteProfileState = {
  repo: null,
  profileId: "",
  baseRefSha: "",
  requestVersion: 0,
  restoreFocus: null
};

const profileLifecycleState = {
  repo: null,
  profileId: "",
  mode: "copy",
  baseRefSha: "",
  requestVersion: 0,
  restoreFocus: null
};

const baselineProfileState = {
  repo: null,
  profileId: "",
  baseRefSha: "",
  requestVersion: 0,
  restoreFocus: null
};

const updateCheckerState = {
  repo: null,
  runId: 0,
  pollTimer: null,
  generation: 0,
  restoreFocus: null
};

const releaseExistingState = {
  repo: null,
  sourceRunId: 0,
  sourceRunNumber: 0,
  runId: 0,
  pollTimer: null,
  generation: 0,
  restoreFocus: null
};

const createState = {
  repo: null,
  previewFiles: [],
  previewValid: false,
  configStudioDraft: null
};

const configStudioState = {
  repo: null,
  requestId: "",
  profileId: "",
  context: "existing",
  catalog: null,
  result: null,
  modifiedValues: new Map(),
  dependencyLocks: new Map(),
  dependencyOnly: false,
  targetId: "",
  subtargetId: "",
  deviceProfileId: "",
  baselineTargetId: "",
  baselineSubtargetId: "",
  baselineDeviceProfileId: "",
  pollTimer: null,
  pollAttempts: 0,
  generation: 0,
  restoreFocus: null,
  newFingerprint: "",
  resumeUi: null
};

const MAX_CONFIG_STUDIO_POLL_ATTEMPTS = 600;

const repositoryState = {
  repositories: [],
  selectedFullName: "",
  selectionVersion: 0
};

function currentRepository() {
  return repositoryState.repositories.find(
    (repo) => repo.fullName === repositoryState.selectedFullName
  ) || null;
}

function setActiveNavigation(name) {
  for (const item of document.querySelectorAll(".sidebar-nav .nav-item")) {
    const active = item.dataset.nav === name;
    item.classList.toggle("active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  }
}

function showControlPlaneView(name) {
  const grid = $("workspace-grid");
  const build = $("build-card");
  const recent = $("recent-build-card");

  grid.hidden = name === "builder";
  grid.classList.toggle("config-only", name === "profiles");
  build.hidden = name !== "builder";
  recent.hidden = name !== "workspace";
}

function scrollToPanel(node) {
  if (!node || node.hidden) return;
  node.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function navigateControlPlane(destination) {
  showError();
  const repo = currentRepository();

  if (!repo) {
    showError("请先从顶栏选择一个仓库。");
    setActiveNavigation("workspace");
    scrollToPanel($("workspace-empty"));
    return;
  }

  if (destination === "workspace") {
    showControlPlaneView("workspace");
    setActiveNavigation("workspace");
    scrollToPanel($("profile-card"));
    return;
  }

  if (destination === "profiles") {
    showControlPlaneView("profiles");
    setActiveNavigation("profiles");
    if (!$("new-profile-card").hidden) {
      scrollToPanel($("new-profile-card"));
    } else if (!$("editor-card").hidden) {
      scrollToPanel($("editor-card"));
    } else {
      scrollToPanel($("profile-card"));
    }
    return;
  }

  if (destination === "builder") {
    showControlPlaneView("builder");
    setActiveNavigation("builder");
    scrollToPanel($("build-card"));
  }
}

function iconSvg(name) {
  const paths = {
    repo: '<path d="M4 5.5h6l1.5 2H20v11H4z"/><path d="M4 9h16"/>',
    profile: '<path d="M7 4h10l3 3v13H4V7z"/><path d="M8 11h8M8 15h8"/>',
    arrow: '<path d="M5 12h14M14 7l5 5-5 5"/>',
    chevron: '<path d="m7 9 5 5 5-5"/>',
    copy: '<path d="M9 9h10v10H9z"/><path d="M5 15H4V5h10v1"/>',
    rename: '<path d="M4 17.5V20h2.5L17.8 8.7l-2.5-2.5z"/><path d="m14.9 6.6 2.5 2.5"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
    restore: '<path d="M4 10a8 8 0 1 1 2.3 5.7"/><path d="M4 17v-7h7"/>',
    star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2-4.5-4.4 6.2-.9z"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/>'
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

const PASSWALL_FEEDS = [
  "src-git --force passwall_packages https://github.com/Openwrt-Passwall/openwrt-passwall-packages.git;main",
  "src-git --force passwall_luci https://github.com/Openwrt-Passwall/openwrt-passwall.git;main"
];

const FW876_HELLOWORLD_FEEDS = [
  "src-git --force helloworld https://github.com/fw876/helloworld.git"
];

const SBWML_HELLOWORLD_FEEDS = [
  "src-git --force sbwml_helloworld https://github.com/sbwml/openwrt_helloworld.git;v5"
];

function configFeedName(line) {
  const match = String(line || "").trim().match(
    /^src-git(?:-full)?(?:\s+--force)?\s+([A-Za-z0-9._-]+)\s+([^\s]+)$/
  );
  return match?.[1] || "";
}

function addFeedPreset(lines) {
  const current = $("new-extra-feeds").value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const merged = [...current];
  const names = new Set(current.map(configFeedName).filter(Boolean));
  for (const line of lines) {
    const name = configFeedName(line);
    if (name && names.has(name)) continue;
    if (!merged.includes(line)) merged.push(line);
    if (name) names.add(name);
  }
  $("new-extra-feeds").value = merged.join("\n");
  invalidateNewProfilePreview();
  renderNewConfigStudioState();
}


function configStudioDraftStorageKey(repo) {
  return "openwrt-ng:config-studio:new:" + (repo?.fullName || "unknown");
}

function fingerprintText(value) {
  let hash = 2166136261;
  const text = String(value || "");
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function newConfigStudioFingerprint(repo) {
  return fingerprintText(
    JSON.stringify({
      repo: repo?.fullName || "",
      sourceRepo: $("new-source-repo")?.value.trim() || "",
      sourceBranch: $("new-source-branch")?.value.trim() || "",
      adapter: $("new-adapter")?.value || "",
      extraFeeds: $("new-extra-feeds")?.value || "",
      baseConfig: $("new-config-text")?.value || ""
    })
  );
}

function loadNewConfigStudioDraft(repo) {
  if (!repo) return null;
  try {
    const raw = localStorage.getItem(configStudioDraftStorageKey(repo));
    if (!raw) return null;
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function saveNewConfigStudioDraft(repo, draft) {
  createState.configStudioDraft = draft || null;
  if (!repo) return;
  try {
    if (draft) {
      localStorage.setItem(
        configStudioDraftStorageKey(repo),
        JSON.stringify(draft)
      );
    } else {
      localStorage.removeItem(configStudioDraftStorageKey(repo));
    }
  } catch {}
}

function configStudioUiSnapshot() {
  return {
    targetId: configStudioState.targetId || "",
    subtargetId: configStudioState.subtargetId || "",
    deviceProfileId: configStudioState.deviceProfileId || "",
    modifiedValues: Object.fromEntries(configStudioState.modifiedValues)
  };
}

function persistNewConfigStudioUi() {
  if (
    configStudioState.context !== "new" ||
    !configStudioState.repo ||
    !configStudioState.requestId
  ) {
    return;
  }
  const draft =
    createState.configStudioDraft ||
    loadNewConfigStudioDraft(configStudioState.repo) ||
    {};
  if (draft.requestId !== configStudioState.requestId) return;
  saveNewConfigStudioDraft(configStudioState.repo, {
    ...draft,
    ui: configStudioUiSnapshot()
  });
}

function restoreNewConfigStudioUi() {
  const ui = configStudioState.resumeUi;
  if (!ui || typeof ui !== "object") return false;
  if (ui.targetId) configStudioState.targetId = String(ui.targetId);
  if (ui.subtargetId) configStudioState.subtargetId = String(ui.subtargetId);
  if (ui.deviceProfileId) {
    configStudioState.deviceProfileId = String(ui.deviceProfileId);
  }
  if (
    ui.modifiedValues &&
    typeof ui.modifiedValues === "object" &&
    !Array.isArray(ui.modifiedValues)
  ) {
    configStudioState.modifiedValues = new Map(
      Object.entries(ui.modifiedValues).map(([key, value]) => [
        key,
        String(value)
      ])
    );
  }
  configStudioState.resumeUi = null;
  return true;
}

function renderNewConfigStudioState() {
  const node = $("new-config-studio-state");
  const button = $("new-config-studio");
  if (!node || !button) return;
  const repo = createState.repo;
  const draft = createState.configStudioDraft || loadNewConfigStudioDraft(repo);
  createState.configStudioDraft = draft;
  const fingerprint = repo ? newConfigStudioFingerprint(repo) : "";
  if (draft?.requestId && draft.fingerprint === fingerprint) {
    node.textContent = "已有配置会话，可继续上次操作；不会重新生成。";
    button.textContent = "继续图形配置";
  } else if (draft?.requestId) {
    node.textContent = "源码、feeds 或基础 .config 已变化，需要重新生成配置菜单。";
    button.textContent = "重新生成配置菜单";
  } else if ($("new-config-text")?.value.trim()) {
    node.textContent = "已有 .config；可继续用图形界面检查或修改。";
    button.textContent = "生成配置菜单";
  } else {
    node.textContent = "尚未生成。请先确认上方源码和软件源。";
    button.textContent = "生成配置菜单";
  }
}


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
  invalid_target_profile_id:
    "新的 Profile ID 不符合规则，只能使用字母、数字、点、下划线和连字符。",
  profile_target_same_as_source:
    "新的 Profile ID 不能与当前 Profile 相同。",
  profile_not_found:
    "该 Profile 不存在、已移动，或当前默认分支中不可用。",
  profile_already_exists:
    "这个 Profile ID 已经存在，请换一个 ID，或直接编辑已有 Profile。",
  protected_profile:
    "当前基准 Profile 不能删除。请先把另一套配置设为基准，再删除它。",
  invalid_baseline_profile:
    "仓库的基准 Profile 指针无效，请检查 profiles/.baseline 是否指向现有 Profile。",
  profile_build_active:
    "这个 Profile 还有排队或运行中的构建，请等构建结束后再删除。",
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
  github_profile_delete_failed:
    "GitHub 未能完成 Profile 删除分支 / Pull Request 写入。",
  github_build_status_failed:
    "暂时无法从 GitHub 读取 Builder 状态。",
  github_builder_dispatch_failed:
    "GitHub 未能启动 Builder，请检查 Actions 权限与 workflow 是否存在。",
  github_builder_control_failed:
    "GitHub 未能完成 Builder 取消 / 重跑操作。",
  github_release_existing_failed:
    "GitHub 未能启动 Release Existing Build。",
  release_existing_unavailable:
    "这个构建当前不能直接补发 Release。",
  release_existing_already_active:
    "这个构建已经有 Release Existing 任务在运行。",
  release_already_exists:
    "这个构建已经有关联 Release，不需要重复发布。",
  release_bundle_missing:
    "这个构建没有保留 Release bundle，无法直接补发 Release。",
  release_bundle_expired:
    "这个构建的 Release bundle 已过期，无法直接补发 Release。",
  build_not_successful:
    "只有成功完成的 Builder 才能补发 Release。",
  github_update_checker_failed:
    "GitHub 未能启动 Update Checker。",
  update_check_already_active:
    "当前已有 Update Checker 在运行，本次不会重复排队。",
  invalid_update_check_request:
    "Update Checker 请求参数无效。",
  invalid_update_check_force:
    "Update Checker 强制选项无效。",
  github_deleted_profiles_failed:
    "暂时无法读取最近删除的 Profile。",
  github_profile_restore_failed:
    "GitHub 未能完成 Profile 恢复 Pull Request。",
  invalid_deletion_commit:
    "删除记录无效，无法恢复 Profile。",
  deletion_commit_mismatch:
    "该删除记录与目标 Profile 不匹配，已拒绝恢复。",
  deleted_profile_snapshot_unavailable:
    "删除前的 Profile 快照已经不可用。",
  deleted_profile_snapshot_incomplete:
    "删除前快照缺少标准 Profile 文件，无法安全恢复。",
  build_not_active:
    "这个构建已经不在运行，不能再取消。",
  build_not_completed:
    "这个构建尚未结束，不能重跑。",
  github_config_studio_failed:
    "GitHub 未能启动图形配置会话，请检查 Actions / Contents 权限与 Config Studio workflow。",
  github_config_studio_apply_failed:
    "Kconfig 已完成，但 GitHub 未能创建 Profile 配置 Pull Request。",
  config_studio_session_not_found:
    "图形配置会话已经不存在，可能已完成、取消或被清理。",
  config_studio_run_active:
    "当前图形配置仍在 Actions 中运行，请等本轮解析完成后再提交。",
  config_studio_not_resolved:
    "还没有可应用的 Kconfig 解析结果，请先校验当前选择。",
  config_studio_profile_mismatch:
    "这次图形配置会话不属于当前 Profile，已拒绝应用。",
  invalid_config_studio_selection:
    "图形配置选择格式无效，请刷新配置目录后重试。",
  invalid_config_symbol:
    "提交内容包含不允许的 Kconfig 符号，已拒绝处理。",
  config_studio_gzip_unavailable:
    "当前 Control Plane 运行环境无法解压配置目录。",
  config_studio_result_invalid:
    "Config Studio 返回的数据无法解析，请查看对应 Actions 日志。",
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

function showProfileListResult(message = "", url = "") {
  const node = $("profile-list-result");
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

function profileWriteResultMessage(result, subject = "Profile") {
  const pull = result?.pullRequest || {};
  const number = Number(pull.number || 0);
  if (pull.merged) {
    const staleCount = Array.isArray(result?.cleanup?.supersededPullRequests)
      ? result.cleanup.supersededPullRequests.length
      : 0;
    const branchNote =
      result?.cleanup?.branchDeleted === false
        ? "；当前临时分支清理未完成"
        : "；临时分支已清理";
    const staleNote = staleCount
      ? "；同时清理 " + staleCount + " 个已被本次保存取代的旧 PR"
      : "";
    return (
      subject +
      " 已通过 PR #" +
      number +
      " 自动合并到默认分支" +
      branchNote +
      staleNote +
      "。"
    );
  }

  const reason =
    pull.mergeReason === "github_http_405" ||
    pull.mergeReason === "github_http_409"
      ? "仓库规则、必需检查或分支状态暂时阻止了自动合并"
      : "自动合并未完成";
  return (
    subject +
    " 已创建 PR #" +
    number +
    "，但" +
    reason +
    "。PR 与临时分支已保留，请打开 PR 处理。"
  );
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
    streamLog: false,
    requiredPackages: $("new-required-packages").value,
    watchSources: $("new-watch-sources").value,
    extraFeeds: $("new-extra-feeds").value
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

function renderNewAdapterVisibility() {
  const field = $("new-adapter-field");
  const select = $("new-adapter");
  const options = [...select.options].filter((option) => option.value);

  if (!select.value && options.length) {
    select.value = options[0].value;
  }

  field.hidden = options.length <= 1;
}

function resetNewProfileForm() {
  $("new-profile-form").reset();
  $("new-profile-id").value = "my-openwrt";
  $("new-profile-name").value = "My OpenWrt";
  $("new-source-preset").value = "lean";
  $("new-source-repo").value = SOURCE_PRESETS.lean.repo;
  $("new-source-branch").value = SOURCE_PRESETS.lean.branch;
  $("new-adapter").value = "direct-openwrt";
  renderNewAdapterVisibility();
  $("new-upload-release").checked = true;
  $("new-upload-firmware").checked = true;
  $("new-config-file").value = "";
  $("new-config-text").value = "";
  $("new-extra-feeds").value = "";
  $("new-required-packages").value = "";
  $("new-watch-sources").value = "";

  createState.configStudioDraft = loadNewConfigStudioDraft(createState.repo);
  const draft = createState.configStudioDraft;
  if (draft?.requestId) {
    $("new-source-repo").value = draft.sourceRepo || $("new-source-repo").value;
    $("new-source-branch").value =
      draft.sourceBranch || $("new-source-branch").value;
    $("new-adapter").value = draft.adapter || "direct-openwrt";
    $("new-extra-feeds").value = draft.extraFeeds || "";
    $("new-config-text").value = draft.baseConfig || "";
    const match = Object.entries(SOURCE_PRESETS).find(([, preset]) =>
      preset.repo === $("new-source-repo").value.trim() &&
      preset.branch === $("new-source-branch").value.trim()
    );
    $("new-source-preset").value = match?.[0] || "custom";
  }
  renderNewConfigStudioState();
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
  $("new-profile-card").hidden = false;
  $("new-profile-title").textContent = repo.fullName + " · 新建配置";
  showControlPlaneView("profiles");
  setActiveNavigation("profiles");
  scrollToPanel($("new-profile-card"));
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

function updateRepositoryContext(repo) {
  $("repo-meta-line").hidden = false;
  $("repo-visibility").textContent = repo.private ? "Private" : "Public";
  $("repo-branch").textContent = repo.defaultBranch;
  const ready = canWriteRepo(repo) && canRunRepo(repo);
  $("repo-capability").textContent = ready ? "完整能力" : "权限受限";
  $("repo-capability").className =
    "repo-meta-chip " + (ready ? "ready" : "limited");
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

function isCurrentBuildContext(repo, generation) {
  return Boolean(
    repo &&
    generation === buildState.generation &&
    buildState.repo?.fullName === repo.fullName &&
    repositoryState.selectedFullName === repo.fullName
  );
}

function buildStateMessage(titleText, detailText) {
  const message = document.createElement("div");
  message.className = "empty-state build-empty";
  const title = document.createElement("strong");
  title.textContent = titleText;
  const detail = document.createElement("span");
  detail.textContent = detailText;
  message.append(title, detail);
  return message;
}

function renderBuildHistoryState(title, detail) {
  const recent = buildStateMessage(title, detail);
  const full = buildStateMessage(title, detail);
  $("recent-build-runs").replaceChildren(recent);
  $("build-runs").replaceChildren(full);
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function relativeTime(value) {
  if (!value) return "—";
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return value;
  const diff = Math.max(0, Date.now() - time);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return formatTime(value);
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

function buildProfileId(run) {
  const title = String(run.displayTitle || "");
  const parts = title.split(" · ").map((item) => item.trim()).filter(Boolean);
  if (parts[0] === "Build" && parts[1]) return parts[1];
  return parts.find((part) => !part.startsWith("cp:") && part !== "Build") || "unknown";
}

function parseProfileReleasePolicy(content) {
  const match = String(content || "").match(
    /^\s*UPLOAD_RELEASE\s*=\s*['"]?(true|false)['"]?\s*$/mi
  );
  return match ? match[1].toLowerCase() === "true" : false;
}

function setBuildDialogStatus(message = "", isError = false) {
  const node = $("build-dialog-status");
  node.hidden = !message;
  node.textContent = message;
  node.classList.toggle("error-text", Boolean(isError));
}

function closeBuildDialog() {
  buildDialogState.requestVersion += 1;
  const restoreFocus = buildDialogState.restoreFocus;
  $("build-dialog").hidden = true;
  document.body.classList.remove("dialog-open");
  buildDialogState.repo = null;
  buildDialogState.profileId = "";
  buildDialogState.releaseAllowed = false;
  buildDialogState.restoreFocus = null;
  setBuildDialogStatus();
  if (restoreFocus?.isConnected && typeof restoreFocus.focus === "function") {
    restoreFocus.focus();
  }
}

async function openBuildDialog(repo, profileId) {
  showError();
  if (!$("update-checker-dialog").hidden) closeUpdateCheckerDialog();
  if (!$("release-existing-dialog").hidden) closeReleaseExistingDialog();
  if (!$("delete-profile-dialog").hidden) closeDeleteProfileDialog();
  if (!$("baseline-profile-dialog").hidden) closeBaselineProfileDialog();
  if (!$("profile-lifecycle-dialog").hidden) closeProfileLifecycleDialog();
  const requestVersion = buildDialogState.requestVersion + 1;
  buildDialogState.requestVersion = requestVersion;
  buildDialogState.repo = repo;
  buildDialogState.profileId = profileId;
  buildDialogState.releaseAllowed = false;
  buildDialogState.restoreFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

  $("build-dialog-profile").textContent = profileId;
  $("build-dialog-title").textContent = `构建 ${profileId}`;
  $("build-dialog-repo").textContent = repo.fullName;
  $("publish-release").checked = false;
  $("publish-release").disabled = true;
  $("publish-release-help").textContent = "正在读取 Profile 发布策略…";
  $("trigger-build").disabled = true;
  setBuildDialogStatus();
  $("build-dialog").hidden = false;
  document.body.classList.add("dialog-open");
  $("build-dialog-close").focus();

  try {
    const data = await request(
      `/api/v1/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/profiles/${encodeURIComponent(profileId)}`
    );
    if (
      requestVersion !== buildDialogState.requestVersion ||
      buildDialogState.repo?.fullName !== repo.fullName ||
      buildDialogState.profileId !== profileId ||
      $("build-dialog").hidden
    ) {
      return;
    }

    const profileEnv = data.profile.files["profile.env"]?.content || "";
    const releaseAllowed = parseProfileReleasePolicy(profileEnv);
    buildDialogState.releaseAllowed = releaseAllowed;
    $("publish-release").disabled = !releaseAllowed;
    $("publish-release-help").textContent = releaseAllowed
      ? "Profile 允许发布；开启后仅影响本次构建。"
      : "此 Profile 的 UPLOAD_RELEASE=false，本次不能发布 Release。";

    if (!canRunRepo(repo)) {
      $("trigger-build").disabled = true;
      setBuildDialogStatus("当前 GitHub App 没有 Actions 写权限，不能发起构建。", true);
    } else {
      $("trigger-build").disabled = false;
    }
  } catch (error) {
    if (
      requestVersion !== buildDialogState.requestVersion ||
      $("build-dialog").hidden
    ) {
      return;
    }
    $("trigger-build").disabled = true;
    setBuildDialogStatus(friendlyError(error), true);
  }
}

function clearUpdateCheckerPolling() {
  if (updateCheckerState.pollTimer) {
    clearTimeout(updateCheckerState.pollTimer);
    updateCheckerState.pollTimer = null;
  }
}

function setUpdateCheckerStatus(message = "", isError = false) {
  const node = $("update-checker-status");
  node.textContent = message;
  node.classList.toggle("error-text", Boolean(isError));
}

function closeUpdateCheckerDialog() {
  clearUpdateCheckerPolling();
  updateCheckerState.generation += 1;
  const restoreFocus = updateCheckerState.restoreFocus;
  $("update-checker-dialog").hidden = true;
  document.body.classList.remove("dialog-open");
  updateCheckerState.repo = null;
  updateCheckerState.runId = 0;
  updateCheckerState.restoreFocus = null;
  renderActionProgressCard("update-checker-progress", null, null);
  $("update-checker-run-link").hidden = true;
  setUpdateCheckerStatus();
  if (restoreFocus?.isConnected && typeof restoreFocus.focus === "function") {
    restoreFocus.focus();
  }
}

async function pollUpdateCheckerRun(generation) {
  const repo = updateCheckerState.repo;
  const runId = updateCheckerState.runId;
  if (
    !repo ||
    !runId ||
    generation !== updateCheckerState.generation ||
    $("update-checker-dialog").hidden
  ) return;

  try {
    const data = await request(
      `/api/v1/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/update-checker/runs/${runId}`,
      { cache: "no-store" }
    );
    if (
      generation !== updateCheckerState.generation ||
      $("update-checker-dialog").hidden
    ) return;

    const run = data.run;
    renderActionProgressCard(
      "update-checker-progress",
      run.progress,
      run,
      {
        force: true,
        runningTitle: "正在检查上游",
        runningDetail: "进度来自 Update Checker 的真实 GitHub Actions 步骤。",
        waitingTitle: "等待 Update Checker",
        waitingDetail: "运行记录已经建立，正在等待 Runner 开始。"
      }
    );
    $("update-checker-run-link").href = run.url || "#";
    $("update-checker-run-link").hidden = !run.url;

    if (run.status === "completed") {
      clearUpdateCheckerPolling();
      const ok = run.conclusion === "success";
      setUpdateCheckerStatus(
        ok
          ? "更新检查完成；如发现需要处理的新上游状态，已按现有规则触发对应 Builder。"
          : `更新检查结束：${buildStatusLabel(run)}。请打开 Actions 查看失败步骤。`,
        !ok
      );
      $("confirm-update-checker").disabled = false;
      $("confirm-update-checker").textContent = "再次检查";
      return;
    }

    setUpdateCheckerStatus("Update Checker 正在运行，页面会自动刷新真实步骤。");
    updateCheckerState.pollTimer = setTimeout(
      () => pollUpdateCheckerRun(generation),
      2500
    );
  } catch (error) {
    if (
      generation !== updateCheckerState.generation ||
      $("update-checker-dialog").hidden
    ) return;
    setUpdateCheckerStatus(friendlyError(error), true);
    updateCheckerState.pollTimer = setTimeout(
      () => pollUpdateCheckerRun(generation),
      5000
    );
  }
}

async function openUpdateCheckerDialog(repo, profileId = "") {
  showError();
  if (!canRunRepo(repo)) {
    showError("当前 GitHub App 没有 Actions 写权限，不能手动触发 Update Checker。");
    return;
  }
  if (!$("build-dialog").hidden) closeBuildDialog();
  if (!$("delete-profile-dialog").hidden) closeDeleteProfileDialog();
  if (!$("baseline-profile-dialog").hidden) closeBaselineProfileDialog();
  if (!$("profile-lifecycle-dialog").hidden) closeProfileLifecycleDialog();
  if (!$("release-existing-dialog").hidden) closeReleaseExistingDialog();

  clearUpdateCheckerPolling();
  const generation = updateCheckerState.generation + 1;
  updateCheckerState.generation = generation;
  updateCheckerState.repo = repo;
  updateCheckerState.runId = 0;
  updateCheckerState.restoreFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;

  $("update-checker-repo").textContent = repo.fullName;
  $("update-checker-force").checked = false;
  $("confirm-update-checker").disabled = true;
  $("confirm-update-checker").textContent = "正在读取 Profile…";
  $("update-checker-run-link").hidden = true;
  renderActionProgressCard("update-checker-progress", null, null);
  setUpdateCheckerStatus("正在读取可检查的 Profile…");
  $("update-checker-dialog").hidden = false;
  document.body.classList.add("dialog-open");

  try {
    const data = await request(
      `/api/v1/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/profiles`,
      { cache: "no-store" }
    );
    if (
      generation !== updateCheckerState.generation ||
      $("update-checker-dialog").hidden
    ) return;

    const select = $("update-checker-profile");
    select.replaceChildren();
    const all = document.createElement("option");
    all.value = "";
    all.textContent = "全部 AUTO_UPDATE=true Profile";
    select.appendChild(all);
    for (const profile of data.profiles || []) {
      const option = document.createElement("option");
      option.value = profile.id;
      option.textContent = profile.id + (profile.baseline ? " · 基准" : "");
      select.appendChild(option);
    }
    select.value = [...select.options].some((item) => item.value === profileId)
      ? profileId
      : "";
    setUpdateCheckerStatus(
      profileId
        ? `将检查 ${profileId}；指定 Profile 时不受 AUTO_UPDATE 开关限制。`
        : "将检查所有 AUTO_UPDATE=true 的 Profile。"
    );
    $("confirm-update-checker").disabled = false;
    $("confirm-update-checker").textContent = "开始检查";
  } catch (error) {
    if (
      generation !== updateCheckerState.generation ||
      $("update-checker-dialog").hidden
    ) return;
    setUpdateCheckerStatus(friendlyError(error), true);
    $("confirm-update-checker").disabled = true;
    $("confirm-update-checker").textContent = "开始检查";
  }
}

function clearReleaseExistingPolling() {
  if (releaseExistingState.pollTimer) {
    clearTimeout(releaseExistingState.pollTimer);
    releaseExistingState.pollTimer = null;
  }
}

function setReleaseExistingStatus(message = "", isError = false) {
  const node = $("release-existing-status");
  node.textContent = message;
  node.classList.toggle("error-text", Boolean(isError));
}

function closeReleaseExistingDialog() {
  clearReleaseExistingPolling();
  releaseExistingState.generation += 1;
  const restoreFocus = releaseExistingState.restoreFocus;
  $("release-existing-dialog").hidden = true;
  document.body.classList.remove("dialog-open");
  releaseExistingState.repo = null;
  releaseExistingState.sourceRunId = 0;
  releaseExistingState.sourceRunNumber = 0;
  releaseExistingState.runId = 0;
  releaseExistingState.restoreFocus = null;
  renderActionProgressCard("release-existing-progress", null, null);
  $("release-existing-run-link").hidden = true;
  setReleaseExistingStatus();
  if (restoreFocus?.isConnected && typeof restoreFocus.focus === "function") {
    restoreFocus.focus();
  }
}

async function pollReleaseExistingRun(generation) {
  const repo = releaseExistingState.repo;
  const runId = releaseExistingState.runId;
  if (
    !repo ||
    !runId ||
    generation !== releaseExistingState.generation ||
    $("release-existing-dialog").hidden
  ) return;

  try {
    const data = await request(
      `/api/v1/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/release-existing/runs/${runId}`,
      { cache: "no-store" }
    );
    if (
      generation !== releaseExistingState.generation ||
      $("release-existing-dialog").hidden
    ) return;

    const run = data.run;
    renderActionProgressCard(
      "release-existing-progress",
      run.progress,
      run,
      {
        force: true,
        runningTitle: "正在补发 Release",
        runningDetail: "正在复用已有 Build 的 Release bundle。",
        waitingTitle: "等待 Release Runner",
        waitingDetail: "恢复发布任务已经建立，正在等待 Runner。"
      }
    );
    $("release-existing-run-link").href = run.url || "#";
    $("release-existing-run-link").hidden = !run.url;

    if (run.status === "completed") {
      clearReleaseExistingPolling();
      const ok = run.conclusion === "success";
      setReleaseExistingStatus(
        ok
          ? "Release Existing Build 已完成；正在刷新来源构建的 Release 信息。"
          : `恢复发布结束：${buildStatusLabel(run)}。请打开 Actions 查看失败步骤。`,
        !ok
      );
      $("confirm-release-existing").disabled = ok;
      $("confirm-release-existing").textContent = ok ? "发布完成" : "重新尝试";
      if (ok && buildState.repo?.fullName === repo.fullName) {
        await loadBuildDetail(releaseExistingState.sourceRunId);
        await loadBuildRuns({ generation: buildState.generation });
      }
      return;
    }

    setReleaseExistingStatus("正在从已有构建补发 Release，页面会自动刷新真实步骤。");
    releaseExistingState.pollTimer = setTimeout(
      () => pollReleaseExistingRun(generation),
      2500
    );
  } catch (error) {
    if (
      generation !== releaseExistingState.generation ||
      $("release-existing-dialog").hidden
    ) return;
    setReleaseExistingStatus(friendlyError(error), true);
    releaseExistingState.pollTimer = setTimeout(
      () => pollReleaseExistingRun(generation),
      5000
    );
  }
}

function openReleaseExistingDialog(repo, run) {
  showError();
  if (!canRunRepo(repo)) {
    showError("当前 GitHub App 没有 Actions 写权限，不能补发 Release。");
    return;
  }
  if (!run?.releaseRecoveryEligible) {
    showError(run?.releaseRecoveryReason || "release_existing_unavailable");
    return;
  }
  if (!$("build-dialog").hidden) closeBuildDialog();
  if (!$("update-checker-dialog").hidden) closeUpdateCheckerDialog();

  clearReleaseExistingPolling();
  const generation = releaseExistingState.generation + 1;
  releaseExistingState.generation = generation;
  releaseExistingState.repo = repo;
  releaseExistingState.sourceRunId = Number(run.id || 0);
  releaseExistingState.sourceRunNumber = Number(run.runNumber || 0);
  releaseExistingState.runId = 0;
  releaseExistingState.restoreFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;

  $("release-existing-repo").textContent = repo.fullName;
  $("release-existing-source").textContent =
    `#${run.runNumber} ${buildProfileId(run)} · ${String(run.headSha || "").slice(0, 12)}`;
  $("confirm-release-existing").disabled = false;
  $("confirm-release-existing").textContent = "发布现有构建";
  $("release-existing-run-link").hidden = true;
  renderActionProgressCard("release-existing-progress", null, null);
  setReleaseExistingStatus(
    "将直接复用已有 Release bundle；不会重新编译，也不会改变来源 Build。"
  );
  $("release-existing-dialog").hidden = false;
  document.body.classList.add("dialog-open");
}

function setProfileLifecycleStatus(message = "", isError = false) {
  const node = $("profile-lifecycle-status");
  node.hidden = !message;
  node.textContent = message;
  node.classList.toggle("error-text", Boolean(isError));
}

function closeProfileLifecycleDialog() {
  profileLifecycleState.requestVersion += 1;
  const restoreFocus = profileLifecycleState.restoreFocus;
  $("profile-lifecycle-dialog").hidden = true;
  document.body.classList.remove("dialog-open");
  profileLifecycleState.repo = null;
  profileLifecycleState.profileId = "";
  profileLifecycleState.mode = "copy";
  profileLifecycleState.baseRefSha = "";
  profileLifecycleState.restoreFocus = null;
  $("profile-lifecycle-target").value = "";
  setProfileLifecycleStatus();
  if (restoreFocus?.isConnected && typeof restoreFocus.focus === "function") {
    restoreFocus.focus();
  }
}

async function openProfileLifecycleDialog(repo, profileId, mode) {
  showError();
  if (!$("update-checker-dialog").hidden) closeUpdateCheckerDialog();
  if (!$("release-existing-dialog").hidden) closeReleaseExistingDialog();
  if (!canWriteRepo(repo)) {
    showError("需要 Contents 与 Pull requests 写权限才能管理 Profile。");
    return;
  }
  if (!["copy", "rename"].includes(mode)) return;
  if (!$("build-dialog").hidden) closeBuildDialog();
  if (!$("delete-profile-dialog").hidden) closeDeleteProfileDialog();
  if (!$("baseline-profile-dialog").hidden) closeBaselineProfileDialog();

  const requestVersion = profileLifecycleState.requestVersion + 1;
  profileLifecycleState.requestVersion = requestVersion;
  profileLifecycleState.repo = repo;
  profileLifecycleState.profileId = profileId;
  profileLifecycleState.mode = mode;
  profileLifecycleState.baseRefSha = "";
  profileLifecycleState.restoreFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const copying = mode === "copy";
  $("profile-lifecycle-eyebrow").textContent = copying ? "复制配置" : "重命名配置";
  $("profile-lifecycle-title").textContent =
    copying ? `复制 ${profileId}` : `重命名 ${profileId}`;
  $("profile-lifecycle-repo").textContent = repo.fullName;
  $("profile-lifecycle-source").textContent = profileId;
  $("profile-lifecycle-target-label").textContent =
    copying ? "新 Profile ID" : "新的 Profile ID";
  $("profile-lifecycle-target").value = copying ? `${profileId}-copy` : profileId;
  $("confirm-profile-lifecycle").disabled = true;
  $("confirm-profile-lifecycle").textContent = "正在校验…";
  setProfileLifecycleStatus("正在读取默认分支最新状态…");
  $("profile-lifecycle-dialog").hidden = false;
  document.body.classList.add("dialog-open");

  try {
    const data = await request(
      `/api/v1/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/profiles/${encodeURIComponent(profileId)}`,
      { cache: "no-store" }
    );
    if (
      requestVersion !== profileLifecycleState.requestVersion ||
      $("profile-lifecycle-dialog").hidden
    ) return;

    profileLifecycleState.baseRefSha = data.baseRefSha || "";
    setProfileLifecycleStatus(
      copying
        ? "复制会保留 7 个标准文件内容，并把内部 profiles/<旧ID>/ 路径改为新 ID。"
        : data.profile?.baseline
          ? "这是当前基准 Profile；重命名会在同一个 commit 中同步更新 profiles/.baseline。"
          : "重命名会在同一个 commit 中写入新目录并删除旧目录。"
    );
    $("confirm-profile-lifecycle").disabled = false;
    $("confirm-profile-lifecycle").textContent = copying ? "创建副本" : "重命名";
    $("profile-lifecycle-target").focus();
    $("profile-lifecycle-target").select();
  } catch (error) {
    if (
      requestVersion !== profileLifecycleState.requestVersion ||
      $("profile-lifecycle-dialog").hidden
    ) return;
    $("confirm-profile-lifecycle").disabled = true;
    setProfileLifecycleStatus(friendlyError(error), true);
  }
}

function setBaselineProfileStatus(message = "", isError = false) {
  const node = $("baseline-profile-status");
  node.hidden = !message;
  node.textContent = message;
  node.classList.toggle("error-text", Boolean(isError));
}

function closeBaselineProfileDialog() {
  baselineProfileState.requestVersion += 1;
  const restoreFocus = baselineProfileState.restoreFocus;
  $("baseline-profile-dialog").hidden = true;
  document.body.classList.remove("dialog-open");
  baselineProfileState.repo = null;
  baselineProfileState.profileId = "";
  baselineProfileState.baseRefSha = "";
  baselineProfileState.restoreFocus = null;
  setBaselineProfileStatus();
  if (restoreFocus?.isConnected && typeof restoreFocus.focus === "function") {
    restoreFocus.focus();
  }
}

async function openBaselineProfileDialog(repo, profileId) {
  showError();
  if (!$("update-checker-dialog").hidden) closeUpdateCheckerDialog();
  if (!$("release-existing-dialog").hidden) closeReleaseExistingDialog();
  if (!canWriteRepo(repo)) {
    showError("需要 Contents 与 Pull requests 写权限才能切换基准 Profile。");
    return;
  }
  if (!$("build-dialog").hidden) closeBuildDialog();
  if (!$("delete-profile-dialog").hidden) closeDeleteProfileDialog();
  if (!$("profile-lifecycle-dialog").hidden) closeProfileLifecycleDialog();

  const requestVersion = baselineProfileState.requestVersion + 1;
  baselineProfileState.requestVersion = requestVersion;
  baselineProfileState.repo = repo;
  baselineProfileState.profileId = profileId;
  baselineProfileState.baseRefSha = "";
  baselineProfileState.restoreFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

  $("baseline-profile-title").textContent = `将 ${profileId} 设为基准`;
  $("baseline-profile-repo").textContent = repo.fullName;
  $("baseline-profile-name").textContent = profileId;
  $("confirm-baseline-profile").disabled = true;
  $("confirm-baseline-profile").textContent = "正在校验…";
  setBaselineProfileStatus("正在读取默认分支最新状态…");
  $("baseline-profile-dialog").hidden = false;
  document.body.classList.add("dialog-open");
  $("baseline-profile-close").focus();

  try {
    const data = await request(
      `/api/v1/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/profiles/${encodeURIComponent(profileId)}`,
      { cache: "no-store" }
    );
    if (
      requestVersion !== baselineProfileState.requestVersion ||
      baselineProfileState.repo?.fullName !== repo.fullName ||
      baselineProfileState.profileId !== profileId ||
      $("baseline-profile-dialog").hidden
    ) {
      return;
    }

    if (data.profile?.baseline) {
      setBaselineProfileStatus("这套配置已经是当前基准 Profile。");
      $("confirm-baseline-profile").textContent = "已是基准";
      return;
    }

    baselineProfileState.baseRefSha = data.baseRefSha || "";
    setBaselineProfileStatus(
      "切换会创建独立 PR；自动合并后，未显式指定 Profile 的入口会使用这套配置。"
    );
    $("confirm-baseline-profile").disabled = false;
    $("confirm-baseline-profile").textContent = "设为基准";
  } catch (error) {
    if (
      requestVersion !== baselineProfileState.requestVersion ||
      $("baseline-profile-dialog").hidden
    ) {
      return;
    }
    $("confirm-baseline-profile").disabled = true;
    $("confirm-baseline-profile").textContent = "设为基准";
    setBaselineProfileStatus(friendlyError(error), true);
  }
}

function setDeleteProfileStatus(message = "", isError = false) {
  const node = $("delete-profile-status");
  node.hidden = !message;
  node.textContent = message;
  node.classList.toggle("error-text", Boolean(isError));
}

function closeDeleteProfileDialog() {
  deleteProfileState.requestVersion += 1;
  const restoreFocus = deleteProfileState.restoreFocus;
  $("delete-profile-dialog").hidden = true;
  document.body.classList.remove("dialog-open");
  deleteProfileState.repo = null;
  deleteProfileState.profileId = "";
  deleteProfileState.baseRefSha = "";
  deleteProfileState.restoreFocus = null;
  setDeleteProfileStatus();
  if (restoreFocus?.isConnected && typeof restoreFocus.focus === "function") {
    restoreFocus.focus();
  }
}

async function openDeleteProfileDialog(repo, profileId) {
  showError();
  if (!$("update-checker-dialog").hidden) closeUpdateCheckerDialog();
  if (!$("release-existing-dialog").hidden) closeReleaseExistingDialog();
  if (!canWriteRepo(repo)) {
    showError("需要 Contents 与 Pull requests 写权限才能删除 Profile。");
    return;
  }
  if (!$("build-dialog").hidden) closeBuildDialog();
  if (!$("baseline-profile-dialog").hidden) closeBaselineProfileDialog();
  if (!$("profile-lifecycle-dialog").hidden) closeProfileLifecycleDialog();

  const requestVersion = deleteProfileState.requestVersion + 1;
  deleteProfileState.requestVersion = requestVersion;
  deleteProfileState.repo = repo;
  deleteProfileState.profileId = profileId;
  deleteProfileState.baseRefSha = "";
  deleteProfileState.restoreFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

  $("delete-profile-title").textContent = `删除 ${profileId}`;
  $("delete-profile-repo").textContent = repo.fullName;
  $("delete-profile-name").textContent = profileId;
  $("confirm-delete-profile").disabled = true;
  $("confirm-delete-profile").textContent = "正在校验…";
  setDeleteProfileStatus("正在读取默认分支最新状态…");
  $("delete-profile-dialog").hidden = false;
  document.body.classList.add("dialog-open");
  $("delete-profile-close").focus();

  try {
    const data = await request(
      `/api/v1/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/profiles/${encodeURIComponent(profileId)}`,
      { cache: "no-store" }
    );
    if (
      requestVersion !== deleteProfileState.requestVersion ||
      deleteProfileState.repo?.fullName !== repo.fullName ||
      deleteProfileState.profileId !== profileId ||
      $("delete-profile-dialog").hidden
    ) {
      return;
    }

    if (data.profile?.baseline) {
      setDeleteProfileStatus(friendlyError("protected_profile"), true);
      $("confirm-delete-profile").disabled = true;
      $("confirm-delete-profile").textContent = "基准不可删除";
      return;
    }

    deleteProfileState.baseRefSha = data.baseRefSha || "";
    setDeleteProfileStatus(
      "删除会创建独立 PR；自动合并成功后此 Profile 将从默认分支移除。"
    );
    $("confirm-delete-profile").disabled = false;
    $("confirm-delete-profile").textContent = "创建删除 PR";
  } catch (error) {
    if (
      requestVersion !== deleteProfileState.requestVersion ||
      $("delete-profile-dialog").hidden
    ) {
      return;
    }
    $("confirm-delete-profile").disabled = true;
    $("confirm-delete-profile").textContent = "创建删除 PR";
    setDeleteProfileStatus(friendlyError(error), true);
  }
}

function buildStatusIcon(run) {
  const icon = document.createElement("span");
  icon.className = `build-status-icon ${statusClass(run)}`;
  icon.title = buildStatusLabel(run);
  icon.setAttribute("aria-label", buildStatusLabel(run));
  icon.setAttribute("role", "img");
  return icon;
}

async function controlBuilderRun(run, action, button) {
  const repo = buildState.repo || currentRepository();
  if (!repo || !canRunRepo(repo)) {
    showError("当前 GitHub App 没有 Actions 写权限，不能控制构建。");
    return;
  }
  if (!["cancel", "rerun"].includes(action)) return;

  const originalText = button?.textContent || "";
  if (button) {
    button.disabled = true;
    button.textContent = action === "cancel" ? "取消中…" : "重跑中…";
  }
  showError();

  try {
    const result = await request(
      `/api/v1/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/builds/${run.id}/${action}`,
      { method: "POST", body: "{}" }
    );
    buildState.activeRunId = Number(result.runId || run.id || 0);
    buildState.requestId = "";
    buildState.pollAttempts = 0;
    buildState.hasActiveRuns = true;
    showBuildResult(
      action === "cancel"
        ? `已请求取消构建 #${run.runNumber}，状态会自动刷新。`
        : `已请求重跑构建 #${run.runNumber}，将进入第 ${result.nextAttempt || "下一"} 次尝试。`
    );
    scheduleBuildPoll(1200, buildState.generation);
    window.setTimeout(() => {
      loadBuildRuns({ generation: buildState.generation })
        .catch((error) => showError(error));
    }, 1400);
  } catch (error) {
    showError(error);
    if (button) button.disabled = false;
  } finally {
    if (button) button.textContent = originalText;
  }
}

function renderBuildRows(root, runs, options = {}) {
  root.replaceChildren();
  const compact = Boolean(options.compact);
  const visibleRuns = compact ? runs.slice(0, 5) : runs;

  if (!visibleRuns.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state build-empty";
    const title = document.createElement("strong");
    title.textContent = buildState.requestId
      ? "正在等待 GitHub 建立运行记录"
      : "还没有构建记录";
    const detail = document.createElement("span");
    detail.textContent = buildState.requestId
      ? "请求已经提交，状态会自动刷新。"
      : "从任意配置行点击“构建”即可发起第一次构建。";
    empty.append(title, detail);
    root.appendChild(empty);
    return;
  }

  for (const run of visibleRuns) {
    const row = document.createElement("div");
    row.className = "build-record";

    const main = document.createElement("button");
    main.type = "button";
    main.className = "build-record-main";

    const status = buildStatusIcon(run);
    const copy = document.createElement("span");
    copy.className = "build-record-copy";
    const title = document.createElement("strong");
    title.textContent = `#${run.runNumber} ${buildProfileId(run)}`;

    const meta = document.createElement("span");
    meta.className = "build-record-meta";
    const time = document.createElement("span");
    time.textContent = relativeTime(run.updatedAt || run.createdAt);
    const sha = document.createElement("code");
    sha.textContent = String(run.headSha || "").slice(0, 8) || "—";
    meta.append(time, sha);
    copy.append(title, meta);
    main.append(status, copy);

    main.addEventListener("click", () => {
      showControlPlaneView("builder");
      setActiveNavigation("builder");
      loadBuildDetail(run.id)
        .then(() => scrollToPanel($("build-detail")))
        .catch((error) => showError(error));
    });

    const actions = document.createElement("span");
    actions.className = "build-record-actions";

    if (ACTIVE_BUILD_STATUSES.has(run.status)) {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "build-record-action danger-action";
      cancel.textContent = "取消";
      cancel.disabled = !canRunRepo(buildState.repo || currentRepository());
      cancel.title = cancel.disabled ? "需要 Actions 写权限" : "取消这次构建";
      cancel.addEventListener("click", () => {
        controlBuilderRun(run, "cancel", cancel).catch((error) => showError(error));
      });
      actions.appendChild(cancel);
    } else if (run.status === "completed") {
      const rerun = document.createElement("button");
      rerun.type = "button";
      rerun.className = "build-record-action";
      rerun.textContent = "重跑";
      rerun.disabled = !canRunRepo(buildState.repo || currentRepository());
      rerun.title = rerun.disabled ? "需要 Actions 写权限" : "完整重跑这次 Builder";
      rerun.addEventListener("click", () => {
        controlBuilderRun(run, "rerun", rerun).catch((error) => showError(error));
      });
      actions.appendChild(rerun);
    }

    if (run.status === "completed" && run.conclusion === "success") {
      const outputs = document.createElement("button");
      outputs.type = "button";
      outputs.className = "build-record-action";
      outputs.textContent = compact ? "产物" : "查看产物";
      outputs.addEventListener("click", () => {
        showControlPlaneView("builder");
        setActiveNavigation("builder");
        loadBuildDetail(run.id)
          .then(() => scrollToPanel($("build-detail")))
          .catch((error) => showError(error));
      });
      actions.appendChild(outputs);
    }

    const actionLink = document.createElement("a");
    actionLink.className = "build-record-action";
    actionLink.href = run.url;
    actionLink.target = "_blank";
    actionLink.rel = "noreferrer";
    actionLink.textContent = "Actions ↗";
    actions.appendChild(actionLink);

    row.append(main, actions);
    root.appendChild(row);
  }
}

async function loadBuildDetail(runId) {
  const repo = buildState.repo;
  const generation = buildState.generation;
  if (!repo || !runId) return null;

  const data = await request(
    `/api/v1/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/builds/${runId}`
  );
  if (!isCurrentBuildContext(repo, generation)) return null;
  const run = data.run;
  buildState.detailRunId = Number(run.id || runId || 0);

  $("build-detail").hidden = false;
  $("build-detail-title").textContent =
    `#${run.runNumber} ${buildProfileId(run)} · ${buildStatusLabel(run)}`;
  $("build-summary-link").href = run.summaryUrl || run.url;
  renderActionProgressCard(
    "build-detail-progress",
    run.progress,
    run,
    {
      runningTitle: "构建进行中",
      runningDetail: "进度来自本次 GitHub Actions 的真实步骤。",
      waitingTitle: "等待构建步骤",
      waitingDetail: "GitHub Job 建立后会自动显示实际构建阶段。"
    }
  );

  const jobs = $("build-jobs");
  jobs.replaceChildren();
  const jobsTitle = document.createElement("h4");
  jobsTitle.textContent = "任务";
  jobs.appendChild(jobsTitle);

  if (!run.jobs.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "暂时还没有任务信息。";
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
  artifactsTitle.textContent = "固件产物";
  artifacts.appendChild(artifactsTitle);
  const availableArtifacts = run.artifacts.filter((item) => !item.expired);

  if (!availableArtifacts.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = run.status === "completed"
      ? "本次运行没有可下载的 Artifact。"
      : "构建完成后将在这里显示固件 Artifact。";
    artifacts.appendChild(empty);
  } else {
    for (const artifact of availableArtifacts) {
      const row = document.createElement("a");
      row.className = "build-link-row output-link-row";
      row.href =
        `/api/v1/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/builds/${run.id}/artifacts/${artifact.id}/download`;
      row.target = "_blank";
      row.rel = "noreferrer";
      const strong = document.createElement("strong");
      strong.textContent = artifact.name;
      const span = document.createElement("span");
      span.textContent =
        `下载固件 ↗ · ${Math.max(1, Math.round(artifact.sizeBytes / 1024))} KiB`;
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
    link.className = "build-link-row output-link-row";
    link.href = run.release.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    const strong = document.createElement("strong");
    strong.textContent = run.release.name || run.release.tag;
    const span = document.createElement("span");
    span.textContent = run.release.recovered
      ? "恢复发布 · 打开 Release ↗"
      : "打开 Release ↗";
    link.append(strong, span);
    release.appendChild(link);
  } else if (run.releaseRecoveryEligible) {
    const recovery = document.createElement("div");
    recovery.className = "release-recovery-row";
    const copy = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = "已有构建可直接发布";
    const span = document.createElement("span");
    span.textContent = "复用已保留的 Release bundle，不重新编译。";
    copy.append(strong, span);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "button primary button-compact";
    button.textContent = "发布现有构建";
    button.disabled = !canRunRepo(repo);
    button.addEventListener("click", () => {
      openReleaseExistingDialog(repo, run);
    });
    recovery.append(copy, button);
    release.appendChild(recovery);
  } else {
    const empty = document.createElement("p");
    empty.className = "muted";
    const reasons = {
      release_bundle_missing: "本次构建没有发布 Release，且没有保留可恢复的 Release bundle。",
      release_bundle_expired: "本次构建的 Release bundle 已过期，不能直接补发。",
      build_not_successful: "只有成功完成的构建才能补发 Release。",
      release_already_exists: "本次构建已经有关联 Release。"
    };
    empty.textContent =
      run.status === "completed"
        ? (reasons[run.releaseRecoveryReason] || "本次构建没有发布 Release。")
        : "运行完成后如发布 Release，会在这里显示。";
    release.appendChild(empty);
  }

  return run;
}

function scheduleBuildPoll(delay = 15000, generation = buildState.generation) {
  clearBuildPolling();
  const repo = buildState.repo;
  if (
    !isCurrentBuildContext(repo, generation) ||
    (!buildState.hasActiveRuns && !buildState.requestId) ||
    buildState.pollAttempts >= MAX_BUILD_POLL_ATTEMPTS
  ) {
    return;
  }

  buildState.pollTimer = setTimeout(() => {
    if (!isCurrentBuildContext(repo, generation)) return;
    loadBuildRuns({ polling: true, generation }).catch((error) => {
      if (!isCurrentBuildContext(repo, generation)) return;
      buildState.pollAttempts += 1;
      showBuildResult(
        `状态刷新暂时失败，将继续自动重试：${friendlyError(error)}`
      );
      scheduleBuildPoll(5000, generation);
    });
  }, delay);
}

async function loadBuildRuns(options = {}) {
  const repo = buildState.repo;
  const generation = options.generation ?? buildState.generation;
  if (
    !repo ||
    !canReadActions(repo) ||
    !isCurrentBuildContext(repo, generation)
  ) {
    return;
  }

  const requestId = options.requestId || buildState.requestId || "";
  let requestedRunId = Number(options.runId || buildState.activeRunId || 0);

  if (requestId && !requestedRunId) {
    const lookup = await request(
      `/api/v1/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/builds?request_id=${encodeURIComponent(requestId)}&limit=1`
    );
    if (!isCurrentBuildContext(repo, generation)) return;

    if (!lookup.runs.length) {
      buildState.requestId = requestId;
      buildState.hasActiveRuns = true;
      renderActionProgressCard(
        "recent-build-progress",
        null,
        null,
        {
          force: true,
          waitingTitle: "等待 GitHub 建立运行记录",
          waitingDetail: "构建请求已经提交；运行记录出现后会自动切换到真实步骤进度。"
        }
      );
      showBuildResult("构建请求已提交，正在等待 GitHub 建立运行记录。");
      buildState.pollAttempts += 1;
      scheduleBuildPoll(2500, generation);
      return;
    }
    requestedRunId = Number(lookup.runs[0]?.id || 0);
    buildState.requestId = "";
  }

  const data = await request(
    `/api/v1/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/builds?limit=100`
  );
  if (!isCurrentBuildContext(repo, generation)) return;

  renderBuildRows($("recent-build-runs"), data.runs, { compact: true });
  renderBuildRows($("build-runs"), data.runs);

  const requestedRun = requestedRunId
    ? data.runs.find((run) => Number(run.id) === requestedRunId) || null
    : null;

  if (requestId && requestedRunId && !requestedRun) {
    buildState.requestId = requestId;
    buildState.activeRunId = requestedRunId;
    buildState.hasActiveRuns = true;
    renderActionProgressCard(
      "recent-build-progress",
      null,
      { id: requestedRunId, url: options.runUrl || "" },
      {
        force: true,
        waitingTitle: "等待 GitHub 同步运行记录",
        waitingDetail: "已经拿到 Run ID；GitHub 列表接口同步后会自动显示真实构建步骤。"
      }
    );
    showBuildResult("构建已建立，正在等待 GitHub 同步运行详情。");
    buildState.pollAttempts += 1;
    scheduleBuildPoll(2500, generation);
    return;
  }

  if (requestedRun) {
    buildState.requestId = "";
  }

  const activeRun =
    requestedRun ||
    data.runs.find((run) => ACTIVE_BUILD_STATUSES.has(run.status)) ||
    null;

  buildState.hasActiveRuns = Boolean(
    activeRun && ACTIVE_BUILD_STATUSES.has(activeRun.status)
  );
  buildState.activeRunId = buildState.hasActiveRuns
    ? Number(activeRun.id || 0)
    : 0;
  buildState.pollAttempts = options.polling
    ? buildState.pollAttempts + 1
    : 0;

  if (buildState.hasActiveRuns && activeRun) {
    const detailData = await request(
      `/api/v1/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/builds/${activeRun.id}`
    );
    if (!isCurrentBuildContext(repo, generation)) return;
    const detailedRun = detailData.run;
    renderActionProgressCard(
      "recent-build-progress",
      detailedRun.progress,
      detailedRun,
      {
        runningTitle: "构建进行中",
        runningDetail: "当前页面会持续读取本次 GitHub Actions 的真实构建步骤。"
      }
    );
    if (buildState.detailRunId === Number(activeRun.id)) {
      await loadBuildDetail(activeRun.id);
    }
    showBuildResult("构建正在运行，真实步骤进度会自动刷新。");
    scheduleBuildPoll(5000, generation);
  } else {
    buildState.requestId = "";
    buildState.activeRunId = 0;
    renderActionProgressCard("recent-build-progress", null, null);
    showBuildResult();
    clearBuildPolling();
  }
}

async function setupBuildHistory(repo) {
  clearBuildPolling();
  const generation = buildState.generation + 1;
  buildState.generation = generation;
  buildState.repo = repo;
  buildState.requestId = "";
  buildState.pollAttempts = 0;
  buildState.hasActiveRuns = false;
  buildState.activeRunId = 0;
  buildState.detailRunId = 0;

  $("recent-build-card").hidden = false;
  $("build-card").hidden = true;
  $("build-detail").hidden = true;
  renderActionProgressCard("recent-build-progress", null, null);
  renderActionProgressCard("build-detail-progress", null, null);
  showBuildResult();
  renderBuildHistoryState("正在读取构建历史", "正在从 GitHub Actions 获取运行记录…");

  if (!canReadActions(repo)) {
    renderBuildHistoryState(
      "无法读取构建历史",
      "GitHub App 需要 Actions 读取权限。"
    );
    return;
  }

  try {
    await loadBuildRuns({ generation });
  } catch (error) {
    if (!isCurrentBuildContext(repo, generation)) return;
    renderBuildHistoryState(
      "构建历史暂时不可用",
      friendlyError(error)
    );
  }
}

async function openProfile(repo, profileId, options = {}) {
  showError();
  showWriteResult();
  $("new-profile-card").hidden = true;
  $("editor-card").hidden = true;
  invalidateNewProfilePreview();

  const loadVersion = editorState.loadVersion + 1;
  editorState.loadVersion = loadVersion;
  const data = await request(
    `/api/v1/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/profiles/${encodeURIComponent(profileId)}`
  );
  if (
    loadVersion !== editorState.loadVersion ||
    currentRepository()?.fullName !== repo.fullName
  ) {
    return;
  }

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
  $("editor-title").textContent = `编辑配置 · ${profileId}`;
  $("editor-meta").textContent =
    `基线：${data.defaultBranch}@${data.baseRefSha.slice(0, 12)} · 保存时创建独立 PR 并自动合并；受仓库规则阻止时保留 PR`;

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

  if (options.activateNavigation !== false) {
    showControlPlaneView("profiles");
    setActiveNavigation("profiles");
  }
  if (options.scroll !== false) {
    scrollToPanel($("editor-card"));
  }
}

async function restoreDeletedProfile(repo, profile, button) {
  if (!canWriteRepo(repo)) {
    showError("需要 Contents 与 Pull requests 写权限才能恢复 Profile。");
    return;
  }
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "恢复中…";
  showError();
  try {
    const result = await request(
      `/api/v1/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/profiles/${encodeURIComponent(profile.id)}/restore`,
      {
        method: "POST",
        body: JSON.stringify({
          deletionCommitSha: profile.deletionCommitSha
        })
      }
    );
    const resultMessage = profileWriteResultMessage(
      result,
      "Profile " + profile.id + " 恢复"
    );
    if (repositoryState.selectedFullName === repo.fullName) {
      await loadProfiles(repo, repositoryState.selectionVersion, {
        forceRefresh: true,
        focusProfileId: profile.id,
        resultMessage,
        resultUrl: result.pullRequest?.url || ""
      });
    }
  } catch (error) {
    showError(error);
    button.disabled = false;
    button.textContent = original;
  }
}

async function loadDeletedProfiles(repo, selectionVersion) {
  const section = $("deleted-profiles-section");
  const root = $("deleted-profiles");
  section.hidden = true;
  root.replaceChildren();

  let data;
  try {
    data = await request(
      `/api/v1/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/profiles/deleted?limit=10`,
      { cache: "no-store" }
    );
  } catch (error) {
    if (
      selectionVersion !== repositoryState.selectionVersion ||
      repositoryState.selectedFullName !== repo.fullName
    ) return;
    console.warn("Deleted Profile history unavailable", error);
    return;
  }

  if (
    selectionVersion !== repositoryState.selectionVersion ||
    repositoryState.selectedFullName !== repo.fullName
  ) return;

  const profiles = Array.isArray(data.profiles) ? data.profiles : [];
  if (!profiles.length) return;

  for (const profile of profiles) {
    const row = document.createElement("div");
    row.className = "profile-item deleted-profile-item";

    const leading = document.createElement("span");
    leading.className = "list-leading";
    const icon = document.createElement("span");
    icon.className = "list-icon deleted-list-icon";
    icon.innerHTML = iconSvg("restore");
    const copy = document.createElement("span");
    copy.className = "list-copy";
    const strong = document.createElement("strong");
    strong.textContent = profile.id;
    const meta = document.createElement("small");
    meta.textContent =
      `删除于 ${relativeTime(profile.deletedAt)} · ${String(profile.deletionCommitSha || "").slice(0, 8)}`;
    copy.append(strong, meta);
    leading.append(icon, copy);

    const actions = document.createElement("span");
    actions.className = "profile-row-actions";
    const restore = document.createElement("button");
    restore.type = "button";
    restore.className = "profile-restore-action";
    restore.textContent = "恢复";
    restore.disabled = !canWriteRepo(repo);
    restore.title = restore.disabled
      ? "需要 Contents 与 Pull requests 写权限"
      : "从删除前快照恢复 7 个标准文件";
    restore.addEventListener("click", () => {
      restoreDeletedProfile(repo, profile, restore)
        .catch((error) => showError(error));
    });
    actions.appendChild(restore);

    if (profile.commitUrl) {
      const history = document.createElement("a");
      history.className = "profile-history-link";
      history.href = profile.commitUrl;
      history.target = "_blank";
      history.rel = "noreferrer";
      history.textContent = "删除记录 ↗";
      actions.appendChild(history);
    }

    row.append(leading, actions);
    root.appendChild(row);
  }
  section.hidden = false;
}

async function loadProfiles(repo, selectionVersion, options = {}) {
  showError();
  if (!$("update-checker-dialog").hidden) closeUpdateCheckerDialog();
  if (!$("release-existing-dialog").hidden) closeReleaseExistingDialog();
  clearBuildPolling();
  editorState.loadVersion += 1;
  createState.repo = repo;
  if (!$("build-dialog").hidden) closeBuildDialog();
  if (!$("delete-profile-dialog").hidden) closeDeleteProfileDialog();
  if (!$("baseline-profile-dialog").hidden) closeBaselineProfileDialog();
  if (!$("profile-lifecycle-dialog").hidden) closeProfileLifecycleDialog();
  $("repo-switcher").value = repo.fullName;
  $("workspace-empty").hidden = true;
  $("editor-card").hidden = true;
  $("new-profile-card").hidden = true;
  updateRepositoryContext(repo);
  showControlPlaneView("workspace");
  setActiveNavigation("workspace");

  $("new-profile-open").disabled = !canWriteRepo(repo);
  $("new-profile-open").title = canWriteRepo(repo)
    ? "通过 Pull Request 新建标准 Profile"
    : "需要 Contents 与 Pull requests 写权限";
  $("update-checker-open").disabled = !canRunRepo(repo);
  $("update-checker-open").title = canRunRepo(repo)
    ? "手动触发 OpenWrt NG Update Checker"
    : "需要 Actions 写权限";

  $("profile-card").hidden = false;
  $("profile-title").textContent = "配置";
  const root = $("profiles");
  showProfileListResult();
  root.replaceChildren(
    buildStateMessage("正在读取配置", "正在从当前仓库读取 Profile…")
  );

  let data;
  try {
    data = await request(
      `/api/v1/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/profiles`,
      options.forceRefresh ? { cache: "no-store" } : {}
    );
  } catch (error) {
    if (
      selectionVersion !== repositoryState.selectionVersion ||
      repositoryState.selectedFullName !== repo.fullName
    ) {
      return;
    }
    root.replaceChildren(
      buildStateMessage("配置暂时不可用", friendlyError(error))
    );
    await setupBuildHistory(repo);
    return;
  }

  if (
    selectionVersion !== repositoryState.selectionVersion ||
    repositoryState.selectedFullName !== repo.fullName
  ) {
    return;
  }

  root.replaceChildren();

  let focusedRow = null;

  if (!data.profiles.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const title = document.createElement("strong");
    title.textContent = "还没有配置";
    const detail = document.createElement("span");
    detail.textContent = "新建一套标准 Profile 配置后即可开始构建。";
    empty.append(title, detail);
    root.appendChild(empty);
  } else {
    for (const profile of data.profiles) {
      const row = document.createElement("div");
      row.className = "profile-item";
      row.dataset.profileId = profile.id;
      if (profile.id === options.focusProfileId) {
        row.classList.add("profile-item-refreshed");
        focusedRow = row;
      }

      const openButton = document.createElement("button");
      openButton.type = "button";
      openButton.className = "profile-open";

      const leading = document.createElement("span");
      leading.className = "list-leading";
      const icon = document.createElement("span");
      icon.className = "list-icon";
      icon.innerHTML = iconSvg("profile");
      const copy = document.createElement("span");
      copy.className = "list-copy";
      const nameLine = document.createElement("span");
      nameLine.className = "profile-name-line";
      const strong = document.createElement("strong");
      strong.textContent = profile.id;
      nameLine.appendChild(strong);
      if (profile.baseline) {
        const badge = document.createElement("span");
        badge.className = "profile-baseline-badge";
        badge.textContent = "基准";
        nameLine.appendChild(badge);
      }
      const meta = document.createElement("small");
      meta.textContent = profile.path;
      copy.append(nameLine, meta);
      leading.append(icon, copy);

      const arrow = document.createElement("span");
      arrow.className = "profile-open-arrow";
      arrow.innerHTML = iconSvg("arrow");
      openButton.append(leading, arrow);
      openButton.addEventListener("click", () => {
        openProfile(repo, profile.id).catch((error) => showError(error));
      });

      const buildButton = document.createElement("button");
      buildButton.type = "button";
      buildButton.className = "profile-build-action";
      buildButton.textContent = "构建";
      buildButton.title = `构建 ${profile.id}`;
      buildButton.addEventListener("click", () => {
        openBuildDialog(repo, profile.id).catch((error) => showError(error));
      });

      const actions = document.createElement("span");
      actions.className = "profile-row-actions";
      actions.appendChild(buildButton);

      const updateButton = document.createElement("button");
      updateButton.type = "button";
      updateButton.className = "profile-update-action";
      updateButton.innerHTML = iconSvg("refresh");
      updateButton.setAttribute("aria-label", `检查 ${profile.id} 上游更新`);
      updateButton.disabled = !canRunRepo(repo);
      updateButton.title = updateButton.disabled
        ? "需要 Actions 写权限"
        : `手动运行 Update Checker · ${profile.id}`;
      updateButton.addEventListener("click", () => {
        openUpdateCheckerDialog(repo, profile.id)
          .catch((error) => showError(error));
      });
      actions.appendChild(updateButton);

      const copyButton = document.createElement("button");
      copyButton.type = "button";
      copyButton.className = "profile-copy-action";
      copyButton.innerHTML = iconSvg("copy");
      copyButton.setAttribute("aria-label", `复制 ${profile.id}`);
      copyButton.disabled = !canWriteRepo(repo);
      copyButton.title = canWriteRepo(repo)
        ? `复制 ${profile.id}`
        : "需要 Contents 与 Pull requests 写权限";
      copyButton.addEventListener("click", () => {
        openProfileLifecycleDialog(repo, profile.id, "copy")
          .catch((error) => showError(error));
      });
      actions.appendChild(copyButton);

      const renameButton = document.createElement("button");
      renameButton.type = "button";
      renameButton.className = "profile-rename-action";
      renameButton.innerHTML = iconSvg("rename");
      renameButton.setAttribute("aria-label", `重命名 ${profile.id}`);
      renameButton.disabled = !canWriteRepo(repo);
      renameButton.title = canWriteRepo(repo)
        ? `重命名 ${profile.id}`
        : "需要 Contents 与 Pull requests 写权限";
      renameButton.addEventListener("click", () => {
        openProfileLifecycleDialog(repo, profile.id, "rename")
          .catch((error) => showError(error));
      });
      actions.appendChild(renameButton);

      const baselineButton = document.createElement("button");
      baselineButton.type = "button";
      baselineButton.className = "profile-baseline-action";
      baselineButton.innerHTML = iconSvg("star");
      baselineButton.setAttribute(
        "aria-label",
        profile.baseline ? `${profile.id} 已是基准` : `将 ${profile.id} 设为基准`
      );
      baselineButton.disabled = Boolean(profile.baseline) || !canWriteRepo(repo);
      baselineButton.title = profile.baseline
        ? "当前基准 Profile"
        : canWriteRepo(repo)
          ? `将 ${profile.id} 设为基准 Profile`
          : "需要 Contents 与 Pull requests 写权限";
      baselineButton.addEventListener("click", () => {
        openBaselineProfileDialog(repo, profile.id).catch((error) => showError(error));
      });
      actions.appendChild(baselineButton);

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "profile-delete-action";
      deleteButton.innerHTML = iconSvg("trash");
      deleteButton.setAttribute("aria-label", `删除 ${profile.id}`);
      deleteButton.disabled = Boolean(profile.baseline) || !canWriteRepo(repo);
      deleteButton.title = profile.baseline
        ? "当前基准 Profile 不可删除，请先切换基准"
        : canWriteRepo(repo)
          ? `删除 ${profile.id}`
          : "需要 Contents 与 Pull requests 写权限";
      deleteButton.addEventListener("click", () => {
        openDeleteProfileDialog(repo, profile.id).catch((error) => showError(error));
      });
      actions.appendChild(deleteButton);

      row.append(openButton, actions);
      root.appendChild(row);
    }
  }

  if (options.resultMessage) {
    showProfileListResult(options.resultMessage, options.resultUrl || "");
  }
  if (focusedRow) {
    requestAnimationFrame(() => {
      focusedRow.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    window.setTimeout(
      () => focusedRow.classList.remove("profile-item-refreshed"),
      2600
    );
  }

  await loadDeletedProfiles(repo, selectionVersion);
  await setupBuildHistory(repo);
  return data.profiles;
}

async function selectRepository(repo) {
  if (!repo) return;
  const selectionVersion = repositoryState.selectionVersion + 1;
  repositoryState.selectionVersion = selectionVersion;
  repositoryState.selectedFullName = repo.fullName;
  await loadProfiles(repo, selectionVersion);
}


function clearConfigStudioPolling() {
  if (configStudioState.pollTimer) {
    clearTimeout(configStudioState.pollTimer);
    configStudioState.pollTimer = null;
  }
}

function configStudioBasePath(repo) {
  return (
    "/api/v1/repositories/" +
    encodeURIComponent(repo.owner) +
    "/" +
    encodeURIComponent(repo.name) +
    "/config-studio"
  );
}

function setConfigStudioError(message = "") {
  const node = $("config-studio-error");
  const text = friendlyError(message);
  node.hidden = !text;
  node.textContent = text;
}

function setConfigStudioStatus(title, detail = "") {
  $("config-studio-status").textContent = title;
  $("config-studio-status-detail").textContent = detail;
}

function actionElapsed(startedAt) {
  const started = Date.parse(String(startedAt || ""));
  if (!Number.isFinite(started)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
  if (seconds < 60) return `已用时 ${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remain = seconds % 60;
  return `已用时 ${minutes} 分 ${String(remain).padStart(2, "0")} 秒`;
}

function resetConfigStudioProgress(mode = "catalog") {
  const resolving = mode === "resolve";
  $("config-studio-progress-title").textContent = resolving
    ? "等待依赖检查任务"
    : "等待 GitHub Runner";
  $("config-studio-progress-detail").textContent = resolving
    ? "正在等待新的 resolve Action 建立运行记录。"
    : "正在建立本次配置任务，随后会显示真实 Action 步骤。";
  $("config-studio-progress-count").textContent = "准备中";
  $("config-studio-progress-elapsed").textContent = "";
  $("config-studio-progress-bar").style.width = "0%";
  $("config-studio-progress-track").setAttribute("aria-valuenow", "0");
  $("config-studio-progress-steps").replaceChildren();
}

function renderConfigStudioProgress(progress, run, mode = "catalog") {
  if (!progress || !Array.isArray(progress.steps) || !progress.steps.length) {
    resetConfigStudioProgress(mode);
    if (run?.startedAt) {
      $("config-studio-progress-elapsed").textContent =
        actionElapsed(run.startedAt);
    }
    return;
  }

  const current = progress.failed || progress.current || "处理中";
  $("config-studio-progress-title").textContent = current;
  $("config-studio-progress-detail").textContent = progress.failed
    ? "后台步骤失败，请展开“后台运行详情”查看 Actions 日志。"
    : current === "更新 Feeds" || current === "安装 Feeds"
      ? "Feeds 数量较多时这一阶段通常最久；页面会继续自动更新。"
      : "进度来自当前 GitHub Actions 的真实 job steps。";
  $("config-studio-progress-count").textContent =
    `已完成 ${progress.completed} / ${progress.total} 步`;
  $("config-studio-progress-elapsed").textContent =
    actionElapsed(run?.startedAt);

  const percent = Math.max(
    0,
    Math.min(100, Number(progress.percent || 0))
  );
  $("config-studio-progress-bar").style.width = percent + "%";
  $("config-studio-progress-track").setAttribute(
    "aria-valuenow",
    String(percent)
  );

  const root = $("config-studio-progress-steps");
  root.replaceChildren();
  for (const step of progress.steps) {
    const node = document.createElement("div");
    node.className = "config-studio-progress-step";
    if (
      step.status === "completed" &&
      step.conclusion &&
      !["success", "skipped", "neutral"].includes(step.conclusion)
    ) {
      node.classList.add("failed");
    } else if (step.status === "completed") {
      node.classList.add("done");
    } else if (step.status === "in_progress") {
      node.classList.add("running");
    }
    node.textContent = step.name;
    root.appendChild(node);
  }
}

function renderActionProgressCard(rootId, progress, run, options = {}) {
  const root = $(rootId);
  if (!root) return;

  const hasProgress =
    progress && Array.isArray(progress.steps) && progress.steps.length;
  if (!hasProgress && !run && !options.force) {
    root.hidden = true;
    root.replaceChildren();
    return;
  }

  root.hidden = false;
  root.replaceChildren();

  const head = document.createElement("div");
  head.className = "action-progress-head";
  const copy = document.createElement("div");
  copy.className = "action-progress-copy";
  const title = document.createElement("strong");
  const detail = document.createElement("span");

  if (hasProgress) {
    title.textContent =
      progress.failed || progress.current || options.runningTitle || "处理中";
    if (progress.failed) {
      detail.textContent =
        `失败步骤：${progress.currentDetail || progress.failed}。可打开 Actions 查看日志。`;
    } else if (progress.currentDetail && progress.currentDetail !== progress.current) {
      detail.textContent = `当前 GitHub 步骤：${progress.currentDetail}`;
    } else {
      detail.textContent =
        options.runningDetail || "进度来自当前 GitHub Actions 的真实步骤。";
    }
  } else {
    title.textContent = options.waitingTitle || "等待 GitHub Runner";
    detail.textContent =
      options.waitingDetail || "运行记录建立后会自动显示真实步骤。";
  }
  copy.append(title, detail);
  head.appendChild(copy);

  if (run?.url) {
    const link = document.createElement("a");
    link.className = "text-link action-progress-link";
    link.href = run.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = "Actions ↗";
    head.appendChild(link);
  }
  root.appendChild(head);

  const progressBox = document.createElement("div");
  progressBox.className = "config-studio-progress";
  const meta = document.createElement("div");
  meta.className = "config-studio-progress-meta";
  const count = document.createElement("strong");
  const elapsed = document.createElement("span");
  count.textContent = hasProgress
    ? `已完成 ${progress.completed} / ${progress.total} 步`
    : "准备中";
  elapsed.textContent = actionElapsed(run?.startedAt || run?.runStartedAt);
  meta.append(count, elapsed);

  const track = document.createElement("div");
  track.className = "config-studio-progress-track";
  track.setAttribute("role", "progressbar");
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", "100");
  const percent = hasProgress
    ? Math.max(0, Math.min(100, Number(progress.percent || 0)))
    : 0;
  track.setAttribute("aria-valuenow", String(percent));
  const bar = document.createElement("span");
  bar.style.width = percent + "%";
  track.appendChild(bar);

  const steps = document.createElement("div");
  steps.className = "config-studio-progress-steps";
  if (hasProgress) {
    for (const step of progress.steps) {
      const node = document.createElement("div");
      node.className = "config-studio-progress-step";
      if (
        step.status === "completed" &&
        step.conclusion &&
        !["success", "skipped", "neutral"].includes(step.conclusion)
      ) {
        node.classList.add("failed");
      } else if (step.status === "completed") {
        node.classList.add("done");
      } else if (step.status === "in_progress") {
        node.classList.add("running");
      }
      node.textContent = step.name;
      steps.appendChild(node);
    }
  }

  progressBox.append(meta, track, steps);
  root.appendChild(progressBox);
}

function setConfigStudioStep(step) {
  for (const node of document.querySelectorAll("[data-config-step]")) {
    const value = Number(node.dataset.configStep || 0);
    node.classList.toggle("active", value === step);
    node.classList.toggle("done", value < step);
  }
}

function currentConfigStudioTarget() {
  return (configStudioState.catalog?.targets || []).find(
    (item) => item.id === configStudioState.targetId
  ) || null;
}

function currentConfigStudioSubtarget() {
  return (currentConfigStudioTarget()?.subtargets || []).find(
    (item) => item.id === configStudioState.subtargetId
  ) || null;
}

function currentConfigStudioDevice() {
  return (currentConfigStudioSubtarget()?.devices || []).find(
    (item) => item.profileId === configStudioState.deviceProfileId
  ) || null;
}

function pickConfigStudioTargetSelection(force = false) {
  const targets = configStudioState.catalog?.targets || [];
  if (!targets.length) return;

  let target = !force
    ? targets.find((item) => item.id === configStudioState.targetId)
    : null;
  target ||= targets.find((item) => item.selected) || targets[0];
  configStudioState.targetId = target?.id || "";

  const subtargets = target?.subtargets || [];
  let subtarget = !force
    ? subtargets.find((item) => item.id === configStudioState.subtargetId)
    : null;
  subtarget ||= subtargets.find((item) => item.selected) || subtargets[0];
  configStudioState.subtargetId = subtarget?.id || "";

  const devices = subtarget?.devices || [];
  let device = !force
    ? devices.find(
        (item) => item.profileId === configStudioState.deviceProfileId
      )
    : null;
  device ||= devices.find((item) => item.selected) || devices[0] || null;
  configStudioState.deviceProfileId = device?.profileId || "";

  if (!configStudioState.baselineTargetId) {
    configStudioState.baselineTargetId = target?.id || "";
    configStudioState.baselineSubtargetId = subtarget?.id || "";
    configStudioState.baselineDeviceProfileId = device?.profileId || "";
  }
}

function renderConfigStudioTargetSelectors() {
  const targets = configStudioState.catalog?.targets || [];
  const targetSelect = $("config-studio-target");
  const subtargetSelect = $("config-studio-subtarget");
  const deviceSelect = $("config-studio-device");

  targetSelect.replaceChildren();
  for (const target of targets) {
    const option = document.createElement("option");
    option.value = target.id;
    option.textContent = target.name
      ? target.name + " · " + target.id
      : target.id;
    targetSelect.appendChild(option);
  }
  targetSelect.value = configStudioState.targetId;

  const target = currentConfigStudioTarget();
  subtargetSelect.replaceChildren();
  for (const subtarget of target?.subtargets || []) {
    const option = document.createElement("option");
    option.value = subtarget.id;
    option.textContent = subtarget.id
      ? (subtarget.name || subtarget.id) + " · " + subtarget.id
      : subtarget.name || "Default";
    subtargetSelect.appendChild(option);
  }
  subtargetSelect.value = configStudioState.subtargetId;
  subtargetSelect.disabled = (target?.subtargets || []).length <= 1;

  const subtarget = currentConfigStudioSubtarget();
  deviceSelect.replaceChildren();
  const devices = subtarget?.devices || [];
  if (!devices.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Default";
    deviceSelect.appendChild(option);
  } else {
    for (const device of devices) {
      const option = document.createElement("option");
      option.value = device.profileId;
      option.textContent =
        (device.name || device.id || device.profileId) +
        (device.broken ? " · BROKEN" : "");
      option.disabled = Boolean(device.broken);
      deviceSelect.appendChild(option);
    }
  }
  deviceSelect.value = configStudioState.deviceProfileId;
  deviceSelect.disabled = devices.length <= 1;
}

function configStudioOptionValue(symbol, fallback = "n") {
  return configStudioState.modifiedValues.has(symbol)
    ? String(configStudioState.modifiedValues.get(symbol))
    : String(fallback ?? "n");
}

function configStudioTristateRank(value) {
  return value === "y" ? 2 : value === "m" ? 1 : 0;
}

function configStudioMaxTristate(left, right) {
  return configStudioTristateRank(left) >= configStudioTristateRank(right)
    ? left
    : right;
}

function configStudioDependencyConditionValue(name) {
  const symbol = "CONFIG_" + name;
  if (configStudioState.modifiedValues.has(symbol)) {
    return String(configStudioState.modifiedValues.get(symbol));
  }

  for (const pkg of configStudioState.catalog?.packages || []) {
    if (pkg.symbol === symbol) return String(pkg.value || "n");
    for (const option of pkg.configOptions || []) {
      if (option.symbol === symbol) return String(option.value || "n");
    }
  }
  for (const feature of configStudioState.catalog?.features || []) {
    if (feature.symbol === symbol) return String(feature.value || "n");
  }

  return String(
    configStudioState.catalog?.dependencyConditionValues?.[name] || "n"
  );
}

function configStudioDependencyConditionMatches(condition) {
  const source = String(condition || "").trim();
  if (!source) return true;

  const compact = source.replace(/\s+/g, "");
  const tokens = compact.match(
    /&&|\|\||!|\(|\)|[A-Za-z_][A-Za-z0-9_.+@/-]*/g
  );
  if (!tokens || tokens.join("") !== compact) return false;

  let index = 0;
  const primary = () => {
    const token = tokens[index];
    if (token === "(") {
      index += 1;
      const value = parseOr();
      if (tokens[index] !== ")") throw new Error("dependency expression");
      index += 1;
      return value;
    }
    if (!token || !/^[A-Za-z_][A-Za-z0-9_.+@/-]*$/.test(token)) {
      throw new Error("dependency expression");
    }
    index += 1;
    return ["y", "m"].includes(configStudioDependencyConditionValue(token));
  };
  const parseNot = () => {
    if (tokens[index] === "!") {
      index += 1;
      return !parseNot();
    }
    return primary();
  };
  const parseAnd = () => {
    let value = parseNot();
    while (tokens[index] === "&&") {
      index += 1;
      value = parseNot() && value;
    }
    return value;
  };
  const parseOr = () => {
    let value = parseAnd();
    while (tokens[index] === "||") {
      index += 1;
      value = parseAnd() || value;
    }
    return value;
  };

  try {
    const value = parseOr();
    return index === tokens.length ? value : false;
  } catch {
    return false;
  }
}

function configStudioDependencyRequiredValue(parentValue, pkg) {
  const assignable = Array.isArray(pkg.assignable)
    ? pkg.assignable
    : ["n", "m", "y"];
  if (parentValue === "y") {
    if (assignable.includes("y")) return "y";
    if (assignable.includes("m")) return "m";
  }
  if (parentValue === "m") {
    if (assignable.includes("m")) return "m";
    if (assignable.includes("y")) return "y";
  }
  return "n";
}

function computeConfigStudioDependencyLocks() {
  const packages = configStudioState.catalog?.packages || [];
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const effective = new Map();
  const queue = [];
  const processedRank = new Map();
  const locks = new Map();

  for (const pkg of packages) {
    const value = configStudioOptionValue(pkg.symbol, pkg.value);
    effective.set(pkg.name, value);
    if (configStudioTristateRank(value) > 0) queue.push(pkg.name);
  }

  while (queue.length) {
    const parentName = queue.shift();
    const parent = byName.get(parentName);
    if (!parent) continue;
    const parentValue = effective.get(parentName) || "n";
    const rank = configStudioTristateRank(parentValue);
    if (rank <= (processedRank.get(parentName) || 0)) continue;
    processedRank.set(parentName, rank);

    for (const rule of parent.dependencyRules || []) {
      if (!configStudioDependencyConditionMatches(rule.condition)) continue;
      const dependency = byName.get(rule.package);
      if (!dependency) continue;

      const requiredValue = configStudioDependencyRequiredValue(
        parentValue,
        dependency
      );
      if (configStudioTristateRank(requiredValue) <= 0) continue;

      const existing = locks.get(dependency.symbol) || {
        package: dependency.name,
        value: "n",
        requiredBy: new Set()
      };
      existing.value = configStudioMaxTristate(
        existing.value,
        requiredValue
      );
      existing.requiredBy.add(parent.name);
      locks.set(dependency.symbol, existing);

      const currentEffective = effective.get(dependency.name) || "n";
      const nextEffective = configStudioMaxTristate(
        currentEffective,
        requiredValue
      );
      if (nextEffective !== currentEffective) {
        effective.set(dependency.name, nextEffective);
        queue.push(dependency.name);
      }
    }
  }

  configStudioState.dependencyLocks = new Map(
    [...locks].map(([symbol, item]) => [
      symbol,
      {
        package: item.package,
        value: item.value,
        requiredBy: [...item.requiredBy].sort()
      }
    ])
  );
  return configStudioState.dependencyLocks;
}

function configStudioPackageDisplayValue(pkg, lock = null) {
  const manual = configStudioOptionValue(pkg.symbol, pkg.value);
  return lock ? configStudioMaxTristate(manual, lock.value) : manual;
}

function configStudioEffectiveModifiedEntries() {
  computeConfigStudioDependencyLocks();
  return [...configStudioState.modifiedValues].filter(([symbol, value]) => {
    const lock = configStudioState.dependencyLocks.get(symbol);
    return (
      !lock ||
      configStudioTristateRank(String(value)) >=
        configStudioTristateRank(lock.value)
    );
  });
}

function renderConfigStudioDependencySummary() {
  const node = $("config-studio-dependency-summary");
  const count = $("config-studio-dependency-count");
  const button = $("config-studio-show-dependencies");
  const locks = configStudioState.dependencyLocks;
  const total = locks.size;

  if (!total && configStudioState.dependencyOnly) {
    configStudioState.dependencyOnly = false;
  }
  node.hidden = total === 0;
  count.textContent =
    total +
    " 项依赖已联动锁定";
  button.textContent = configStudioState.dependencyOnly
    ? "返回分类浏览"
    : "查看联动项";
  button.setAttribute("aria-pressed", String(configStudioState.dependencyOnly));
}

function setConfigStudioModifiedValue(symbol, value) {
  configStudioState.modifiedValues.set(symbol, String(value));
  updateConfigStudioChangeCount();
  persistNewConfigStudioUi();
}

function updateConfigStudioChangeCount() {
  let targetChanges = 0;
  if (
    configStudioState.targetId &&
    configStudioState.targetId !== configStudioState.baselineTargetId
  ) {
    targetChanges += 1;
  }
  if (
    configStudioState.subtargetId !==
    configStudioState.baselineSubtargetId
  ) {
    targetChanges += 1;
  }
  if (
    configStudioState.deviceProfileId !==
    configStudioState.baselineDeviceProfileId
  ) {
    targetChanges += 1;
  }
  $("config-studio-change-count").textContent = String(
    configStudioEffectiveModifiedEntries().length + targetChanges
  );
}

function configStudioMenuLabel(value) {
  return String(value || "").replace(/^\s*\d+\.\s*/, "").trim();
}

function renderConfigStudioPackageCategories() {
  const select = $("config-studio-category");
  const previous = select.value || "";
  select.replaceChildren();

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "选择一级分类…";
  select.appendChild(placeholder);

  for (const category of configStudioState.catalog?.packageCategories || []) {
    const option = document.createElement("option");
    option.value = category;
    option.textContent = configStudioMenuLabel(category) || category;
    select.appendChild(option);
  }
  select.value = [...select.options].some((item) => item.value === previous)
    ? previous
    : "";
  renderConfigStudioPackageSubmenus();
}

function renderConfigStudioPackageSubmenus() {
  const select = $("config-studio-submenu");
  const category = $("config-studio-category").value || "";
  const previous = select.value || "";
  select.replaceChildren();

  const all = document.createElement("option");
  all.value = "";
  all.textContent = category ? "全部二级菜单" : "先选择一级分类";
  select.appendChild(all);

  const values = [
    ...new Set(
      (configStudioState.catalog?.packages || [])
        .filter(
          (pkg) =>
            (pkg.visible || pkg.selected) &&
            (!category || pkg.category === category)
        )
        .map((pkg) => String(pkg.submenu || "").trim())
        .filter(Boolean)
    )
  ].sort((a, b) =>
    configStudioMenuLabel(a).localeCompare(
      configStudioMenuLabel(b),
      "zh-Hans-CN",
      { numeric: true }
    )
  );

  for (const submenu of values) {
    const option = document.createElement("option");
    option.value = submenu;
    option.textContent = configStudioMenuLabel(submenu) || submenu;
    select.appendChild(option);
  }

  select.disabled = !category || !values.length;
  select.value = [...select.options].some((item) => item.value === previous)
    ? previous
    : "";
}

function configStudioFeatureMenuPath(feature) {
  return (feature.menuPath || [])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function renderConfigStudioFeatureMenus() {
  const menu = $("config-studio-feature-menu");
  const previousMenu = menu.value || "";
  menu.replaceChildren();

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "选择一级菜单…";
  menu.appendChild(placeholder);

  const firstLevels = [
    ...new Set(
      (configStudioState.catalog?.features || [])
        .filter((feature) => feature.visible)
        .map((feature) => configStudioFeatureMenuPath(feature)[0] || "其他")
    )
  ].sort((a, b) =>
    configStudioMenuLabel(a).localeCompare(
      configStudioMenuLabel(b),
      "zh-Hans-CN",
      { numeric: true }
    )
  );

  for (const item of firstLevels) {
    const option = document.createElement("option");
    option.value = item;
    option.textContent = configStudioMenuLabel(item) || item;
    menu.appendChild(option);
  }

  menu.value = [...menu.options].some((item) => item.value === previousMenu)
    ? previousMenu
    : "";
  renderConfigStudioFeatureSubmenus();
}

function renderConfigStudioFeatureSubmenus() {
  const menu = $("config-studio-feature-menu");
  const submenu = $("config-studio-feature-submenu");
  const firstLevel = menu.value || "";
  const previous = submenu.value || "";
  submenu.replaceChildren();

  const all = document.createElement("option");
  all.value = "";
  all.textContent = firstLevel ? "全部二级菜单" : "先选择一级菜单";
  submenu.appendChild(all);

  const values = new Set();
  let hasDirect = false;
  for (const feature of configStudioState.catalog?.features || []) {
    if (!feature.visible) continue;
    const path = configStudioFeatureMenuPath(feature);
    const level1 = path[0] || "其他";
    if (firstLevel && level1 !== firstLevel) continue;
    if (path[1]) values.add(path[1]);
    else hasDirect = true;
  }

  if (hasDirect) {
    const option = document.createElement("option");
    option.value = "__direct__";
    option.textContent = "当前菜单直属选项";
    submenu.appendChild(option);
  }
  for (const item of [...values].sort((a, b) =>
    configStudioMenuLabel(a).localeCompare(
      configStudioMenuLabel(b),
      "zh-Hans-CN",
      { numeric: true }
    )
  )) {
    const option = document.createElement("option");
    option.value = item;
    option.textContent = configStudioMenuLabel(item) || item;
    submenu.appendChild(option);
  }

  submenu.disabled = !firstLevel || (!values.size && !hasDirect);
  submenu.value = [...submenu.options].some((item) => item.value === previous)
    ? previous
    : "";
}

function configStudioPackageEnabled(pkg) {
  return ["y", "m"].includes(
    configStudioOptionValue(pkg.symbol, pkg.value)
  );
}

function configStudioPackageOptionAssignable(pkg, option) {
  const current = Array.isArray(option.assignable)
    ? option.assignable.filter((value) => ["n", "m", "y"].includes(value))
    : [];
  if (current.length) return current;

  const baselineEnabled = ["y", "m"].includes(String(pkg.value || "n"));
  if (!baselineEnabled && configStudioPackageEnabled(pkg)) {
    return Array.isArray(option.potentialAssignable)
      ? option.potentialAssignable.filter((value) =>
          ["n", "m", "y"].includes(value)
        )
      : [];
  }
  return [];
}

function configStudioPackageOptionSearch(pkg, search) {
  if (!search) return false;
  return (pkg.configOptions || []).some((option) =>
    [
      option.name,
      option.prompt,
      option.choicePrompt,
      ...(option.menuPath || []),
      option.help
    ].some((value) => String(value || "").toLowerCase().includes(search))
  );
}

function configStudioPackageOptionRow(pkg, option) {
  const row = document.createElement("div");
  row.className =
    "config-studio-package-child-row" +
    (configStudioState.modifiedValues.has(option.symbol) ? " modified" : "");

  const copy = document.createElement("div");
  copy.className = "config-studio-option-copy";
  const title = document.createElement("div");
  title.className = "config-studio-option-title";
  const strong = document.createElement("strong");
  strong.textContent = option.prompt || option.name;
  const symbol = document.createElement("span");
  symbol.textContent = option.name;
  title.append(strong, symbol);

  const meta = document.createElement("small");
  const path = (option.menuPath || []).slice(-3).join(" › ");
  meta.textContent = [path, option.help].filter(Boolean).join(" · ");
  copy.append(title, meta);

  const select = document.createElement("select");
  select.setAttribute("aria-label", option.prompt || option.name);
  const assignable = configStudioPackageOptionAssignable(pkg, option);
  const labels = { n: "关闭", m: "模块", y: "开启" };
  const current = configStudioOptionValue(option.symbol, option.value);

  for (const value of assignable) {
    const item = document.createElement("option");
    item.value = value;
    item.textContent = labels[value] || value;
    select.appendChild(item);
  }
  if (
    current &&
    ![...select.options].some((item) => item.value === current)
  ) {
    const item = document.createElement("option");
    item.value = current;
    item.textContent = labels[current] || current;
    select.appendChild(item);
  }
  select.value = current;
  select.disabled = !configStudioPackageEnabled(pkg) || !assignable.length;
  if (select.disabled) {
    select.title = configStudioPackageEnabled(pkg)
      ? "当前目标的 Kconfig 依赖不允许修改该子选项"
      : "先选择主软件包后再配置子选项";
  }
  select.addEventListener("change", () => {
    const root = $("config-studio-packages");
    const scrollTop = root.scrollTop;
    setConfigStudioModifiedValue(option.symbol, select.value);
    renderConfigStudioPackages();
    root.scrollTop = scrollTop;
  });

  row.append(copy, select);
  return row;
}

function configStudioPackageRelativeTrail(pkg, option) {
  const explicit = Array.isArray(option.relativeMenuTrail)
    ? option.relativeMenuTrail
        .map((node) => ({
          prompt: String(node?.prompt || "").trim(),
          kind: String(node?.kind || "menu").trim() || "menu"
        }))
        .filter((node) => node.prompt)
    : [];
  if (explicit.length) return explicit;

  const packagePath = Array.isArray(pkg.menuPath) ? pkg.menuPath : [];
  const optionPath = Array.isArray(option.menuPath) ? option.menuPath : [];
  let prefix = 0;
  while (
    prefix < packagePath.length &&
    prefix < optionPath.length &&
    packagePath[prefix] === optionPath[prefix]
  ) {
    prefix += 1;
  }

  return optionPath.slice(prefix).map((prompt, index, values) => ({
    prompt: String(prompt || "").trim(),
    kind:
      option.choicePrompt &&
      String(prompt || "") === String(option.choicePrompt) &&
      index === values.length - 1
        ? "choice"
        : "menu"
  })).filter((node) => node.prompt);
}

function configStudioPackageMenuTree(pkg) {
  const root = {
    prompt: "",
    kind: "root",
    options: [],
    children: new Map()
  };

  for (const option of pkg.configOptions || []) {
    let node = root;
    for (const entry of configStudioPackageRelativeTrail(pkg, option)) {
      const key = entry.kind + "\u0000" + entry.prompt;
      if (!node.children.has(key)) {
        node.children.set(key, {
          prompt: entry.prompt,
          kind: entry.kind,
          options: [],
          children: new Map()
        });
      }
      node = node.children.get(key);
    }
    node.options.push(option);
  }
  return root;
}

function configStudioPackageMenuOptions(node) {
  const items = [...node.options];
  for (const child of node.children.values()) {
    items.push(...configStudioPackageMenuOptions(child));
  }
  return items;
}

function configStudioPackageMenuMatches(node, search) {
  if (!search) return false;
  const normalized = search.toLowerCase();
  if (String(node.prompt || "").toLowerCase().includes(normalized)) {
    return true;
  }
  return configStudioPackageMenuOptions(node).some((option) =>
    [
      option.name,
      option.prompt,
      option.choicePrompt,
      option.help,
      ...(option.menuPath || [])
    ].some((value) => String(value || "").toLowerCase().includes(normalized))
  );
}

function configStudioPackageMenuModified(node) {
  return configStudioPackageMenuOptions(node).some((option) =>
    configStudioState.modifiedValues.has(option.symbol)
  );
}

function setConfigStudioChoice(options, selectedSymbol) {
  for (const option of options) {
    configStudioState.modifiedValues.set(
      option.symbol,
      option.symbol === selectedSymbol ? "y" : "n"
    );
  }
  updateConfigStudioChangeCount();
  persistNewConfigStudioUi();

  const root = $("config-studio-packages");
  const scrollTop = root.scrollTop;
  renderConfigStudioPackages();
  root.scrollTop = scrollTop;
}

function resetConfigStudioChoice(options) {
  for (const option of options) {
    configStudioState.modifiedValues.delete(option.symbol);
  }
  updateConfigStudioChangeCount();
  persistNewConfigStudioUi();

  const root = $("config-studio-packages");
  const scrollTop = root.scrollTop;
  renderConfigStudioPackages();
  root.scrollTop = scrollTop;
}

function configStudioPackageChoiceMenu(pkg, node) {
  const wrap = document.createElement("div");
  wrap.className = "config-studio-choice-options";

  for (const option of node.options) {
    const assignable = configStudioPackageOptionAssignable(pkg, option);
    const current = configStudioOptionValue(option.symbol, option.value);
    const selected = current === "y";
    const canSelect =
      configStudioPackageEnabled(pkg) &&
      (assignable.includes("y") || selected);

    const button = document.createElement("button");
    button.type = "button";
    button.className =
      "config-studio-choice-option" + (selected ? " selected" : "");
    button.disabled = !canSelect;
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", String(selected));

    const radio = document.createElement("span");
    radio.className = "config-studio-choice-radio";
    radio.setAttribute("aria-hidden", "true");

    const copy = document.createElement("span");
    copy.className = "config-studio-choice-copy";
    const strong = document.createElement("strong");
    strong.textContent = option.prompt || option.name;
    const small = document.createElement("small");
    small.textContent = option.name;
    copy.append(strong, small);

    const state = document.createElement("span");
    state.className = "config-studio-choice-state";
    state.textContent = selected ? "当前" : "选择";

    button.append(radio, copy, state);
    button.addEventListener("click", () => {
      setConfigStudioChoice(node.options, option.symbol);
    });
    wrap.appendChild(button);
  }

  if (
    node.options.some((option) =>
      configStudioState.modifiedValues.has(option.symbol)
    )
  ) {
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "config-studio-choice-reset";
    reset.textContent = "恢复 OpenWrt 默认选择";
    reset.addEventListener("click", () => resetConfigStudioChoice(node.options));
    wrap.appendChild(reset);
  }

  return wrap;
}

function configStudioPackageSubmenu(pkg, node, search, depth = 1) {
  const details = document.createElement("details");
  details.className = "config-studio-package-submenu";
  details.dataset.kind = node.kind;
  details.dataset.depth = String(depth);
  details.open =
    configStudioPackageMenuMatches(node, search) ||
    configStudioPackageMenuModified(node);

  const allOptions = configStudioPackageMenuOptions(node);
  const summary = document.createElement("summary");
  const heading = document.createElement("span");
  heading.className = "config-studio-package-submenu-heading";

  const icon = document.createElement("span");
  icon.className = "config-studio-package-submenu-icon";
  icon.textContent = node.kind === "choice" ? "○" : "›";
  icon.setAttribute("aria-hidden", "true");

  const copy = document.createElement("span");
  copy.className = "config-studio-package-submenu-copy";
  const strong = document.createElement("strong");
  strong.textContent = node.prompt || "子菜单";

  const currentChoice =
    node.kind === "choice"
      ? node.options.find(
          (option) =>
            configStudioOptionValue(option.symbol, option.value) === "y"
        )
      : null;
  const small = document.createElement("small");
  small.textContent =
    node.kind === "choice"
      ? [
          "单选菜单",
          currentChoice
            ? "当前：" + (currentChoice.prompt || currentChoice.name)
            : "",
          node.options.length + " 项"
        ].filter(Boolean).join(" · ")
      : [
          depth === 1 ? "二级菜单" : "子菜单",
          allOptions.length + " 项"
        ].join(" · ");

  copy.append(strong, small);
  heading.append(icon, copy);

  const chevron = document.createElement("span");
  chevron.className = "config-studio-package-submenu-chevron";
  chevron.textContent = "⌄";
  chevron.setAttribute("aria-hidden", "true");
  summary.append(heading, chevron);
  details.appendChild(summary);

  const body = document.createElement("div");
  body.className = "config-studio-package-submenu-body";

  if (node.kind === "choice" && node.children.size === 0) {
    body.appendChild(configStudioPackageChoiceMenu(pkg, node));
  } else {
    if (node.options.length) {
      for (const option of node.options) {
        body.appendChild(configStudioPackageOptionRow(pkg, option));
      }
    }
    for (const child of node.children.values()) {
      body.appendChild(
        configStudioPackageSubmenu(pkg, child, search, depth + 1)
      );
    }
  }

  details.appendChild(body);
  return details;
}

function configStudioPackageChoice(pkg, prompt, options) {
  const row = document.createElement("div");
  row.className = "config-studio-package-choice";

  const copy = document.createElement("div");
  copy.className = "config-studio-option-copy";
  const title = document.createElement("div");
  title.className = "config-studio-option-title";
  const strong = document.createElement("strong");
  strong.textContent = prompt || "单选配置";
  const badge = document.createElement("span");
  badge.textContent = "choice";
  title.append(strong, badge);

  const meta = document.createElement("small");
  meta.textContent =
    "与传统 menuconfig 的 choice 一致：同组只能选择一个值。";
  copy.append(title, meta);

  const select = document.createElement("select");
  select.setAttribute("aria-label", prompt || "单选配置");

  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = "使用 OpenWrt 默认值";
  select.appendChild(defaultOption);

  const baselineEnabled = ["y", "m"].includes(String(pkg.value || "n"));
  let selectedSymbol = "";
  for (const option of options) {
    const assignable = configStudioPackageOptionAssignable(pkg, option);
    const canSelect = assignable.includes("y");
    const current = configStudioOptionValue(option.symbol, option.value);
    if (current === "y") selectedSymbol = option.symbol;

    const item = document.createElement("option");
    item.value = option.symbol;
    item.textContent = option.prompt || option.name;
    item.disabled =
      !configStudioPackageEnabled(pkg) ||
      (!canSelect && baselineEnabled);
    select.appendChild(item);
  }
  select.value = [...select.options].some(
    (item) => item.value === selectedSymbol
  )
    ? selectedSymbol
    : "";
  select.disabled = !configStudioPackageEnabled(pkg);

  select.addEventListener("change", () => {
    if (!select.value) {
      for (const option of options) {
        configStudioState.modifiedValues.delete(option.symbol);
      }
      updateConfigStudioChangeCount();
      persistNewConfigStudioUi();
      const root = $("config-studio-packages");
      const scrollTop = root.scrollTop;
      renderConfigStudioPackages();
      root.scrollTop = scrollTop;
      return;
    }
    for (const option of options) {
      configStudioState.modifiedValues.set(
        option.symbol,
        option.symbol === select.value ? "y" : "n"
      );
    }
    updateConfigStudioChangeCount();
    persistNewConfigStudioUi();
    const root = $("config-studio-packages");
    const scrollTop = root.scrollTop;
    renderConfigStudioPackages();
    root.scrollTop = scrollTop;
  });

  row.append(copy, select);
  return row;
}

function configStudioPackageChildren(pkg, search) {
  const options = Array.isArray(pkg.configOptions)
    ? pkg.configOptions
    : [];
  if (!options.length) return null;

  const details = document.createElement("details");
  details.className = "config-studio-package-children";
  const hasModifiedChild =
    configStudioState.modifiedValues.has(pkg.symbol) ||
    options.some((option) =>
      configStudioState.modifiedValues.has(option.symbol)
    );
  details.open =
    Boolean(search && configStudioPackageOptionSearch(pkg, search)) ||
    hasModifiedChild;

  const summary = document.createElement("summary");
  const treePreview = configStudioPackageMenuTree(pkg);
  const secondLevelCount = treePreview.children.size;
  summary.textContent =
    "配置项 " +
    options.length +
    (secondLevelCount ? " · 二级菜单 " + secondLevelCount : "") +
    (configStudioPackageEnabled(pkg)
      ? " · 点击展开"
      : " · 选择主软件包后可配置");
  details.appendChild(summary);

  const body = document.createElement("div");
  body.className = "config-studio-package-children-body";
  if (!configStudioPackageEnabled(pkg)) {
    const note = document.createElement("div");
    note.className = "config-studio-package-child-note";
    note.textContent =
      "这些选项来自此软件包自己的 Package/<name>/config；启用主软件包后即可设置。";
    body.appendChild(note);
    details.appendChild(body);
    return details;
  }

  const tree = configStudioPackageMenuTree(pkg);
  const submenuCount = tree.children.size;

  if (tree.options.length && submenuCount) {
    const directHeading = document.createElement("div");
    directHeading.className = "config-studio-package-direct-heading";
    directHeading.textContent = "直接选项";
    body.appendChild(directHeading);
  }
  for (const option of tree.options) {
    body.appendChild(configStudioPackageOptionRow(pkg, option));
  }

  if (submenuCount) {
    const menuHeading = document.createElement("div");
    menuHeading.className = "config-studio-package-direct-heading";
    menuHeading.textContent = "二级菜单";
    body.appendChild(menuHeading);
  }
  for (const child of tree.children.values()) {
    body.appendChild(configStudioPackageSubmenu(pkg, child, search, 1));
  }

  if (!["y", "m"].includes(String(pkg.value || "n"))) {
    const note = document.createElement("div");
    note.className = "config-studio-package-child-note";
    note.textContent =
      "主软件包是本次刚启用的；子选项的最终可用性会在“检查依赖”时由真实 OpenWrt Kconfig 再确认。";
    body.appendChild(note);
  }

  details.appendChild(body);
  return details;
}

function renderConfigStudioPackages() {
  const root = $("config-studio-packages");
  const search = $("config-studio-search").value.trim().toLowerCase();
  const category = $("config-studio-category").value || "";
  const submenu = $("config-studio-submenu").value || "";
  const luciOnly = $("config-studio-luci-only").checked;

  computeConfigStudioDependencyLocks();
  renderConfigStudioDependencySummary();

  if (!configStudioState.dependencyOnly && !search && !category) {
    $("config-studio-package-count").textContent = "请先选择一级分类";
    root.replaceChildren();
    const empty = document.createElement("div");
    empty.className = "config-studio-empty config-studio-menu-hint";
    empty.textContent =
      "像传统 menuconfig 一样，先选择一级分类，再按二级菜单缩小范围；也可以直接搜索全部软件包。";
    root.appendChild(empty);
    return;
  }

  const matches = (configStudioState.catalog?.packages || []).filter((pkg) => {
    const modified = configStudioState.modifiedValues.has(pkg.symbol);
    const lock = configStudioState.dependencyLocks.get(pkg.symbol);
    if (configStudioState.dependencyOnly) return Boolean(lock);
    if (!pkg.visible && !pkg.selected && !modified && !lock) return false;
    if (!search && category && pkg.category !== category) return false;
    if (!search && submenu && pkg.submenu !== submenu) return false;
    if (luciOnly && !pkg.luciApp) return false;
    if (!search) return true;
    return [
      pkg.name,
      pkg.title,
      pkg.category,
      pkg.submenu,
      pkg.repository
    ].some((value) => String(value || "").toLowerCase().includes(search)) ||
      configStudioPackageOptionSearch(pkg, search);
  });

  $("config-studio-package-count").textContent =
    configStudioState.dependencyOnly
      ? matches.length + " 个依赖联动项"
      : matches.length + " 个可选软件包";
  root.replaceChildren();

  if (!matches.length) {
    const empty = document.createElement("div");
    empty.className = "config-studio-empty";
    empty.textContent = "没有符合当前筛选条件的软件包。";
    root.appendChild(empty);
    return;
  }

  const cap = 600;
  for (const pkg of matches.slice(0, cap)) {
    const block = document.createElement("div");
    block.className = "config-studio-package-block";

    const lock = configStudioState.dependencyLocks.get(pkg.symbol);
    const baselineLocked = pkg.selected && pkg.changeable === false;
    const row = document.createElement("div");
    row.className =
      "config-studio-option" +
      (configStudioState.modifiedValues.has(pkg.symbol) ? " modified" : "") +
      (lock || baselineLocked ? " dependency-locked" : "");

    const copy = document.createElement("div");
    copy.className = "config-studio-option-copy";
    const title = document.createElement("div");
    title.className = "config-studio-option-title";
    const strong = document.createElement("strong");
    strong.textContent = pkg.name;
    const subtitle = document.createElement("span");
    subtitle.textContent = pkg.title || pkg.submenu || pkg.category || "";
    title.append(strong, subtitle);
    if (lock || baselineLocked) {
      const badge = document.createElement("span");
      badge.className = "config-studio-lock-badge";
      badge.textContent = lock ? "依赖锁定" : "Kconfig 锁定";
      title.appendChild(badge);
    }
    const meta = document.createElement("small");
    const lockReason = lock
      ? "由 " +
        lock.requiredBy.slice(0, 3).join("、") +
        (lock.requiredBy.length > 3
          ? " 等 " + lock.requiredBy.length + " 项"
          : "") +
        " 必需依赖"
      : baselineLocked
        ? "当前配置由 Kconfig 依赖固定"
        : "";
    meta.textContent = [
      lockReason,
      pkg.category,
      pkg.submenu,
      pkg.repository && pkg.repository !== "base"
        ? "feed:" + pkg.repository
        : ""
    ].filter(Boolean).join(" · ");
    copy.append(title, meta);

    const select = document.createElement("select");
    select.setAttribute("aria-label", pkg.name + " 构建方式");
    const packageLabels = {
      n: "不选",
      y: "编入固件",
      m: "仅编译模块"
    };
    const baseAssignable =
      Array.isArray(pkg.assignable) && pkg.assignable.length
        ? pkg.assignable
        : ["n", "m", "y"];
    const assignable = lock
      ? baseAssignable.filter(
          (value) =>
            configStudioTristateRank(value) >=
            configStudioTristateRank(lock.value)
        )
      : baseAssignable;
    for (const value of assignable) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = packageLabels[value] || value;
      select.appendChild(option);
    }
    const displayValue = configStudioPackageDisplayValue(pkg, lock);
    if (![...select.options].some((item) => item.value === displayValue)) {
      const option = document.createElement("option");
      option.value = displayValue;
      option.textContent = packageLabels[displayValue] || displayValue;
      select.appendChild(option);
    }
    select.value = displayValue;
    select.disabled = Boolean(
      baselineLocked || (lock && assignable.length <= 1)
    );
    if (lock) {
      select.title =
        "该软件包由必需依赖锁定，不能低于 " +
        (lock.value === "y" ? "编入固件" : "仅编译模块") +
        "；可用范围与最终值仍由 OpenWrt Kconfig 确认";
    } else if (baselineLocked) {
      select.title = "该软件包当前由 OpenWrt Kconfig 固定，不能手动修改";
    }
    select.addEventListener("change", () => {
      const scrollTop = root.scrollTop;
      setConfigStudioModifiedValue(pkg.symbol, select.value);
      renderConfigStudioPackages();
      root.scrollTop = scrollTop;
    });

    row.append(copy, select);
    block.appendChild(row);
    const children = configStudioPackageChildren(pkg, search);
    if (children) block.appendChild(children);
    root.appendChild(block);
  }

  if (matches.length > cap) {
    const more = document.createElement("div");
    more.className = "config-studio-empty";
    more.textContent =
      "当前匹配 " +
      matches.length +
      " 项，为保证手机端流畅仅显示前 " +
      cap +
      " 项；请使用分类或搜索继续缩小范围。";
    root.appendChild(more);
  }
}

function featureControl(feature, row) {
  const symbol = feature.symbol;
  const current = configStudioOptionValue(symbol, feature.value);
  const assignable = Array.isArray(feature.assignable)
    ? feature.assignable
    : [];

  if (assignable.length) {
    const select = document.createElement("select");
    select.setAttribute("aria-label", feature.prompt || feature.name);
    const labels = { n: "关闭", m: "模块", y: "开启" };
    for (const value of assignable) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = labels[value] || value;
      select.appendChild(option);
    }
    if (![...select.options].some((item) => item.value === current)) {
      const option = document.createElement("option");
      option.value = current;
      option.textContent = labels[current] || current;
      select.appendChild(option);
    }
    select.value = current;
    select.disabled = feature.changeable === false;
    if (select.disabled) {
      select.title = "该选项当前由 Kconfig 依赖固定，不能手动修改";
    }
    select.addEventListener("change", () => {
      setConfigStudioModifiedValue(symbol, select.value);
      row.classList.add("modified");
    });
    return select;
  }

  const input = document.createElement("input");
  input.type = "text";
  input.value = current;
  input.disabled = feature.changeable === false;
  if (input.disabled) {
    input.title = "该选项当前由 Kconfig 依赖固定，不能手动修改";
  }
  input.setAttribute("aria-label", feature.prompt || feature.name);
  input.addEventListener("change", () => {
    setConfigStudioModifiedValue(symbol, input.value);
    row.classList.add("modified");
  });
  return input;
}

function renderConfigStudioFeatures() {
  const root = $("config-studio-features");
  const search = $("config-studio-feature-search").value.trim().toLowerCase();
  const menu = $("config-studio-feature-menu").value || "";
  const submenu = $("config-studio-feature-submenu").value || "";

  if (!search && !menu) {
    $("config-studio-feature-count").textContent = "请先选择一级菜单";
    root.replaceChildren();
    const empty = document.createElement("div");
    empty.className = "config-studio-empty config-studio-menu-hint";
    empty.textContent =
      "编译特性按 OpenWrt 的真实 Kconfig 菜单路径分类；先进入一级菜单，或直接搜索全部特性。";
    root.appendChild(empty);
    return;
  }

  const matches = (configStudioState.catalog?.features || []).filter(
    (feature) => {
      if (!feature.visible) return false;
      const path = configStudioFeatureMenuPath(feature);
      const firstLevel = path[0] || "其他";
      if (!search && menu && firstLevel !== menu) return false;
      if (
        !search &&
        submenu &&
        (submenu === "__direct__" ? Boolean(path[1]) : path[1] !== submenu)
      ) {
        return false;
      }
      if (!search) return true;
      return [
        feature.name,
        feature.prompt,
        ...(feature.menuPath || []),
        feature.help
      ].some((value) => String(value || "").toLowerCase().includes(search));
    }
  );

  $("config-studio-feature-count").textContent =
    matches.length + " 个当前可见特性";
  root.replaceChildren();

  if (!matches.length) {
    const empty = document.createElement("div");
    empty.className = "config-studio-empty";
    empty.textContent =
      configStudioState.catalog?.featureCatalogError ||
      "当前目标没有匹配的可视化特性。";
    root.appendChild(empty);
    return;
  }

  const cap = 500;
  for (const feature of matches.slice(0, cap)) {
    const row = document.createElement("div");
    row.className =
      "config-studio-option" +
      (configStudioState.modifiedValues.has(feature.symbol)
        ? " modified"
        : "");

    const copy = document.createElement("div");
    copy.className = "config-studio-option-copy";
    const title = document.createElement("div");
    title.className = "config-studio-option-title";
    const strong = document.createElement("strong");
    strong.textContent = feature.prompt || feature.name;
    const symbol = document.createElement("span");
    symbol.textContent = feature.name;
    title.append(strong, symbol);
    const meta = document.createElement("small");
    const path = (feature.menuPath || []).join(" › ");
    meta.textContent = [path, feature.help].filter(Boolean).join(" · ");
    copy.append(title, meta);

    row.append(copy, featureControl(feature, row));
    root.appendChild(row);
  }

  if (matches.length > cap) {
    const more = document.createElement("div");
    more.className = "config-studio-empty";
    more.textContent =
      "当前匹配 " +
      matches.length +
      " 项，仅显示前 " +
      cap +
      " 项；请搜索具体特性。";
    root.appendChild(more);
  }
}

function renderConfigStudioCatalog(forceSelection = false) {
  if (!configStudioState.catalog) return;
  pickConfigStudioTargetSelection(forceSelection);
  renderConfigStudioTargetSelectors();
  renderConfigStudioPackageCategories();
  renderConfigStudioFeatureMenus();
  renderConfigStudioPackages();
  renderConfigStudioFeatures();
  updateConfigStudioChangeCount();

  $("config-studio-loading").hidden = true;
  $("config-studio-workbench").hidden = false;
  $("config-studio-result").hidden = true;
  $("config-studio-back").hidden = true;
  $("config-studio-apply").hidden = true;
  $("config-studio-use").hidden = true;
  $("config-studio-resolve").hidden = false;
  $("config-studio-resolve").disabled = false;
}

function configStudioTargetValues() {
  const values = {};
  const targets = configStudioState.catalog?.targets || [];
  const target = currentConfigStudioTarget();
  const subtarget = currentConfigStudioSubtarget();
  const device = currentConfigStudioDevice();

  if (target?.symbol) values[target.symbol] = "y";
  if (subtarget?.symbol && subtarget.symbol !== target?.symbol) {
    values[subtarget.symbol] = "y";
  }
  if (device?.symbol) values[device.symbol] = "y";

  const baselineTarget = targets.find(
    (item) => item.id === configStudioState.baselineTargetId
  );
  const baselineSubtarget = (baselineTarget?.subtargets || []).find(
    (item) => item.id === configStudioState.baselineSubtargetId
  );
  const baselineDevice = (baselineSubtarget?.devices || []).find(
    (item) => item.profileId === configStudioState.baselineDeviceProfileId
  );

  if (
    baselineTarget?.symbol &&
    baselineTarget.symbol !== target?.symbol
  ) {
    values[baselineTarget.symbol] = "n";
  }
  if (
    baselineSubtarget?.symbol &&
    baselineSubtarget.symbol !== subtarget?.symbol &&
    baselineSubtarget.symbol !== baselineTarget?.symbol
  ) {
    values[baselineSubtarget.symbol] = "n";
  }
  if (
    baselineDevice?.symbol &&
    baselineDevice.symbol !== device?.symbol
  ) {
    values[baselineDevice.symbol] = "n";
  }
  return values;
}

function renderConfigStudioResult() {
  const result = configStudioState.result;
  if (!result) return;

  $("config-result-honored").textContent = String(
    result.summary?.honored || 0
  );
  $("config-result-adjusted").textContent = String(
    result.summary?.adjusted || 0
  );
  $("config-result-packages").textContent = String(
    result.summary?.selectedPackages || 0
  );

  const root = $("config-studio-adjustments");
  root.replaceChildren();
  const adjusted = (result.comparison || []).filter(
    (item) => item.status === "adjusted"
  );
  const dependencyChanges = (result.packageChanges || []).filter(
    (item) => item.reason === "dependency"
  );

  const items = [
    ...adjusted.map((item) => ({
      key: item.symbol,
      detail:
        "请求 " +
        String(item.requested) +
        " → Kconfig " +
        String(item.resolved)
    })),
    ...dependencyChanges.map((item) => ({
      key: item.name,
      detail:
        item.change === "added"
          ? "Kconfig 自动加入依赖"
          : "Kconfig 因依赖关系移除"
    }))
  ];

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "config-studio-empty";
    empty.textContent =
      "你本轮提交的选择全部被 Kconfig 接受，没有额外依赖调整需要提示。";
    root.appendChild(empty);
  } else {
    for (const item of items.slice(0, 120)) {
      const row = document.createElement("div");
      row.className = "config-studio-adjustment";
      const code = document.createElement("code");
      code.textContent = item.key;
      const detail = document.createElement("span");
      detail.textContent = item.detail;
      row.append(code, detail);
      root.appendChild(row);
    }
  }

  $("config-studio-loading").hidden = true;
  $("config-studio-workbench").hidden = true;
  $("config-studio-result").hidden = false;
  $("config-studio-resolve").hidden = true;
  $("config-studio-back").hidden = false;
  const existing = configStudioState.context === "existing";
  $("config-studio-apply").hidden = !existing;
  $("config-studio-use").hidden = existing;
  setConfigStudioStatus(
    "Kconfig 解析完成",
    "依赖检查完成。确认无误后，点击右下角的确认按钮进入下一步。"
  );
}

function resetConfigStudioState() {
  clearConfigStudioPolling();
  configStudioState.repo = null;
  configStudioState.requestId = "";
  configStudioState.profileId = "";
  configStudioState.context = "existing";
  configStudioState.catalog = null;
  configStudioState.result = null;
  configStudioState.modifiedValues = new Map();
  configStudioState.dependencyLocks = new Map();
  configStudioState.dependencyOnly = false;
  configStudioState.targetId = "";
  configStudioState.subtargetId = "";
  configStudioState.deviceProfileId = "";
  configStudioState.baselineTargetId = "";
  configStudioState.baselineSubtargetId = "";
  configStudioState.baselineDeviceProfileId = "";
  configStudioState.pollAttempts = 0;
  configStudioState.restoreFocus = null;
  configStudioState.newFingerprint = "";
  configStudioState.resumeUi = null;
}

function hideConfigStudioDialog() {
  clearConfigStudioPolling();
  $("config-studio-dialog").hidden = true;
  document.body.classList.remove("dialog-open");
}

async function deleteConfigStudioSession() {
  const repo = configStudioState.repo;
  const requestId = configStudioState.requestId;
  if (!repo || !requestId) return;
  try {
    await request(
      configStudioBasePath(repo) + "/" + requestId,
      { method: "DELETE" }
    );
  } catch (error) {
    if (error.code !== "config_studio_session_not_found") {
      console.warn("Config Studio cleanup failed", error);
    }
  }
}

async function closeConfigStudio({ cleanup = true } = {}) {
  const restoreFocus = configStudioState.restoreFocus;
  const context = configStudioState.context;
  const requestId = configStudioState.requestId;
  const repo = configStudioState.repo;
  const shouldCleanup = cleanup || context !== "new";
  if (!shouldCleanup) persistNewConfigStudioUi();
  configStudioState.generation += 1;
  clearConfigStudioPolling();
  if (shouldCleanup) {
    await deleteConfigStudioSession();
    if (
      context === "new" &&
      createState.configStudioDraft?.requestId === requestId
    ) {
      saveNewConfigStudioDraft(repo, null);
      renderNewConfigStudioState();
    }
  }
  hideConfigStudioDialog();
  resetConfigStudioState();
  if (restoreFocus?.isConnected && typeof restoreFocus.focus === "function") {
    restoreFocus.focus();
  }
}

async function pollConfigStudio(generation) {
  const repo = configStudioState.repo;
  const requestId = configStudioState.requestId;
  if (!repo || !requestId || generation !== configStudioState.generation) {
    return;
  }

  configStudioState.pollAttempts += 1;
  try {
    const data = await request(
      configStudioBasePath(repo) + "/" + requestId
    );
    if (
      generation !== configStudioState.generation ||
      $("config-studio-dialog").hidden
    ) {
      return;
    }

    if (data.run?.url) {
      $("config-studio-run-link").href = data.run.url;
      $("config-studio-run-link").hidden = false;
    }

    const status = data.status?.status || "preparing";
    renderConfigStudioProgress(
      data.progress,
      data.run,
      data.status?.mode || (status === "resolving" ? "resolve" : "catalog")
    );
    if (status === "failed") {
      setConfigStudioStatus(
        "配置环境生成失败",
        "请打开 Actions 查看真实 OpenWrt / feeds / Kconfig 错误。"
      );
      setConfigStudioError("Config Studio Action 执行失败。");
      $("config-studio-resolve").disabled = true;
      return;
    }

    if (data.catalog) {
      configStudioState.catalog = data.catalog;
    }

    if (status === "ready" && data.catalog) {
      setConfigStudioStep(1);
      setConfigStudioStatus(
        "配置菜单已就绪",
        "选择设备、App 和编译特性；完成后点击“下一步：检查依赖”。"
      );
      renderConfigStudioCatalog(true);
      if (restoreNewConfigStudioUi()) {
        renderConfigStudioCatalog(false);
      }
      return;
    }

    if (status === "resolved" && data.result) {
      setConfigStudioStep(3);
      configStudioState.result = data.result;
      if (data.catalog) {
        configStudioState.catalog = data.catalog;
        pickConfigStudioTargetSelection(true);
      }
      renderConfigStudioResult();
      return;
    }

    if (status === "resolving") {
      setConfigStudioStep(2);
      setConfigStudioStatus(
        "Kconfig 正在解析选择",
        "正在真实运行 make defconfig，并重新生成当前目标下的菜单目录。"
      );
      $("config-studio-resolve").disabled = true;
    } else {
      setConfigStudioStep(1);
      setConfigStudioStatus(
        "正在生成配置菜单",
        "正在读取源码、feeds 和设备元数据。"
      );
    }
  } catch (error) {
    if (
      generation !== configStudioState.generation ||
      $("config-studio-dialog").hidden
    ) {
      return;
    }
    setConfigStudioError(error);
  }

  if (configStudioState.pollAttempts >= MAX_CONFIG_STUDIO_POLL_ATTEMPTS) {
    setConfigStudioError("图形配置准备时间过长，请打开 Actions 检查运行状态。");
    return;
  }
  configStudioState.pollTimer = setTimeout(
    () => pollConfigStudio(generation),
    2500
  );
}

async function startConfigStudio(repo, options) {
  if (!repo || !canWriteRepo(repo) || !canRunRepo(repo)) {
    showError(
      "图形配置需要 Contents、Pull requests 与 Actions 写权限。"
    );
    return;
  }

  const existing = Boolean(options.profileId);
  const payload = existing
    ? {
        profileId: options.profileId,
        baseRefSha: options.baseRefSha || "",
        profileFiles: options.profileFiles || null
      }
    : {
        sourceRepo: options.sourceRepo,
        sourceBranch: options.sourceBranch,
        adapter: options.adapter,
        baseConfig: options.baseConfig || "",
        extraFeeds: options.extraFeeds || ""
      };

  resetConfigStudioState();
  configStudioState.generation += 1;
  const generation = configStudioState.generation;
  configStudioState.repo = repo;
  configStudioState.profileId = options.profileId || "";
  configStudioState.context = existing ? "existing" : "new";
  configStudioState.newFingerprint = options.fingerprint || "";
  configStudioState.resumeUi = options.resumeUi || null;
  configStudioState.restoreFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

  setConfigStudioError();
  $("config-studio-title").textContent = existing
    ? "图形配置 · " + options.profileId
    : "新 Profile · 图形 Menuconfig";
  $("config-studio-context").textContent = existing
    ? repo.fullName + " · 从当前编辑器 Profile 快照开始"
    : repo.fullName + " · " + options.sourceRepo + " @ " + options.sourceBranch;
  $("config-studio-loading").hidden = false;
  $("config-studio-workbench").hidden = true;
  resetConfigStudioProgress("catalog");
  $("config-studio-result").hidden = true;
  $("config-studio-run-link").hidden = true;
  $("config-studio-resolve").hidden = false;
  $("config-studio-resolve").disabled = true;
  $("config-studio-back").hidden = true;
  $("config-studio-apply").hidden = true;
  $("config-studio-use").hidden = true;
  setConfigStudioStep(1);
  setConfigStudioStatus(
    options.resumeRequestId ? "正在恢复上次配置" : "正在生成配置菜单",
    options.resumeRequestId
      ? "源码和 feeds 没有变化，继续使用上次会话，不会重新启动 Action。"
      : "后台会读取源码、应用 feeds，并生成可选择的设备、App 与特性。"
  );

  $("config-studio-dialog").hidden = false;
  document.body.classList.add("dialog-open");
  $("config-studio-close").focus();

  try {
    if (options.resumeRequestId) {
      configStudioState.requestId = options.resumeRequestId;
      configStudioState.pollAttempts = 0;
      await pollConfigStudio(generation);
      return;
    }

    const result = await request(configStudioBasePath(repo), {
      method: "POST",
      body: JSON.stringify(payload)
    });
    if (
      generation !== configStudioState.generation ||
      $("config-studio-dialog").hidden
    ) {
      return;
    }
    configStudioState.requestId = result.requestId;
    if (!existing) {
      saveNewConfigStudioDraft(repo, {
        requestId: result.requestId,
        fingerprint: options.fingerprint || "",
        sourceRepo: options.sourceRepo || "",
        sourceBranch: options.sourceBranch || "",
        adapter: options.adapter || "direct-openwrt",
        extraFeeds: options.extraFeeds || "",
        baseConfig: options.baseConfig || ""
      });
      renderNewConfigStudioState();
    }
    if (result.runUrl) {
      $("config-studio-run-link").href = result.runUrl;
      $("config-studio-run-link").hidden = false;
    }
    configStudioState.pollAttempts = 0;
    await pollConfigStudio(generation);
  } catch (error) {
    if (generation !== configStudioState.generation) return;
    setConfigStudioStatus(
      "无法启动图形配置",
      "Control Plane 没有创建 Config Studio 会话。"
    );
    setConfigStudioError(error);
  }
}

async function resolveConfigStudio() {
  const repo = configStudioState.repo;
  const requestId = configStudioState.requestId;
  if (!repo || !requestId || !configStudioState.catalog) return;

  computeConfigStudioDependencyLocks();
  const values = {
    ...configStudioTargetValues(),
    ...Object.fromEntries(configStudioEffectiveModifiedEntries())
  };
  const button = $("config-studio-resolve");
  button.disabled = true;
  button.textContent = "正在检查依赖…";
  setConfigStudioStep(2);
  setConfigStudioError();

  try {
    const result = await request(
      configStudioBasePath(repo) + "/" + requestId + "/resolve",
      {
        method: "POST",
        body: JSON.stringify({ values })
      }
    );
    if (result.runUrl) {
      $("config-studio-run-link").href = result.runUrl;
      $("config-studio-run-link").hidden = false;
    }
    configStudioState.result = null;
    configStudioState.pollAttempts = 0;
    $("config-studio-loading").hidden = false;
    $("config-studio-workbench").hidden = true;
    resetConfigStudioProgress("resolve");
    setConfigStudioStatus(
      "Kconfig 正在解析选择",
      "正在运行 make defconfig；依赖变化会在完成后逐项展示。"
    );
    await pollConfigStudio(configStudioState.generation);
  } catch (error) {
    setConfigStudioError(error);
    button.disabled = false;
  } finally {
    button.textContent = "下一步：检查依赖";
  }
}

async function applyConfigStudioToProfile() {
  const repo = configStudioState.repo;
  const requestId = configStudioState.requestId;
  const profileId = configStudioState.profileId;
  if (!repo || !requestId || !profileId || !configStudioState.result) return;

  const button = $("config-studio-apply");
  button.disabled = true;
  button.textContent = "正在保存…";
  setConfigStudioError();

  try {
    const result = await request(
      configStudioBasePath(repo) +
        "/" +
        requestId +
        "/apply/" +
        encodeURIComponent(profileId),
      { method: "POST", body: "{}" }
    );
    const restoreFocus = configStudioState.restoreFocus;
    hideConfigStudioDialog();
    resetConfigStudioState();
    showWriteResult(
      profileWriteResultMessage(result, "图形配置"),
      result.pullRequest?.url || ""
    );
    $("preview-card").hidden = true;
    editorState.previewValid = false;
    restoreFocus?.focus?.();
  } catch (error) {
    setConfigStudioError(error);
    button.disabled = false;
  } finally {
    button.textContent = "确认并保存配置";
  }
}

async function useConfigStudioForNewProfile() {
  if (
    configStudioState.context !== "new" ||
    !configStudioState.result?.finalConfig
  ) {
    return;
  }
  const finalConfig = configStudioState.result.finalConfig;
  $("new-config-text").value = finalConfig;
  invalidateNewProfilePreview();
  await closeConfigStudio({ cleanup: true });
  $("new-profile-card").hidden = false;
  showControlPlaneView("profiles");
  setActiveNavigation("profiles");
  scrollToPanel($("new-profile-card"));
  showNewProfileResult(
    "图形配置已完成，正在自动生成 Profile 预览。最后检查后点击“完成：创建 Profile PR”。"
  );
  $("new-profile-preview").click();
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
    return;
  }

  setupStatus.hidden = true;
  loginAction.hidden = false;
  installLink.href = publicConfig.githubAppInstallUrl;

  const session = await request("/api/v1/session");

  if (!session.authenticated) {
    $("login-card").hidden = false;
    return;
  }

  $("login-card").hidden = true;

  const userBox = $("user-box");
  const avatar = document.createElement("img");
  avatar.src = session.user.avatarUrl || "";
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

  const switcher = $("repo-switcher");
  switcher.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = data.repositories.length
    ? "选择仓库"
    : "暂无可访问仓库";
  switcher.appendChild(placeholder);

  for (const repo of data.repositories) {
    const option = document.createElement("option");
    option.value = repo.fullName;
    option.textContent = repo.fullName;
    switcher.appendChild(option);
  }

  $("repo-switcher-wrap").hidden = false;
  installLink.hidden = false;

  if (!data.repositories.length) {
    $("repo-meta-line").hidden = true;
    $("workspace-empty").hidden = false;
    $("workspace-empty-title").textContent = "还没有可访问仓库";
    $("workspace-empty-text").textContent =
      "请从头像菜单调整 GitHub App 的仓库授权范围。";
    return;
  }

  if (data.repositories.length === 1) {
    await selectRepository(data.repositories[0]);
  } else {
    $("workspace-empty").hidden = false;
    $("workspace-empty-title").textContent = "选择一个仓库";
    $("workspace-empty-text").textContent =
      "从顶栏仓库切换器进入 Profile 与构建工作区。";
  }
}
for (const item of document.querySelectorAll(".sidebar-nav .nav-item")) {
  item.addEventListener("click", () => {
    navigateControlPlane(item.dataset.nav).catch((error) => showError(error));
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
    if (!$("build-dialog").hidden) closeBuildDialog();
    if (!$("delete-profile-dialog").hidden) closeDeleteProfileDialog();
    if (!$("baseline-profile-dialog").hidden) closeBaselineProfileDialog();
    if (!$("profile-lifecycle-dialog").hidden) closeProfileLifecycleDialog();
    if (!$("update-checker-dialog").hidden) closeUpdateCheckerDialog();
    if (!$("release-existing-dialog").hidden) closeReleaseExistingDialog();
    if (!$("config-studio-dialog").hidden) {
      closeConfigStudio({ cleanup: false }).catch((error) => showError(error));
    }
  }
});

$("update-checker-open").addEventListener("click", () => {
  const repo = currentRepository();
  if (!repo) {
    showError("请先选择仓库。");
    return;
  }
  openUpdateCheckerDialog(repo).catch((error) => showError(error));
});

$("new-profile-open").addEventListener("click", openNewProfileForm);

$("new-config-studio").addEventListener("click", async () => {
  const repo = createState.repo;
  const sourceRepo = $("new-source-repo").value.trim();
  const sourceBranch = $("new-source-branch").value.trim();
  const adapter = $("new-adapter").value;
  const extraFeeds = $("new-extra-feeds").value;
  if (!repo) {
    showError("请先选择仓库。");
    return;
  }
  if (!sourceRepo || !sourceBranch) {
    showError("请先填写源码仓库与分支 / Tag。");
    return;
  }

  const fingerprint = newConfigStudioFingerprint(repo);
  let draft = createState.configStudioDraft || loadNewConfigStudioDraft(repo);

  if (draft?.requestId && draft.fingerprint !== fingerprint) {
    try {
      await request(
        configStudioBasePath(repo) + "/" + draft.requestId,
        { method: "DELETE" }
      );
    } catch (error) {
      if (error.code !== "config_studio_session_not_found") {
        console.warn("Old Config Studio draft cleanup failed", error);
      }
    }
    saveNewConfigStudioDraft(repo, null);
    draft = null;
  }

  if (draft?.requestId && draft.fingerprint === fingerprint) {
    try {
      await request(configStudioBasePath(repo) + "/" + draft.requestId);
      await startConfigStudio(repo, {
        sourceRepo,
        sourceBranch,
        adapter,
        baseConfig: $("new-config-text").value,
        extraFeeds,
        fingerprint,
        resumeRequestId: draft.requestId,
        resumeUi: draft.ui || null
      });
      return;
    } catch (error) {
      if (error.code !== "config_studio_session_not_found") {
        showError(error);
        return;
      }
      saveNewConfigStudioDraft(repo, null);
    }
  }

  startConfigStudio(repo, {
    sourceRepo,
    sourceBranch,
    adapter,
    baseConfig: $("new-config-text").value,
    extraFeeds,
    fingerprint
  }).catch((error) => showError(error));
});

$("new-profile-close").addEventListener("click", () => {
  $("new-profile-card").hidden = true;
  invalidateNewProfilePreview();
  showControlPlaneView("profiles");
  setActiveNavigation("profiles");
  scrollToPanel($("profile-card"));
});

$("new-source-preset").addEventListener("change", () => {
  const preset = SOURCE_PRESETS[$("new-source-preset").value];
  if (preset) {
    $("new-source-repo").value = preset.repo;
    $("new-source-branch").value = preset.branch;
  }
  invalidateNewProfilePreview();
  renderNewConfigStudioState();
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

$("new-feed-passwall").addEventListener("click", () => {
  addFeedPreset(PASSWALL_FEEDS);
});

$("new-feed-fw876").addEventListener("click", () => {
  addFeedPreset(FW876_HELLOWORLD_FEEDS);
});

$("new-feed-sbwml").addEventListener("click", () => {
  addFeedPreset(SBWML_HELLOWORLD_FEEDS);
});

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
  "new-source-repo",
  "new-source-branch",
  "new-adapter",
  "new-extra-feeds",
  "new-config-text"
]) {
  $(id).addEventListener("input", renderNewConfigStudioState);
  $(id).addEventListener("change", renderNewConfigStudioState);
}

for (const id of [
  "new-profile-id",
  "new-profile-name",
  "new-source-repo",
  "new-source-branch",
  "new-adapter",
  "new-config-text",
  "new-extra-feeds",
  "new-auto-update",
  "new-upload-release",
  "new-upload-firmware",
  "new-maximize-space",
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
    createState.previewValid = createState.previewFiles.length === 7;
    renderNewProfilePreview();
    $("new-profile-create").disabled =
      !createState.previewValid || !canWriteRepo(createState.repo);
  } catch (error) {
    invalidateNewProfilePreview();
    showError(error);
  } finally {
    button.disabled = false;
    button.textContent = "下一步：预览 Profile";
  }
});

$("new-profile-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!createState.repo || !canWriteRepo(createState.repo)) return;
  if (!createState.previewValid) {
    showError("内容已经变化，请重新预览标准文件后再保存。");
    return;
  }

  const button = $("new-profile-create");
  button.disabled = true;
  button.textContent = "正在保存…";
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
    const resultMessage = profileWriteResultMessage(
      result,
      "Profile " + result.profileId
    );
    const resultUrl = result.pullRequest.url;
    createState.previewValid = false;
    $("new-profile-preview-card").hidden = true;

    if (result.pullRequest?.merged) {
      await loadProfiles(repo, repositoryState.selectionVersion, {
        forceRefresh: true,
        focusProfileId: result.profileId,
        resultMessage,
        resultUrl
      });
    } else {
      showNewProfileResult(resultMessage, resultUrl);
    }
  } catch (error) {
    showError(error);
    button.disabled = false;
  } finally {
    button.textContent = "完成：保存并应用";
  }
});

$("file-select").addEventListener("change", () => {
  saveCurrentEditorFile();
  editorState.currentFile = $("file-select").value;
  $("editor-content").value = editorState.files[editorState.currentFile] || "";
});

$("editor-content").addEventListener("input", setPreviewStale);

$("editor-config-studio").addEventListener("click", () => {
  if (!editorState.repo || !editorState.profileId) return;
  saveCurrentEditorFile();
  startConfigStudio(editorState.repo, {
    profileId: editorState.profileId,
    baseRefSha: editorState.baseRefSha,
    profileFiles: Object.fromEntries(
      PROFILE_FILES.map((name) => [name, editorState.files[name] || ""])
    )
  }).catch((error) => showError(error));
});


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
    showError("内容已变化，请重新预览后再保存。");
    return;
  }

  const button = $("create-pr");
  button.disabled = true;
  button.textContent = "正在保存…";
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
      profileWriteResultMessage(result, "Profile " + editorState.profileId),
      result.pullRequest.url
    );
    if (result.pullRequest?.merged) {
      editorState.baseRefSha =
        result.pullRequest.mergeCommitSha || editorState.baseRefSha;
      for (const name of PROFILE_FILES) {
        editorState.original[name] = editorState.files[name];
      }
      $("editor-meta").textContent =
        "基线：" +
        repo.defaultBranch +
        "@" +
        editorState.baseRefSha.slice(0, 12) +
        " · 已自动合并，可继续编辑";
    }
    editorState.previewValid = false;
    $("preview-card").hidden = true;
  } catch (error) {
    showError(error);
    button.disabled = false;
  } finally {
    button.textContent = "保存并应用";
  }
});

$("trigger-build").addEventListener("click", async () => {
  const repo = buildDialogState.repo;
  const profileId = buildDialogState.profileId;
  const requestVersion = buildDialogState.requestVersion;
  if (!repo || !profileId || !canRunRepo(repo)) return;

  const button = $("trigger-build");
  button.disabled = true;
  button.textContent = "正在提交…";
  showError();
  setBuildDialogStatus();

  try {
    const result = await request(
      `/api/v1/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/profiles/${encodeURIComponent(profileId)}/builds`,
      {
        method: "POST",
        body: JSON.stringify({
          publishRelease:
            buildDialogState.releaseAllowed && $("publish-release").checked
        })
      }
    );

    if (currentRepository()?.fullName !== repo.fullName) return;

    buildState.requestId = result.requestId || "";
    buildState.activeRunId = Number(result.runId || 0);
    buildState.pollAttempts = 0;
    const generation = buildState.generation;
    if (requestVersion === buildDialogState.requestVersion) {
      closeBuildDialog();
    }

    renderActionProgressCard(
      "recent-build-progress",
      null,
      result.runId
        ? { id: Number(result.runId), url: result.runUrl || "" }
        : null,
      {
        force: true,
        waitingTitle: result.runId
          ? "构建运行已建立"
          : "等待 GitHub 建立运行记录",
        waitingDetail: "正在获取本次构建的真实 Job / Step 进度。"
      }
    );

    await loadBuildRuns({
      requestId: result.requestId || "",
      runId: Number(result.runId || 0),
      runUrl: result.runUrl || "",
      generation
    });
  } catch (error) {
    if (currentRepository()?.fullName !== repo.fullName) return;

    if (error.code === "build_already_active" && error.body?.activeRun) {
      const run = error.body.activeRun;
      if (
        requestVersion === buildDialogState.requestVersion &&
        !$("build-dialog").hidden
      ) {
        setBuildDialogStatus(
          `这个 Profile 已有构建 #${run.runNumber} 正在${buildStatusLabel(run)}，不会重复触发。`,
          true
        );
      }
      buildState.requestId = "";
      buildState.activeRunId = Number(run.id || 0);
      await loadBuildRuns({
        runId: Number(run.id || 0),
        generation: buildState.generation
      });
    } else if (
      requestVersion === buildDialogState.requestVersion &&
      !$("build-dialog").hidden
    ) {
      setBuildDialogStatus(friendlyError(error), true);
    }
  } finally {
    button.textContent = "开始构建";
    if (
      requestVersion === buildDialogState.requestVersion &&
      !$("build-dialog").hidden
    ) {
      button.disabled = !canRunRepo(repo);
    }
  }
});

$("confirm-profile-lifecycle").addEventListener("click", async () => {
  const repo = profileLifecycleState.repo;
  const profileId = profileLifecycleState.profileId;
  const mode = profileLifecycleState.mode;
  const baseRefSha = profileLifecycleState.baseRefSha;
  const targetProfileId = $("profile-lifecycle-target").value.trim();
  const requestVersion = profileLifecycleState.requestVersion;
  if (!repo || !profileId || !baseRefSha || !canWriteRepo(repo)) return;

  const button = $("confirm-profile-lifecycle");
  button.disabled = true;
  button.textContent = mode === "copy" ? "正在复制…" : "正在重命名…";
  showError();
  setProfileLifecycleStatus(
    mode === "copy"
      ? "正在创建复制分支与 Pull Request…"
      : "正在创建原子重命名分支与 Pull Request…"
  );

  try {
    const result = await request(
      `/api/v1/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/profiles/${encodeURIComponent(profileId)}/${mode}`,
      {
        method: "POST",
        body: JSON.stringify({ baseRefSha, targetProfileId })
      }
    );
    let resultMessage = profileWriteResultMessage(
      result,
      mode === "copy"
        ? `Profile ${profileId} → ${targetProfileId} 复制`
        : `Profile ${profileId} → ${targetProfileId} 重命名`
    );
    const cleaned = Number(result.configStudioCleanup?.sessionsFound || 0);
    if (cleaned > 0) {
      resultMessage += `；已清理 ${cleaned} 个关联图形配置会话`;
    }
    const resultUrl = result.pullRequest?.url || "";
    closeProfileLifecycleDialog();

    if (repositoryState.selectedFullName === repo.fullName) {
      await loadProfiles(repo, repositoryState.selectionVersion, {
        forceRefresh: true,
        focusProfileId: targetProfileId,
        resultMessage,
        resultUrl
      });
    } else {
      showProfileListResult(resultMessage, resultUrl);
    }
  } catch (error) {
    if (
      requestVersion === profileLifecycleState.requestVersion &&
      !$("profile-lifecycle-dialog").hidden
    ) {
      setProfileLifecycleStatus(friendlyError(error), true);
      button.disabled = false;
    }
  } finally {
    if (
      requestVersion === profileLifecycleState.requestVersion &&
      !$("profile-lifecycle-dialog").hidden
    ) {
      button.textContent = mode === "copy" ? "创建副本" : "重命名";
    }
  }
});

$("confirm-baseline-profile").addEventListener("click", async () => {
  const repo = baselineProfileState.repo;
  const profileId = baselineProfileState.profileId;
  const baseRefSha = baselineProfileState.baseRefSha;
  const requestVersion = baselineProfileState.requestVersion;
  if (!repo || !profileId || !baseRefSha || !canWriteRepo(repo)) return;

  const button = $("confirm-baseline-profile");
  button.disabled = true;
  button.textContent = "正在切换…";
  showError();
  setBaselineProfileStatus("正在创建基准切换分支与 Pull Request…");

  try {
    const result = await request(
      `/api/v1/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/profiles/${encodeURIComponent(profileId)}/baseline`,
      {
        method: "POST",
        body: JSON.stringify({ baseRefSha })
      }
    );
    const resultMessage = profileWriteResultMessage(
      result,
      "基准 Profile " + profileId
    );
    const resultUrl = result.pullRequest?.url || "";
    closeBaselineProfileDialog();

    if (repositoryState.selectedFullName === repo.fullName) {
      await loadProfiles(repo, repositoryState.selectionVersion, {
        forceRefresh: true,
        focusProfileId: profileId,
        resultMessage,
        resultUrl
      });
    } else {
      showProfileListResult(resultMessage, resultUrl);
    }
  } catch (error) {
    if (
      requestVersion === baselineProfileState.requestVersion &&
      !$("baseline-profile-dialog").hidden
    ) {
      setBaselineProfileStatus(friendlyError(error), true);
      button.disabled = false;
    }
  } finally {
    if (
      requestVersion === baselineProfileState.requestVersion &&
      !$("baseline-profile-dialog").hidden
    ) {
      button.textContent = "设为基准";
    }
  }
});

$("confirm-delete-profile").addEventListener("click", async () => {
  const repo = deleteProfileState.repo;
  const profileId = deleteProfileState.profileId;
  const baseRefSha = deleteProfileState.baseRefSha;
  const requestVersion = deleteProfileState.requestVersion;
  if (!repo || !profileId || !baseRefSha || !canWriteRepo(repo)) return;

  const button = $("confirm-delete-profile");
  button.disabled = true;
  button.textContent = "正在删除…";
  showError();
  setDeleteProfileStatus("正在创建删除分支与 Pull Request…");

  try {
    const result = await request(
      `/api/v1/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/profiles/${encodeURIComponent(profileId)}`,
      {
        method: "DELETE",
        body: JSON.stringify({ baseRefSha })
      }
    );
    let resultMessage = profileWriteResultMessage(
      result,
      "Profile " + profileId + " 删除"
    );
    const cleanedSessions = Number(
      result.configStudioCleanup?.sessionsFound || 0
    );
    if (cleanedSessions > 0) {
      resultMessage += `；已清理 ${cleanedSessions} 个关联图形配置会话`;
    }
    const resultUrl = result.pullRequest?.url || "";
    closeDeleteProfileDialog();

    if (repositoryState.selectedFullName === repo.fullName) {
      await loadProfiles(repo, repositoryState.selectionVersion, {
        forceRefresh: true,
        resultMessage,
        resultUrl
      });
    } else {
      showProfileListResult(resultMessage, resultUrl);
    }
  } catch (error) {
    if (
      requestVersion === deleteProfileState.requestVersion &&
      !$("delete-profile-dialog").hidden
    ) {
      setDeleteProfileStatus(friendlyError(error), true);
      button.disabled = false;
    }
  } finally {
    if (
      requestVersion === deleteProfileState.requestVersion &&
      !$("delete-profile-dialog").hidden
    ) {
      button.textContent = "创建删除 PR";
    }
  }
});

$("confirm-update-checker").addEventListener("click", async () => {
  const repo = updateCheckerState.repo;
  const generation = updateCheckerState.generation;
  if (!repo || !canRunRepo(repo)) return;

  const button = $("confirm-update-checker");
  button.disabled = true;
  button.textContent = "正在启动…";
  setUpdateCheckerStatus("正在提交 Update Checker 请求…");
  renderActionProgressCard(
    "update-checker-progress",
    null,
    null,
    {
      force: true,
      waitingTitle: "正在建立 Update Checker",
      waitingDetail: "GitHub 建立运行记录后会显示真实步骤。"
    }
  );

  try {
    const result = await request(
      `/api/v1/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/update-checker`,
      {
        method: "POST",
        body: JSON.stringify({
          profileId: $("update-checker-profile").value,
          force: $("update-checker-force").checked
        })
      }
    );
    if (
      generation !== updateCheckerState.generation ||
      $("update-checker-dialog").hidden
    ) return;
    updateCheckerState.runId = Number(result.runId || 0);
    $("update-checker-run-link").href = result.runUrl || "#";
    $("update-checker-run-link").hidden = !result.runUrl;
    setUpdateCheckerStatus("Update Checker 已提交，正在等待真实运行步骤。");
    button.textContent = "运行中…";
    if (updateCheckerState.runId) {
      await pollUpdateCheckerRun(generation);
    } else {
      setUpdateCheckerStatus(
        "GitHub 已接受请求，但暂未返回 Run ID；请通过 Actions 链接查看本次检查。",
        true
      );
      button.disabled = false;
      button.textContent = "再次检查";
    }
  } catch (error) {
    if (
      generation === updateCheckerState.generation &&
      !$("update-checker-dialog").hidden
    ) {
      setUpdateCheckerStatus(friendlyError(error), true);
      button.disabled = false;
      button.textContent = "开始检查";
    }
  }
});

$("update-checker-profile").addEventListener("change", () => {
  const profileId = $("update-checker-profile").value;
  setUpdateCheckerStatus(
    profileId
      ? `将检查 ${profileId}；指定 Profile 时不受 AUTO_UPDATE 开关限制。`
      : "将检查所有 AUTO_UPDATE=true 的 Profile。"
  );
});

$("confirm-release-existing").addEventListener("click", async () => {
  const repo = releaseExistingState.repo;
  const sourceRunId = releaseExistingState.sourceRunId;
  const generation = releaseExistingState.generation;
  if (!repo || !sourceRunId || !canRunRepo(repo)) return;

  const button = $("confirm-release-existing");
  button.disabled = true;
  button.textContent = "正在启动…";
  setReleaseExistingStatus("正在提交 Release Existing Build 请求…");
  renderActionProgressCard(
    "release-existing-progress",
    null,
    null,
    {
      force: true,
      waitingTitle: "正在建立恢复发布任务",
      waitingDetail: "GitHub 建立运行记录后会显示真实步骤。"
    }
  );

  try {
    const result = await request(
      `/api/v1/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/builds/${sourceRunId}/release-existing`,
      { method: "POST", body: "{}" }
    );
    if (
      generation !== releaseExistingState.generation ||
      $("release-existing-dialog").hidden
    ) return;
    releaseExistingState.runId = Number(result.runId || 0);
    $("release-existing-run-link").href = result.runUrl || "#";
    $("release-existing-run-link").hidden = !result.runUrl;
    setReleaseExistingStatus("恢复发布任务已提交，正在等待真实运行步骤。");
    button.textContent = "发布中…";
    if (releaseExistingState.runId) {
      await pollReleaseExistingRun(generation);
    } else {
      setReleaseExistingStatus(
        "GitHub 已接受请求，但暂未返回 Run ID；请通过 Actions 链接查看。",
        true
      );
      button.disabled = false;
      button.textContent = "重新尝试";
    }
  } catch (error) {
    if (
      generation === releaseExistingState.generation &&
      !$("release-existing-dialog").hidden
    ) {
      setReleaseExistingStatus(friendlyError(error), true);
      button.disabled = false;
      button.textContent = "重新尝试";
    }
  }
});

for (const id of ["refresh-builds", "refresh-recent-builds"]) {
  $(id).addEventListener("click", () => {
    clearBuildPolling();
    buildState.requestId = "";
    buildState.pollAttempts = 0;
    loadBuildRuns().catch((error) => showError(error));
  });
}

$("update-checker-close").addEventListener("click", closeUpdateCheckerDialog);
$("update-checker-cancel").addEventListener("click", closeUpdateCheckerDialog);
$("update-checker-dialog").addEventListener("click", (event) => {
  if (event.target === $("update-checker-dialog")) closeUpdateCheckerDialog();
});

$("release-existing-close").addEventListener("click", closeReleaseExistingDialog);
$("release-existing-cancel").addEventListener("click", closeReleaseExistingDialog);
$("release-existing-dialog").addEventListener("click", (event) => {
  if (event.target === $("release-existing-dialog")) closeReleaseExistingDialog();
});

$("build-dialog-close").addEventListener("click", closeBuildDialog);
$("build-dialog-cancel").addEventListener("click", closeBuildDialog);
$("build-dialog").addEventListener("click", (event) => {
  if (event.target === $("build-dialog")) closeBuildDialog();
});

$("profile-lifecycle-close").addEventListener("click", closeProfileLifecycleDialog);
$("profile-lifecycle-cancel").addEventListener("click", closeProfileLifecycleDialog);
$("profile-lifecycle-dialog").addEventListener("click", (event) => {
  if (event.target === $("profile-lifecycle-dialog")) closeProfileLifecycleDialog();
});

$("baseline-profile-close").addEventListener("click", closeBaselineProfileDialog);
$("baseline-profile-cancel").addEventListener("click", closeBaselineProfileDialog);
$("baseline-profile-dialog").addEventListener("click", (event) => {
  if (event.target === $("baseline-profile-dialog")) closeBaselineProfileDialog();
});

$("delete-profile-close").addEventListener("click", closeDeleteProfileDialog);
$("delete-profile-cancel").addEventListener("click", closeDeleteProfileDialog);
$("delete-profile-dialog").addEventListener("click", (event) => {
  if (event.target === $("delete-profile-dialog")) closeDeleteProfileDialog();
});

$("config-studio-target").addEventListener("change", () => {
  configStudioState.targetId = $("config-studio-target").value;
  const target = currentConfigStudioTarget();
  const subtarget =
    (target?.subtargets || []).find((item) => item.selected) ||
    target?.subtargets?.[0] ||
    null;
  configStudioState.subtargetId = subtarget?.id || "";
  const device =
    (subtarget?.devices || []).find((item) => item.selected) ||
    subtarget?.devices?.find((item) => !item.broken) ||
    null;
  configStudioState.deviceProfileId = device?.profileId || "";
  renderConfigStudioTargetSelectors();
  updateConfigStudioChangeCount();
  persistNewConfigStudioUi();
});

$("config-studio-subtarget").addEventListener("change", () => {
  configStudioState.subtargetId = $("config-studio-subtarget").value;
  const subtarget = currentConfigStudioSubtarget();
  const device =
    (subtarget?.devices || []).find((item) => item.selected) ||
    subtarget?.devices?.find((item) => !item.broken) ||
    null;
  configStudioState.deviceProfileId = device?.profileId || "";
  renderConfigStudioTargetSelectors();
  updateConfigStudioChangeCount();
  persistNewConfigStudioUi();
});

$("config-studio-device").addEventListener("change", () => {
  configStudioState.deviceProfileId = $("config-studio-device").value;
  updateConfigStudioChangeCount();
  persistNewConfigStudioUi();
});

$("config-studio-search").addEventListener("input", () => {
  configStudioState.dependencyOnly = false;
  renderConfigStudioPackages();
});

$("config-studio-category").addEventListener("change", () => {
  configStudioState.dependencyOnly = false;
  renderConfigStudioPackageSubmenus();
  renderConfigStudioPackages();
});

$("config-studio-submenu").addEventListener("change", () => {
  configStudioState.dependencyOnly = false;
  renderConfigStudioPackages();
});

$("config-studio-luci-only").addEventListener("change", () => {
  configStudioState.dependencyOnly = false;
  if (
    $("config-studio-luci-only").checked &&
    !$("config-studio-category").value &&
    [...$("config-studio-category").options].some(
      (item) => item.value === "LuCI"
    )
  ) {
    $("config-studio-category").value = "LuCI";
    renderConfigStudioPackageSubmenus();
  }
  renderConfigStudioPackages();
});

$("config-studio-show-dependencies").addEventListener("click", () => {
  configStudioState.dependencyOnly = !configStudioState.dependencyOnly;
  renderConfigStudioPackages();
});

$("config-studio-feature-search").addEventListener(
  "input",
  renderConfigStudioFeatures
);

$("config-studio-feature-menu").addEventListener("change", () => {
  renderConfigStudioFeatureSubmenus();
  renderConfigStudioFeatures();
});

$("config-studio-feature-submenu").addEventListener(
  "change",
  renderConfigStudioFeatures
);

function setConfigStudioTab(tab) {
  const packages = tab === "packages";
  $("config-studio-tab-packages").classList.toggle("active", packages);
  $("config-studio-tab-packages").setAttribute(
    "aria-selected",
    String(packages)
  );
  $("config-studio-tab-features").classList.toggle("active", !packages);
  $("config-studio-tab-features").setAttribute(
    "aria-selected",
    String(!packages)
  );
  $("config-studio-packages-panel").hidden = !packages;
  $("config-studio-features-panel").hidden = packages;
}

$("config-studio-tab-packages").addEventListener("click", () => {
  setConfigStudioTab("packages");
});
$("config-studio-tab-features").addEventListener("click", () => {
  setConfigStudioTab("features");
});

$("config-studio-resolve").addEventListener("click", () => {
  resolveConfigStudio().catch((error) => setConfigStudioError(error));
});

$("config-studio-back").addEventListener("click", () => {
  configStudioState.result = null;
  configStudioState.modifiedValues = new Map();
  pickConfigStudioTargetSelection(true);
  configStudioState.baselineTargetId = configStudioState.targetId;
  configStudioState.baselineSubtargetId = configStudioState.subtargetId;
  configStudioState.baselineDeviceProfileId =
    configStudioState.deviceProfileId;
  setConfigStudioStep(1);
  setConfigStudioStatus(
    "返回修改",
    "以上一轮依赖检查结果作为新的起点；修改后可再次检查依赖。"
  );
  renderConfigStudioCatalog(false);
  persistNewConfigStudioUi();
});

$("config-studio-apply").addEventListener("click", () => {
  applyConfigStudioToProfile().catch((error) => setConfigStudioError(error));
});

$("config-studio-use").addEventListener("click", () => {
  useConfigStudioForNewProfile().catch((error) => setConfigStudioError(error));
});

$("config-studio-close").addEventListener("click", () => {
  closeConfigStudio({ cleanup: false }).catch((error) => showError(error));
});

$("config-studio-cancel").addEventListener("click", () => {
  closeConfigStudio({ cleanup: true }).catch((error) => showError(error));
});

$("config-studio-dialog").addEventListener("click", (event) => {
  if (event.target === $("config-studio-dialog")) {
    closeConfigStudio({ cleanup: false }).catch((error) => showError(error));
  }
});


$("logout").addEventListener("click", async () => {
  clearBuildPolling();
  clearUpdateCheckerPolling();
  clearReleaseExistingPolling();
  clearConfigStudioPolling();
  if (!$("config-studio-dialog").hidden) {
    await closeConfigStudio({ cleanup: true });
  }
  await request("/api/v1/logout", { method: "POST" });
  location.reload();
});

init().catch((error) => showError(error));
