const PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ADAPTER_RE = /^[A-Za-z0-9._-]+$/;

export const PROFILE_TEMPLATE_KEYS = Object.freeze([
  "profileId",
  "profileName",
  "sourceRepo",
  "sourceBranch",
  "adapter",
  "configText",
  "autoUpdate",
  "uploadRelease",
  "uploadFirmware",
  "maximizeSpace",
  "streamLog",
  "requiredPackages",
  "watchSources",
  "extraFeeds",
  "feedPriorityMode"
]);

const BOOLEAN_KEYS = Object.freeze([
  "autoUpdate",
  "uploadRelease",
  "uploadFirmware",
  "maximizeSpace",
  "streamLog"
]);

export class ProfileTemplateError extends Error {
  constructor(code, message, validationErrors = []) {
    super(message || code);
    this.name = "ProfileTemplateError";
    this.code = code;
    this.status = 400;
    this.validationErrors = validationErrors;
  }
}

export function shellQuote(value) {
  const text = String(value ?? "");
  return "'" + text.replaceAll("'", "'\"'\"'") + "'";
}

export function normalizeLines(value) {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

export function feedNameFromLine(line) {
  const match = String(line ?? "").trim().match(
    /^src-git(?:-full)?(?:\s+--force)?\s+([A-Za-z0-9._-]+)\s+([^\s]+)$/
  );
  return match?.[1] || "";
}

export function normalizeFeedLines(value) {
  const lines = normalizeLines(value);
  if (!lines) return "";

  const seen = new Set();
  const output = [];
  for (const line of lines.split("\n")) {
    if (line.startsWith("#")) {
      output.push(line);
      continue;
    }
    const name = feedNameFromLine(line);
    if (name && seen.has(name)) continue;
    if (name) seen.add(name);
    output.push(line);
  }
  return output.join("\n");
}

function validateShape(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ProfileTemplateError(
      "invalid_profile_template",
      "Profile 模板请求格式无效。"
    );
  }
  const unknown = Object.keys(input).filter(
    (key) => !PROFILE_TEMPLATE_KEYS.includes(key)
  );
  if (unknown.length) {
    throw new ProfileTemplateError(
      "invalid_profile_template",
      "Profile 模板包含不允许的字段。"
    );
  }
  for (const key of BOOLEAN_KEYS) {
    if (typeof input[key] !== "boolean") {
      throw new ProfileTemplateError(
        "invalid_profile_template",
        `${key} 必须是布尔值。`
      );
    }
  }
}

export function validateProfileTemplateInput(input) {
  validateShape(input);
  const errors = [];
  const profileId = String(input.profileId ?? "");
  const profileName = String(input.profileName ?? "");
  const sourceRepo = String(input.sourceRepo ?? "");
  const sourceBranch = String(input.sourceBranch ?? "");
  const adapter = String(input.adapter ?? "");
  const configText = String(input.configText ?? "");
  const requiredPackages = String(input.requiredPackages ?? "");
  const watchSources = String(input.watchSources ?? "");
  const extraFeeds = String(input.extraFeeds ?? "");
  const feedPriorityMode = String(
    input.feedPriorityMode ?? "per-package"
  ).trim() || "per-package";

  if (!PROFILE_ID_RE.test(profileId)) {
    errors.push(
      "Profile ID 必须以字母或数字开头，仅包含字母、数字、点、下划线和短横线，且最多 64 个字符。"
    );
  }
  if (!profileName.trim()) errors.push("请填写显示名称。");
  if (/\r|\n/.test(profileName)) errors.push("显示名称不能包含换行。");
  if (profileName.length > 200) errors.push("显示名称不能超过 200 个字符。");

  if (!sourceRepo.trim()) errors.push("请填写源码仓库。");
  if (/\r|\n/.test(sourceRepo)) errors.push("源码仓库不能包含换行。");
  if (sourceRepo.length > 1000) errors.push("源码仓库地址过长。");

  if (!sourceBranch.trim()) errors.push("请填写分支或 Tag。");
  if (/\r|\n/.test(sourceBranch)) errors.push("分支或 Tag 不能包含换行。");
  if (sourceBranch.length > 255) errors.push("分支或 Tag 过长。");

  if (!adapter.trim() || !ADAPTER_RE.test(adapter)) {
    errors.push("Adapter 只能包含字母、数字、点、下划线和短横线。");
  }

  if (!configText.trim()) {
    errors.push("请上传或粘贴 .config。");
  } else if (
    !/^(?:CONFIG_[A-Za-z0-9_]+=|# CONFIG_[A-Za-z0-9_]+ is not set$)/m.test(
      configText
    )
  ) {
    errors.push("输入内容看起来不是有效的 OpenWrt/Kconfig .config。");
  }
  if (configText.includes("\0")) errors.push(".config 包含非法 NUL 字符。");
  if (new TextEncoder().encode(configText).byteLength > 2 * 1024 * 1024) {
    errors.push(".config 不能超过 2 MiB。");
  }

  if (requiredPackages.length > 256 * 1024) {
    errors.push("Manifest 必选包清单过大。");
  }
  const required = normalizeLines(requiredPackages);
  for (const raw of required ? required.split("\n") : []) {
    const packageName = raw.split("#", 1)[0].trim();
    if (!packageName) continue;
    if (!/^[A-Za-z0-9._+@-]+$/.test(packageName)) {
      errors.push(`Manifest 包名格式不合法：${packageName}`);
      break;
    }
  }

  if (!["per-package", "feed-order"].includes(feedPriorityMode)) {
    errors.push("Feed 冲突策略必须是 per-package 或 feed-order。");
  }

  if (extraFeeds.length > 256 * 1024) {
    errors.push("额外 feeds 清单过大。");
  }
  const normalizedFeeds = normalizeLines(extraFeeds);
  for (const line of normalizedFeeds ? normalizedFeeds.split("\n") : []) {
    if (line.startsWith("#")) continue;
    const match = line.match(
      /^src-git(?:-full)?(?:\s+--force)?\s+([A-Za-z0-9._-]+)\s+([^\s]+)$/
    );
    if (!match) {
      errors.push(
        "额外 feed 格式必须是：src-git [--force] 名称 Git地址[;分支]。"
      );
      break;
    }
  }

  if (watchSources.length > 256 * 1024) {
    errors.push("额外 Git 上游清单过大。");
  }
  const labels = new Set(["source"]);
  const watch = normalizeLines(watchSources);
  for (const line of watch ? watch.split("\n") : []) {
    const parts = line.split("|");
    if (parts.length !== 3 || parts.some((part) => !part.trim())) {
      errors.push("额外 Git 上游格式必须是 label|git_url|branch_or_tag。");
      break;
    }
    const label = parts[0].trim();
    if (!/^[A-Za-z0-9._-]+$/.test(label)) {
      errors.push(
        "额外 Git 上游的 label 只能包含字母、数字、点、下划线和短横线。"
      );
      break;
    }
    if (labels.has(label)) {
      errors.push(`额外 Git 上游 label 重复或保留：${label}`);
      break;
    }
    labels.add(label);
  }

  return errors;
}

export function buildProfileTemplateFiles(input) {
  const errors = validateProfileTemplateInput(input);
  if (errors.length) {
    throw new ProfileTemplateError(
      "invalid_profile_template",
      errors.join("\n"),
      errors
    );
  }

  const id = input.profileId.trim();
  const base = `profiles/${id}`;
  const requiredPackages = normalizeLines(input.requiredPackages);
  const watchSources = normalizeLines(input.watchSources);
  const extraFeeds = normalizeFeedLines(input.extraFeeds);
  const feedPriorityMode = String(
    input.feedPriorityMode ?? "per-package"
  ).trim() || "per-package";

  const profileEnv = [
    `PROFILE_NAME=${shellQuote(input.profileName.trim())}`,
    `SOURCE_REPO=${shellQuote(input.sourceRepo.trim())}`,
    `SOURCE_BRANCH=${shellQuote(input.sourceBranch.trim())}`,
    `ADAPTER=${shellQuote(input.adapter.trim())}`,
    "",
    `CONFIG_FILE=${shellQuote(`${base}/.config`)}`,
    `DIY_PART1=${shellQuote(`${base}/diy-part1.sh`)}`,
    `DIY_PART2=${shellQuote(`${base}/diy-part2.sh`)}`,
    `REQUIRED_PACKAGES_FILE=${shellQuote(
      `${base}/required-packages.txt`
    )}`,
    `WATCH_SOURCES_FILE=${shellQuote(`${base}/watch-sources.txt`)}`,
    `EXTRA_FEEDS_FILE=${shellQuote(`${base}/feeds.conf`)}`,
    "",
    `AUTO_UPDATE=${shellQuote(input.autoUpdate ? "true" : "false")}`,
    `MAXIMIZE_BUILD_SPACE=${shellQuote(
      input.maximizeSpace ? "true" : "false"
    )}`,
    `FEED_PRIORITY_MODE=${shellQuote(feedPriorityMode)}`,
    "STREAM_BUILD_LOG='false'",
    "",
    "UPLOAD_BIN_DIR='false'",
    `UPLOAD_FIRMWARE=${shellQuote(
      input.uploadFirmware ? "true" : "false"
    )}`,
    `UPLOAD_RELEASE=${shellQuote(input.uploadRelease ? "true" : "false")}`,
    ""
  ].join("\n");

  const diy = `#!/usr/bin/env bash
set -Eeuo pipefail

# 在这里添加此 Profile 专属的通用 OpenWrt 配置调整。
# 默认留空即可。
`;

  const watch = [
    "# 可选额外 Git 上游监控。",
    "# 格式：label|git_url|branch_or_tag",
    "# SOURCE_REPO / SOURCE_BRANCH 已自动监控，无需重复填写。",
    ...(watchSources ? ["", watchSources] : []),
    ""
  ].join("\n");

  const required = requiredPackages
    ? requiredPackages + "\n"
    : "# 每行一个必须出现在最终 image manifest 中的软件包；留空表示不额外强制。\n";

  const configText = input.configText.replace(/\r\n/g, "\n");
  return [
    { path: `${base}/profile.env`, text: profileEnv, mode: "100644" },
    {
      path: `${base}/.config`,
      text: configText.endsWith("\n") ? configText : configText + "\n",
      mode: "100644"
    },
    { path: `${base}/diy-part1.sh`, text: diy, mode: "100755" },
    { path: `${base}/diy-part2.sh`, text: diy, mode: "100755" },
    {
      path: `${base}/required-packages.txt`,
      text: required,
      mode: "100644"
    },
    { path: `${base}/watch-sources.txt`, text: watch, mode: "100644" },
    {
      path: `${base}/feeds.conf`,
      text: [
        "# 在 ./scripts/feeds update -a 前插入的额外 feeds。",
        "# 格式：src-git [--force] 名称 Git地址[;分支]",
        ...(extraFeeds ? ["", extraFeeds] : []),
        ""
      ].join("\n"),
      mode: "100644"
    }
  ];
}

export function profileFilesObject(files) {
  const out = {};
  for (const file of files) {
    const name = String(file.path || "").split("/").pop();
    out[name] = file.text;
  }
  return out;
}
