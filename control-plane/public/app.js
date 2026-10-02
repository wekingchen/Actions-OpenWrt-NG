const $ = (id) => document.getElementById(id);

const PROFILE_FILES = [
  ".config",
  "profile.env",
  "diy-part1.sh",
  "diy-part2.sh",
  "required-packages.txt",
  "watch-sources.txt"
];

const editorState = {
  repo: null,
  profileId: "",
  baseRefSha: "",
  original: {},
  files: {},
  currentFile: ".config",
  previewValid: false
};

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
    throw new Error((body.error || `HTTP ${response.status}`) + suffix);
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

async function openProfile(repo, profileId) {
  showError();
  showWriteResult();
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
    const content = data.profile.files[name]?.content || "";
    editorState.original[name] = content;
    editorState.files[name] = content;
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
  $("editor-card").hidden = true;
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
      repo.permissions.pullRequests;
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

$("logout").addEventListener("click", async () => {
  await request("/api/v1/logout", { method: "POST" });
  location.reload();
});

init().catch((error) => showError(error.message));
