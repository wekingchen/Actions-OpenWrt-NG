export function normalizeControlPlaneConfig(raw) {
  const config = raw && typeof raw === "object" ? raw : {};
  const normalized = {
    version: Number(config.version || 0),
    enabled: config.enabled === true,
    controlPlaneUrl: String(config.controlPlaneUrl || "").trim().replace(/\/$/, ""),
    githubAppSlug: String(config.githubAppSlug || "").trim()
  };

  if (normalized.version !== 1) {
    throw new Error("不支持的 Control Plane 配置版本。");
  }

  if (normalized.enabled) {
    if (!/^https:\/\//i.test(normalized.controlPlaneUrl)) {
      throw new Error("启用 Control Plane 时必须配置 HTTPS 地址。");
    }
    const url = new URL(normalized.controlPlaneUrl);
    if (url.username || url.password || url.search || url.hash) {
      throw new Error("Control Plane 地址不能包含账号、查询参数或片段。");
    }
  }

  return normalized;
}

export function containsSensitiveControlPlaneData(raw) {
  const text = JSON.stringify(raw || {}).toLowerCase();
  return [
    "access_token",
    "refresh_token",
    "client_secret",
    "private_key",
    "github_pat_",
    "ghu_",
    "ghr_",
    "ghs_",
    "ghp_"
  ].some((needle) => text.includes(needle));
}

export function buildControlPlaneUrl(config, path = "/") {
  const normalized = normalizeControlPlaneConfig(config);
  if (!normalized.enabled) return "";
  const rawPath = String(path || "/");
  const suffix = rawPath.startsWith("/") ? rawPath : "/" + rawPath;
  return normalized.controlPlaneUrl + suffix;
}

export async function loadControlPlaneConfig(
  url = "./data/control-plane.json",
  fetchImpl = fetch
) {
  const response = await fetchImpl(url, {
    cache: "no-store",
    credentials: "omit"
  });
  if (!response.ok) {
    throw new Error(`Control Plane 配置读取失败：HTTP ${response.status}`);
  }

  const raw = await response.json();
  if (containsSensitiveControlPlaneData(raw)) {
    throw new Error("Control Plane 公共配置包含疑似凭据，已拒绝加载。");
  }
  return normalizeControlPlaneConfig(raw);
}
