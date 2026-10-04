#!/usr/bin/env python3
import importlib.util
from pathlib import Path

module_path = Path(__file__).with_name("detect_failed_target.py")
spec = importlib.util.spec_from_file_location("detect_failed_target", module_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

detect = module.detect_failed_target

assert detect("    ERROR: package/feeds/helloworld/gn [host] failed to build.\n") == (
    "package/feeds/helloworld/gn/host/compile"
)
assert detect("ERROR: package/feeds/packages/curl failed to build.\n") == (
    "package/feeds/packages/curl/compile"
)
assert detect("ERROR: tools/cmake failed to build.\n") == "tools/cmake/compile"
assert detect(
    "ERROR: package/feeds/demo/first failed to build.\n"
    "ERROR: package/feeds/demo/hosttool [host] failed to build.\n"
) == "package/feeds/demo/hosttool/host/compile"
assert detect("nothing failed here\n") == ""

print("失败目标识别测试通过")
