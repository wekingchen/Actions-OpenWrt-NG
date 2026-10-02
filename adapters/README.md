# Adapter Contract

Adapter 的职责只有一个：把 Profile 指定的源码准备成可编译的 OpenWrt 根目录。

Workflow 会执行：

```bash
"$ADAPTER_SCRIPT" install-deps
"$ADAPTER_SCRIPT" prepare
```

要求：

1. `install-deps` 可以是空操作；特殊 SDK 可在这里安装额外宿主依赖。
2. `prepare` 成功后，`$GITHUB_WORKSPACE/openwrt` 必须是 OpenWrt build root（目录或符号链接均可）。
3. Adapter 必须把实际源码 commit 写入 `SOURCE_COMMIT`：
   - GitHub Actions 中写入 `$GITHUB_ENV`；
   - 同时允许后续脚本通过环境变量读取。
4. Adapter 不负责 feeds、配置、编译、Release；这些属于 Core。
5. 设备特有补丁优先放 Profile DIY Hook，只有“源码树生成方式”确实特殊时才放 Adapter。

V0.1 内置 `direct-openwrt.sh`。


## Profile Hook

除 Adapter 外，Profile 还可以声明以下可选 Hook：

- `PREFLIGHT_SCRIPT`：只读 Preflight 阶段运行。通过 `OPENWRT_NG_PREFLIGHT_ENV` 写入 `KEY=value` 元数据；Core 会校验后用短期 Artifact 交给 build。
- `POST_FEEDS_SCRIPT`：`feeds update -a` 后、feed 指纹与 `feeds install` 前运行。
- `DIY_PART1`：feeds 更新前。
- `DIY_PART2`：feeds 安装后、最终 `make defconfig` 前。

需要给 make 临时补充宿主动态库搜索路径时，可声明：

```bash
MAKE_LD_LIBRARY_PATH_RELATIVE="staging_dir/hostpkg/lib"
```

该路径只注入 make 及诊断重试的子进程，不写入全局 `LD_LIBRARY_PATH`。


## Heavy Build Options

Profile 可以按需声明：

```bash
MAXIMIZE_BUILD_SPACE="true"
STREAM_BUILD_LOG="false"
```

- `MAXIMIZE_BUILD_SPACE` 只在需要较大工作盘的 Profile 开启；Core 使用固定 commit 的 `easimon/maximize-build-space`。
- `STREAM_BUILD_LOG=false` 适合日志量很大的老 SDK；完整日志仍保存在 `build.log`，页面通过心跳显示进度。
