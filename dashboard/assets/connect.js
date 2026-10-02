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
        "当前仓库尚未绑定自己的 Control Plane。这是公共模板的安全默认值；Dashboard 与 Profile Wizard 仍可独立使用。";
      endpoint.textContent = "Control Plane URL：未配置";
      action.hidden = true;
      return;
    }

    const target = buildControlPlaneUrl(config, "/");
    state.textContent = "已启用";
    state.className = "status-pill success";
    detail.textContent =
      "将打开该模板实例自己的同源控制面。GitHub 登录、Profile 编辑和 Builder 调度均在控制面完成，公开 Pages 不接收 GitHub Token。";
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
