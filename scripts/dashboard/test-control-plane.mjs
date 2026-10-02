import assert from "node:assert/strict";
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

console.log("Control Plane public-config tests passed.");
