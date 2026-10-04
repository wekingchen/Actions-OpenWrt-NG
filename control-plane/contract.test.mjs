import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const schema = JSON.parse(readFileSync("./api-schema.json", "utf8"));
const packageJson = JSON.parse(readFileSync("./package.json", "utf8"));
const packageLock = JSON.parse(readFileSync("./package-lock.json", "utf8"));
const indexHtml = readFileSync("./public/index.html", "utf8");
const workerSource = readFileSync("./worker.mjs", "utf8");
const serverSource = readFileSync("./server.mjs", "utf8");

function githubMethodCalls(source, pattern) {
  return [...new Set([...source.matchAll(pattern)].map((match) => match[1]))]
    .sort();
}

const workerMethods = githubMethodCalls(
  workerSource,
  /\bdeps\.github\.([A-Za-z][A-Za-z0-9_]*)\s*\(/g
);
const serverMethods = githubMethodCalls(
  serverSource,
  /\bgithub\.([A-Za-z][A-Za-z0-9_]*)\s*\(/g
);
assert.deepEqual(
  serverMethods,
  workerMethods,
  "Cloudflare Worker 与自托管 Server 必须调用同一组 GitHub 能力"
);

const sessionResponse = schema.$defs?.configStudioSessionResponse;
assert.ok(sessionResponse, "缺少 configStudioSessionResponse Schema");
assert.ok(
  sessionResponse.required?.includes("progress"),
  "Config Studio 状态响应必须要求 progress 字段"
);
assert.equal(
  sessionResponse.properties?.progress?.$ref,
  "#/$defs/actionProgress",
  "Config Studio progress 必须复用 actionProgress Schema"
);

for (const field of ["extraFeeds", "feedPriorityMode"]) {
  assert.ok(
    sessionResponse.required?.includes(field),
    `Config Studio 状态响应必须要求 ${field} 字段`
  );
  assert.ok(
    sessionResponse.properties?.[field],
    `Config Studio 状态响应缺少 ${field} Schema`
  );
}
assert.deepEqual(
  schema.$defs?.profileTemplateInput?.properties?.feedPriorityMode?.enum,
  ["per-package", "feed-order"],
  "Profile Template Feed 策略枚举必须保持稳定"
);

for (const name of [
  "profileLifecycleRequest",
  "profileRestoreRequest",
  "buildControlResponse",
  "updateCheckerRequest",
  "workflowDispatchResponse",
  "managedWorkflowRun"
]) {
  assert.ok(schema.$defs?.[name], `缺少 API 契约定义：${name}`);
}

assert.equal(packageLock.version, packageJson.version);
assert.equal(packageLock.packages?.[""]?.version, packageJson.version);
assert.match(
  indexHtml,
  new RegExp(`Control Plane ${packageJson.version.replaceAll(".", "\\.")}`)
);
assert.match(
  indexHtml,
  new RegExp(
    `mobile-version-badge[^>]*>\\s*${packageJson.version.replaceAll(".", "\\.")}\\s*<`
  )
);

console.log(
  `Control Plane contract tests passed: version=${packageJson.version}, github-methods=${workerMethods.length}`
);
