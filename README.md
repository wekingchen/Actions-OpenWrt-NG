# Actions-OpenWrt-NG

一个面向 GitHub Actions 的通用 OpenWrt 在线编译模板。

项目理念参考 [P3TERX/Actions-OpenWrt](https://github.com/P3TERX/Actions-OpenWrt)：尽量把日常使用保持为“准备一个 `.config`，运行一次 Workflow”。在此基础上，提供更完整的缓存、构建诊断、配置留档、上游追溯、最小权限 Release 和失败恢复能力。

> 当前稳定基础为 **V1.3**；**V2.0A Control Plane 已完成真实端到端验证**。V2.0B 正在开发“Profile 在线编辑 → 原子 commit → 新分支 → Pull Request”，不会直接修改默认分支。

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
- 通用 Core 只负责构建编排、缓存、诊断、验收、留档和发布。

## 快速开始

默认 Profile：

```text
profiles/default/
├── profile.env
├── .config
├── diy-part1.sh
├── diy-part2.sh
├── required-packages.txt
└── watch-sources.txt
```

默认示例使用 Lean `master` + x86_64 generic，用于提供一个开箱即用的基准。

最简单的使用方式：

1. 使用本仓库作为模板创建自己的仓库。
2. 用目标 OpenWrt 源码生成 `.config`。
3. 用它替换 `profiles/default/.config`。
4. 如果源码仓库或分支不同，修改 `profiles/default/profile.env`。
5. 第一次先保持 `AUTO_UPDATE=false`，手动验证配置能够成功构建。
6. Actions → **OpenWrt NG Builder** → **Run workflow**。
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

AUTO_UPDATE="false"
MAXIMIZE_BUILD_SPACE="false"
STREAM_BUILD_LOG="true"
UPLOAD_BIN_DIR="false"
UPLOAD_FIRMWARE="true"
UPLOAD_RELEASE="true"
```

## 开发与验证原则

本仓库的 `main` 只保留第三方可复用能力。

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
- **构建结果**：源码 commit、缓存命中、编译耗时、固件候选数量、配置变化，以及 Compile / Manifest / Config Record / Release Bundle 各阶段状态。
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
- 配置自动追新、Release、固件 Artifact、构建空间和日志策略。
- 配置 Manifest 必选包与额外 Git 上游。
- 预览最终 `profile.env` 等文件。
- 下载标准 `profiles/<id>/` ZIP。

Profile ID 必须以字母或数字开头，只允许字母、数字、点、下划线和短横线，最大 64 个字符；向导与 Core 使用同一套校验规则。

安全边界：

- `.config` 与表单内容只在浏览器本地处理。
- Wizard 不调用 GitHub API，不持有 Token，也不拥有仓库写权限。
- 生成 ZIP 已通过真实 `profile.sh validate/export`、Update Checker 和 Manifest 验收器兼容测试。
- V1.3 只负责生成 Profile；网页直接写仓库、登录 GitHub 与触发构建留给后续 V2 控制面。

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

V2.0B 在此基础上增加在线 Profile 编辑，但保存固定走“预览 → 基线 SHA 冲突检查 → 原子 commit → 新分支 → Pull Request”，不直接写 `main`。写入范围只允许标准 `profiles/<id>/` 文件，并为状态变更请求增加同源 Origin + CSRF 请求头校验。

项目提供 **Deploy V2 Control Plane** 手动 Workflow：第一次可以无 GitHub App Secret bootstrap 部署，拿到 workers.dev URL 后再创建 GitHub App并同步 Secret。Node.js + SQLite + Docker 仅保留为可选自托管方式。

作为公共模板，`dashboard/data/control-plane.json` 在本仓库 `main` 中**刻意保持 `enabled=false` 且不绑定维护者个人 Worker / GitHub App**。使用者从模板创建自己的仓库后，完成自己的 Control Plane 部署与真实验证，再在自己的仓库中启用入口。详细步骤见 `control-plane/README.md`。

## 构建与诊断

Core 提供：

- 180 分钟构建超时。
- 可选构建空间扩展。
- `dl` 下载缓存。
- ccache / Go build cache。
- 可选流式或静默编译日志。
- 长编译心跳。
- 并行编译失败后的目标识别。
- 有限时单目标 / 单线程诊断。
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
```

设计原则：

- checkout 不持久化仓库凭据。
- build 不拥有仓库写权限。
- Release 使用独立 job。
- 没有成功构建和验收，不创建 Release。
- 旧 Release 只在新 Release 成功后清理。
- Workflow 历史由独立最小权限 job 清理。

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

手动运行 Update Checker 时，可以：

- 指定某个 Profile，即使它的 `AUTO_UPDATE=false` 也可以检查。
- 勾选 `force`，忽略已记录状态并强制触发一次构建。

## Release 失败恢复

如果 Build 已经成功，但 Release 因 GitHub 上传接口或临时故障失败，不需要重新编译。

使用：

**Actions → Release Existing Build**

输入原构建的 workflow `run_id`。

恢复工作流会：

1. 确认来源 Run 的 build job 为 success。
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

优先使用 **Profile Wizard** 生成标准 Profile；如果希望手工维护，也可以复制 `profiles/default/`：

```text
profiles/my-router/
├── profile.env
├── .config
├── diy-part1.sh
├── diy-part2.sh
├── required-packages.txt
└── watch-sources.txt
```

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
