# Actions-OpenWrt-NG

OpenWrt NG 是一套基于 GitHub Actions 的 OpenWrt 构建与管理框架。目标不是把某一台设备的编译脚本写死在 workflow 里，而是把不同设备、源码、软件源和构建策略拆成独立“配置方案”，再由统一工作流负责构建、更新检查、产物留档和发布。

当前稳定框架版本：**V1.3.0**

当前管理中心版本：**0.21.11**

## 当前状态

目前核心链路已经实际跑通：

- 配置方案新建、编辑、复制、重命名、切换基准、删除和恢复。
- 删除或重命名配置方案时清理关联图形配置会话。
- 图形配置按真实 OpenWrt 源码、feeds 和 Kconfig 生成菜单。
- 构建启动、进度展示、取消和重新构建。
- 手动上游更新检查和强制重新构建。
- 构建产物、配置留档和版本发布。
- 在来源构建仍保留发布包时补发已有构建，不重新编译。
- 主仓与测试仓共享代码同步门禁。

项目日常开发以主仓为准；独立测试仓只用于真实验证，并通过同步门禁保证共享代码与主仓一致。测试仓额外的 smoke / 设备测试配置不应反向混入主仓。

## 适合什么场景

适合：

- 用 GitHub Actions 编译 OpenWrt / LEDE / ImmortalWrt。
- 同一个仓库维护多台设备或多套配置。
- 希望自动检查源码和第三方软件源更新。
- 希望每次构建都能追溯源码、feeds、配置和关键上游版本。
- 希望通过网页管理配置和构建，但不把 GitHub Token 暴露给浏览器。

如果只是偶尔手工编译一次 OpenWrt，这套框架可能比单个 workflow 更完整，也更复杂。

## 核心概念：配置方案

每套配置方案放在 profiles/<id>/ 下，标准结构是 7 个文件：

~~~text
profiles/
├── .baseline
└── <id>/
    ├── .config
    ├── profile.env
    ├── diy-part1.sh
    ├── diy-part2.sh
    ├── required-packages.txt
    ├── watch-sources.txt
    └── feeds.conf
~~~

profiles/.baseline 保存当前唯一基准配置 ID。

基准配置不是固定 default。任何现有配置方案都可以设为基准；当前基准不能删除，切换后原基准就会变成普通配置方案。

当前仓库自带 default 示例，使用 Lean LEDE master + x86_64 generic。它只是示例配置，不代表框架只能编译 x86。

## 7 个标准文件分别做什么

- .config：OpenWrt 最终基础配置。
- profile.env：源码、分支、构建开关和各文件路径。
- diy-part1.sh：源码准备完成后、feeds 更新前执行。
- diy-part2.sh：feeds 安装完成后、make defconfig 前执行。
- required-packages.txt：要求最终固件清单必须出现的软件包。
- watch-sources.txt：除主源码外需要额外监控的 Git 上游。
- feeds.conf：额外第三方 feeds。

管理中心新建配置方案时会生成完整 7 文件结构。恢复已删除配置时，会读取删除前的真实快照。

## 推荐使用方式

### 方式一：管理中心

已经部署管理中心时，推荐直接在网页完成：

- 新建配置方案。
- 图形选择目标设备、LuCI 应用和编译特性。
- 编辑 7 个标准文件。
- 复制 / 重命名配置。
- 切换基准。
- 删除和恢复。
- 启动、取消、重跑构建。
- 检查上游更新。
- 查看产物和版本发布。

配置变更不会直接写默认分支，而是通过独立分支和合并请求（PR）保存。

部署说明见 control-plane/README.md。

### 方式二：浏览器本地向导

如果不想部署管理中心，可以使用 GitHub Pages 的配置方案向导，在浏览器本地生成 ZIP。

向导不会上传 .config 或表单内容。

说明见 dashboard/README.md。

### 方式三：手工维护

也可以直接复制 profiles/default/，改成自己的配置 ID，再手工维护 7 个文件。

只要配置目录能通过 scripts/profile.sh validate，就可以交给统一构建工作流使用。

## 图形配置为什么不是“假菜单”

Config Studio 不维护静态设备数据库，也不在浏览器里自己猜 OpenWrt 依赖。

它会启动真实 GitHub Actions，在目标源码上：

1. 读取配置方案。
2. 运行预检。
3. 准备源码。
4. 执行 diy-part1.sh。
5. 合并额外 feeds。
6. 更新 feeds。
7. 安装 feeds。
8. 设置 PROFILE_FILES_DIR。
9. 执行 diy-part2.sh。
10. 运行 make defconfig。
11. 从真实 Kconfig 导出目标设备、软件包和编译特性。

编辑已有配置时，会先把当前编辑器里的 7 个文件组成完整快照，再进入上面流程。因此你还没保存到默认分支的 diy-part1.sh、diy-part2.sh、feeds.conf 或 .config 修改也会真实生效。

用户提交选择后，后台再次运行 make defconfig，再告诉前端哪些选择被原样接受、哪些因依赖被调整。

## 软件源和同名包处理

额外第三方源写在 feeds.conf。

项目把两个问题分开处理：

1. feed 名称重复：合并 feeds 时去重。
2. 不同 feed 提供同名 source package：按配置策略决定使用哪个来源。

当前冲突策略：

- per-package：默认。比较真实二进制包版本，版本更高的来源优先；如果同一 source 内不同二进制包要求不同 feed 胜出，会停止并提示风险。
- feed-order：按 feeds.conf 中第三方优先 feed 的声明顺序整源选择。

常用第三方源可以使用 --force 标记，从而优先覆盖源码默认同名包。

每轮决策都会进入 config-record/feed-priority.json，方便之后排查“这次到底用了哪个源”。

## 正式构建

主构建工作流：

- .github/workflows/build-openwrt.yml

手动运行时可以指定配置 ID；留空时使用 profiles/.baseline 指向的基准配置。

构建主要阶段包括：

- 配置预检。
- 源码准备。
- feeds 合并和安装。
- 编译缓存恢复。
- 源码下载。
- OpenWrt 编译。
- 固件清单校验。
- 配置与来源留档。
- 构建产物上传。
- 可选版本发布。
- 历史运行和缓存清理。

如果没有成功生成并验收固件，不会创建 Release。

## 构建日志

正常编译不会把完整 make 并行日志持续刷到 GitHub 页面。

默认行为是：

- 页面显示阶段和定期心跳。
- 详细并行输出留在 Runner 临时文件。
- 失败后提取有限错误上下文。
- 必要时对失败目标执行受限的 -j1 V=s 诊断。
- 失败诊断作为短期构建产物保留。

这样可以避免 GitHub 日志被截断后只剩“step truncated”而看不到真正错误。

旧版 STREAM_BUILD_LOG 已废弃并被忽略。新配置方案不会生成这个字段。

只有框架调试时才使用内部 OPENWRT_NG_DEBUG_STREAM_LOG=true。

## 缓存

构建缓存按配置方案隔离，避免不同设备或源码互相污染。

项目会管理：

- OpenWrt 下载缓存。
- 构建缓存。
- 相关语言工具链缓存。

清理逻辑会保留有限数量的近期缓存，不应为了“看起来干净”每次都做冷构建。

## 配置和来源留档

成功构建会生成 config-record，记录本次可追溯信息，包括：

- 最终 .config。
- Profile 配置。
- 主源码提交。
- 各 feed 的具体提交。
- 单文件动态来源的校验值。
- Feed 冲突决策。
- 固件清单校验结果。

目标是让两次构建出现差异时，可以知道到底是源码、feed、配置还是某个动态文件发生了变化。

## 固件清单校验

required-packages.txt 每行写一个必须出现在最终固件清单中的软件包。

构建完成后 scripts/validate-manifest.sh 会检查它们是否真实进入目标固件，而不是只检查 .config 中有没有选中。

## 自动检查上游更新

工作流：

- .github/workflows/update-checker.yml

自动模式只检查 AUTO_UPDATE=true 的配置方案。

管理中心手动触发时可以：

- 检查全部已开启自动更新的配置。
- 指定单个配置方案，此时不受 AUTO_UPDATE 开关限制。
- 强制忽略已记录状态并重新触发构建。

更新状态按源码和额外 watch-sources 计算。相同上游状态不会无限自动重试失败构建。

## 补发已有构建

工作流：

- .github/workflows/release-existing.yml

它用于“固件已经编译成功，但版本发布阶段失败或被中断”的场景。

只有以下条件同时满足才允许补发：

- 来源是正式构建工作流。
- 来源运行已经结束。
- “编译 OpenWrt 固件”任务成功。
- 当前没有关联 Release。
- OpenWrt_NG_release_bundle_<run_id> 仍存在且没有过期。

补发直接复用原发布包，不会重新编译固件。

如果发布包没有生成或已经过期，就必须重新构建，不能伪造恢复。

## 构建看板

GitHub Pages 构建看板用于只读查看：

- 配置方案。
- 最近构建。
- 上游状态。
- 最近版本发布。

它不持有 GitHub Token，也不会触发编译或修改仓库。

说明见 dashboard/README.md。

## 管理中心

默认部署方式是 Cloudflare Workers + D1。

浏览器不会拿到 GitHub access token。完整 GitHub App 权限建议：

- Metadata：只读。
- Contents：读写。
- Pull requests（合并请求）：读写。
- Actions：读写。

不需要 Administration 或 Workflows 权限。

详细部署和安全说明见 control-plane/README.md。

## Adapter

当前正式 Adapter：

- adapters/direct-openwrt.sh

适用于标准 OpenWrt 源码树及常见兼容分支。

如果未来接入目录结构或准备流程明显不同的 SDK，应新增 Adapter，而不是把设备特例继续堆进主 workflow。

规范见 adapters/README.md。

## 正式 Workflow

当前仓库只有以下正式工作流：

- build-openwrt.yml：正式构建。
- config-studio.yml：图形配置。
- update-checker.yml：上游更新检查。
- release-existing.yml：补发已有构建。
- pages-dashboard.yml：生成并部署构建看板。
- deploy-control-plane.yml：部署 Cloudflare 管理中心。
- control-plane-ci.yml：中央代码和契约测试。
- profile-post-merge-cleanup.yml：配置方案 PR 合并后的补偿清理。

临时验证 workflow 不应长期留在仓库。

## 目录结构

~~~text
.github/workflows/     正式 GitHub Actions 工作流
adapters/              不同 OpenWrt 源码树的接入层
control-plane/         管理中心 Worker / D1 / 可选自托管实现
dashboard/             GitHub Pages 构建看板和本地配置向导
profiles/              各设备 / 各方案配置
scripts/               构建、校验、追新、诊断和同步脚本
VERSION                框架版本唯一来源
~~~

## 开发和验证原则

项目维护时遵守：

- 主仓是共享代码唯一来源。
- 测试仓在跑新功能前必须先通过共享代码同步门禁。
- 测试仓允许保留自己的测试配置方案、构建看板数据和 .openwrt-ng 同步配置。
- 共享代码有缺失、额外或内容 / 文件模式不同，测试应直接失败。
- 优先使用 smoke 配置验证框架逻辑，不为了验证按钮反复跑大型固件。
- 大型编译失败时只抓有限错误上下文，不反复拉取被 GitHub 截断的巨型日志。
- 临时分支和临时 workflow 用完必须清理。
- 不通过丢弃提交或重写历史来“清理”已经完成的真实验证。

同步门禁实现：

- scripts/verify-shared-sync.py

默认允许测试仓在以下目录存在自己的内容：

- profiles/
- dashboard/data/
- .openwrt-ng/

除此之外的共享文件必须和上游完全一致。

## 本地 / CI 测试

管理中心需要 Node.js 24。

核心测试入口：

~~~bash
cd control-plane
npm test
~~~

中央 CI 还会检查：

- JavaScript / Shell / Python 基础语法。
- 运行时 API 版本。
- 共享代码同步。
- 配置方案模板。
- Config Studio。
- Feed 合并和冲突策略。
- 失败上下文提取。
- 缓存清理。
- 构建看板 / 配置方案向导。
- Docker 自托管启动。

## 常见问题

### 为什么 default 不能当成固定基准？

default 只是一个普通配置目录。真正的基准由 profiles/.baseline 决定。

### 为什么图形配置要等 GitHub Actions？

因为设备、软件包和依赖来自目标 OpenWrt 源码当前版本。项目故意运行真实 Kconfig，而不是在网页里维护一份容易过期的假数据库。

### 为什么有些构建不能“发布现有构建”？

补发依赖构建当时保存的 Release bundle。没有保存、已经过期、编译任务本身失败，或者已经存在 Release，都不能补发。

### 为什么正常构建日志看不到完整 make 输出？

这是刻意设计。完整并行日志很容易被 GitHub 截断；正常时只显示心跳，失败后才提取真正有用的上下文。

### 测试仓 HEAD 为什么和主仓不一样？

测试仓有自己的测试配置、验证提交和同步门禁配置，所以 commit SHA 不要求相同。判断是否同步，应看共享代码门禁是否通过，而不是比较 HEAD SHA。

## Credits

- [P3TERX/Actions-OpenWrt](https://github.com/P3TERX/Actions-OpenWrt)
- [OpenWrt](https://github.com/openwrt/openwrt)
- [Lean's LEDE](https://github.com/coolsnowwolf/lede)
- [easimon/maximize-build-space](https://github.com/easimon/maximize-build-space)
- GitHub Actions

## License

MIT
