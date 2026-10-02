(() => {
  "use strict";

  const el = (id) => document.getElementById(id);
  const fmtTime = (value) => {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
    }).format(date);
  };
  const fmtDuration = (seconds) => {
    if (!Number.isFinite(seconds)) return "—";
    const mins = Math.floor(seconds / 60);
    const secs = Math.max(0, Math.floor(seconds % 60));
    return mins > 0 ? `${mins}m ${String(secs).padStart(2, "0")}s` : `${secs}s`;
  };
  const statusClass = (status) => {
    if (status === "success") return "success";
    if (status === "failure") return "failure";
    if (status === "in_progress" || status === "queued") return "warning";
    return "neutral";
  };
  const statusLabel = (status) => ({
    success: "Build Success",
    failure: "Build Failed",
    in_progress: "Building",
    queued: "Queued"
  }[status] || status || "Unknown");

  function setLinks(repo) {
    const base = repo.html_url || "#";
    el("repo-link").href = base;
    el("actions-link").href = repo.actions_url || `${base}/actions`;
    el("all-runs-link").href = repo.actions_url || `${base}/actions`;
    el("all-releases-link").href = repo.releases_url || `${base}/releases`;
  }

  function renderOverview(data) {
    const build = data.latest_build || {};
    el("latest-build-title").textContent = build.profile_name || build.profile || "No build";
    const pill = el("latest-build-status");
    pill.textContent = statusLabel(build.status);
    pill.className = `status-pill ${statusClass(build.status)}`;

    const config = build.config || {};
    const configSummary = [config.changed, config.added, config.removed].every((v) => Number.isFinite(v))
      ? `changed ${config.changed} · added ${config.added} · removed ${config.removed}`
      : "—";
    const metrics = [
      ["Profile", build.profile || "—"],
      ["Source", build.source ? `${build.source} @ ${build.branch || "—"}` : "—"],
      ["Commit", build.commit ? build.commit.slice(0, 12) : "—"],
      ["Duration", fmtDuration(build.duration_seconds)],
      ["Config", configSummary]
    ];
    el("latest-build-metrics").innerHTML = metrics.map(([k, v]) =>
      `<div><dt>${k}</dt><dd>${escapeHtml(v)}</dd></div>`
    ).join("");
    el("latest-build-link").href = build.url || "#";

    const update = data.update_status?.[0];
    const upstreamLabel = {
      up_to_date: "Up to date",
      update_available: "Update Available",
      unknown: "Status Unknown"
    };
    el("upstream-status").textContent = update
      ? (upstreamLabel[update.state] || "Status Unknown")
      : "No data";
    el("upstream-detail").textContent = update
      ? `${update.profile}: current ${update.commit?.slice(0, 12) || "unknown"} · built ${update.last_built_commit?.slice(0, 12) || "unknown"}`
      : "暂无上游状态数据";

    const release = data.latest_releases?.[0];
    el("latest-release-tag").textContent = release?.tag || "No release";
    el("latest-release-time").textContent = release ? fmtTime(release.published_at) : "—";
    el("latest-release-link").href = release?.url || "#";

    el("profile-count").textContent = String(data.profiles?.length || 0);
    const enabled = (data.profiles || []).filter((p) => p.auto_update).length;
    el("auto-update-count").textContent = `${enabled} 个启用自动追新`;
  }

  function renderProfiles(profiles) {
    const grid = el("profiles-grid");
    grid.textContent = "";
    const template = el("profile-template");

    profiles.forEach((profile) => {
      const node = template.content.cloneNode(true);
      node.querySelector(".profile-id").textContent = profile.id;
      node.querySelector(".profile-name").textContent = profile.name || profile.id;
      const status = node.querySelector(".profile-status");
      status.textContent = statusLabel(profile.last_build_status);
      status.className = `status-pill profile-status ${statusClass(profile.last_build_status)}`;
      const rows = [
        ["Source", profile.source_repo || "—"],
        ["Branch", profile.source_branch || "—"],
        ["Adapter", profile.adapter || "—"],
        ["Last commit", profile.last_commit ? profile.last_commit.slice(0, 12) : "—"]
      ];
      node.querySelector(".profile-meta").innerHTML = rows.map(([k, v]) =>
        `<div><dt>${k}</dt><dd>${escapeHtml(v)}</dd></div>`
      ).join("");
      node.querySelector(".update-badge").textContent = profile.auto_update ? "Auto update · On" : "Auto update · Off";
      node.querySelector(".profile-run-link").href = profile.last_build_url || "#";
      grid.appendChild(node);
    });

    if (!profiles.length) {
      grid.innerHTML = '<p class="muted">没有可展示的 Profile。</p>';
    }
  }

  function renderBuilds(builds) {
    const body = el("builds-table");
    body.textContent = "";
    builds.forEach((build) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><span class="state-dot ${statusClass(build.status)}"></span>${escapeHtml(statusLabel(build.status))}</td>
        <td>${escapeHtml(build.profile || "—")}</td>
        <td>${escapeHtml(build.event || "—")}</td>
        <td class="mono">${escapeHtml(build.commit ? build.commit.slice(0, 12) : "—")}</td>
        <td>${escapeHtml(fmtDuration(build.duration_seconds))}</td>
        <td>${escapeHtml(fmtTime(build.created_at))}</td>
        <td><a class="text-link" target="_blank" rel="noreferrer" href="${safeUrl(build.url)}">查看 →</a></td>
      `;
      body.appendChild(tr);
    });
  }

  function renderReleases(releases) {
    const list = el("release-list");
    list.textContent = "";
    const template = el("release-template");

    releases.forEach((release) => {
      const node = template.content.cloneNode(true);
      node.querySelector(".release-tag").textContent = release.tag;
      node.querySelector(".release-meta").textContent = `${fmtTime(release.published_at)} · ${release.assets?.length || 0} assets`;
      const chips = node.querySelector(".release-assets");
      const allAssets = release.assets || [];
      const firmwareAssets = allAssets.filter((asset) =>
        /\.(bin|img|img\.gz|itb|trx|tar|tar\.gz|ubi|ubifs|squashfs|iso|vdi|vmdk|vhdx|qcow2)$/i.test(asset.name || "")
      );
      const visibleAssets = (firmwareAssets.length ? firmwareAssets : allAssets).slice(0, 4);

      visibleAssets.forEach((asset) => {
        const chip = document.createElement(asset.download_url ? "a" : "span");
        chip.className = "asset-chip";
        chip.textContent = asset.name;
        if (asset.download_url) {
          chip.href = safeUrl(asset.download_url);
          chip.target = "_blank";
          chip.rel = "noreferrer";
          chip.title = Number.isFinite(asset.size) ? `${formatBytes(asset.size)} · 直接下载` : "直接下载";
        }
        chips.appendChild(chip);
      });

      const candidateCount = firmwareAssets.length || allAssets.length;
      if (candidateCount > visibleAssets.length) {
        const chip = document.createElement("span");
        chip.className = "asset-chip";
        chip.textContent = `+${candidateCount - visibleAssets.length}`;
        chips.appendChild(chip);
      }
      node.querySelector(".release-link").href = release.url || "#";
      list.appendChild(node);
    });
  }

  function formatBytes(value) {
    if (!Number.isFinite(value) || value < 0) return "—";
    if (value < 1024) return `${value} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let size = value / 1024;
    let index = 0;
    while (size >= 1024 && index < units.length - 1) {
      size /= 1024;
      index += 1;
    }
    return `${size >= 100 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function safeUrl(value) {
    try {
      const url = new URL(value, window.location.href);
      return url.protocol === "https:" ? url.href : "#";
    } catch {
      return "#";
    }
  }

  async function boot() {
    try {
      const response = await fetch("./data/status.json", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      setLinks(data.repository || {});
      renderOverview(data);
      renderProfiles(data.profiles || []);
      renderBuilds(data.latest_builds || []);
      renderReleases(data.latest_releases || []);
      el("generated-at").textContent = `Updated ${fmtTime(data.generated_at)}`;
    } catch (error) {
      el("latest-build-title").textContent = "Dashboard data unavailable";
      el("latest-build-status").textContent = "Data Error";
      el("latest-build-status").className = "status-pill failure";
      el("generated-at").textContent = `Failed to load data: ${error.message}`;
    }
  }

  boot();
})();
