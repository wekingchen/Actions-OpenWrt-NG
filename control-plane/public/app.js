const $ = (id) => document.getElementById(id);

function showError(message = "") {
  const node = $("error");
  node.hidden = !message;
  node.textContent = message;
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.headers || {})
    }
  });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return body;
}

async function loadProfiles(fullName) {
  showError();
  const [owner, repo] = fullName.split("/", 2);
  const data = await request(
    `/api/v1/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/profiles`
  );
  $("profile-card").hidden = false;
  $("profile-title").textContent = fullName + " · Profiles";
  const root = $("profiles");
  root.textContent = "";

  if (!data.profiles.length) {
    root.textContent = "仓库中没有 profiles/ 目录或没有可用 Profile。";
    return;
  }

  for (const profile of data.profiles) {
    const item = document.createElement("div");
    item.className = "profile-item";
    const strong = document.createElement("strong");
    strong.textContent = profile.id;
    const code = document.createElement("code");
    code.textContent = profile.path;
    item.append(strong, code);
    root.appendChild(item);
  }
}

async function init() {
  showError();
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
      " · actions:" +
      repo.permissions.actions;
    button.append(title, meta);
    button.addEventListener("click", () =>
      loadProfiles(repo.fullName).catch((error) => showError(error.message))
    );
    root.appendChild(button);
  }

  if (!data.repositories.length) {
    root.textContent = "当前 GitHub App 安装范围内没有可访问仓库。";
  }
}

$("logout").addEventListener("click", async () => {
  await request("/api/v1/logout", { method: "POST" });
  location.reload();
});

init().catch((error) => showError(error.message));
