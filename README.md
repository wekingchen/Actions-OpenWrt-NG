# Actions-OpenWrt-NG

一个面向 GitHub Actions 的现代 OpenWrt 通用编译模板。

项目理念继承自 [P3TERX/Actions-OpenWrt](https://github.com/P3TERX/Actions-OpenWrt)：尽量把使用体验保持为“准备一个 `.config`，运行一次 Workflow”。在此基础上，加入从 `Actions-SFT1200` 长期维护中验证过的缓存、失败诊断、配置留档、上游追溯、权限隔离和 Release 安全交接机制。

> 当前状态：**V0.1 架构初稿**。默认提供 Lean x86_64 直编 Profile，用于验证通用主路径。SFT1200 将作为第一个特殊 Adapter 在后续迁入；现有 `Actions-SFT1200` 不受影响。

## 设计目标

- 普通 OpenWrt / Lean / ImmortalWrt 类源码：原则上只需要替换 Profile 的 `.config`。
- 特殊 SDK / 老源码树：通过 Adapter 处理源码准备，不把设备兼容逻辑塞进通用 Workflow。
- Core 不认识具体路由器，不硬编码 SFT1200、Passwall、NaiveProxy 等设备或插件名称。
- build job 只读；Release 与 Workflow 清理分别使用最小写权限。
- 成功构建自动留下可比较的配置与上游追溯记录。

## 快速开始

默认 Profile 位于：

```text
profiles/default/
├── profile.env
├── .config
├── diy-part1.sh
├── diy-part2.sh
└── required-packages.txt
```

默认示例使用 Lean `master` + x86_64 generic，主要用于验证框架本身。

最简单的使用方式：

1. Fork / Use template 创建自己的仓库。
2. 用目标 OpenWrt 源码生成 `.config`。
3. 用它替换 `profiles/default/.config`。
4. 如源码不是默认 Lean，只修改 `profiles/default/profile.env` 的 `SOURCE_REPO` / `SOURCE_BRANCH`。
5. Actions → **OpenWrt NG Builder** → **Run workflow**。
6. 构建成功后从 Artifact 或 Release 下载固件。

## Profile

`profile.env` 定义一次构建需要的最少信息：

```bash
PROFILE_NAME="Lean x86_64"
SOURCE_REPO="https://github.com/coolsnowwolf/lede"
SOURCE_BRANCH="master"
ADAPTER="direct-openwrt"

CONFIG_FILE="profiles/default/.config"
DIY_PART1="profiles/default/diy-part1.sh"
DIY_PART2="profiles/default/diy-part2.sh"
REQUIRED_PACKAGES_FILE="profiles/default/required-packages.txt"

UPLOAD_BIN_DIR="false"
UPLOAD_FIRMWARE="true"
UPLOAD_RELEASE="true"
```

### Adapter

Adapter 负责“如何得到一个可编译的 OpenWrt 根目录”。

V0.1 内置：

- `direct-openwrt`：直接 clone `SOURCE_REPO/SOURCE_BRANCH` 到仓库工作区的 `openwrt/`。

后续 Siflower/SFT1200 会实现独立 Adapter，在 Adapter 内完成 SDK 生成、真实 build root 定位等特殊步骤。通用 Workflow 不需要知道这些细节。

Adapter 合约见 `adapters/README.md`。

## DIY Hook

- `diy-part1.sh`：在 `feeds update -a` **之前**执行。
- `diy-part2.sh`：在 feeds 安装、`.config` 放入源码树之后，`make defconfig` **之前**执行。

默认 Hook 是空实现。

如果 DIY 脚本直接追踪动态上游，可以使用：

```bash
source "$GITHUB_WORKSPACE/scripts/lib/trace.sh"

trace_git upstream_example_commit /path/to/cloned/repo
trace_file upstream_example_sha256 /path/to/downloaded/file
```

这些记录会自动进入构建留档的 `build-info.txt`。

## 构建留档

每次成功构建都会生成 `config-record`：

- `repository.config`：本轮仓库基准配置。
- `final.config`：DIY + `make defconfig` 后真正参与编译的配置。
- `diffconfig.txt`：OpenWrt `scripts/diffconfig.sh` 输出。
- `config-changes.diff`：基准与最终配置的语义差异。
- `config-stats.env`：新增 / 删除 / 改变数量。
- `build-info.txt`：源码、Profile、Adapter、缓存指纹、最终配置 SHA256、动态上游记录。
- `feed-commits.txt`：各真实 feed 的实际 HEAD commit。
- `README.txt`：留档内置说明。

## CI 安全模型

```text
preflight
  contents: read
      │
      ▼
build
  contents: read
  无 GitHub 写 token
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

原则：

- checkout 不持久化 GitHub 凭据。
- build 不直接持有 `contents: write` / `actions: write`。
- Release 由独立 job 下载经过验收的 Artifact 后使用 Runner 自带 `gh` 发布。
- 没有成功固件，不进入 Release。
- 旧 Release 只在新 Release 发布成功后清理。
- Workflow 历史由独立最小权限 cleanup job 处理。

## 目录结构

```text
.github/workflows/       GitHub Actions
adapters/                源码/SDK 适配层
profiles/                设备/源码 Profile
scripts/                 通用构建工具
scripts/lib/             DIY 可复用函数
```

## 与 Actions-SFT1200 的关系

`Actions-SFT1200` 继续作为已验证稳定的 SFT1200 专用实现，不在原仓库上做通用化重构。

本项目会反向提炼其中可复用能力，并通过独立 SFT1200 Profile/Adapter 做等价验证。只有通用框架验证成熟后，才考虑让更多设备迁入。

## Credits

- [P3TERX/Actions-OpenWrt](https://github.com/P3TERX/Actions-OpenWrt)
- [OpenWrt](https://github.com/openwrt/openwrt)
- [Lean's LEDE](https://github.com/coolsnowwolf/lede)
- GitHub Actions

## License

MIT
