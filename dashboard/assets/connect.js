import {
  buildControlPlaneUrl,
  loadControlPlaneConfig
} from "./control-plane.js";

const $ = (id) => document.getElementById(id);

async function init() {
  const state = $("control-state");
  const action = $("control-action");
  const detail = $("control-detail");
  const endpoint = $("control-endpoint");

  try {
    const config = await loadControlPlaneConfig();

    if (!config.enabled) {
      state.textContent = "模板默认关闭";
      state.className = "status-pill warning";
      detail.textContent =
        "当前仓库尚未绑定自己的管理中心。这是公共模板的安全默认设置；构建看板和配置方案向导仍可独立使用。";
      endpoint.textContent = "管理中心地址：未配置";
      action.hidden = true;
      return;
    }

    const target = buildControlPlaneUrl(config, "/");
    state.textContent = "已启用";
    state.className = "status-pill success";
    detail.textContent =
      "将打开这个仓库自己的管理中心。GitHub 登录、配置编辑和构建调度都在管理中心完成，公开页面不会接收 GitHub 凭据。";
    endpoint.textContent = "管理中心地址：" + config.controlPlaneUrl;
    action.href = target;
    action.hidden = false;
  } catch (error) {
    state.textContent = "配置错误";
    state.className = "status-pill failure";
    detail.textContent = error.message || String(error);
    endpoint.textContent = "检测到不安全的管理中心配置，已阻止连接。";
    action.hidden = true;
  }
}

init();
