# OpenWrt NG 管理中心

当前管理中心版本：**0.21.11**。

管理中心用于在浏览器里安全地管理配置方案、图形配置、构建、上游更新和补发版本。默认部署方式是 **Cloudflare Workers + D1**，不要求自备 VPS、Docker、Caddy 或常驻数据库。

公开 GitHub Pages 仍保持只读；登录和所有需要仓库权限的操作都在独立管理中心中完成。

## 能做什么

当前已经具备：

- 使用 GitHub App 登录，并列出已授权仓库。
- 查看、新建、编辑、复制、重命名、删除和恢复配置方案。
- 在任意现有配置方案之间切换唯一基准配置。
- 图形读取真实 OpenWrt 配置菜单，选择设备、LuCI 应用和编译特性。
- 启动构建、查看真实 GitHub Actions 步骤、取消构建和重新构建。
- 手动检查上游更新，可指定配置方案，也可强制重新触发构建。
- 查看构建产物和版本发布。
- 在满足条件时复用已有发布包补发版本，不重新编译固件。

## 安全边界

管理中心遵守以下原则：

- 浏览器不会拿到 GitHub access token 或 refresh token。
- GitHub 登录凭据只在服务端加密保存。
- 浏览器只保存 HttpOnly 会话 Cookie。
- 所有写操作都会校验登录会话、请求来源和 CSRF 信息。
- 浏览器不能指定任意 workflow、任意 ref 或任意仓库路径。
- 配置写入范围被限制在标准配置方案文件和 profiles/.baseline。
- 正常配置变更不会直接修改默认分支，而是创建独立分支和合并请求（PR）。
- 执行第三方 OpenWrt 源码和 feeds 的图形配置工作流只拥有读取仓库内容的权限，大型结果通过短期 GitHub Actions 构建产物返回。

## GitHub App 权限

当前完整功能建议一次配置：

- Metadata（仓库基本信息）：只读
- Contents（仓库文件）：读写
- Pull requests（合并请求）：读写
- Actions（构建任务）：读写

不需要：

- Administration
- Workflows

如果后续修改 GitHub App 权限，已有安装可能需要在 GitHub 中重新确认。修改完成后建议退出管理中心并重新登录一次。

## 推荐部署：Cloudflare Workers + D1

### 1. 创建 D1 数据库

在 Cloudflare 创建一个 D1 数据库。仓库中的 wrangler.jsonc 使用绑定名 DB，部署时会由 workflow 把真实 database_id 写入临时配置。

把 D1 数据库 ID 保存为 GitHub Repository Variable：

- CONTROL_PLANE_D1_DATABASE_ID

### 2. 配置 Cloudflare 部署凭据

在 GitHub Repository Secrets 中配置：

- CLOUDFLARE_API_TOKEN
- CLOUDFLARE_ACCOUNT_ID

Cloudflare API Token 至少需要允许部署 Workers，并管理目标 D1 数据库。

### 3. 第一次部署

运行 GitHub Actions 中的 **Deploy V2 Control Plane（部署管理中心）**。

第一次还没有 GitHub App 时，不要勾选“同步 GitHub App Secret”。工作流会：

1. 检查 Cloudflare 配置。
2. 安装 Node.js 24 和 Wrangler。
3. 应用 D1 Migration。
4. 部署 Worker。

部署成功后先拿到真实 workers.dev 地址。

### 4. 创建 GitHub App

使用上一步得到的 Worker 地址配置 GitHub App。

管理中心的登录回调和安装流程由应用自己处理。GitHub App 权限按前面的“GitHub App 权限”配置即可。

创建完成后准备以下 Repository Secrets：

- OPENWRT_NG_GITHUB_APP_CLIENT_ID
- OPENWRT_NG_GITHUB_APP_CLIENT_SECRET
- OPENWRT_NG_GITHUB_APP_SLUG
- TOKEN_ENCRYPTION_KEY

TOKEN_ENCRYPTION_KEY 至少 32 个字符，用于服务端加密保存 GitHub 登录凭据。

### 5. 第二次部署并同步密钥

再次运行 **Deploy V2 Control Plane（部署管理中心）**，这次勾选“同步 GitHub App Secret”。

工作流会把上面四个 GitHub App Secret 写入 Worker Secret。

部署完成后访问：

- /api/v1/health

确认 configured=true，再进行 GitHub 登录。

### 6. 真实验证

建议至少实际验证一次：

1. GitHub 登录成功。
2. 能看到 GitHub App 已授权仓库。
3. 能读取配置方案。
4. 新建一套临时配置方案并保存。
5. 确认保存走独立分支和合并请求（PR），没有直接改默认分支。
6. 复制和重命名临时配置。
7. 切换临时配置为基准，并确认基准配置不能删除。
8. 切回原基准。
9. 删除临时配置，并确认关联的图形配置会话会被取消和清理。
10. 从“最近删除”恢复，再做最终清理。
11. 手动运行一次上游更新检查。
12. 验证构建取消和重新构建。

正式仓库不建议为了测试专门制造无意义的版本发布。补发版本功能只在来源构建真实保留发布包时可用。

## 公开 Pages 的管理中心入口

公共模板仓库的 dashboard/data/control-plane.json 必须保持默认关闭：

~~~json
{
  "version": 1,
  "enabled": false,
  "controlPlaneUrl": "",
  "githubAppSlug": ""
}
~~~

只有自己的仓库完成真实验证后，才改成自己的 Worker 地址并启用。

这个文件只能放公开信息，不能放 Client Secret、GitHub Token 或 TOKEN_ENCRYPTION_KEY。

## 配置方案标准结构

管理中心的新建、复制、重命名、删除和恢复都围绕同一套标准文件工作：

~~~text
profiles/<id>/
├── .config
├── profile.env
├── diy-part1.sh
├── diy-part2.sh
├── required-packages.txt
├── watch-sources.txt
└── feeds.conf
~~~

diy-part1.sh 和 diy-part2.sh 使用可执行权限，其余文件使用普通文件权限。

仓库根下的 profiles/.baseline 保存当前唯一基准配置 ID。基准身份不绑定 default 目录名。

## 配置保存方式

正常写入流程是：

~~~text
读取默认分支最新提交
        ↓
检查用户要修改的标准文件
        ↓
创建一个原子 Git commit
        ↓
创建 openwrt-ng/profile-* 临时分支
        ↓
创建合并请求（PR）
        ↓
按合并策略处理
        ↓
合并后清理临时分支和被取代的旧 PR
~~~

管理中心支持 PROFILE_MERGE_POLICY：

- immediate：默认。创建 PR 后立即尝试 squash 合并。
- after-checks：启用 GitHub Auto-merge，等待仓库要求的检查和审核满足后再合并。
- manual：只创建 PR，由用户在 GitHub 手工审核和合并。

如果仓库规则阻止自动合并，PR 会保留，不会退回直接写默认分支。

## 配置方案生命周期

### 复制

复制会保留原配置的标准文件内容，并把文件内部明确指向 profiles/<旧ID>/ 的路径改成新 ID。

### 重命名

重命名使用一次原子提交同时创建新目录和删除旧目录。如果目标正好是当前基准配置，会在同一个提交中更新 profiles/.baseline。

重命名完成后会清理旧配置关联的图形配置会话。

### 切换基准

任意现有配置方案都可以设为基准。仓库始终只有一个基准配置。

当前基准不能删除。切换完成后，原基准只是变成普通配置方案，可以正常删除。

### 删除

删除前会确认：

- 目标不是当前基准。
- 没有仍在排队或运行中的该配置构建。
- 默认分支没有在用户确认期间发生变化。

删除成功后会取消关联的活动图形配置任务，并删除临时会话分支。

### 恢复

“最近删除”只显示由管理中心删除、当前仍不存在的配置方案。

恢复会校验删除提交的审计信息，并从删除提交的父提交读取删除前快照，再通过新的独立分支和 PR 恢复。不会 reset 或 revert 默认分支。

## 图形配置

图形配置不是静态设备数据库，也不是前端自己猜依赖。它会启动真实 GitHub Actions，在目标 OpenWrt 源码上运行 Kconfig。

编辑已有配置时，管理中心会先把当前编辑器中的 7 个标准文件作为完整快照写入专用 session 分支。也就是说，还没保存到默认分支的修改同样会进入本次图形配置。

准备顺序固定为：

1. 加载配置方案。
2. 配置预检。
3. 准备源码。
4. 执行 diy-part1.sh。
5. 合并额外 feeds。
6. feeds update。
7. feeds install。
8. 设置 PROFILE_FILES_DIR。
9. 执行 diy-part2.sh。
10. make defconfig。
11. 生成目标设备、软件包和编译特性菜单。

用户修改后再次运行 make defconfig，最终页面会区分：

- 用户选择被原样接受。
- 因依赖关系被调整。
- Kconfig 自动加入或移除的软件包。

关闭图形配置默认只暂存 session；明确选择“放弃本次配置”才会删除 session。

## 软件源和同名包

额外软件源保存在 feeds.conf。

常用第三方源会使用第三方优先标记。多个第三方 feed 提供同名 source package 时，当前支持两种策略：

- per-package：默认。比较真实包版本，版本更高者优先；如果同一 source 内不同二进制包要求不同 feed 胜出，会停止并提示风险。
- feed-order：按 feeds.conf 中第三方优先 feed 的顺序整源选择。

最终决策会写入配置留档中的 feed-priority.json。

## 构建

管理中心只会调度固定的 .github/workflows/build-openwrt.yml。

同一配置方案已有活动构建时，不会重复排队。

构建页面会显示真实 GitHub Actions 运行步骤，而不是固定转圈动画。支持：

- 启动构建。
- 选择本次是否允许版本发布。
- 取消活动构建。
- 对已结束构建执行完整重跑。
- 查看固件产物。
- 查看版本发布。

原生重跑会保留原提交和原输入，并使用新的 run attempt。

## 上游更新检查

管理中心可手动触发 update-checker.yml。

可以：

- 检查所有开启 AUTO_UPDATE 的配置方案。
- 指定单个配置方案；此时不受 AUTO_UPDATE 开关限制。
- 勾选强制重新构建，忽略已记录的上游状态。

页面会持续显示真实 GitHub Actions 步骤。

## 补发已有构建

只有同时满足以下条件时，构建详情才会提供“发布现有构建”：

- 来源运行属于 build-openwrt.yml。
- 来源运行已经结束。
- “编译 OpenWrt 固件”任务成功。
- 当前还没有关联版本发布（Release）。
- OpenWrt_NG_release_bundle_<run_id> 仍存在且没有过期。

补发会调用 release-existing.yml，直接复用原发布包，不重新编译。

如果原构建没有发布包或发布包已经过期，管理中心会直接说明原因，不会启动无效任务。

## 日志

旧版 STREAM_BUILD_LOG 已废弃并被忽略。新配置方案不会再生成这个字段。

正常编译只显示阶段和心跳；失败时提取有限错误上下文，并执行受限的单目标详细诊断。

框架开发调试才可以使用 OPENWRT_NG_DEBUG_STREAM_LOG=true 临时恢复全量输出。

## 会话与运行参数

wrangler.jsonc 当前默认值：

- PROFILE_MERGE_POLICY=immediate
- SESSION_TTL_SECONDS=604800
- SESSION_IDLE_TTL_SECONDS=86400

修改这些值时应同步检查 Worker、自托管版本和测试。

## 本地开发

需要 Node.js 24。

~~~bash
cd control-plane
npm install
npx wrangler d1 migrations apply DB --local
npx wrangler dev
~~~

本地 Secret 可放在 .dev.vars。这个文件不应提交到仓库。

## 自托管 Docker

仓库仍保留 Node.js + SQLite + Docker 实现，用于不想使用 Cloudflare 的部署环境：

- server.mjs
- lib/store.mjs
- Dockerfile

自托管方式不是默认教程，但浏览器侧安全边界、配置写入规则和 GitHub App 权限要求应与 Workers 版本保持一致。

## 测试

control-plane/package.json 的 npm test 会覆盖：

- Worker 路由。
- 自托管 Node.js 路由。
- API 契约。
- 配置方案模板。
- 配置复制、重命名、基准、删除和恢复。
- 图形配置。
- 构建取消与重跑。
- 补发已有构建。
- 上游更新检查。
- 合并策略。

中央 control-plane-ci.yml 还会检查共享代码同步、运行时 API、构建看板 / 配置方案向导契约和自托管容器启动。
