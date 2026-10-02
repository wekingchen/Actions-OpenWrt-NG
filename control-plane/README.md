# OpenWrt NG Control Plane

V2 控制面的**默认部署方式是 Cloudflare Workers + D1**。不要求用户自备 VPS、Docker、Caddy 或常驻数据库。

自托管 Node.js + SQLite + Docker 仍保留为可选高级方案，但不再是主路线。

## 架构

```text
GitHub Pages
  Dashboard / Profile Wizard
  只读、无 Token
        |
        | 打开控制面
        v
Cloudflare Workers
  静态 UI + Auth Broker + /api/v1/*
  Same-Origin HttpOnly Session
        |
        +---- D1
        |     OAuth state / Session / 加密后的 GitHub token
        |
        +---- Worker Secrets
        |     GitHub Client Secret / TOKEN_ENCRYPTION_KEY
        |
        v
GitHub App / GitHub API
```

安全原则：

- GitHub Pages 继续保持公开只读，不持有 GitHub Token。
- GitHub App 使用 Web Application Flow + PKCE。
- OAuth state 额外绑定发起浏览器的 HttpOnly nonce Cookie，防 Login CSRF。
- 浏览器只持有随机 Session ID，不接触 GitHub access / refresh token。
- GitHub token 使用 AES-256-GCM 加密后写入 D1。
- Session 同时具有绝对过期与闲置过期。
- GitHub user token 临近到期时由 Worker 自动 refresh。
- V2.0A 只需要 GitHub Repository Metadata read + Contents read。

## 目录

- `worker.mjs`：Cloudflare Workers 主入口。
- `lib/d1-store.mjs`：D1 Session / OAuth state 存储。
- `migrations/`：D1 schema migration。
- `public/`：与 API 同源部署的控制面静态 UI。
- `wrangler.jsonc`：Workers / D1 / Assets 配置。
- `worker.test.mjs`：Worker OAuth / Session / Repository / Profile 回归。
- `server.mjs` + `lib/store.mjs`：可选自托管兼容实现。
- `Dockerfile`：可选自托管镜像。

## 推荐部署：GitHub Actions + Cloudflare

不需要本地安装 Wrangler。

### 1. Cloudflare 创建 D1

在 Cloudflare Dashboard 创建数据库：

```text
openwrt-ng-control-plane
```

记录它的 **Database ID**。

在本仓库 Settings → Secrets and variables → Actions → Variables 新建：

```text
CONTROL_PLANE_D1_DATABASE_ID=<Database ID>
```

### 2. 创建 Cloudflare API Token

GitHub Actions 中 Wrangler 需要：

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

把二者保存为仓库 Actions Secrets。

第一次由 CI 创建 Worker 时，Token 需要 Workers 产品范围的创建权限；D1 migration 还需要对目标 D1 的编辑权限。Worker 创建后可以再把 Token 收紧为只允许编辑该 Worker，并保留目标 D1 所需权限。

### 3. 第一次 bootstrap 部署

Actions → **Deploy V2 Control Plane** → **Run workflow**

保持：

```text
同步 GitHub App Secret = false
```

Workflow 会：

1. 应用 D1 migration。
2. 部署 Worker + 静态 UI。
3. 不要求 GitHub App Secret。

完成后，从 Workflow 日志或 Cloudflare Dashboard 获取：

```text
https://openwrt-ng-control-plane.<你的workers子域>.workers.dev
```

此时访问 `/api/v1/health` 应返回：

```json
{
  "ok": true,
  "version": 1,
  "runtime": "cloudflare-workers",
  "configured": false
}
```

### 4. 创建 GitHub App

使用刚才真实的 workers.dev 地址：

- Homepage URL：`https://...workers.dev`
- Callback URL：`https://...workers.dev/api/v1/auth/callback`
- Setup URL：`https://...workers.dev/`
- Expire user authorization tokens：开启
- Request user authorization during installation：**不要开启**
- Device Flow：关闭
- Webhook：关闭
- Repository permissions：
  - Metadata：Read-only
  - Contents：Read-only
- 安装仓库建议使用 **Only select repositories**

记录：

- Client ID
- Client Secret
- App slug

### 5. 配置 GitHub Actions Secrets

仓库 Actions Secrets 新建：

```text
OPENWRT_NG_GITHUB_APP_CLIENT_ID
OPENWRT_NG_GITHUB_APP_CLIENT_SECRET
OPENWRT_NG_GITHUB_APP_SLUG
TOKEN_ENCRYPTION_KEY
```

其中 `TOKEN_ENCRYPTION_KEY` 必须是稳定的高熵随机值，至少 32 字符。**以后重新部署也不要随意更换**，否则 D1 中既有加密 token 无法解密。

例如本地生成：

```bash
openssl rand -hex 32
```

Client Secret、TOKEN_ENCRYPTION_KEY 不得写进仓库文件或 `dashboard/data/control-plane.json`。

### 6. 第二次部署并同步 Secret

Actions → **Deploy V2 Control Plane** → **Run workflow**

这次勾选：

```text
同步 GitHub App Secret = true
```

Workflow 会先部署代码与 D1 migration，再使用 Wrangler Secret API 把四个 GitHub App / 加密 Secret 写入 Worker。

访问：

```text
https://...workers.dev/api/v1/health
```

应看到：

```json
{
  "ok": true,
  "version": 1,
  "runtime": "cloudflare-workers",
  "configured": true
}
```

### 7. 真实验证

打开 Worker 首页：

1. 点击“使用 GitHub 登录”。
2. 登录成功后安装 / 调整 GitHub App。
3. 只授权目标仓库。
4. 页面应列出该仓库。
5. 点击仓库后应读取到 `profiles/*`，例如 `profiles/default`。

只有这五步真实通过后，才启用公开 Pages 入口。

### 8. 启用 GitHub Pages V2 入口

修改：

`dashboard/data/control-plane.json`

例如：

```json
{
  "version": 1,
  "enabled": true,
  "controlPlaneUrl": "https://openwrt-ng-control-plane.example.workers.dev",
  "githubAppSlug": "your-app-slug"
}
```

这个文件只允许公开信息。严禁放入 Client Secret、GitHub token 或 TOKEN_ENCRYPTION_KEY。

## Bootstrap 模式

Worker 可以在没有 GitHub App Secret 时先上线。

在此状态：

- 静态 UI 可访问。
- `/api/v1/health` 正常。
- `/api/v1/config` 正常。
- GitHub 登录入口会显示“尚未配置”。
- 其他需要认证的 API 返回 `503 control_plane_not_configured`。

这样可以先获得真实 workers.dev URL，再创建 GitHub App，不存在 Callback URL 的初始化死循环。

## 本地 Wrangler（可选）

需要 Node.js 24。

```bash
cd control-plane
npm install
npx wrangler d1 migrations apply DB --local
npx wrangler dev
```

本地 Secret 放入 `.dev.vars`，该文件已被 `.gitignore` 排除。

## 自托管 Docker（可选）

Node.js + SQLite + Docker 版本仍保留用于不希望依赖 Cloudflare 的用户。

它不再是 V2 的默认教程。相关实现：

- `server.mjs`
- `lib/store.mjs`
- `Dockerfile`

无论使用 Workers 还是 Docker，浏览器侧与 GitHub App 的安全边界保持一致。
