import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildControlPlaneUrl,
  containsSensitiveControlPlaneData,
  loadControlPlaneConfig,
  normalizeControlPlaneConfig
} from "../../dashboard/assets/control-plane.js";

assert.deepEqual(
  normalizeControlPlaneConfig({
    version: 1,
    enabled: false,
    controlPlaneUrl: "",
    githubAppSlug: ""
  }),
  {
    version: 1,
    enabled: false,
    controlPlaneUrl: "",
    githubAppSlug: ""
  }
);

const enabled = normalizeControlPlaneConfig({
  version: 1,
  enabled: true,
  controlPlaneUrl: "https://control.example.com/",
  githubAppSlug: "openwrt-ng"
});
assert.equal(enabled.controlPlaneUrl, "https://control.example.com");
assert.equal(
  buildControlPlaneUrl(enabled, "/profiles"),
  "https://control.example.com/profiles"
);

assert.throws(
  () =>
    normalizeControlPlaneConfig({
      version: 1,
      enabled: true,
      controlPlaneUrl: "http://control.example.com"
    }),
  /HTTPS/
);
assert.throws(
  () => normalizeControlPlaneConfig({ version: 2, enabled: false }),
  /不支持/
);

assert.equal(containsSensitiveControlPlaneData({ access_token: "secret" }), true);
assert.equal(containsSensitiveControlPlaneData({ note: "ghu_example" }), true);
assert.equal(
  containsSensitiveControlPlaneData({ version: 1, enabled: false }),
  false
);

const fakeFetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    version: 1,
    enabled: true,
    controlPlaneUrl: "https://control.example.com",
    githubAppSlug: "openwrt-ng"
  })
});
const loaded = await loadControlPlaneConfig("unused", fakeFetch);
assert.equal(loaded.enabled, true);

const secretFetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    version: 1,
    enabled: false,
    refresh_token: "do-not-publish"
  })
});
await assert.rejects(
  () => loadControlPlaneConfig("unused", secretFetch),
  /疑似凭据/
);

console.log("管理中心公开配置测试通过。");


const publicConfig = JSON.parse(
  await readFile(
    new URL("../../dashboard/data/control-plane.json", import.meta.url),
    "utf8"
  )
);
assert.equal(publicConfig.enabled, false);
assert.equal(publicConfig.controlPlaneUrl, "");
assert.equal(containsSensitiveControlPlaneData(publicConfig), false);

const connectHtml = await readFile(
  new URL("../../dashboard/connect.html", import.meta.url),
  "utf8"
);
assert.match(connectHtml, /能做什么/);
assert.match(connectHtml, /配置方案：.*新建.*复制.*重命名.*删除.*恢复/);
assert.match(connectHtml, /推荐最终权限/);
assert.match(connectHtml, /Administration \/ Workflows：不需要/);
assert.doesNotMatch(connectHtml, /V2 Preview|Roadmap|V2\.0A 权限边界/);

const connectJs = await readFile(
  new URL("../../dashboard/assets/connect.js", import.meta.url),
  "utf8"
);
assert.match(connectJs, /模板默认关闭/);
