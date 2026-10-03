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
- V2.0B 使用 Git Database API 原子创建 commit，再创建独立分支与 Pull Request；Control Plane 默认立即 squash 合并，成功后删除临时分支。
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
5. 做一次无害编辑，预览差异后保存；确认 Control Plane 创建 PR、自动 squash 合并，并清理临时分支。若仓库规则阻止合并，应保留 PR 并在页面提供入口。
6. 在目标配置行点击“构建”，在确认弹层中保持“本次构建同时发布 Release”关闭后开始构建；确认工作区“最近构建”自动更新，构建页能查看完整历史、Artifact / Release / Actions 出口。
7. 再测试一次“新建 Profile”：服务端预览应只生成标准 7 文件，保存后 PR 应自动合并到默认分支并清理临时分支。
8. 验证结束后确认没有遗留的 Open Profile PR 与 `openwrt-ng/profile-*` 临时分支，再在自己的模板实例启用 Pages Control Plane 入口。

这套验证覆盖当前 V2.0A / V2.0B / V2.0C / V2.0D 的核心链路。首次测试建议关闭 Release，避免测试仓库留下无意义发布物。

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
Control Plane 尝试 squash 自动合并
        ├─ 成功 → 删除临时分支 → 清理同 Profile 已被取代的旧 Control Plane PR
        └─ 受仓库规则 / 检查阻止 → 保留 PR 与分支，前端提示人工处理
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
profile = 用户点击“构建”的目标 Profile
publish_release = 构建确认弹层中用户明确选择
control_plane_request_id = 服务端随机生成
```

Builder 增加一个可选的 `control_plane_request_id` 输入。手动运行时保持为空即可；Control Plane 调度时会自动填入，用于精确关联本次点击与实际 Actions Run。

调度请求同时设置 GitHub 的 `return_run_details=true`：支持该能力时直接获得 `workflow_run_id` 并按 Run ID 轮询；若 GitHub 返回旧式空响应，则自动退回 `control_plane_request_id` 搜索。两条路径均保留，避免依赖 Actions Run 列表的传播延迟。

页面职责按三层拆分：

- **工作区**：显示配置摘要与当前仓库最近 5 次构建，不保存“当前 Profile”构建状态。
- **配置**：管理 Profile；每一行唯一的“构建”入口会打开确认弹层，明确显示本次目标 Profile。
- **构建**：显示当前仓库最近 100 次构建、运行详情与产物，不再放置第二个“开始构建”入口。
- 构建确认弹层里的“本次构建同时发布 Release”只控制本次运行；若目标 Profile 的 `UPLOAD_RELEASE=false`，该开关直接禁用并说明原因。
- 活动 Run 会自动轮询；手动刷新仅作为小图标补充操作。切换仓库、快速切换 Profile 或关闭构建弹层时，旧异步响应会被版本隔离，不会覆盖当前视图。
- 点击“开始构建”后，不再只显示“等待 GitHub 建立运行记录”。工作区会立即出现统一 Action 进度卡；一旦拿到 run/job 数据，就显示 Profile 预检、源码、Feeds、缓存、编译、产物、Release、清理等真实阶段。构建详情页复用同一份 progress 数据。
- 成功记录提供产物入口和 GitHub Actions 链接；详情中展示 Artifact 下载入口、匹配的 Release 和 Job 状态。

Artifact 下载先经过 Control Plane 会话鉴权，再由服务端使用 GitHub user token 获取短时下载重定向；浏览器不会获得 GitHub access token，也不依赖浏览器是否已单独登录 GitHub。

同一 Profile 已经存在活动构建时，Control Plane 返回 `409 build_already_active`，不会再次排队。

### 10. V2.0D：直接新建标准 Profile

V2.0D 的写入仍先生成独立 Pull Request：PR 恰好包含 7 个标准文件和 1 个 commit，DIY 脚本 mode 为 100755，其余文件为 100644。自 0.16.0 起，Control Plane 默认在 PR 创建后立即 squash 合并并删除临时分支；若合并被仓库规则或检查阻止，则保留 PR 供人工处理。

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
服务端校验并生成固定 7 个文件
        ↓
预览（不写 GitHub）
        ↓
用户确认
        ↓
服务端重新生成相同标准文件
        ↓
检查 profiles/<id> 当前不存在
        ↓
原子 commit → 新分支 → Pull Request → 自动 squash 合并 → 清理分支
```

服务端只会生成：

```text
profiles/<id>/.config
profiles/<id>/profile.env
profiles/<id>/diy-part1.sh
profiles/<id>/diy-part2.sh
profiles/<id>/required-packages.txt
profiles/<id>/watch-sources.txt
profiles/<id>/feeds.conf
```

浏览器不能通过该接口提交任意仓库路径；如果目标 Profile 已经存在，返回 `409 profile_already_exists`，不会覆盖。创建前还会再次确认默认分支 head 与检查时的基线 SHA 一致；如果期间仓库发生变化，返回 `409 repository_changed`，不会基于旧 head 静默创建。预览时 `.config` 会发送到用户自己的 Control Plane 做服务端校验，但不会写入 GitHub。

### 11. V2.0E：Config Studio / Web Menuconfig

0.19.2 修复跨仓运行时漂移：当 Config Studio 或 Builder 在非主仓（例如 `Actions-OpenWrt-NG-Test`）运行时，Workflow 在 Runner 中先从 `wekingchen/Actions-OpenWrt-NG@main` 同步最新 `scripts/` 与 `adapters/`，再解析 Profile/feeds/Kconfig。这样主仓的 feeds 去重、Config Studio 解析器等修复无需逐个复制到测试仓脚本目录；目标仓本身不会被这个同步步骤改写。移动端同时在顶栏显示 Control Plane 版本徽标，避免桌面侧栏 footer 在手机布局中被隐藏后无法确认部署版本。

0.19.1 增加 feed name 级自动去重。Config Studio 与正式 Builder 在 `feeds update -a` 前统一通过 `scripts/apply-extra-feeds.sh` + `scripts/merge-feeds.py` 生成唯一 feed 名列表：额外/常用源优先于源码默认源；额外源内部或源码默认源内部重名时保留第一条。这样源码自带 `helloworld`、用户又加入同名 `helloworld` 时，不再触发 `Duplicate feed name`。Control Plane/Wizard 生成 Profile 时也会先按名称去重，常用源按钮不会重复加入已存在的同名 feed。这里的“feed 名称去重”与后续“不同 feed 的同名 source package 按版本择优”是两层独立机制。

0.19.0 增加 menuconfig 式依赖联动预览。catalog 从 OpenWrt `.packageinfo` 的 `Depends:` 提取 `+` 包依赖与常见条件依赖，浏览器根据当前手动选择递归计算依赖闭包：被必需依赖的可见软件包会自动显示为已选并标记“依赖锁定”，下拉框不可取消，同时展示“由谁依赖”。条件依赖支持常见的 `!`、`&&`、`||` 与括号，并兼容 OpenWrt 包符号中的连字符。自动联动值只用于界面预览，不会作为用户手工修改提交；“检查依赖”仍由真实 OpenWrt `make defconfig` 给出最终结果。界面增加联动数量摘要和“查看联动项 / 返回分类浏览”快捷入口，手机端自动改为纵向布局。

0.18.0 将 Config Studio 的大列表改为更接近传统 menuconfig 的分层浏览：软件包按 OpenWrt `Category → Submenu` 两级筛选，编译特性按真实 Kconfig `menuPath` 的一级/二级菜单筛选。默认不再一次性铺开全部选项；没有搜索词时先进入一级分类，再按二级菜单缩小范围。搜索框仍可跨全部分类直接检索；勾选“只看 LuCI App”时会优先进入 LuCI 分类。

0.17.0 补齐软件包自己的 Kconfig 子配置：OpenWrt 的 `Package/<name>/config` 会以 `configOptions` 附着到对应软件包，不再把所有 `CONFIG_PACKAGE_*` 一律误判为独立包状态。前端在主软件包下提供可展开“子选项”，并识别 Kconfig `choice` 为单选组；例如 `luci-app-ssr-plus` 的透明代理后端、Shadowsocks 客户端/服务端、Xray/Mihomo/ChinaDNS-NG 等选项会跟传统 menuconfig 一样出现在该 App 下。对本次刚启用、原始 catalog 中因父包未选而不可见的子项，页面允许先做选择，最终仍由下一步真实 `make defconfig` 校验依赖与架构可用性。

0.16.1 修复 Config Studio 进度条 DOM 契约：补齐 `config-studio-progress-track` 节点 ID，并在回归测试中校验 `app.js` 的所有 `$(&quot;id&quot;)` 引用都必须能在 `index.html` 找到对应元素，避免再次出现 `null is not an object` 类前端运行时错误。

V2.0E 解决“创建 `.config` 仍必须在本地搭建编译环境并执行 `make menuconfig`”的问题。0.16.0 在统一 Actions 实时进度的基础上补齐 Profile PR 生命周期：保存后自动 squash 合并、清理临时分支，并在新保存成功后清理同一 Profile 已被取代的旧 Control Plane PR；自动合并受阻时保留 PR 供人工处理。0.15.0 把真实 GitHub Actions step 进度提升为整个 Control Plane 的统一等待模型：Config Studio 与 Builder 均显示真实 Action 阶段；feed 优先级/同名包覆盖语义保持不变。额外 feeds 保存为 `profiles/<id>/feeds.conf`，Config Studio 与正式 Builder 都在 `feeds update -a` 前应用它；带 `--force` 的 feed 由 OpenWrt 在 `feeds install` 阶段覆盖 core/default 同名包。

用户仍然亲自决定：

- Target System / Subtarget / Target Profile（设备）。
- 软件包与 LuCI App，保留 `n / y / m` 三态语义。
- 当前目标下可见的 Kconfig 编译特性，例如开发、镜像、网络、内核和调试相关选项。

常用源当前包括 Passwall、`fw876/helloworld` 和 `sbwml/openwrt_helloworld`。所有常用源预设都会写成 `src-git --force ...`，统一优先于 OpenWrt core/default 同名 source package。后台在 `feeds update` 后先由 `scripts/resolve-feed-priority.py` 比较所有优先第三方 feed 的真实 `Version:` metadata；同名 source package 只保留版本最高候选，版本相同才按 feed 顺序稳定择一。随后 `scripts/install-feeds.sh` 调用 OpenWrt 原生 feeds 安装器完成 core override，并汇总 `Overriding core package` / `Not overriding core package` 日志。

Control Plane 不自己计算依赖。用户提交选择后，Action 实际运行 `make defconfig`，再把结果返回前端，标记：

- 用户请求被原样接受的选项。
- 因依赖条件被 Kconfig 调整或取消的选项。
- Kconfig 自动加入 / 移除的软件包。

Config Studio Workflow 已拆成可观察阶段：读取请求、安装解析工具、加载 Profile、准备 OpenWrt 源码、应用额外 Feeds、更新 Feeds、安装 Feeds、运行 Kconfig、生成菜单、上传结果。Session API 会读取当前 run 的 jobs/steps，前端每轮轮询同步“已完成 X/Y 步”、当前步骤和已用时。Feeds update/install 阶段会明确提示通常耗时较长；不提供虚假的剩余分钟数。

统一 progress API 使用同一结构：`completed / total / percent / current / currentDetail / failed / steps[]`。以后任何新的前端 workflow_dispatch 等待流程都应复用该模型，而不是新增独立 spinner 状态机。

每次 resolve 后会重新生成菜单目录，因此切换 Target 或设备后点击“返回修改”，看到的是新目标上下文下的真实菜单。关闭 Config Studio、按 Esc 或点击遮罩默认只暂存 session；同一源码、feeds 与基础配置再次打开时直接恢复，不再重复触发 catalog Action。只有“放弃本次配置”会删除 session branch。

安全模型：

```text
Control Plane 创建临时 session branch
  仅保存 request.json
        ↓
Config Studio Action · contents:read
  clone 外部源码 / feeds
  make defconfig
  生成 catalog / result
        ↓
1 天短期 Actions Artifact
        ↓
Control Plane 会话鉴权读取并解压
        ↓
用户确认
  ├─ 已有 Profile → 只替换 .config → 新分支 + PR → 自动合并
  └─ 新 Profile   → 带回 V2.0D 创建表单 → 标准 7 文件 PR → 自动合并
        ↓
清理 Profile 临时分支与 session branch；合并受阻时仅保留需要人工处理的 PR
```

执行第三方 OpenWrt 源码和 feeds 的 Workflow 全程不拥有仓库写权限；大型 catalog / result 不再写入 GitHub 分支，避免尺寸限制和第三方代码与写权限共存。原 `.config` 上传 / 文本编辑仍然保留为高级兼容入口。SSH / tmate 不作为正式 Config Studio 主流程。

### 12. 在自己的模板实例中启用 GitHub Pages V2 入口

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
