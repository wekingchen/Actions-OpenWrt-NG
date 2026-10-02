# Dashboard

OpenWrt NG V1.3 的 GitHub Pages Dashboard 与 Profile Wizard。

## 当前状态

- 静态响应式 UI：已完成
- 真实 GitHub 数据导出：已完成
- schema / 敏感信息校验：已完成
- Pages Artifact 打包：已完成真实验证
- GitHub Pages 主干部署：已完成真实验证
- Profile Wizard 主干部署与 Core 契约测试：已完成真实验证
- 正式地址：<https://wekingchen.github.io/Actions-OpenWrt-NG/>

## 目录

- `index.html`：页面结构
- `assets/style.css`：响应式样式
- `assets/app.js`：只读 Dashboard 渲染逻辑
- `wizard.html`：Profile Wizard 页面
- `assets/wizard.js`：Wizard 表单、预览与本地下载逻辑
- `assets/wizard-core.js`：Profile 校验、文件生成与 ZIP 封装核心
- `connect.html`：V2 Control Plane 安全交接页
- `assets/control-plane.js`：公开 Control Plane 配置校验与 URL 构造
- `assets/connect.js`：V2 交接页渲染逻辑
- `data/status.json`：占位 schema；CI 发布前会用真实数据覆盖
- `../scripts/dashboard/export-data.py`：GitHub / Profile 数据导出器
- `../scripts/dashboard/validate-data.py`：schema 与敏感信息校验

## 数据与权限

Dashboard 浏览器端不调用 GitHub API，也不持有 Token。

Pages Workflow 使用：

- `contents: read`
- `actions: read`

生成静态数据；只有独立 deploy job 拥有：

- `pages: write`
- `id-token: write`

Dashboard 不参与 Core 的编译、追新或 Release 决策。

## Pages 首次启用

正式合入 main 后，需要在仓库 Settings → Pages 中把 Build and deployment Source 设置为 **GitHub Actions**。这是仓库级一次性设置，Dashboard Workflow 不使用额外 PAT 自动修改 Pages 配置。

## Profile Wizard

V1.3 新增 `wizard.html`。

- 浏览器本地读取 / 粘贴 `.config`
- 生成标准 `profiles/<id>/` 六文件结构
- Profile ID 与 Core 共用安全命名边界：字母或数字开头，最大 64 个字符
- 对上传 / 粘贴内容做基础 Kconfig 形态校验
- 客户端生成 ZIP，不上传配置
- 生成器回归测试：`scripts/dashboard/test-wizard.mjs`
- Core 集成测试：`scripts/dashboard/test-wizard.sh`

正式地址：<https://wekingchen.github.io/Actions-OpenWrt-NG/wizard.html>


## V2 Control Plane

公开 Pages 只展示 Control Plane 的连接状态，不执行 GitHub OAuth，也不读取登录 Session。

- `data/control-plane.json` 只能包含公开配置，默认 `enabled=false`
- 配置校验会拒绝常见 GitHub Token / Secret 字段
- 登录后的控制面必须运行在独立同源 BFF 上
- GitHub Token 不得回传到 Pages 或写入浏览器存储
