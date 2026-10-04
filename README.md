# Actions-OpenWrt-NG

一个面向 GitHub Actions 的通用 OpenWrt 在线编译模板。

项目理念参考 [P3TERX/Actions-OpenWrt](https://github.com/P3TERX/Actions-OpenWrt)：尽量把日常使用保持为“准备一个 `.config`，运行一次 Workflow”。在此基础上，提供更完整的缓存、构建诊断、配置留档、上游追溯、最小权限 Release 和失败恢复能力。

> 当前稳定基础为 **V1.3**；**V2.0A / V2.0B / V2.0C / V2.0D Control Plane 的核心链路均已完成真实端到端验证**。V2.0D 已验证“在 Control Plane 直接新建标准 Profile → 服务端预览 → 新分支 → Pull Request”，且默认分支未被直接修改。

## V1 验证状态

V1 已使用默认通用 Profile 完成真实端到端验证：

```text
OpenWrt NG Update Checker
        ↓
repository_dispatch
        ↓
OpenWrt NG Builder
        ↓
Preflight
        ↓
direct-openwrt Adapter
        ↓
Feeds / Config / Cache
        ↓
Compile
        ↓
Manifest Validation
        ↓
Config Record
        ↓
Release
        ↓
Cleanup
```

以上链路全部通过后才标记为 V1。后续新能力继续遵循“特殊环境在分支验证，只把通用能力收敛到 main”的原则。

## 适用范围

适用于常见 OpenWrt / Lean / ImmortalWrt 类源码树，也允许通过 Adapter 和 Profile Hook 适配非标准源码准备流程。

核心原则：

- Workflow 不硬编码具体路由器、厂商或插件。
- 普通源码优先做到只替换 `.config` 即可使用。
- 特殊源码准备逻辑放在 Adapter。
- 设备或业务定制逻辑放在 Profile / DIY Hook。
- Profile 如需覆盖 rootfs `files/`，Core 内部统一使用 `PROFILE_FILES_DIR`；旧 Profile 的 `FILES_DIR` 仍会兼容读取，但不会再导出到 OpenWrt `make` 环境，避免与 OpenWrt 内核构建同名变量冲突。
- 通用 Core 只负责构建编排、缓存、诊断、验收、留档和发布。
- 模板仓构建时只执行自身仓库中已检出的 Workflow、`scripts/` 与 `adapters/`，不会在运行时从本维护仓拉取并覆盖代码；自定义 Adapter 与本地脚本修改因此保持有效。模板升级应通过可审阅的代码同步/PR 完成，而不是构建时热替换。

## 快速开始

初始基准 Profile：

```text
profiles/
├── .baseline          # 内容为当前基准 Profile ID，初始为 default
└── default/
    ├── profile.env
    ├── .config
    ├── diy-part1.sh
    ├── diy-part2.sh
    ├── required-packages.txt
    ├── watch-sources.txt
    └── feeds.conf
```

默认示例使用 Lean `master` + x86_64 generic。**基准身份不绑定 `default` 目录名**：在 Control Plane 中可以把任意现有 Profile 设为基准；当前基准不可删除，切换后原基准即可按普通 Profile 删除。手动 Builder 的 Profile 留空、或直接运行 `scripts/profile.sh` 未指定 Profile 时，都会使用当前基准。

最简单的使用方式：

1. 使用本仓库作为模板创建自己的仓库。
2. 推荐在 V2 Control Plane 使用 **Config Studio / Web Menuconfig**，从真实源码与 feeds 中图形选择 Target、设备、App 与构建特性；也可以沿用原生 `make menuconfig` 生成 `.config`。
3. Config Studio 会让 OpenWrt 自己执行 `make defconfig` 解析依赖，并通过 Pull Request 写入 Profile；手工方式则用生成结果替换 `profiles/default/.config`。
4. 如果源码仓库或分支不同，修改 `profiles/default/profile.env`。
5. 第一次先保持 `AUTO_UPDATE=false`，手动验证配置能够成功构建。
6. Actions → **OpenWrt NG Builder** → **Run workflow**；Profile 留空会自动使用当前基准。
7. 构建成功后从 Artifact 或 Release 下载固件。
8. 确认稳定后，如果希望自动追新，再把 `AUTO_UPDATE` 改成 `true`。

典型 `profile.env`：

```bash
PROFILE_NAME="My OpenWrt"
SOURCE_REPO="https://github.com/coolsnowwolf/lede"
SOURCE_BRANCH="master"
ADAPTER="direct-openwrt"

CONFIG_FILE="profiles/default/.config"
DIY_PART1="profiles/default/diy-part1.sh"
DIY_PART2="profiles/default/diy-part2.sh"
REQUIRED_PACKAGES_FILE="profiles/default/required-packages.txt"
WATCH_SOURCES_FILE="profiles/default/watch-sources.txt"
EXTRA_FEEDS_FILE="profiles/default/feeds.conf"

AUTO_UPDATE="false"
MAXIMIZE_BUILD_SPACE="false"
STREAM_BUILD_LOG="false"
UPLOAD_BIN_DIR="false"
UPLOAD_FIRMWARE="true"
UPLOAD_RELEASE="true"
```

## 开发与验证原则

本仓库的 `main` 只保留第三方可复用能力。

测试仓若需要强制验证共享代码与上游一致，可设置仓库变量 `OPENWRT_NG_SYNC_GATE_UPSTREAM=<owner/repo>`（可选 `OPENWRT_NG_SYNC_GATE_REF=<branch-or-sha>`），也可以在测试仓专属的 `.openwrt-ng/sync-gate.json` 中写入 `upstream_repository` / `upstream_ref`。环境变量优先于 marker；两者都未配置时普通模板仓门禁立即跳过，不发生网络访问。门禁只做一致性校验，不覆盖本地代码。

特殊设备、特殊 SDK 或厂商源码的兼容验证，应在独立分支进行，例如：

```text
test/<device-or-sdk>
experiment/<feature>
adapter/<source-family>
```

验证分支可以临时包含具体设备 Profile、专用补丁、测试资产和兼容脚本，但这些内容**不直接合并到 `main`**。

验证完成后，只提炼并回合能够被其他设备复用的能力，例如：

- 新的 Adapter 契约或通用 Adapter 行为。
- 通用 Preflight / post-feeds Hook。
- 源码或 feed 快照固定机制。
- 通用缓存、空间管理、日志心跳和失败诊断。
- 通用 Manifest 验收、配置留档和上游追溯。
- 不绑定具体设备的 Release / Artifact 恢复能力。

主干验收标准：

1. 不出现具体路由器、厂商或个人环境名称。
2. 不包含某一设备独占的二进制资产、配置或补丁。
3. 新能力至少能用通用 Profile/Adapter 接口解释，而不是依赖 Workflow 中的设备判断。
4. 特殊设备验证分支完成后可以删除，不影响 `main` 的可用性。

换句话说：

```text
特殊设备 = 测试用例
main      = 从测试中提炼出的通用框架
```

## Adapter

Adapter 负责把源码准备成可编译的 OpenWrt build root。

内置：

- `direct-openwrt`：直接 clone `SOURCE_REPO/SOURCE_BRANCH` 到 `openwrt/`。

如果源码需要额外生成、转换或定位真实 build root，可以新增 Adapter，但不应修改通用 Workflow。

Adapter 契约见 `adapters/README.md`。

## Profile Hook

Profile 可以声明以下可选 Hook：

- `PREFLIGHT_SCRIPT`：只读预检阶段运行，可解析外部元数据。
- `DIY_PART1`：在 `feeds update -a` 前执行。
- `POST_FEEDS_SCRIPT`：在 feeds 更新后、安装前执行。
- `DIY_PART2`：feeds 安装后、最终 `make defconfig` 前执行。

动态上游可以使用通用追溯接口：

```bash
source "$GITHUB_WORKSPACE/scripts/lib/trace.sh"

trace_git upstream_example_commit /path/to/repo
trace_file upstream_example_sha256 /path/to/file
```

这些记录会进入 `build-info.txt`。

## Workflow Summary 可视化

V1.1 开始把 GitHub Actions 的 **Summary** 作为主要状态入口之一。

不需要翻完整日志，就可以直接看到：

- **构建预检**：Profile、源码、Adapter、触发方式、自动追新、空间扩展和 Release 开关。
- **构建结果**：源码 commit、dl / 编译缓存命中、ccache 本轮 Hits / Misses / 大小、编译耗时、固件候选数量、配置变化，以及 Compile / Manifest / Config Record / Release Bundle 各阶段状态。
- **Update Checker**：本轮检查哪些 Profile、上游状态指纹、是否命中历史状态、本轮是否触发构建。
- **Release**：发布状态、Release Tag、附件数量和直接入口。
- **Release Existing Build**：原 Build Run、原 commit、恢复发布状态和新 Release 入口。

Summary 只是展示层：

- 不参与编译结果判断。
- 不改变 Core、Profile 或 Adapter 契约。
- Summary 生成异常不会把原本成功的构建改成失败。
- 完整日志、Artifact 和配置留档仍然保留，便于深度排障。

## GitHub Pages Dashboard

正式 Dashboard：<https://wekingchen.github.io/Actions-OpenWrt-NG/>

V1.2 提供只读的 **OpenWrt NG Dashboard**，把分散在 Actions、Profiles 和 Releases 中的信息集中到一个静态页面。

Dashboard 展示：

- Profile、源码、分支、Adapter 与自动追新状态。
- 最近 Builder Runs、触发方式、真实上游源码 commit 与构建耗时。
- 当前上游源码是否已经由最近成功构建覆盖。
- 最近 Releases、固件附件以及直接下载入口。

安全边界：

- 浏览器只读取 CI 生成的静态 `status.json`。
- 浏览器不调用 GitHub API，也不持有 GitHub Token。
- 数据生成 job 只有 `contents: read` 与 `actions: read`。
- 只有独立 Pages deploy job 拥有 `pages: write` 与 `id-token: write`。
- Dashboard 删除或故障不会影响 Builder、Update Checker 或 Release。

首次启用时，在仓库：

**Settings → Pages → Build and deployment → Source → GitHub Actions**

选择一次即可。未启用时 Dashboard workflow 会正常生成 Pages Artifact，但跳过公开部署并在 Summary 给出提示。

## Profile Wizard

V1.3 提供浏览器本地运行的 **Profile Wizard**：

<https://wekingchen.github.io/Actions-OpenWrt-NG/wizard.html>

向导可以：

- 选择常用源码预设，或填写自定义 Git 仓库与分支 / Tag。
- 上传或粘贴 OpenWrt `.config`。
- 配置自动追新、Release、固件 Artifact 与构建空间。编译日志由 Core 统一使用静默 + 心跳 + 失败上下文策略。
- 配置 Manifest 必选包与额外 Git 上游。
- 预览最终 `profile.env` 等文件。
- 下载标准 `profiles/<id>/` ZIP。

Profile ID 必须以字母或数字开头，只允许字母、数字、点、下划线和短横线，最大 64 个字符；向导与 Core 使用同一套校验规则。

安全边界：

- `.config` 与表单内容只在浏览器本地处理。
- Wizard 不调用 GitHub API，不持有 Token，也不拥有仓库写权限。
- 生成 ZIP 已通过真实 `profile.sh validate/export`、Update Checker 和 Manifest 验收器兼容测试。
- V1.3 Wizard 本身仍只负责本地生成 Profile；如果已部署 V2 Control Plane，也可以在控制面中直接新建标准 Profile，并通过独立分支 + Pull Request 安全写入仓库。

## Config Studio / Web Menuconfig

Control Plane 0.15.0 将“等待后端 Action”统一为真实步骤进度：Config Studio 和 Builder 都直接读取 GitHub Actions jobs/steps，显示当前阶段、已完成步骤数、进度条、已用时与失败步骤；第三方源优先级/同名包覆盖规则保持不变。新 Profile 仍按和手工 OpenWrt 配置一致的顺序：

1. 选择 OpenWrt / LEDE 源码与分支。
2. **先配置额外 feeds / 软件源。**
3. 点击“生成配置菜单”；后台只在这一阶段建立真实源码 + feeds 环境。
4. 在图形 Menuconfig 中选择 Target、设备、LuCI App、软件包与编译特性。
5. 点击“下一步：检查依赖”，由 OpenWrt 自己执行 `make defconfig`。
6. 检查自动加入 / 移除的依赖后确认，把最终 `.config` 带回 Profile 并创建 PR。

Config Studio 在“生成配置菜单”和“检查依赖”两个等待阶段会直接读取当前 GitHub Actions 的真实 job steps，展示当前阶段、已完成步骤数、进度条与已用时。源码准备、Feeds 更新/安装、Kconfig、菜单导出和 Artifact 上传都会分别显示；这里的进度是实际步骤进度，不伪造预计剩余分钟数。

同一规则也应用于 Builder。用户点击“开始构建”后，工作区“最近构建”会立即显示等待/运行进度；GitHub 建立 run 后自动切换为真实阶段：Profile 预检、OpenWrt 源码、Feeds、编译缓存、源码下载、固件编译、Manifest/产物、Release 与清理。进入构建详情后继续显示同一份进度。Control Plane 不用虚假的固定 spinner 代替可读取的 Action 状态。

关闭 Config Studio 窗口、按 Esc 或点遮罩只会**暂存当前会话**。只要源码、feeds 和基础 `.config` 没有变化，再次点击“继续图形配置”会恢复同一 session，不会重复启动 catalog Action；只有点击“放弃本次配置”才删除会话。

额外 feeds 会保存到 `profiles/<id>/feeds.conf`，并在正式 Builder 和 Config Studio 中统一于 `./scripts/feeds update -a` **之前**插入。例如 Passwall 当前官方 feed 方式：

```text
src-git passwall_packages https://github.com/Openwrt-Passwall/openwrt-passwall-packages.git;main
src-git passwall_luci https://github.com/Openwrt-Passwall/openwrt-passwall.git;main
```

因此正确顺序是“先加 Passwall 源，再生成 Menuconfig，再搜索并选择 Passwall App”，而不是在 Menuconfig 之后补源。

0.13.0 还支持把“这个第三方源是否要替代默认同名包”直接写进 `feeds.conf`。OpenWrt 自己支持在 feed 行声明 `--force`；项目会在 `feeds install` 阶段由 OpenWrt 完成 override，并汇总“已覆盖 / 未覆盖”的同名包日志。常用源预设：

```text
# 所有“常用源”都统一第三方优先
src-git --force passwall_packages https://github.com/Openwrt-Passwall/openwrt-passwall-packages.git;main
src-git --force passwall_luci https://github.com/Openwrt-Passwall/openwrt-passwall.git;main
src-git --force helloworld https://github.com/fw876/helloworld.git
src-git --force sbwml_helloworld https://github.com/sbwml/openwrt_helloworld.git;v5
```

所有通过“常用源”按钮加入的 feed 都会自动写成 `--force`，因此统一优先于 OpenWrt 默认/core 同名 source package。在 `feeds update -a` 之前，项目先按 **feed name** 自动去重：额外/常用源与源码默认源同名时保留额外源，额外源内部或源码默认源内部重名时保留第一条，因此不会再因 `Duplicate feed name` 中断。随后，如果**不同 feed 名称**仍提供同名 source package，项目会读取各 feed 的真实 `Version:` metadata，逐包保留版本最高者；只有版本完全相同才按 `feeds.conf` 顺序稳定择一。对于自定义 feed，只有明确写 `--force` 才加入“第三方优先 + 版本择优”规则；未写时保持 OpenWrt 默认的保守行为。sbwml 上游还给出了替换 Golang 的做法，但本项目不随源预设自动更换工具链，避免对不同 OpenWrt 分支造成额外影响。


工作方式：

```text
选择源码 / 已有 Profile
        ↓
Config Studio Action（真实源码 + feeds）
        ↓
Target / Subtarget / Device 元数据
软件包 / LuCI App / 可见 Kconfig 特性
        ↓
浏览器由用户手动选择 n / y / m
        ↓
make defconfig
        ↓
展示：原样接受 / 依赖调整 / 自动加入软件包
        ↓
现有 Profile → 独立分支 + PR 更新 .config
新 Profile   → 带回创建向导 → 标准 Profile PR
```

这里的“图形配置”不是由 Control Plane 猜依赖，也不会用静态设备数据库替代 OpenWrt。浏览器只记录用户明确的选择；最终配置始终由目标源码当前版本的 Kconfig 和 feeds 解析。

安全边界：

- 每次配置使用 `openwrt-ng/config-session-<id>` 临时分支只保存请求状态，默认分支不被直接修改。
- 真正执行外部 OpenWrt 源码 / feeds 的 Config Studio Workflow 全程只有 `contents: read`，不拥有仓库写权限。
- catalog / result 只作为 1 天短期 Actions Artifact 返回；Control Plane 使用当前登录用户的受控会话读取并解压，不再由 Action 写回仓库。
- 完成或取消配置后清理临时会话分支。
- 原 `.config` 上传 / 文本编辑继续保留，作为高级兼容方式。
- SSH / tmate 不作为正式配置入口；未来若增加，只作为高级排障模式。

## V2 Control Plane

V2 不把 GitHub 登录和写权限直接加入公开 GitHub Pages。默认运行方式已经改为**无服务器架构**：

```text
Public GitHub Pages（只读）
        ↓ 打开
Cloudflare Workers（UI + Auth Broker + API）
        ↓
D1 + Worker Secrets
        ↓
GitHub App
```

因此使用 V2 **不需要自备 VPS、Docker 或 Caddy**。V2.0A 已实现并完成真实验证：GitHub App 登录、安装仓库选择、仓库枚举和只读 Profile 访问；GitHub user access token / refresh token 只在 Worker 侧加密存入 D1，公开 Pages 与浏览器脚本都不保存 GitHub Token。

V2.0B 在此基础上增加在线 Profile 编辑，保存固定走“预览 → 基线 SHA 冲突检查 → 原子 commit → 新分支 → Pull Request”，不直接写 `main`。写入范围只允许标准 `profiles/<id>/` 文件，并为状态变更请求增加同源 Origin + CSRF 请求头校验。该链路已在独立测试仓库完成真实写入验证，确认默认分支在创建 PR 前后保持不变。

V2.0C 继续增加 Builder 控制能力：浏览器只能请求固定的 OpenWrt NG Builder，服务端固定使用仓库默认分支并生成请求标识；页面展示 queued / running / completed、Jobs、Artifacts、Release 与 Actions Summary 入口。该链路已在独立 Test 仓完成真实 Actions 调度验证：Run 与 request ID 精确对应，成功完成编译、Manifest 校验、配置留档、固件 Artifact 上传与 Summary 生成；测试时关闭了 Release，因此没有留下测试发布物。

V2 Control Plane 0.21.3 进一步补齐 Profile 生命周期：仓库用 `profiles/.baseline` 保存唯一逻辑基准，页面可安全切换基准；创建、编辑、基准切换和删除都沿用独立分支 + Pull Request + 自动合并的审计路径。删除保护跟随当前基准而不是固定 `default`。

V2.0D 补齐新建 Profile：用户只提交结构化参数，服务端按与 Profile Wizard 一致的规则生成固定 7 个标准文件。预览不会写 GitHub；确认后仍走原子 commit → 独立分支 → Pull Request。浏览器不能指定任意仓库路径，已有同名 Profile 会被拒绝覆盖。该链路已在独立 Test 仓真实验证：PR 恰好包含 7 个标准文件、只有 1 个 commit，head commit 的唯一父提交为测试前 main；DIY 脚本保持 100755，其余文件保持 100644，创建 PR 前后默认分支 SHA 不变。

Control Plane 0.21.4 继续补齐操作闭环：Profile 支持安全复制和原子重命名；重命名基准 Profile 时 `.baseline` 同步迁移。Profile 删除/重命名完成后会自动清理关联 Config Studio 会话与活动 Action。Builder 历史支持直接取消运行中构建，以及对已结束构建执行完整重跑；所有操作均校验目标 workflow 身份并保留 GitHub Actions 审计记录。

Control Plane 0.21.5 补齐剩余恢复与运维入口：已结束的 Builder 只要“编译 OpenWrt 固件”job 成功、仍保留未过期的 `OpenWrt_NG_release_bundle_<run_id>` 且尚无 Release，就能从构建详情直接执行 **Release Existing Build**，全程不重新编译并显示真实 Actions 步骤；Profile 列表可手动触发 **Update Checker**，既支持全部 `AUTO_UPDATE=true` Profile，也支持指定单个 Profile 与 `force`；通过 Control Plane 删除且当前仍不存在的 Profile 会出现在“最近删除”，可从删除 commit 的父提交恢复完整 7 个标准文件，恢复仍走独立分支 → Pull Request → 自动合并，而不是 reset/revert。

项目提供 **Deploy V2 Control Plane** 手动 Workflow：第一次可以无 GitHub App Secret bootstrap 部署，拿到 workers.dev URL 后再创建 GitHub App 并同步 Secret。当前完整 V2 推荐 GitHub App 一次配置 Metadata read、Contents write、Pull requests write、Actions write；不需要 Administration / Workflows。Node.js + SQLite + Docker 仅保留为可选自托管方式。

作为公共模板，`dashboard/data/control-plane.json` 在本仓库 `main` 中**刻意保持 `enabled=false` 且不绑定维护者个人 Worker / GitHub App**。使用者从模板创建自己的仓库后，完成自己的 Control Plane 部署与真实验证，再在自己的仓库中启用入口。Pages 的 Control Plane 页面会明确显示“模板默认关闭”，并提供当前完整能力、最终权限与启用顺序。详细步骤见 `control-plane/README.md`。

## 构建与诊断

Core 提供：

- 180 分钟构建超时。
- 可选构建空间扩展。
- `dl` 下载缓存。
- ccache / Go build cache；Lean/OpenWrt 的 `CONFIG_CCACHE=y` 需要同时启用 `CONFIG_DEVEL=y`，默认缓存目录为源码树内的 `openwrt/.ccache`。Core 会直接持久化这一实际目录，并在 `make defconfig` 后校验 ccache 没有被 Kconfig 静默裁掉；即使本轮编译失败，也会先记录 ccache Hits / Misses / 大小并保存可复用的部分编译缓存，避免后续修复后完全冷启动。 Ubuntu 24.04 构建缓存使用独立 `build-v3-ubuntu24` 命名空间，不恢复 Ubuntu 22.04 生成的 host/ccache 数据；`dl/` 源码下载缓存继续跨 Runner 版本复用。
- 默认静默编译并保留长编译心跳；只有 Core 调试变量 `OPENWRT_NG_DEBUG_STREAM_LOG=true` 才临时恢复全量流式输出。
- 默认静默编译：完整 `make -jN` 输出仅保存在 Runner 临时文件，不持续写入 GitHub step；成功时只显示心跳、耗时和 ccache 统计。失败时才自动识别失败目标并从并行日志/单目标诊断日志中提取有限上下文，生成 `build-error-context.log`。失败 Artifact 不再上传整份 `build.log`，避免超长日志触发 GitHub `This step has been truncated...`。
- Builder 固定运行在 Ubuntu 24.04，避免持续追新的 host 工具（例如 helloworld/gn）在 Ubuntu 22.04 的 Clang 14 / libstdc++ 12 上触发 C++23 ranges 兼容失败。
- 并行编译失败后的目标识别；`ERROR: ... [host] failed to build` 会直接映射到对应 `/host/compile`。
- 有限时单目标 / 单线程诊断，避免 host 包失败后误跑整轮全量单线程诊断。
- 失败日志 Artifact。

## Manifest 验收

`required-packages.txt` 可以声明必须出现在最终 image manifest 中的软件包。

默认 Profile 不强制额外包。

适合第三方 Profile 在不修改 Core 的情况下定义自己的功能验收标准。

## 配置与上游留档

成功构建会生成 `config-record`：

- `repository.config`：仓库提供的基准配置。
- `final.config`：实际参与编译的最终配置。
- `diffconfig.txt`：OpenWrt `scripts/diffconfig.sh` 输出。
- `config-changes.diff`：基准配置与最终配置的语义差异。
- `config-stats.env`：新增 / 删除 / 改变数量。
- `build-info.txt`：源码、Profile、Adapter、缓存指纹、配置 SHA256 和动态上游记录。
- `feed-commits.txt`：真实 Git feed 的实际 commit。
- `manifest-files.txt`：参与验收的 image manifest。

## CI 权限模型

```text
preflight
  contents: read
      │
      ▼
build
  actions: read
  contents: read
      │ Artifact
      ▼
release
  actions: read
  contents: write
      │
      ▼
cleanup
  actions: write
  contents: read
```

设计原则：

- checkout 不持久化仓库凭据。
- build 不拥有仓库写权限。
- Release 使用独立 job。
- 正常情况下 Release tag 精确指向本次构建 commit；如果 GitHub 因历史 commit 与当前默认分支存在 workflow 差异而返回 `403 Resource not accessible by integration`，才自动降级为当前默认分支 tag，并在 Release 说明中保留真实 Build Run / commit。
- 没有成功构建和验收，不创建 Release。
- 旧 Release 只在新 Release 成功后清理。
- Workflow 历史由独立最小权限 job 清理：现存 Workflow 每个至少保留最近 10 条，超过 30 天的额外记录才删除；如果临时 Workflow 的 `.yml/.yaml` 已从默认分支删除，其已完成 runs 会在后续 Builder cleanup 中自动清理，运行中的记录会跳过。

## 自动检查上游更新

项目提供 **OpenWrt NG Update Checker**。

默认每 12 小时运行一次，但只有 Profile 显式开启：

```bash
AUTO_UPDATE="true"
```

才会自动触发构建，因此使用模板后不会默认消耗大量 Actions 时长。

每个启用的 Profile 会自动监控：

```text
SOURCE_REPO + SOURCE_BRANCH
```

如果还需要监控额外 Git 上游，在 Profile 中声明：

```bash
WATCH_SOURCES_FILE="profiles/default/watch-sources.txt"
```

文件格式：

```text
label|git_url|branch_or_tag
```

例如：

```text
packages|https://github.com/openwrt/packages|master
luci|https://github.com/openwrt/luci|master
```

工作机制：

1. 解析主源码和额外 Git 上游的实际 commit。
2. 计算当前 Profile 的上游状态指纹。
3. 使用 Actions cache 判断这个状态是否已经处理。
4. 只有状态变化时才发送 `repository_dispatch`。
5. **OpenWrt NG Builder** 根据 `client_payload.profile` 构建对应 Profile。
6. 首次启用 `AUTO_UPDATE=true` 时，因为还没有已记录状态，会触发一次基线构建。
7. 如果下游构建失败，同一个上游状态不会自动无限重试；可以手动运行 Builder，或在 Update Checker 中勾选 `force` 再触发一次。

手动运行 Update Checker 时，可以直接从 Control Plane 顶部点击“检查更新”，或从某个 Profile 行点击更新图标：

- 顶部入口默认检查全部 `AUTO_UPDATE=true` Profile。
- 指定某个 Profile 时，即使它的 `AUTO_UPDATE=false` 也可以检查。
- 勾选 `force`，忽略已记录状态并强制触发一次构建。
- Control Plane 会持续显示 Update Checker 的真实 Actions 步骤，不需要另开日志页面猜进度。

## Release 失败恢复

如果 Build 已经成功，但 Release 因 GitHub 上传接口或临时故障失败，不需要重新编译。

可以直接在 Control Plane 的成功构建详情中点击 **发布现有构建**；只有来源 Build 成功、尚无 Release、并且对应 Release bundle 仍存在且未过期时才显示入口。也仍可使用 **Actions → Release Existing Build**，输入原构建的 workflow `run_id`。

恢复工作流会：

1. 确认来源 Run 确实属于 `build-openwrt.yml` 且已经结束，并确认“编译 OpenWrt 固件”job 为 success；允许后续 Release job 失败，因为这正是恢复发布的主要场景。
2. 下载来源 Run 的 `OpenWrt_NG_release_bundle_<run_id>`。
3. 校验 Release 附件。
4. 对“配置完全无变化”导致的空差异文件进行受控修复。
5. 在 Release notes 中记录原 Run、原构建 commit 和恢复 Run，保持可追溯性。
6. 重新发布已有构建产物。

## 目录结构

```text
.github/workflows/
├── build-openwrt.yml     主构建 / Release / cleanup
├── update-checker.yml    通用 Git 上游更新检查
├── release-existing.yml      Build 成功后的 Release 恢复
├── pages-dashboard.yml       Dashboard 数据生成与 Pages 部署
├── control-plane-ci.yml      V2 Workers / D1 / 自托管兼容测试
└── deploy-control-plane.yml  V2 Cloudflare Worker 手动部署
dashboard/                Dashboard + Profile Wizard + V2 控制面入口静态前端
control-plane/             V2 Workers + D1 Auth Broker；保留可选自托管实现
adapters/                 源码准备适配层
profiles/
└── default/
    ├── profile.env
    ├── .config
    ├── diy-part1.sh
    ├── diy-part2.sh
    ├── required-packages.txt
    └── watch-sources.txt
scripts/                  通用构建与追溯工具
scripts/dashboard/        Dashboard 数据导出、校验与 Wizard 回归测试
scripts/lib/              DIY 可复用函数
```

## 创建自己的 Profile

可以使用 **Profile Wizard** 在浏览器本地生成标准 Profile ZIP；如果已经部署 V2 Control Plane，也可以直接在控制面点击“新建 Profile”，服务端校验后通过独立分支 + Pull Request 写入。若希望手工维护，也可以复制 `profiles/default/`：

```text
profiles/my-router/
├── profile.env
├── .config
├── diy-part1.sh
├── diy-part2.sh
├── required-packages.txt
├── watch-sources.txt
└── feeds.conf
```

其中 `.config` 与 `profile.env` 是恢复与构建所需的必需文件；其余 Hook、校验清单与 `feeds.conf` 都是可选文件。Control Plane 新建 Profile 时仍会生成完整标准结构；恢复历史 Profile 时会按删除前实际存在的可选文件原样恢复。

然后在 **Run workflow** 时把 `profile` 填成：

```text
my-router
```

只要源码结构可以由现有 Adapter 处理，就不需要修改 Workflow。

## Credits

- [P3TERX/Actions-OpenWrt](https://github.com/P3TERX/Actions-OpenWrt)
- [OpenWrt](https://github.com/openwrt/openwrt)
- [Lean's LEDE](https://github.com/coolsnowwolf/lede)
- [easimon/maximize-build-space](https://github.com/easimon/maximize-build-space)
- GitHub Actions

## License

MIT
