import { buildProfileFiles, createZipBytes } from "./wizard-core.js";

const $ = (id) => document.getElementById(id);
let generatedFiles = [];
let activeFile = "";

const sourcePresets = {
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
};

function readInput() {
  return {
    profileId: $("profile-id").value,
    profileName: $("profile-name").value,
    sourceRepo: $("source-repo").value,
    sourceBranch: $("source-branch").value,
    adapter: $("adapter").value,
    configText: $("config-text").value,
    autoUpdate: $("auto-update").checked,
    uploadRelease: $("upload-release").checked,
    uploadFirmware: $("upload-firmware").checked,
    maximizeSpace: $("maximize-space").checked,
    streamLog: $("stream-log").checked,
    requiredPackages: $("required-packages").value,
    watchSources: $("watch-sources").value
  };
}

function showError(message) {
  const node = $("form-error");
  if (!message) {
    node.hidden = true;
    node.textContent = "";
    return;
  }
  node.hidden = false;
  node.textContent = message;
}

function generate() {
  showError("");
  try {
    generatedFiles = buildProfileFiles(readInput());
    activeFile = generatedFiles[0].path;
    renderPreview();
    $("wizard-state").textContent = "已生成";
    $("wizard-state").className = "status-pill success";
    return true;
  } catch (error) {
    generatedFiles = [];
    $("wizard-state").textContent = "需要修正";
    $("wizard-state").className = "status-pill failure";
    showError(error.validationErrors?.join(" ") || error.message);
    return false;
  }
}

function renderPreview() {
  if (!generatedFiles.length) return;
  const id = $("profile-id").value.trim();
  $("generated-tree").innerHTML = [
    `profiles/${escapeHtml(id)}/`,
    "├── profile.env",
    "├── .config",
    "├── diy-part1.sh",
    "├── diy-part2.sh",
    "├── required-packages.txt",
    "└── watch-sources.txt"
  ].join("<br>");

  const tabs = $("preview-tabs");
  tabs.textContent = "";
  for (const file of generatedFiles) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "preview-tab" + (file.path === activeFile ? " active" : "");
    button.textContent = file.path.split("/").pop();
    button.addEventListener("click", () => {
      activeFile = file.path;
      renderPreview();
    });
    tabs.appendChild(button);
  }

  const file = generatedFiles.find((item) => item.path === activeFile) || generatedFiles[0];
  $("generated-code").textContent = file.text;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function downloadZip() {
  if (!generate()) return;
  const bytes = createZipBytes(generatedFiles);
  const blob = new Blob([bytes], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `openwrt-ng-profile-${$("profile-id").value.trim()}.zip`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$("source-preset").addEventListener("change", (event) => {
  const preset = sourcePresets[event.target.value];
  if (!preset) return;
  $("source-repo").value = preset.repo;
  $("source-branch").value = preset.branch;
  if (generatedFiles.length) generate();
});

for (const id of ["source-repo", "source-branch"]) {
  $(id).addEventListener("input", () => {
    const match = Object.entries(sourcePresets).find(([, preset]) =>
      preset.repo === $("source-repo").value.trim() &&
      preset.branch === $("source-branch").value.trim()
    );
    $("source-preset").value = match?.[0] || "custom";
  });
}

$("config-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  $("config-text").value = text;
  $("config-file-meta").textContent = `${file.name} · ${Math.ceil(file.size / 1024)} KB`;
  generate();
});

$("config-drop").addEventListener("dragover", (event) => {
  event.preventDefault();
  event.currentTarget.classList.add("dragging");
});

$("config-drop").addEventListener("dragleave", (event) => {
  event.currentTarget.classList.remove("dragging");
});

$("config-drop").addEventListener("drop", async (event) => {
  event.preventDefault();
  event.currentTarget.classList.remove("dragging");
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  $("config-text").value = await file.text();
  $("config-file-meta").textContent = `${file.name} · ${Math.ceil(file.size / 1024)} KB`;
  generate();
});

$("clear-config").addEventListener("click", () => {
  $("config-file").value = "";
  $("config-text").value = "";
  $("config-file-meta").textContent = "尚未选择文件";
  generatedFiles = [];
  $("wizard-state").textContent = "待生成";
  $("wizard-state").className = "status-pill neutral";
  $("generated-code").textContent = "填写左侧表单后点击“预览文件”。";
  $("preview-tabs").textContent = "";
  showError("");
});

$("preview-profile").addEventListener("click", generate);
$("profile-form").addEventListener("submit", (event) => {
  event.preventDefault();
  downloadZip();
});

for (const id of ["profile-id", "profile-name", "source-repo", "source-branch"]) {
  $(id).addEventListener("input", () => {
    if (generatedFiles.length) generate();
  });
}
