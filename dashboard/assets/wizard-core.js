const encoder = new TextEncoder();

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

export function validateProfileInput(input) {
  const errors = [];
  const profileId = String(input.profileId ?? "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profileId)) {
    errors.push("Profile ID 必须以字母或数字开头，仅包含字母、数字、点、下划线和短横线，且最多 64 个字符。");
  }
  if (!(input.profileName || "").trim()) errors.push("请填写显示名称。");
  if (/\r|\n/.test(input.profileName || "")) errors.push("显示名称不能包含换行。");
  if (!(input.sourceRepo || "").trim()) errors.push("请填写源码仓库。");
  if (/\r|\n/.test(input.sourceRepo || "")) errors.push("源码仓库不能包含换行。");
  if (!(input.sourceBranch || "").trim()) errors.push("请填写分支或 Tag。");
  if (/\r|\n/.test(input.sourceBranch || "")) errors.push("分支或 Tag 不能包含换行。");
  const configText = String(input.configText ?? "");
  if (!configText.trim()) {
    errors.push("请上传或粘贴 .config。");
  } else if (!/^(?:CONFIG_[A-Za-z0-9_]+=|# CONFIG_[A-Za-z0-9_]+ is not set$)/m.test(configText)) {
    errors.push("输入内容看起来不是有效的 OpenWrt/Kconfig .config。");
  }
  if (configText.includes("\0")) errors.push(".config 包含非法 NUL 字符。");

  const required = normalizeLines(input.requiredPackages);
  for (const raw of required ? required.split("\n") : []) {
    const packageName = raw.split("#", 1)[0].trim();
    if (!packageName) continue;
    if (!/^[A-Za-z0-9._+@-]+$/.test(packageName)) {
      errors.push(`Manifest 包名格式不合法：${packageName}`);
      break;
    }
  }

  const feeds = normalizeLines(input.extraFeeds);
  for (const line of feeds ? feeds.split("\n") : []) {
    if (line.startsWith("#")) continue;
    const match = line.match(
      /^src-git(?:-full)?(?:\s+--force)?\s+([A-Za-z0-9._-]+)\s+([^\s]+)$/
    );
    if (!match) {
      errors.push("额外 feed 格式必须是：src-git [--force] 名称 Git地址[;分支]。");
      break;
    }
  }

  const labels = new Set(["source"]);
  const watch = normalizeLines(input.watchSources);
  for (const line of watch ? watch.split("\n") : []) {
    const parts = line.split("|");
    if (parts.length !== 3 || parts.some((part) => !part.trim())) {
      errors.push("额外 Git 上游格式必须是 label|git_url|branch_or_tag。");
      break;
    }
    const label = parts[0].trim();
    if (!/^[A-Za-z0-9._-]+$/.test(label)) {
      errors.push("额外 Git 上游的 label 只能包含字母、数字、点、下划线和短横线。");
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

export function buildProfileFiles(input) {
  const errors = validateProfileInput(input);
  if (errors.length) {
    const error = new Error(errors.join("\n"));
    error.validationErrors = errors;
    throw error;
  }

  const id = input.profileId.trim();
  const base = `profiles/${id}`;
  const requiredPackages = normalizeLines(input.requiredPackages);
  const watchSources = normalizeLines(input.watchSources);
  const extraFeeds = normalizeFeedLines(input.extraFeeds);

  const profileEnv = [
    `PROFILE_NAME=${shellQuote(input.profileName.trim())}`,
    `SOURCE_REPO=${shellQuote(input.sourceRepo.trim())}`,
    `SOURCE_BRANCH=${shellQuote(input.sourceBranch.trim())}`,
    `ADAPTER=${shellQuote(input.adapter || "direct-openwrt")}`,
    "",
    `CONFIG_FILE=${shellQuote(`${base}/.config`)}`,
    `DIY_PART1=${shellQuote(`${base}/diy-part1.sh`)}`,
    `DIY_PART2=${shellQuote(`${base}/diy-part2.sh`)}`,
    `REQUIRED_PACKAGES_FILE=${shellQuote(`${base}/required-packages.txt`)}`,
    `WATCH_SOURCES_FILE=${shellQuote(`${base}/watch-sources.txt`)}`,
    `EXTRA_FEEDS_FILE=${shellQuote(`${base}/feeds.conf`)}`,
    "",
    `AUTO_UPDATE=${shellQuote(input.autoUpdate ? "true" : "false")}`,
    `MAXIMIZE_BUILD_SPACE=${shellQuote(input.maximizeSpace ? "true" : "false")}`,
    `STREAM_BUILD_LOG=${shellQuote(input.streamLog ? "true" : "false")}`,
    "",
    `UPLOAD_BIN_DIR='false'`,
    `UPLOAD_FIRMWARE=${shellQuote(input.uploadFirmware ? "true" : "false")}`,
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
    { path: `${base}/.config`, text: configText.endsWith("\n") ? configText : configText + "\n", mode: "100644" },
    { path: `${base}/diy-part1.sh`, text: diy, mode: "100755" },
    { path: `${base}/diy-part2.sh`, text: diy, mode: "100755" },
    { path: `${base}/required-packages.txt`, text: required, mode: "100644" },
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

function crc32Table() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
}

const CRC_TABLE = crc32Table();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value) {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff);
}

function u32(value) {
  return Uint8Array.of(
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff
  );
}

function concat(parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function createZipBytes(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.path);
    const data = file.bytes instanceof Uint8Array ? file.bytes : encoder.encode(file.text ?? "");
    const crc = crc32(data);
    const externalAttrs = file.mode === "100755" ? (0o100755 << 16) >>> 0 : (0o100644 << 16) >>> 0;

    const local = concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length),
      u16(name.length), u16(0), name, data
    ]);
    locals.push(local);

    const central = concat([
      u32(0x02014b50), u16(0x0314), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length),
      u16(name.length), u16(0), u16(0), u16(0), u16(0),
      u32(externalAttrs), u32(offset), name
    ]);
    centrals.push(central);
    offset += local.length;
  }

  const centralBytes = concat(centrals);
  const localBytes = concat(locals);
  const end = concat([
    u32(0x06054b50), u16(0), u16(0),
    u16(files.length), u16(files.length),
    u32(centralBytes.length), u32(localBytes.length),
    u16(0)
  ]);
  return concat([localBytes, centralBytes, end]);
}
