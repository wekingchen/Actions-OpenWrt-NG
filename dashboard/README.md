# 构建看板与配置方案向导

dashboard/ 是 OpenWrt NG 的公开 GitHub Pages 前端。它负责展示只读状态、提供本地配置方案向导，以及跳转到独立的管理中心。

当前框架版本由仓库根目录 VERSION 统一提供。构建看板本身不参与编译、自动更新判断或版本发布。

## 页面组成

- index.html：构建看板。查看配置方案、最近构建、上游状态和版本发布。
- wizard.html：配置方案向导。在浏览器本地生成标准配置方案 ZIP。
- connect.html：管理中心连接页。只读取公开连接配置，不处理 GitHub 登录凭据。
- assets/app.js：构建看板渲染逻辑。
- assets/wizard.js：向导交互逻辑。
- assets/wizard-core.js：配置校验、7 个标准文件生成和 ZIP 封装。
- assets/connect.js：管理中心连接状态展示。
- assets/control-plane.js：公开连接配置校验。
- data/status.json：构建看板数据占位文件，发布 Pages 前由 CI 写入真实数据。
- data/control-plane.json：管理中心公开连接配置。

## 数据和权限

浏览器端不会直接使用 GitHub Token，也不会调用需要仓库写权限的 GitHub API。

Pages 工作流读取仓库和 Actions 状态后生成静态数据。部署任务只需要 GitHub Pages 所需权限。构建看板发生故障不会影响 Builder、Update Checker 或版本发布。

## 配置方案向导

向导生成的是标准 7 文件结构：

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

其中 diy-part1.sh 和 diy-part2.sh 保持可执行权限，其余文件为普通文本文件。

向导会在当前浏览器内处理 .config 和表单内容，不上传文件。生成结果与管理中心的新建配置方案模板使用同一套核心规则，并由自动测试检查两边输出是否一致。

向导适合：

- 不想部署管理中心，只需要本地生成一套配置方案。
- 想先离线准备配置，再手工提交到仓库。

如果已经部署管理中心，更推荐直接在管理中心新建或图形编辑配置方案，保存时会自动走独立分支和合并请求（PR）。

## 管理中心入口

公共模板仓库默认保持 dashboard/data/control-plane.json 为：

~~~json
{
  "version": 1,
  "enabled": false,
  "controlPlaneUrl": "",
  "githubAppSlug": ""
}
~~~

这是安全默认值，避免使用模板创建的新仓库误连到维护者自己的服务。

只有在自己的仓库已经完成管理中心部署、真实登录和仓库操作验证后，才应填入自己的公开地址并把 enabled 改为 true。

这个文件只能放公开信息，不能写 Client Secret、GitHub Token、TOKEN_ENCRYPTION_KEY 或其他密钥。

## GitHub Pages 首次启用

在仓库 Settings → Pages 中，把 Build and deployment 的 Source 设置为 GitHub Actions。这个设置通常只需要做一次。

正式页面由 pages-dashboard.yml 生成和部署。

## 验证

相关测试包括：

- scripts/dashboard/test-wizard.mjs：检查向导输入、文件生成和 ZIP。
- scripts/dashboard/test-wizard.sh：把生成结果放回真实 profiles/ 路径，验证 profile.sh、更新检查和固件清单校验兼容性。
- scripts/dashboard/validate-data.py：检查构建看板数据结构和敏感信息。
- control-plane/contract.test.mjs：检查管理中心版本和前端契约。
