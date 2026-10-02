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
- 权限按能力最小化设计：V2.0A 只读需要 Metadata read + Contents read；V2.0B 编辑再增加 Contents write + Pull requests write；V2.0C Builder 再增加 Actions write。
- 对当前完整 V2 功能的新部署，推荐一次配置最终权限：Metadata read、Contents write、Pull requests write、Actions write；不需要 Administration / Workflows。
- V2.0B 写入严格限定在 `profiles/<id>/` 的标准文件，默认分支永不由控制面直接修改。
- V2.0B 使用 Git Database API 原子创建 commit，再创建独立分支与 Pull Request。
- 所有状态变更请求同时校验精确 Origin 与 `X-OpenWrt-NG-CSRF` 请求头。
- 保存前携带默认分支基线 SHA；若仓库已变化，返回 `409 repository_changed`，要求重新加载后再编辑。
- V2.0C 只允许调度固定的 `.github/workflows/build-openwrt.yml`，不接受浏览器传入任意 workflow、ref 或额外 inputs。
- V2.0C 同一 Profile 已有 queued / running 构建时拒绝重复触发，避免误操作浪费 Actions 时长。
- Builder 调度使用服务端生成的随机 request ID 与实际 Actions Run 关联；若 GitHub dispatch API 直接返回 run ID，也会兼容使用。

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
- Redirect URI（GitHub UI；即 OAuth callback）：`https://...workers.dev/api/v1/auth/callback`
- Setup URL：`https://...workers.dev/`
- Expire user authorization tokens：开启
- Request user authorization during installation：**不要开启**
- Device Flow：关闭
- Webhook：关闭
- Repository permissions（当前完整 V2 推荐一次配齐）：
  - Metadata：Read-only
  - Contents：Read and write
  - Pull requests：Read and write
  - Actions：Read and write
  - Administration：No access
  - Workflows：No access
- 安装仓库建议使用 **Only select repositories**，只授权真正需要由控制面管理的仓库

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

打开 Worker 首页，建议先用独立测试仓库完成整套验收：

1. 点击“使用 GitHub 登录”。
2. 登录成功后安装 / 调整 GitHub App，并只授权目标测试仓库。
3. 仓库列表应显示 Profile 可读取、可编辑 / PR、Builder 可运行。
4. 点击仓库与 Profile，确认可以读取标准 `profiles/*` 文件。
5. 做一次无害编辑，预览差异后创建 Pull Request；确认默认分支没有被直接修改。
6. 不勾 Release，触发一次 Builder；确认页面能自动关联 Run、持续更新 Job 状态并最终显示 Artifact / Summary。
7. 再测试一次“新建 Profile”：服务端预览应只生成标准 6 文件，创建 PR 后确认默认分支仍未直接变化。
8. 验证通过后关闭测试 PR、清理临时分支，再在自己的模板实例启用 Pages Control Plane 入口。

这套验证覆盖当前 V2.0A / V2.0B / V2.0C 的核心链路。首次测试建议关闭 Release，避免测试仓库留下无意义发布物。

### 8. V2.0B：在线编辑 Profile 并通过 PR 保存

V2.0B 已完成独立测试仓库的真实端到端写入验证：Control Plane 创建的新 commit 以当前默认分支为唯一父提交，PR 只包含预期 Profile 文件变化，创建 PR 前后默认分支 SHA 保持不变。

V2.0B 不允许直接写默认分支。编辑流程固定为：

```text
读取默认分支 + 基线 SHA
        ↓
编辑标准 Profile 文件
        ↓
浏览器预览变更
        ↓
服务端再次校验基线 SHA
        ↓
原子创建 Git commit
        ↓
创建 openwrt-ng/profile-* 分支
        ↓
创建 Pull Request
        ↓
用户在 GitHub 审核后决定是否合并
```

如果只部署到 V2.0B，可使用 Metadata read + Contents write + Pull requests write，并保持 Actions No access；当前完整 V2 推荐直接使用前文的最终权限。

如果后续修改 GitHub App 权限，已有安装可能需要重新确认权限变更。修改后建议退出 Control Plane 并重新登录一次，避免旧授权状态造成判断混乱。

V2.0B 只接受以下文件：

```text
.config
profile.env
diy-part1.sh
diy-part2.sh
required-packages.txt
watch-sources.txt
```

控制面不会接受任意仓库路径，也不会修改 `.github/workflows/*`，因此本阶段不需要 Workflows 权限。

### 9. V2.0C：触发 Builder 与查看运行状态

V2.0C 核心链路已在独立 Test 仓完成真实端到端验证：

- Control Plane 成功触发固定 Builder。
- request ID 与实际 Actions Run 精确对应。
- Run / Job 状态可读取并跟踪。
- 编译、Manifest 校验、最终配置留档、固件 Artifact 上传与 Workflow Summary 均真实成功。
- 首轮真实验收明确关闭 Release，因此发布 Job 正常跳过，Test 仓未留下测试 Release；Release 识别/展示逻辑由自动化回归测试覆盖。

V2.0C 在 V2.0B 的权限基础上额外需要：

- Actions：Read and write

GitHub 官方对 `workflow_dispatch` 要求 Actions write；读取 workflow runs、jobs 和 artifacts 只需要 Actions read。控制面虽然获得 Actions write，但服务端接口只暴露固定 Builder 调度，不允许浏览器指定其他 workflow 或任意 ref。

控制面固定调用：

```text
.github/workflows/build-openwrt.yml
ref = 仓库默认分支
profile = 当前选择的 Profile
publish_release = 用户明确选择
control_plane_request_id = 服务端随机生成
```

Builder 增加一个可选的 `control_plane_request_id` 输入。手动运行时保持为空即可；Control Plane 调度时会自动填入，用于精确关联本次点击与实际 Actions Run。

调度请求同时设置 GitHub 的 `return_run_details=true`：支持该能力时直接获得 `workflow_run_id` 并按 Run ID 轮询；若 GitHub 返回旧式空响应，则自动退回 `control_plane_request_id` 搜索。两条路径均保留，避免依赖 Actions Run 列表的传播延迟。

页面可查看：

- queued / running / completed 与最终 conclusion。
- 各 Job 状态及 GitHub Actions 链接。
- 当前 Run 产生的 Artifact 名称、大小与 GitHub 下载链接。
- 与当前 Builder Run 匹配的 Release。
- GitHub Actions Run 页面；该页面同时是 Workflow Summary 的入口。

Artifact 链接使用 GitHub 自身的登录态，不把 GitHub access token 暴露给浏览器。

同一 Profile 已经存在活动构建时，Control Plane 返回 `409 build_already_active`，不会再次排队。

### 10. V2.0D：直接新建标准 Profile

V2.0D 在控制面中补齐 Profile Wizard 到仓库写入之间的缺口。用户填写与 Wizard 一致的结构化字段：

- Profile ID / 显示名称。
- 源码仓库、分支 / Tag、Adapter。
- OpenWrt `.config`。
- 自动追新、Release、Artifact、构建空间、流式日志开关。
- Manifest 必选软件包与额外 Git 上游监控。

安全边界：

```text
浏览器提交结构化字段
        ↓
服务端校验并生成固定 6 个文件
        ↓
预览（不写 GitHub）
        ↓
用户确认
        ↓
服务端重新生成相同标准文件
        ↓
检查 profiles/<id> 当前不存在
        ↓
原子 commit → 新分支 → Pull Request
```

服务端只会生成：

```text
profiles/<id>/.config
profiles/<id>/profile.env
profiles/<id>/diy-part1.sh
profiles/<id>/diy-part2.sh
profiles/<id>/required-packages.txt
profiles/<id>/watch-sources.txt
```

浏览器不能通过该接口提交任意仓库路径；如果目标 Profile 已经存在，返回 `409 profile_already_exists`，不会覆盖。预览时 `.config` 会发送到用户自己的 Control Plane 做服务端校验，但不会写入 GitHub。

### 11. 在自己的模板实例中启用 GitHub Pages V2 入口

**公共模板仓库的 `main` 应继续保持默认关闭，不应提交模板维护者自己的 workers.dev 地址或 GitHub App slug。**

使用本模板创建自己的仓库后，在该仓库完成 Control Plane 部署与真实验证，再修改：

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

模板仓库默认值应保持：

```json
{
  "version": 1,
  "enabled": false,
  "controlPlaneUrl": "",
  "githubAppSlug": ""
}
```

这样从模板创建的新仓库不会误连到模板维护者的 Control Plane。

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
