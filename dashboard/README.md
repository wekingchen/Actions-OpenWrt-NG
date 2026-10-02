# Dashboard

OpenWrt NG V1.2 的只读 GitHub Pages Dashboard。

## 当前状态

- 静态响应式 UI：已完成
- 真实 GitHub 数据导出：已完成
- schema / 敏感信息校验：已完成
- Pages Artifact 打包：已完成真实验证
- GitHub Pages 部署：仅允许 main；首次需要在 Settings → Pages 选择 GitHub Actions

## 目录

- `index.html`：页面结构
- `assets/style.css`：响应式样式
- `assets/app.js`：只读渲染逻辑
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
