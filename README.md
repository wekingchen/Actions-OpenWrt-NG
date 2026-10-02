# Actions-OpenWrt-NG

一个面向 GitHub Actions 的通用 OpenWrt 在线编译模板。

项目理念参考 [P3TERX/Actions-OpenWrt](https://github.com/P3TERX/Actions-OpenWrt)：尽量把日常使用保持为“准备一个 `.config`，运行一次 Workflow”。在此基础上，提供更完整的缓存、构建诊断、配置留档、上游追溯、最小权限 Release 和失败恢复能力。

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
└── required-packages.txt
```

默认示例使用 Lean `master` + x86_64 generic，用于提供一个开箱即用的基准。

最简单的使用方式：

1. 使用本仓库作为模板创建自己的仓库。
2. 用目标 OpenWrt 源码生成 `.config`。
3. 用它替换 `profiles/default/.config`。
4. 如果源码仓库或分支不同，修改 `profiles/default/profile.env`。
5. Actions → **OpenWrt NG Builder** → **Run workflow**。
6. 构建成功后从 Artifact 或 Release 下载固件。

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
.github/workflows/       GitHub Actions
adapters/                源码准备适配层
profiles/                构建 Profile
scripts/                 通用构建工具
scripts/lib/             DIY 可复用函数
```

## 创建自己的 Profile

建议复制 `profiles/default/`：

```text
profiles/my-router/
├── profile.env
├── .config
├── diy-part1.sh
├── diy-part2.sh
└── required-packages.txt
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
