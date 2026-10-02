# OpenWrt NG Control Plane

V2 控制面采用 **Public Pages + Same-Origin BFF** 两层结构。

## 为什么不能直接在 GitHub Pages 登录

GitHub Pages 是公开静态站点，不能安全保存 GitHub App client secret、private key、user access token 或 refresh token。
V2 因此不把 GitHub 凭据交给浏览器，也不把写权限加入现有 Pages Workflow。

## V2.0A 架构

```text
GitHub Pages
  Dashboard / Profile Wizard
  只读、无 Token
        |
        | 打开控制面
        v
Control Plane Origin
  UI + Auth Broker + /api/v1/*
  同源 HttpOnly Session
        |
        | GitHub App Web Flow + PKCE
        v
GitHub
```

原则：

- GitHub App 的授权回调只指向 Control Plane Origin。
- GitHub user access token / refresh token 只保存在服务端加密存储。
- 浏览器只持有 Secure + HttpOnly Session Cookie。
- Pages 不通过 CORS 读取登录 Session，也不持有任何 GitHub Token。
- V2.0A 只申请读取仓库所需权限；写 Profile 和触发 Workflow 在后续阶段单独扩权。
- 安装 GitHub App 时应让用户选择目标仓库，不默认要求所有仓库。

## V2.0A GitHub App 最小权限

建议初始权限：

- Repository metadata: read
- Repository contents: read
- Actions: read

V2.0A 不需要：

- Contents: write
- Pull requests: write
- Actions: write
- Administration
- Secrets

V2.0B 在线保存 Profile 时再评估 `contents: write` / `pull_requests: write`。
V2.0C 网页触发 Builder 时再评估 Actions/Workflow 相关写能力。

## API 契约

同源 API 前缀：`/api/v1`

- `GET /api/v1/session`：读取当前登录 Session。
- `GET /api/v1/auth/start?return_to=/...`：开始 GitHub App Web Flow。
- `GET /api/v1/auth/callback`：GitHub OAuth callback，仅由服务端处理。
- `POST /api/v1/logout`：注销并销毁 Session。
- `GET /api/v1/repositories`：列出当前用户与 App 安装共同可访问的仓库。
- `GET /api/v1/repositories/{owner}/{repo}/profiles`：V2.0A 只读列出 Profile。

响应不得包含 GitHub access token、refresh token、client secret 或 private key。

## Session

推荐：

- Cookie: Secure, HttpOnly, SameSite=Lax
- Session ID: 高熵随机值
- 服务端 Session 有绝对过期时间和闲置过期时间
- GitHub user token 使用 GitHub 的过期 token
- logout 时服务端同时清理 Session / token material

## 浏览器配置

`dashboard/data/control-plane.json` 只包含公开信息：

```json
{
  "version": 1,
  "enabled": false,
  "controlPlaneUrl": "",
  "githubAppSlug": ""
}
```

这里禁止放任何 Secret 或 Token。

V2.0A 在未部署 BFF 时保持 `enabled=false`，因此主干 Pages 不会出现“看似可登录、实际泄漏凭据”的半成品状态。
