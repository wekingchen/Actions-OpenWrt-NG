# 源码适配器（Adapter）接入规范

源码适配器用来把不同 OpenWrt 源码树接到同一套构建流程里。当前仓库只有一个正式适配器：**direct-openwrt**，适用于 OpenWrt、Lean LEDE、ImmortalWrt 以及大多数保持标准 OpenWrt 目录结构的分支。

普通用户通常不需要直接修改源码适配器。只有源码树的准备方式、feeds 处理方式或编译入口与标准 OpenWrt 明显不同，才应该新增适配器。

## 当前调用顺序

正式构建和图形配置都会遵循同一套大体顺序：

1. 读取配置方案和 profile.env。
2. 运行配置方案预检。
3. 由源码适配器准备源码树。
4. 执行 diy-part1.sh。
5. 合并并更新 feeds。
6. 安装 feeds，并按配置的同名包策略处理冲突。
7. 设置 PROFILE_FILES_DIR。
8. 执行 diy-part2.sh。
9. 运行 make defconfig。
10. 后续进入图形配置解析或正式编译。

这条顺序是项目契约的一部分。特别是编辑已有配置方案时，管理中心会先还原该方案的 7 个标准文件，再按上面的顺序执行，不能跳过 DIY 脚本或交换 diy-part1.sh / diy-part2.sh 的位置。

## 源码适配器必须提供的能力

适配器脚本由框架调用，不应自行改写 GitHub 工作流。当前 direct-openwrt.sh 提供标准 OpenWrt 源码树需要的准备、依赖和编译接入逻辑。

新增源码适配器时至少要满足：

- 能根据 SOURCE_REPO 与 SOURCE_BRANCH 得到可用源码树。
- 不绕过项目的 feeds 合并、同名包处理和配置留档逻辑。
- 不绕过 make defconfig。
- 不自行创建版本发布（Release）。
- 不自行上传 GitHub Actions 构建产物。
- 不把凭据写进源码树、日志、配置留档或构建产物。

## 配置方案脚本

每套配置方案可以提供：

- diy-part1.sh：源码拉取完成后、feeds 更新前执行。
- diy-part2.sh：feeds 安装完成后、make defconfig 前执行。

两个脚本都应保持可重复执行，失败时必须返回非 0 状态。不要依赖交互输入。

## 构建空间

MAXIMIZE_BUILD_SPACE=true 时，工作流会按项目现有逻辑扩展 GitHub 执行器的可用空间。普通 OpenWrt 配置建议保持关闭，只有大型源码或目标确实需要时再打开。

## 日志说明

旧版 STREAM_BUILD_LOG 已废弃。现在正常编译默认只显示阶段和心跳，完整并行输出不会持续刷满 GitHub 页面；失败后才提取有限错误上下文，并额外执行受限的单目标详细诊断。

如需框架开发调试，可使用内部变量 OPENWRT_NG_DEBUG_STREAM_LOG=true 临时恢复全量流式日志。这个变量不是配置方案的常规选项，也不应写入新配置方案。

## 新增源码适配器前的检查

新增源码适配器后至少要确认：

- shell 语法检查通过。
- 中央 CI 全部通过。
- 图形配置能按真实源码生成配置目录。
- 构建工作流能完成预检、make defconfig、编译和产物校验。
- 不影响现有 direct-openwrt 路径。
