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
      state.textContent = "尚未启用";
      state.className = "status-pill warning";
      detail.textContent =
        "V2.0A Auth Broker 尚未配置。公开 Dashboard 仍保持只读，V1.3 Profile Wizard 不受影响。";
      endpoint.textContent = "Control Plane URL：未配置";
      action.hidden = true;
      return;
    }

    const target = buildControlPlaneUrl(config, "/");
    state.textContent = "可连接";
    state.className = "status-pill success";
    detail.textContent =
      "登录与 GitHub 授权将在独立的同源控制面中完成；公开 Pages 不接收 GitHub Token。";
    endpoint.textContent = "Control Plane URL：" + config.controlPlaneUrl;
    action.href = target;
    action.hidden = false;
  } catch (error) {
    state.textContent = "配置错误";
    state.className = "status-pill failure";
    detail.textContent = error.message || String(error);
    endpoint.textContent = "已阻止不安全的 Control Plane 配置。";
    action.hidden = true;
  }
}

init();
