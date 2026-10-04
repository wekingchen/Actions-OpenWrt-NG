#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import tempfile

module_path = Path(__file__).with_name("extract_failure_context.py")
spec = importlib.util.spec_from_file_location("extract_failure_context", module_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

lines = [f"noise {i}" for i in range(800)]
lines[300] = "../src/gn/scope.h:241:20: error: invalid operands to binary expression"
lines[301] = "return values_ | std::views::transform(...)"
lines[745] = "ninja: build stopped: subcommand failed."
lines[760] = "ERROR: package/feeds/helloworld/gn [host] failed to build."

ranges = module.select_ranges(lines)
selected = []
for start, end in ranges:
    selected.extend(lines[start:end + 1])

joined = "\n".join(selected)
assert "scope.h:241:20: error" in joined
assert "ERROR: package/feeds/helloworld/gn [host] failed to build." in joined
assert "noise 10" not in joined
assert sum(end - start + 1 for start, end in ranges) <= 320

with tempfile.TemporaryDirectory() as tmp:
    path = Path(tmp) / "build.log"
    path.write_text("\n".join(lines) + "\n")
    assert path.is_file()

print("失败上下文提取测试通过")
