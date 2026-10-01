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
