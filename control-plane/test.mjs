import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import {
  GitHubAppClient,
  builderProgressFromJobs,
  configStudioProgressFromJobs,
  githubErrorReason,
  selectConfigStudioRun
} from "./lib/github.mjs";
import {
  decryptString,
  encryptString,
  hashOpaque,
  safeReturnTo,
  sha256Base64Url
} from "./lib/security.mjs";
import { ControlPlaneStore } from "./lib/store.mjs";
import { createControlPlaneHandler } from "./server.mjs";
import {
  buildProfileTemplateFiles,
  profileFilesObject
} from "./lib/profile-template.mjs";
import { buildProfileFiles as buildWizardProfileFiles } from "../dashboard/assets/wizard-core.js";

const controlPlaneAppJs = readFileSync("./public/app.js", "utf8");
const controlPlaneIndexHtml = readFileSync("./public/index.html", "utf8");
const githubClientSource = readFileSync("./lib/github.mjs", "utf8");
const configStudioWorkflow = readFileSync(
  "../.github/workflows/config-studio.yml",
  "utf8"
);
const releaseExistingWorkflow = readFileSync(
  "../.github/workflows/release-existing.yml",
  "utf8"
);
const updateCheckerWorkflow = readFileSync(
  "../.github/workflows/update-checker.yml",
  "utf8"
);
const referencedDomIds = [
  ...new Set(
    [...controlPlaneAppJs.matchAll(/\$\("([^"]+)"\)/g)].map((match) => match[1])
  )
];
const missingDomIds = referencedDomIds.filter(
  (id) =>
    !controlPlaneIndexHtml.includes('id="' + id + '"') &&
    !controlPlaneIndexHtml.includes("id='" + id + "'")
);
assert.deepEqual(
  missingDomIds,
  [],
  "app.js 引用的 DOM id 必须全部存在于 index.html"
);
assert.match(
  controlPlaneIndexHtml,
  /id="config-studio-progress-track"[^>]*role="progressbar"/
);
assert.match(controlPlaneAppJs, /configStudioPackageChildren/);
assert.match(controlPlaneAppJs, /configStudioPackageMenuTree/);
assert.match(controlPlaneAppJs, /configStudioPackageSubmenu/);
assert.match(controlPlaneAppJs, /relativeMenuTrail/);
assert.match(controlPlaneAppJs, /choicePrompt/);
assert.match(controlPlaneAppJs, /configOptions/);
assert.match(controlPlaneAppJs, /renderConfigStudioPackageSubmenus/);
assert.match(controlPlaneAppJs, /renderConfigStudioFeatureMenus/);
assert.match(controlPlaneAppJs, /renderConfigStudioFeatureSubmenus/);
assert.match(controlPlaneIndexHtml, /id="config-studio-submenu"/);
assert.match(controlPlaneIndexHtml, /id="config-studio-feature-menu"/);
assert.match(controlPlaneIndexHtml, /id="config-studio-feature-submenu"/);
assert.match(controlPlaneAppJs, /computeConfigStudioDependencyLocks/);
assert.match(controlPlaneAppJs, /configStudioDependencyConditionMatches/);
assert.match(controlPlaneAppJs, /configStudioEffectiveModifiedEntries/);
assert.match(controlPlaneIndexHtml, /id="config-studio-dependency-summary"/);
assert.match(controlPlaneIndexHtml, /id="config-studio-show-dependencies"/);
assert.match(controlPlaneIndexHtml, /class="mobile-version-badge"[^>]*>0\.21\.9<\/span>/);
assert.match(controlPlaneIndexHtml, /id="new-adapter-field" hidden/);
assert.match(controlPlaneIndexHtml, /id="profile-list-result"/);
assert.match(controlPlaneAppJs, /showProfileListResult/);
assert.match(controlPlaneAppJs, /forceRefresh: true/);
assert.match(controlPlaneAppJs, /cache: "no-store"/);
assert.match(controlPlaneAppJs, /profile-item-refreshed/);
assert.match(controlPlaneIndexHtml, /id="delete-profile-dialog"/);
assert.match(controlPlaneIndexHtml, /id="confirm-delete-profile"/);
assert.match(controlPlaneIndexHtml, /id="baseline-profile-dialog"/);
assert.match(controlPlaneIndexHtml, /id="confirm-baseline-profile"/);
assert.match(controlPlaneAppJs, /openBaselineProfileDialog/);
assert.match(controlPlaneAppJs, /profile\.baseline/);
assert.match(githubClientSource, /setBaselineProfilePullRequest/);
assert.match(githubClientSource, /profiles\/\.baseline/);
assert.match(controlPlaneAppJs, /method: "DELETE"/);
assert.match(controlPlaneAppJs, /protected_profile/);
assert.match(githubClientSource, /deleteProfilePullRequest/);
assert.match(githubClientSource, /action === "delete"/);
assert.match(controlPlaneIndexHtml, /id="profile-lifecycle-dialog"/);
assert.match(controlPlaneAppJs, /openProfileLifecycleDialog/);
assert.match(controlPlaneAppJs, /profile-copy-action/);
assert.match(controlPlaneAppJs, /profile-rename-action/);
assert.match(controlPlaneAppJs, /controlBuilderRun/);
assert.match(githubClientSource, /copyProfilePullRequest/);
assert.match(githubClientSource, /renameProfilePullRequest/);
assert.match(githubClientSource, /cleanupConfigStudioSessionsForProfile/);
assert.match(githubClientSource, /cancelBuilderRun/);
assert.match(githubClientSource, /rerunBuilderRun/);
assert.match(githubClientSource, /listDeletedProfiles/);
assert.match(githubClientSource, /restoreDeletedProfilePullRequest/);
assert.match(githubClientSource, /triggerReleaseExisting/);
assert.match(githubClientSource, /triggerUpdateChecker/);
assert.match(controlPlaneIndexHtml, /id="deleted-profiles-section"/);
assert.match(controlPlaneIndexHtml, /id="update-checker-dialog"/);
assert.match(controlPlaneIndexHtml, /id="release-existing-dialog"/);
assert.match(controlPlaneAppJs, /loadDeletedProfiles/);
assert.match(controlPlaneAppJs, /restoreDeletedProfile/);
assert.match(controlPlaneAppJs, /openUpdateCheckerDialog/);
assert.match(controlPlaneAppJs, /openReleaseExistingDialog/);
assert.match(releaseExistingWorkflow, /run-name: Release Existing/);
assert.match(releaseExistingWorkflow, /source_workflow_path/);
assert.match(releaseExistingWorkflow, /\.github\/workflows\/build-openwrt\.yml/);
assert.match(updateCheckerWorkflow, /run-name: Update Checker/);
assert.doesNotMatch(releaseExistingWorkflow, /runs-on: ubuntu-22\.04/);
assert.doesNotMatch(updateCheckerWorkflow, /runs-on: ubuntu-22\.04/);
assert.match(controlPlaneAppJs, /renderNewAdapterVisibility/);
assert.match(controlPlaneIndexHtml, />标准 OpenWrt 源码<\/option>/);
assert.doesNotMatch(controlPlaneIndexHtml, /id="new-stream-log"/);
assert.match(controlPlaneAppJs, /streamLog: false/);
assert.match(controlPlaneAppJs, /baseRefSha: editorState\.baseRefSha/);
assert.match(controlPlaneAppJs, /profileFiles: Object\.fromEntries/);
assert.match(controlPlaneAppJs, /saveCurrentEditorFile\(\);[\s\S]*profileFiles:/);
assert.match(githubClientSource, /profileSnapshot: Boolean\(profileSnapshot\)/);
assert.match(githubClientSource, /PROFILE_FILE_MODES\[name\]/);
assert.match(githubClientSource, /request\.profileSnapshot/);
assert.match(configStudioWorkflow, /ref: \$\{\{ inputs\.session_branch \}\}/);
assert.match(configStudioWorkflow, /name: 运行 Profile Preflight/);
assert.match(configStudioWorkflow, /OPENWRT_NG_PREFLIGHT_ENV=/);
assert.match(configStudioWorkflow, /PROFILE_FILES_DIR/);

const builderProgress = builderProgressFromJobs([
  {
    name: "构建前快速预检",
    status: "completed",
    conclusion: "success",
    steps: [
      { name: "静态预检", status: "completed", conclusion: "success" }
    ]
  },
  {
    name: "编译 OpenWrt 固件",
    status: "in_progress",
    conclusion: "",
    steps: [
      { name: "准备 OpenWrt 源码", status: "completed", conclusion: "success" },
      { name: "更新 Feeds", status: "completed", conclusion: "success" },
      { name: "安装 Feeds", status: "in_progress", conclusion: "" },
      { name: "恢复编译缓存", status: "pending", conclusion: "" },
      { name: "下载软件包源码", status: "pending", conclusion: "" },
      { name: "编译固件", status: "pending", conclusion: "" },
      { name: "校验固件 Manifest", status: "pending", conclusion: "" },
      { name: "上传固件目录", status: "pending", conclusion: "" }
    ]
  },
  {
    name: "发布 OpenWrt 固件",
    status: "queued",
    conclusion: "",
    steps: []
  },
  {
    name: "清理旧 Workflow 运行记录",
    status: "queued",
    conclusion: "",
    steps: []
  }
]);
assert.equal(builderProgress?.completed, 3);
assert.equal(builderProgress?.total, 11);
assert.equal(builderProgress?.current, "安装 Feeds");
assert.equal(builderProgress?.currentDetail, "安装 Feeds");
assert.equal(builderProgress?.percent, 27);

const configStudioProgress = configStudioProgressFromJobs([
  {
    name: "解析 OpenWrt 配置",
    steps: [
      { name: "Set up job", status: "completed", conclusion: "success" },
      {
        name: "校验会话并读取请求",
        status: "completed",
        conclusion: "success"
      },
      {
        name: "安装配置解析依赖",
        status: "in_progress",
        conclusion: ""
      },
      {
        name: "准备 OpenWrt 源码",
        status: "pending",
        conclusion: ""
      }
    ]
  }
]);
assert.equal(configStudioProgress?.completed, 1);
assert.equal(configStudioProgress?.total, 3);
assert.equal(configStudioProgress?.percent, 33);
assert.equal(configStudioProgress?.current, "安装配置工具");
assert.deepEqual(
  configStudioProgress?.steps.map((step) => step.name),
  ["读取配置请求", "安装配置工具", "拉取并准备 OpenWrt 源码"]
);

const staleCatalogRun = {
  id: 100,
  display_title: "Config · catalog · cs:aabbccddeeff0011"
};
const oldResolveRun = {
  id: 101,
  display_title: "Config · resolve · cs:aabbccddeeff0011"
};
const newResolveRun = {
  id: 102,
  display_title: "Config · resolve · cs:aabbccddeeff0011"
};
const newerCatalogRun = {
  id: 103,
  display_title: "Config · catalog · cs:aabbccddeeff0011"
};

assert.equal(
  selectConfigStudioRun(
    [staleCatalogRun],
    "aabbccddeeff0011",
    "resolve",
    100
  ),
  undefined
);
assert.equal(
  selectConfigStudioRun(
    [newResolveRun, oldResolveRun, staleCatalogRun],
    "aabbccddeeff0011",
    "resolve",
    100
  )?.id,
  102
);
assert.equal(
  selectConfigStudioRun(
    [newerCatalogRun, newResolveRun, oldResolveRun],
    "aabbccddeeff0011",
    "resolve",
    101
  )?.id,
  102
);

const templateInput = {
  profileId: "new-profile",
  profileName: "New Profile O'Reilly",
  sourceRepo: "https://github.com/openwrt/openwrt",
  sourceBranch: "main",
  adapter: "direct-openwrt",
  configText: "CONFIG_TARGET_x86=y\nCONFIG_TARGET_x86_64=y\n",
  autoUpdate: false,
  uploadRelease: true,
  uploadFirmware: true,
  maximizeSpace: false,
  streamLog: true,
  requiredPackages: "curl\nluci\n",
  watchSources: "packages|https://github.com/openwrt/packages|master",
  extraFeeds:
    "src-git --force helloworld https://github.com/fw876/helloworld.git\n" +
    "src-git --force helloworld https://example.invalid/duplicate.git"
};

const controlPlaneTemplateFiles = buildProfileTemplateFiles(templateInput);
const wizardTemplateFiles = buildWizardProfileFiles(templateInput);
assert.deepEqual(controlPlaneTemplateFiles, wizardTemplateFiles);
const templateProfileEnv = controlPlaneTemplateFiles.find(
  (file) => file.path.endsWith("/profile.env")
)?.text || "";
assert.match(templateProfileEnv, /STREAM_BUILD_LOG='false'/);
assert.equal(controlPlaneTemplateFiles.length, 7);
const templateFeeds = controlPlaneTemplateFiles.find(
  (file) => file.path.endsWith("/feeds.conf")
)?.text || "";
assert.equal(
  (templateFeeds.match(/^src-git(?:-full)?(?:\s+--force)?\s+helloworld\s+/gm) || []).length,
  1
);
assert.match(templateFeeds, /github\.com\/fw876\/helloworld\.git/);
assert.doesNotMatch(templateFeeds, /example\.invalid\/duplicate\.git/);
assert.deepEqual(
  Object.keys(profileFilesObject(controlPlaneTemplateFiles)).sort(),
  [
    ".config",
    "diy-part1.sh",
    "diy-part2.sh",
    "profile.env",
    "required-packages.txt",
    "watch-sources.txt",
    "feeds.conf"
  ].sort()
);

assert.throws(
  () =>
    buildProfileTemplateFiles({
      ...templateInput,
      unexpectedPath: ".github/workflows/pwn.yml"
    }),
  /不允许的字段/
);
assert.throws(
  () =>
    buildProfileTemplateFiles({
      ...templateInput,
      configText: "not a kconfig\n"
    }),
  /OpenWrt\/Kconfig/
);

const secret = "0123456789abcdef0123456789abcdef";
const encrypted = encryptString("ghu_example", secret);
assert.notEqual(encrypted, "ghu_example");
assert.equal(decryptString(encrypted, secret), "ghu_example");
assert.equal(safeReturnTo("/repos?a=1"), "/repos?a=1");
assert.equal(safeReturnTo("https://evil.example"), "/");
assert.equal(safeReturnTo("//evil.example"), "/");
assert.equal(sha256Base64Url("abc").length > 40, true);

const store = new ControlPlaneStore(":memory:", secret);
store.createOAuthState({
  stateHash: hashOpaque("state"),
  verifier: "verifier",
  browserHash: hashOpaque("browser"),
  returnTo: "/",
  expiresAt: Date.now() + 60_000
});
const consumedState = store.consumeOAuthState(hashOpaque("state"));
assert.equal(consumedState.verifier, "verifier");
assert.equal(consumedState.browserHash, hashOpaque("browser"));
assert.equal(store.consumeOAuthState(hashOpaque("state")), null);



const receiverSensitiveClient = new GitHubAppClient(
  {
    clientId: "Iv1.receiver",
    clientSecret: "receiver-secret",
    redirectUri: "https://example.test/api/v1/auth/callback"
  },
  function receiverSensitiveFetch(_url, _options = {}) {
    if (this !== undefined) {
      throw new TypeError("Illegal invocation");
    }
    return Response.json({
      access_token: "ghu_receiver_access",
      token_type: "bearer"
    });
  }
);
const receiverToken = await receiverSensitiveClient.exchangeCode(
  "code",
  "verifier"
);
assert.equal(receiverToken.accessToken, "ghu_receiver_access");

const oauthErrorClient = new GitHubAppClient(
  {
    clientId: "Iv1.bad",
    clientSecret: "bad-secret",
    redirectUri: "https://example.test/api/v1/auth/callback"
  },
  async () =>
    Response.json(
      {
        error: "incorrect_client_credentials",
        error_description: "The client_id and/or client_secret passed are incorrect."
      },
      { status: 200 }
    )
);
await assert.rejects(
  () => oauthErrorClient.exchangeCode("code", "verifier"),
  (error) => {
    assert.equal(githubErrorReason(error), "incorrect_client_credentials");
    return true;
  }
);


let oauthRequestHeaders;
const formOAuthClient = new GitHubAppClient(
  {
    clientId: "Iv1.form",
    clientSecret: "form-secret",
    redirectUri: "https://example.test/api/v1/auth/callback"
  },
  async (_url, options = {}) => {
    oauthRequestHeaders = new Headers(options.headers || {});
    return new Response(
      "access_token=ghu_form_access&token_type=bearer&expires_in=28800&refresh_token=ghr_form_refresh&refresh_token_expires_in=15897600&scope=",
      {
        status: 200,
        headers: { "content-type": "application/x-www-form-urlencoded" }
      }
    );
  }
);
const formToken = await formOAuthClient.exchangeCode("code", "verifier");
assert.equal(formToken.accessToken, "ghu_form_access");
assert.equal(formToken.refreshToken, "ghr_form_refresh");
assert.equal(
  oauthRequestHeaders.get("user-agent"),
  "OpenWrt-NG-Control-Plane"
);


const profileBaseSha = "a".repeat(40);
const profileFileContents = {
  ".config": "CONFIG_TEST=y\n",
  "profile.env": "PROFILE_NAME=\"Test\"\nCONFIG_FILE=\"profiles/default/.config\"\nDIY_PART1=\"profiles/default/diy-part1.sh\"\n",
  "diy-part1.sh": "#!/bin/bash\n",
  "diy-part2.sh": "#!/bin/bash\n",
  "required-packages.txt": "",
  "watch-sources.txt": "",
  "feeds.conf": ""
};
const profileCalls = [];
const profileFetch = async (url, options = {}) => {
  const parsed = new URL(String(url));
  const path = parsed.pathname.replace(/^\/repos\/acme\/router/, "");
  const method = String(options.method || "GET").toUpperCase();
  profileCalls.push({ path, method, body: options.body || "" });

  if (method === "GET" && path === "") {
    return Response.json({ default_branch: "main" });
  }
  if (method === "GET" && path === "/commits/main") {
    return Response.json({ sha: profileBaseSha });
  }
  if (
    method === "GET" &&
    path === "/contents/profiles" &&
    parsed.searchParams.get("ref") === "main"
  ) {
    return Response.json([
      { type: "dir", name: "default", path: "profiles/default", sha: "dir-default" },
      { type: "dir", name: "deletable", path: "profiles/deletable", sha: "dir-deletable" }
    ]);
  }
  if (
    method === "GET" &&
    path === "/contents/profiles/.baseline" &&
    parsed.searchParams.get("ref") === "main"
  ) {
    return Response.json({
      type: "file",
      name: ".baseline",
      path: "profiles/.baseline",
      sha: "baseline-sha",
      encoding: "base64",
      content: Buffer.from("default\n", "utf8").toString("base64")
    });
  }
  if (
    method === "GET" &&
    path === "/contents/profiles/default" &&
    parsed.searchParams.get("ref") === "main"
  ) {
    return Response.json(
      Object.keys(profileFileContents).map((name) => ({
        type: "file",
        name,
        path: "profiles/default/" + name,
        sha: "old-" + name
      }))
    );
  }
  if (
    method === "GET" &&
    path === "/contents/profiles/deletable" &&
    parsed.searchParams.get("ref") === "main"
  ) {
    return Response.json(
      Object.keys(profileFileContents).map((name) => ({
        type: "file",
        name,
        path: "profiles/deletable/" + name,
        sha: "old-delete-" + name
      }))
    );
  }
  if (
    method === "GET" &&
    path === "/contents/profiles/new-profile" &&
    parsed.searchParams.get("ref") === profileBaseSha
  ) {
    return Response.json({ message: "Not Found" }, { status: 404 });
  }
  if (
    method === "GET" &&
    ["/contents/profiles/copy-profile", "/contents/profiles/default-renamed"].includes(path) &&
    parsed.searchParams.get("ref") === profileBaseSha
  ) {
    return Response.json({ message: "Not Found" }, { status: 404 });
  }
  if (
    method === "GET" &&
    path === "/contents/profiles/exists-profile" &&
    parsed.searchParams.get("ref") === profileBaseSha
  ) {
    return Response.json([{ type: "file", name: ".config" }]);
  }
  if (
    method === "GET" &&
    path.startsWith("/contents/profiles/default/") &&
    parsed.searchParams.get("ref") === "main"
  ) {
    const name = decodeURIComponent(
      path.slice("/contents/profiles/default/".length)
    );
    return Response.json({
      type: "file",
      name,
      path: "profiles/default/" + name,
      sha: "old-" + name,
      encoding: "base64",
      content: Buffer.from(profileFileContents[name], "utf8").toString("base64")
    });
  }
  if (
    method === "GET" &&
    path.startsWith("/contents/profiles/deletable/") &&
    parsed.searchParams.get("ref") === "main"
  ) {
    const name = decodeURIComponent(
      path.slice("/contents/profiles/deletable/".length)
    );
    return Response.json({
      type: "file",
      name,
      path: "profiles/deletable/" + name,
      sha: "old-delete-" + name,
      encoding: "base64",
      content: Buffer.from(profileFileContents[name], "utf8").toString("base64")
    });
  }
  if (
    method === "GET" &&
    path === "/actions/workflows/build-openwrt.yml/runs"
  ) {
    return Response.json({ workflow_runs: [] });
  }
  if (
    method === "GET" &&
    path.startsWith("/git/matching-refs/heads/openwrt-ng/config-session-")
  ) {
    return Response.json([]);
  }
  if (method === "GET" && path === "/git/commits/" + profileBaseSha) {
    return Response.json({ sha: profileBaseSha, tree: { sha: "base-tree" } });
  }
  if (method === "POST" && path === "/git/blobs") {
    const body = JSON.parse(options.body);
    return Response.json({
      sha: "blob-" + Buffer.from(body.content).toString("hex").slice(0, 12)
    }, { status: 201 });
  }
  if (method === "POST" && path === "/git/trees") {
    return Response.json({ sha: "new-tree" }, { status: 201 });
  }
  if (method === "POST" && path === "/git/commits") {
    return Response.json({ sha: "b".repeat(40) }, { status: 201 });
  }
  if (method === "POST" && path === "/git/refs") {
    return Response.json({ ref: "refs/heads/openwrt-ng/test" }, { status: 201 });
  }
  if (method === "POST" && path === "/pulls") {
    return Response.json({
      number: 17,
      html_url: "https://github.com/acme/router/pull/17"
    }, { status: 201 });
  }
  if (method === "PUT" && path === "/pulls/17/merge") {
    return Response.json({
      sha: "d".repeat(40),
      merged: true,
      message: "Pull Request successfully merged"
    });
  }
  if (
    method === "GET" &&
    path === "/pulls" &&
    parsed.searchParams.get("state") === "open"
  ) {
    return Response.json([
      {
        number: 9,
        title: "profile(default): update via Control Plane",
        body: "由 OpenWrt NG Control Plane 创建。\n\n旧配置。",
        head: {
          ref: "openwrt-ng/profile-default-stale",
          repo: { full_name: "acme/router" }
        }
      },
      {
        number: 10,
        title: "profile(other): update via Control Plane",
        body: "由 OpenWrt NG Control Plane 创建。\n\n其他配置。",
        head: {
          ref: "openwrt-ng/profile-other-stale",
          repo: { full_name: "acme/router" }
        }
      }
    ]);
  }
  if (method === "PATCH" && path === "/pulls/9") {
    return Response.json({ number: 9, state: "closed" });
  }
  if (method === "DELETE" && path.startsWith("/git/refs/heads/")) {
    return new Response(null, { status: 204 });
  }

  return Response.json({ message: "unexpected profile request" }, { status: 500 });
};

const profileClient = new GitHubAppClient(
  {
    clientId: "Iv1.profile",
    clientSecret: "profile-secret",
    redirectUri: "https://example.test/api/v1/auth/callback"
  },
  profileFetch
);
const loadedProfile = await profileClient.getProfile(
  "ghu_profile",
  "acme",
  "router",
  "default"
);
assert.equal(loadedProfile.baseRefSha, profileBaseSha);
assert.equal(
  loadedProfile.profile.files[".config"].content,
  "CONFIG_TEST=y\n"
);
assert.equal(loadedProfile.baselineProfileId, "default");
assert.equal(loadedProfile.profile.baseline, true);

const changedProfileFiles = {
  ...profileFileContents,
  ".config": "CONFIG_TEST=m\n"
};
const createdProfilePr = await profileClient.createProfilePullRequest(
  "ghu_profile",
  "acme",
  "router",
  "default",
  {
    baseRefSha: profileBaseSha,
    files: changedProfileFiles
  }
);
assert.equal(createdProfilePr.pullRequest.number, 17);
assert.equal(createdProfilePr.pullRequest.merged, true);
assert.equal(createdProfilePr.pullRequest.mergeCommitSha, "d".repeat(40));
assert.equal(createdProfilePr.cleanup.branchDeleted, true);
assert.deepEqual(
  createdProfilePr.cleanup.supersededPullRequests.map((item) => item.number),
  [9]
);
assert.deepEqual(createdProfilePr.changedFiles, [".config"]);
const createdNewProfilePr = await profileClient.createNewProfilePullRequest(
  "ghu_profile",
  "acme",
  "router",
  "new-profile",
  profileFilesObject(controlPlaneTemplateFiles)
);
assert.equal(createdNewProfilePr.action, "create");
assert.equal(createdNewProfilePr.changedFiles.length, 7);
assert.equal(createdNewProfilePr.pullRequest.number, 17);
assert.equal(createdNewProfilePr.pullRequest.merged, true);

const createTreeCall = [...profileCalls].reverse().find(
  (call) => call.method === "POST" && call.path === "/git/trees"
);
assert.ok(createTreeCall);
const createTreeBody = JSON.parse(createTreeCall.body);
assert.deepEqual(
  createTreeBody.tree.map((entry) => entry.path).sort(),
  controlPlaneTemplateFiles.map((file) => file.path).sort()
);
assert.equal(
  createTreeBody.tree.find((entry) =>
    entry.path.endsWith("/diy-part1.sh")
  ).mode,
  "100755"
);

const copyCallStart = profileCalls.length;
const copiedProfilePr = await profileClient.copyProfilePullRequest(
  "ghu_profile",
  "acme",
  "router",
  "default",
  { baseRefSha: profileBaseSha, targetProfileId: "copy-profile" }
);
assert.equal(copiedProfilePr.action, "copy");
assert.equal(copiedProfilePr.sourceProfileId, "default");
assert.equal(copiedProfilePr.targetProfileId, "copy-profile");
assert.equal(copiedProfilePr.pullRequest.merged, true);
const copyCalls = profileCalls.slice(copyCallStart);
const copyTreeCall = copyCalls.find(
  (call) => call.method === "POST" && call.path === "/git/trees"
);
assert.ok(copyTreeCall);
const copyTreeBody = JSON.parse(copyTreeCall.body);
assert.equal(copyTreeBody.tree.length, 7);
assert.ok(
  copyTreeBody.tree.every((entry) =>
    entry.path.startsWith("profiles/copy-profile/")
  )
);
assert.ok(
  copyCalls
    .filter((call) => call.method === "POST" && call.path === "/git/blobs")
    .map((call) => JSON.parse(call.body).content)
    .some((content) => content.includes("profiles/copy-profile/.config"))
);

const renameCallStart = profileCalls.length;
const renamedProfilePr = await profileClient.renameProfilePullRequest(
  "ghu_profile",
  "acme",
  "router",
  "default",
  { baseRefSha: profileBaseSha, targetProfileId: "default-renamed" }
);
assert.equal(renamedProfilePr.action, "rename");
assert.equal(renamedProfilePr.sourceProfileId, "default");
assert.equal(renamedProfilePr.targetProfileId, "default-renamed");
assert.equal(renamedProfilePr.baselineProfileId, "default-renamed");
assert.equal(renamedProfilePr.pullRequest.merged, true);
const renameCalls = profileCalls.slice(renameCallStart);
const renameTreeCall = renameCalls.find(
  (call) => call.method === "POST" && call.path === "/git/trees"
);
assert.ok(renameTreeCall);
const renameTreeBody = JSON.parse(renameTreeCall.body);
assert.equal(renameTreeBody.tree.length, 15);
assert.ok(
  renameTreeBody.tree.some((entry) =>
    entry.path === "profiles/.baseline" && entry.sha !== null
  )
);
assert.equal(
  renameTreeBody.tree.filter((entry) =>
    entry.path.startsWith("profiles/default/") && entry.sha === null
  ).length,
  7
);
assert.equal(
  renameTreeBody.tree.filter((entry) =>
    entry.path.startsWith("profiles/default-renamed/") && entry.sha !== null
  ).length,
  7
);
assert.equal(renamedProfilePr.configStudioCleanup.sessionsFound, 0);
assert.equal(renamedProfilePr.configStudioCleanup.branchesDeleted, 0);
assert.deepEqual(renamedProfilePr.configStudioCleanup.cancelFailedRuns, []);
assert.deepEqual(renamedProfilePr.configStudioCleanup.branchDeleteFailures, []);
assert.equal(renamedProfilePr.configStudioCleanup.runLookupFailed, false);

const sessionCleanupCalls = [];
const sessionCleanupClient = new GitHubAppClient(
  {
    clientId: "Iv1.session-cleanup",
    clientSecret: "session-cleanup-secret",
    redirectUri: "https://example.test/api/v1/auth/callback"
  },
  async (url, options = {}) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname.replace(/^\/repos\/acme\/router/, "");
    const method = String(options.method || "GET").toUpperCase();
    sessionCleanupCalls.push({ path, method, body: options.body || "" });

    if (
      method === "GET" &&
      path.startsWith("/git/matching-refs/heads/openwrt-ng/config-session-")
    ) {
      return Response.json([{
        ref: "refs/heads/openwrt-ng/config-session-aabbccddeeff0011",
        object: { sha: "1".repeat(40) }
      }]);
    }
    if (
      method === "GET" &&
      path === "/contents/.openwrt-ng/config-studio/aabbccddeeff0011/request.json"
    ) {
      return Response.json({
        encoding: "base64",
        content: Buffer.from(
          JSON.stringify({ profileId: "deletable" }),
          "utf8"
        ).toString("base64")
      });
    }
    if (
      method === "GET" &&
      path === "/actions/workflows/config-studio.yml/runs"
    ) {
      return Response.json({
        workflow_runs: [{
          id: 456,
          run_number: 3,
          display_title: "Config · resolve · cs:aabbccddeeff0011",
          status: "in_progress"
        }]
      });
    }
    if (method === "POST" && path === "/actions/runs/456/cancel") {
      return new Response(null, { status: 202 });
    }
    if (
      method === "DELETE" &&
      path === "/git/refs/heads/openwrt-ng/config-session-aabbccddeeff0011"
    ) {
      return new Response(null, { status: 204 });
    }
    return profileFetch(url, options);
  }
);
const sessionCleanup =
  await sessionCleanupClient.cleanupConfigStudioSessionsForProfile(
    "ghu_profile",
    "acme",
    "router",
    "deletable"
  );
assert.equal(sessionCleanup.sessionsFound, 1);
assert.equal(sessionCleanup.branchesDeleted, 1);
assert.deepEqual(sessionCleanup.canceledRuns, [456]);
assert.deepEqual(sessionCleanup.cancelFailedRuns, []);
assert.deepEqual(sessionCleanup.branchDeleteFailures, []);
assert.equal(sessionCleanup.runLookupFailed, false);
assert.ok(
  sessionCleanupCalls.some((call) =>
    call.method === "POST" && call.path === "/actions/runs/456/cancel"
  )
);
assert.ok(
  sessionCleanupCalls.some((call) =>
    call.method === "DELETE" &&
    call.path.endsWith("/config-session-aabbccddeeff0011")
  )
);

const baselineCallStart = profileCalls.length;
const baselineProfilePr = await profileClient.setBaselineProfilePullRequest(
  "ghu_profile",
  "acme",
  "router",
  "deletable",
  { baseRefSha: profileBaseSha }
);
assert.equal(baselineProfilePr.action, "baseline");
assert.equal(baselineProfilePr.baselineProfileId, "deletable");
assert.deepEqual(baselineProfilePr.changedFiles, ["profiles/.baseline"]);
assert.equal(baselineProfilePr.pullRequest.merged, true);
const baselineCalls = profileCalls.slice(baselineCallStart);
const baselineTreeCall = baselineCalls.find(
  (call) => call.method === "POST" && call.path === "/git/trees"
);
assert.ok(baselineTreeCall);
const baselineTreeBody = JSON.parse(baselineTreeCall.body);
assert.equal(baselineTreeBody.tree.length, 1);
assert.equal(baselineTreeBody.tree[0].path, "profiles/.baseline");
assert.notEqual(baselineTreeBody.tree[0].sha, null);
const baselinePullCall = baselineCalls.find(
  (call) => call.method === "POST" && call.path === "/pulls"
);
assert.match(JSON.parse(baselinePullCall.body).body, /基准 Profile/);

const deleteCallStart = profileCalls.length;
const deletedProfilePr = await profileClient.deleteProfilePullRequest(
  "ghu_profile",
  "acme",
  "router",
  "deletable",
  { baseRefSha: profileBaseSha }
);
assert.equal(deletedProfilePr.action, "delete");
assert.equal(deletedProfilePr.changedFiles.length, 7);
assert.equal(deletedProfilePr.pullRequest.number, 17);
assert.equal(deletedProfilePr.pullRequest.merged, true);
const deleteCalls = profileCalls.slice(deleteCallStart);
const deleteTreeCall = deleteCalls.find(
  (call) => call.method === "POST" && call.path === "/git/trees"
);
assert.ok(deleteTreeCall);
const deleteTreeBody = JSON.parse(deleteTreeCall.body);
assert.equal(deleteTreeBody.tree.length, 7);
assert.ok(deleteTreeBody.tree.every((entry) => entry.sha === null));
assert.ok(
  deleteTreeBody.tree.every((entry) =>
    entry.path.startsWith("profiles/deletable/")
  )
);
assert.equal(
  deleteCalls.some((call) => call.method === "POST" && call.path === "/git/blobs"),
  false
);
const deletePullCall = deleteCalls.find(
  (call) => call.method === "POST" && call.path === "/pulls"
);
assert.match(JSON.parse(deletePullCall.body).body, /删除标准 Profile 文件/);

await assert.rejects(
  () =>
    profileClient.deleteProfilePullRequest(
      "ghu_profile",
      "acme",
      "router",
      "default",
      { baseRefSha: profileBaseSha }
    ),
  (error) => {
    assert.equal(error.code, "protected_profile");
    assert.equal(error.status, 409);
    return true;
  }
);

const deletedProfileCommitSha = "7".repeat(40);
const deletedProfileParentSha = "6".repeat(40);
const retiredSnapshot = {
  ...profileFileContents,
  ".config": "CONFIG_RETIRED_SNAPSHOT=y\n",
  "profile.env":
    "PROFILE_NAME=\"Retired Snapshot\"\n" +
    "CONFIG_FILE=\"profiles/retired/.config\"\n" +
    "DIY_PART1=\"profiles/retired/diy-part1.sh\"\n"
};
const restoreCalls = [];
const restoreClient = new GitHubAppClient(
  {
    clientId: "Iv1.profile-restore",
    clientSecret: "profile-restore-secret",
    redirectUri: "https://example.test/api/v1/auth/callback"
  },
  async (url, options = {}) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname.replace(/^\/repos\/acme\/router/, "");
    const method = String(options.method || "GET").toUpperCase();
    restoreCalls.push({ path, method, body: options.body || "", search: parsed.search });

    if (
      method === "GET" &&
      path === "/commits" &&
      parsed.searchParams.get("per_page") === "100"
    ) {
      return Response.json([
        {
          sha: deletedProfileCommitSha,
          html_url:
            "https://github.com/acme/router/commit/" + deletedProfileCommitSha,
          commit: {
            message: "profile(retired): delete via Control Plane (#99)\n\nAudit",
            committer: { date: "2026-10-04T10:00:00Z" },
            author: { date: "2026-10-04T09:59:00Z" }
          }
        },
        {
          sha: "5".repeat(40),
          html_url: "https://github.com/acme/router/commit/" + "5".repeat(40),
          commit: {
            message: "profile(deletable): delete via Control Plane",
            committer: { date: "2026-10-03T10:00:00Z" }
          }
        }
      ]);
    }

    if (
      method === "GET" &&
      path === "/contents/profiles/retired" &&
      parsed.searchParams.get("ref") === profileBaseSha
    ) {
      return Response.json({ message: "Not Found" }, { status: 404 });
    }

    if (
      method === "GET" &&
      path === "/commits/" + deletedProfileCommitSha
    ) {
      return Response.json({
        sha: deletedProfileCommitSha,
        commit: {
          message: "profile(retired): delete via Control Plane (#99)\n\nAudit"
        },
        parents: [{ sha: deletedProfileParentSha }]
      });
    }
    if (
      method === "GET" &&
      path === "/commits/" + "4".repeat(40)
    ) {
      return Response.json({
        sha: "4".repeat(40),
        commit: {
          message: "profile(someone-else): delete via Control Plane"
        },
        parents: [{ sha: "3".repeat(40) }]
      });
    }

    if (
      method === "GET" &&
      path.startsWith("/contents/profiles/retired/") &&
      parsed.searchParams.get("ref") === deletedProfileParentSha
    ) {
      const name = decodeURIComponent(
        path.slice("/contents/profiles/retired/".length)
      );
      if (!Object.hasOwn(retiredSnapshot, name)) {
        return Response.json({ message: "Not Found" }, { status: 404 });
      }
      return Response.json({
        type: "file",
        name,
        path: "profiles/retired/" + name,
        sha: "retired-" + name,
        encoding: "base64",
        content: Buffer.from(retiredSnapshot[name], "utf8").toString("base64")
      });
    }

    return profileFetch(url, options);
  }
);

const deletedProfiles = await restoreClient.listDeletedProfiles(
  "ghu_profile",
  "acme",
  "router",
  { limit: 10 }
);
assert.deepEqual(
  deletedProfiles.map((item) => item.id),
  ["retired"]
);
assert.equal(
  deletedProfiles[0].deletionCommitSha,
  deletedProfileCommitSha
);
assert.equal(
  deletedProfiles[0].deletedAt,
  "2026-10-04T10:00:00Z"
);

const restoreCallStart = restoreCalls.length;
const restoredProfilePr = await restoreClient.restoreDeletedProfilePullRequest(
  "ghu_profile",
  "acme",
  "router",
  "retired",
  { deletionCommitSha: deletedProfileCommitSha }
);
assert.equal(restoredProfilePr.action, "restore");
assert.equal(restoredProfilePr.changedFiles.length, 7);
assert.equal(restoredProfilePr.pullRequest.merged, true);
const restoreMutationCalls = restoreCalls.slice(restoreCallStart);
assert.ok(
  restoreMutationCalls.some((call) =>
    call.method === "GET" &&
    call.path ===
      "/contents/profiles/retired/.config" &&
    call.search.includes(encodeURIComponent(deletedProfileParentSha))
  ),
  "恢复必须读取删除 commit 的父提交快照"
);
assert.ok(
  restoreMutationCalls
    .filter((call) => call.method === "POST" && call.path === "/git/blobs")
    .map((call) => JSON.parse(call.body).content)
    .includes("CONFIG_RETIRED_SNAPSHOT=y\n"),
  "恢复写入内容必须来自删除前快照"
);
const restoreTreeCall = restoreMutationCalls.find(
  (call) => call.method === "POST" && call.path === "/git/trees"
);
assert.ok(restoreTreeCall);
const restoreTree = JSON.parse(restoreTreeCall.body).tree;
assert.equal(
  restoreTree.filter((entry) =>
    entry.path.startsWith("profiles/retired/") && entry.sha !== null
  ).length,
  7
);

await assert.rejects(
  () =>
    restoreClient.restoreDeletedProfilePullRequest(
      "ghu_profile",
      "acme",
      "router",
      "retired",
      { deletionCommitSha: "4".repeat(40) }
    ),
  (error) => {
    assert.equal(error.code, "deletion_commit_mismatch");
    assert.equal(error.status, 409);
    return true;
  }
);

const switchedBaselineClient = new GitHubAppClient(
  {
    clientId: "Iv1.profile-switched-baseline",
    clientSecret: "profile-switched-baseline-secret",
    redirectUri: "https://example.test/api/v1/auth/callback"
  },
  async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (
      String(options.method || "GET").toUpperCase() === "GET" &&
      parsed.pathname === "/repos/acme/router/contents/profiles/.baseline" &&
      parsed.searchParams.get("ref") === "main"
    ) {
      return Response.json({
        type: "file",
        name: ".baseline",
        path: "profiles/.baseline",
        sha: "baseline-switched",
        encoding: "base64",
        content: Buffer.from("deletable\n", "utf8").toString("base64")
      });
    }
    return profileFetch(url, options);
  }
);

const deleteFormerBaseline = await switchedBaselineClient.deleteProfilePullRequest(
  "ghu_profile",
  "acme",
  "router",
  "default",
  { baseRefSha: profileBaseSha }
);
assert.equal(deleteFormerBaseline.action, "delete");
assert.equal(deleteFormerBaseline.pullRequest.merged, true);

await assert.rejects(
  () =>
    switchedBaselineClient.deleteProfilePullRequest(
      "ghu_profile",
      "acme",
      "router",
      "deletable",
      { baseRefSha: profileBaseSha }
    ),
  (error) => {
    assert.equal(error.code, "protected_profile");
    assert.equal(error.status, 409);
    return true;
  }
);

const busyDeleteClient = new GitHubAppClient(
  {
    clientId: "Iv1.profile-busy-delete",
    clientSecret: "profile-busy-delete-secret",
    redirectUri: "https://example.test/api/v1/auth/callback"
  },
  async (url, options = {}) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname.replace(/^\/repos\/acme\/router/, "");
    const method = String(options.method || "GET").toUpperCase();
    if (
      method === "GET" &&
      path === "/actions/workflows/build-openwrt.yml/runs"
    ) {
      return Response.json({
        workflow_runs: [{
          id: 99,
          run_number: 12,
          display_title: "Build · deletable · cp:test",
          status: "in_progress",
          conclusion: null,
          event: "workflow_dispatch",
          head_branch: "main",
          head_sha: profileBaseSha,
          created_at: "2026-10-04T09:36:21Z",
          updated_at: "2026-10-04T09:36:34Z",
          html_url: "https://github.com/acme/router/actions/runs/99"
        }]
      });
    }
    return profileFetch(url, options);
  }
);
await assert.rejects(
  () =>
    busyDeleteClient.deleteProfilePullRequest(
      "ghu_profile",
      "acme",
      "router",
      "deletable",
      { baseRefSha: profileBaseSha }
    ),
  (error) => {
    assert.equal(error.code, "profile_build_active");
    assert.equal(error.status, 409);
    return true;
  }
);

await assert.rejects(
  () =>
    profileClient.createNewProfilePullRequest(
      "ghu_profile",
      "acme",
      "router",
      "exists-profile",
      profileFilesObject(
        buildProfileTemplateFiles({
          ...templateInput,
          profileId: "exists-profile"
        })
      )
    ),
  (error) => {
    assert.equal(error.code, "profile_already_exists");
    assert.equal(error.status, 409);
    return true;
  }
);


let concurrentHeadCalls = 0;
let concurrentWriteCalls = 0;
const concurrentClient = new GitHubAppClient(
  {
    clientId: "Iv1.concurrent",
    clientSecret: "concurrent-secret",
    redirectUri: "https://example.test/api/v1/auth/callback"
  },
  async (url, options = {}) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname.replace(/^\/repos\/acme\/router/, "");
    const method = String(options.method || "GET").toUpperCase();

    if (method === "GET" && path === "") {
      return Response.json({ default_branch: "main" });
    }
    if (method === "GET" && path === "/commits/main") {
      concurrentHeadCalls += 1;
      return Response.json({
        sha:
          concurrentHeadCalls === 1
            ? "1".repeat(40)
            : "2".repeat(40)
      });
    }
    if (
      method === "GET" &&
      path === "/contents/profiles/race-profile" &&
      parsed.searchParams.get("ref") === "1".repeat(40)
    ) {
      return Response.json({ message: "Not Found" }, { status: 404 });
    }

    if (method !== "GET") concurrentWriteCalls += 1;
    return Response.json({ message: "unexpected concurrent request" }, { status: 500 });
  }
);

await assert.rejects(
  () =>
    concurrentClient.createNewProfilePullRequest(
      "ghu_profile",
      "acme",
      "router",
      "race-profile",
      profileFilesObject(
        buildProfileTemplateFiles({
          ...templateInput,
          profileId: "race-profile"
        })
      )
    ),
  (error) => {
    assert.equal(error.code, "repository_changed");
    assert.equal(error.status, 409);
    return true;
  }
);
assert.equal(concurrentWriteCalls, 0);

assert.match(createdProfilePr.branch, /^openwrt-ng\/profile-default-/);
assert.ok(
  profileCalls.some((call) =>
    call.method === "POST" && call.path === "/git/trees"
  )
);
assert.ok(
  profileCalls.some((call) =>
    call.method === "POST" && call.path === "/pulls"
  )
);
assert.ok(
  profileCalls.some((call) =>
    call.method === "PUT" && call.path === "/pulls/17/merge"
  )
);
assert.ok(
  profileCalls.some((call) =>
    call.method === "PATCH" && call.path === "/pulls/9"
  )
);
assert.ok(
  profileCalls.some((call) =>
    call.method === "DELETE" &&
    call.path.startsWith("/git/refs/heads/openwrt-ng/profile-default-")
  )
);

const deleteCallsBeforeBlockedMerge = profileCalls.filter(
  (call) => call.method === "DELETE"
).length;
const blockedMergeClient = new GitHubAppClient(
  {
    clientId: "Iv1.profile-blocked",
    clientSecret: "profile-blocked-secret",
    redirectUri: "https://example.test/api/v1/auth/callback"
  },
  async (url, options = {}) => {
    const parsed = new URL(String(url));
    const method = String(options.method || "GET").toUpperCase();
    if (
      method === "PUT" &&
      parsed.pathname === "/repos/acme/router/pulls/17/merge"
    ) {
      return Response.json(
        { message: "Merge cannot be performed" },
        { status: 405 }
      );
    }
    return profileFetch(url, options);
  }
);
const blockedProfilePr = await blockedMergeClient.createProfilePullRequest(
  "ghu_profile",
  "acme",
  "router",
  "default",
  {
    baseRefSha: profileBaseSha,
    files: changedProfileFiles
  }
);
assert.equal(blockedProfilePr.pullRequest.merged, false);
assert.equal(blockedProfilePr.pullRequest.mergeReason, "github_http_405");
assert.equal(blockedProfilePr.cleanup.branchDeleted, false);
assert.equal(blockedProfilePr.cleanup.supersededPullRequests.length, 0);
assert.equal(
  profileCalls.filter((call) => call.method === "DELETE").length,
  deleteCallsBeforeBlockedMerge
);

await assert.rejects(
  () =>
    profileClient.createProfilePullRequest(
      "ghu_profile",
      "acme",
      "router",
      "default",
      {
        baseRefSha: "c".repeat(40),
        files: changedProfileFiles
      }
    ),
  (error) => {
    assert.equal(error.code, "repository_changed");
    assert.equal(error.status, 409);
    return true;
  }
);


const builderCalls = [];
const builderFetch = async (url, options = {}) => {
  const parsed = new URL(String(url));
  const path = parsed.pathname.replace(/^\/repos\/acme\/router/, "");
  const method = String(options.method || "GET").toUpperCase();
  builderCalls.push({ path, method, body: options.body || "" });

  if (method === "GET" && path === "") {
    return Response.json({ default_branch: "main" });
  }
  if (method === "GET" && path === "/commits/main") {
    return Response.json({ sha: "d".repeat(40) });
  }
  if (
    method === "GET" &&
    path === "/contents/profiles/default" &&
    parsed.searchParams.get("ref") === "main"
  ) {
    return Response.json([{ type: "file", name: ".config" }]);
  }
  if (
    method === "GET" &&
    path === "/actions/workflows/build-openwrt.yml/runs"
  ) {
    return Response.json({ workflow_runs: [] });
  }
  if (
    method === "POST" &&
    path === "/actions/workflows/build-openwrt.yml/dispatches"
  ) {
    const body = JSON.parse(options.body);
    assert.equal(body.ref, "main");
    assert.equal(body.return_run_details, true);
    assert.equal(body.inputs.profile, "default");
    assert.equal(body.inputs.publish_release, false);
    assert.match(body.inputs.control_plane_request_id, /^[0-9a-f]{16}$/);
    return Response.json({
      workflow_run_id: 123,
      run_url: "https://api.github.com/repos/acme/router/actions/runs/123",
      html_url: "https://github.com/acme/router/actions/runs/123"
    });
  }
  if (method === "GET" && path === "/actions/runs/123") {
    return Response.json({
      id: 123,
      run_number: 9,
      run_attempt: 1,
      display_title: "Build · default · cp:abcdef1234567890",
      status: "completed",
      conclusion: "success",
      event: "workflow_dispatch",
      path: ".github/workflows/build-openwrt.yml",
      head_branch: "main",
      head_sha: "d".repeat(40),
      created_at: "2026-10-02T00:00:00Z",
      updated_at: "2026-10-02T00:10:00Z",
      run_started_at: "2026-10-02T00:00:10Z",
      html_url: "https://github.com/acme/router/actions/runs/123"
    });
  }
  if (method === "POST" && path === "/actions/runs/123/rerun") {
    return new Response(null, { status: 201 });
  }
  if (method === "GET" && path === "/actions/runs/124") {
    return Response.json({
      id: 124,
      run_number: 10,
      run_attempt: 1,
      display_title: "Build · default · cp:0011223344556677",
      status: "in_progress",
      conclusion: null,
      event: "workflow_dispatch",
      path: ".github/workflows/build-openwrt.yml",
      head_branch: "main",
      head_sha: "e".repeat(40),
      created_at: "2026-10-02T01:00:00Z",
      updated_at: "2026-10-02T01:05:00Z",
      run_started_at: "2026-10-02T01:00:10Z",
      html_url: "https://github.com/acme/router/actions/runs/124"
    });
  }
  if (method === "POST" && path === "/actions/runs/124/cancel") {
    return new Response(null, { status: 202 });
  }
  if (method === "GET" && path === "/actions/runs/123/jobs") {
    return Response.json({
      jobs: [{
        id: 1,
        name: "编译 OpenWrt 固件",
        status: "completed",
        conclusion: "success",
        html_url: "https://github.com/acme/router/actions/runs/123/job/1"
      }]
    });
  }
  if (method === "GET" && path === "/actions/runs/123/artifacts") {
    return Response.json({
      artifacts: [{
        id: 77,
        name: "OpenWrt_firmware_default_20261002",
        size_in_bytes: 12345,
        expired: false,
        created_at: "2026-10-02T00:09:00Z",
        expires_at: "2026-11-01T00:09:00Z"
      }]
    });
  }
  if (method === "GET" && path === "/releases") {
    return Response.json([{
      tag_name: "2026.10.02-0810-9",
      name: "2026.10.02-0810-9",
      target_commitish: "d".repeat(40),
      html_url: "https://github.com/acme/router/releases/tag/2026.10.02-0810-9",
      published_at: "2026-10-02T00:10:00Z"
    }]);
  }
  if (method === "GET" && path === "/actions/artifacts/77/zip") {
    return new Response(null, {
      status: 302,
      headers: {
        Location: "https://downloads.example.test/artifacts/77.zip"
      }
    });
  }

  return Response.json({ message: "unexpected builder request " + path }, { status: 500 });
};

const builderClient = new GitHubAppClient(
  {
    clientId: "Iv1.builder",
    clientSecret: "builder-secret",
    redirectUri: "https://example.test/api/v1/auth/callback"
  },
  builderFetch
);
const dispatched = await builderClient.triggerBuilder(
  "ghu_builder",
  "acme",
  "router",
  "default",
  { publishRelease: false }
);
assert.equal(dispatched.accepted, true);
assert.equal(dispatched.ref, "main");
assert.equal(dispatched.runId, 123);
assert.equal(
  dispatched.runUrl,
  "https://github.com/acme/router/actions/runs/123"
);
assert.match(dispatched.requestId, /^[0-9a-f]{16}$/);

const builderDetail = await builderClient.getBuilderRun(
  "ghu_builder",
  "acme",
  "router",
  123
);
assert.equal(builderDetail.conclusion, "success");
assert.equal(builderDetail.artifacts[0].id, 77);
assert.equal(
  builderDetail.artifacts[0].url,
  "https://github.com/acme/router/actions/runs/123/artifacts/77"
);
assert.equal(builderDetail.release.tag, "2026.10.02-0810-9");
assert.equal(builderDetail.summaryUrl, builderDetail.url);

const artifactDownloadUrl = await builderClient.getBuilderArtifactDownloadUrl(
  "ghu_builder",
  "acme",
  "router",
  123,
  77
);
assert.equal(
  artifactDownloadUrl,
  "https://downloads.example.test/artifacts/77.zip"
);

const rerunResult = await builderClient.rerunBuilderRun(
  "ghu_builder",
  "acme",
  "router",
  123
);
assert.equal(rerunResult.accepted, true);
assert.equal(rerunResult.action, "rerun");
assert.equal(rerunResult.nextAttempt, 2);
assert.ok(
  builderCalls.some((call) =>
    call.method === "POST" && call.path === "/actions/runs/123/rerun"
  )
);

const cancelResult = await builderClient.cancelBuilderRun(
  "ghu_builder",
  "acme",
  "router",
  124
);
assert.equal(cancelResult.accepted, true);
assert.equal(cancelResult.action, "cancel");
assert.equal(cancelResult.runId, 124);
assert.ok(
  builderCalls.some((call) =>
    call.method === "POST" && call.path === "/actions/runs/124/cancel"
  )
);

let recoveredReleasePresent = false;
const managedWorkflowCalls = [];
const managedWorkflowFetch = async (url, options = {}) => {
  const parsed = new URL(String(url));
  const path = parsed.pathname.replace(/^\/repos\/acme\/router/, "");
  const method = String(options.method || "GET").toUpperCase();
  managedWorkflowCalls.push({ path, method, body: options.body || "" });

  if (method === "GET" && path === "") {
    return Response.json({ default_branch: "main" });
  }
  if (method === "GET" && path === "/commits/main") {
    return Response.json({ sha: "9".repeat(40) });
  }
  if (method === "GET" && path === "/actions/runs/222") {
    return Response.json({
      id: 222,
      run_number: 18,
      run_attempt: 1,
      display_title: "Build · default · cp:feedfacecafebeef",
      status: "completed",
      conclusion: "failure",
      event: "workflow_dispatch",
      path: ".github/workflows/build-openwrt.yml",
      head_branch: "main",
      head_sha: "8".repeat(40),
      created_at: "2026-10-04T08:00:00Z",
      updated_at: "2026-10-04T09:00:00Z",
      run_started_at: "2026-10-04T08:00:10Z",
      html_url: "https://github.com/acme/router/actions/runs/222"
    });
  }
  if (method === "GET" && path === "/actions/runs/222/jobs") {
    return Response.json({
      jobs: [{
        id: 2201,
        name: "编译 OpenWrt 固件",
        status: "completed",
        conclusion: "success",
        html_url: "https://github.com/acme/router/actions/runs/222/job/2201",
        steps: [{
          name: "编译固件",
          status: "completed",
          conclusion: "success"
        }]
      }]
    });
  }
  if (method === "GET" && path === "/actions/runs/222/artifacts") {
    return Response.json({
      artifacts: [
        {
          id: 880,
          name: "OpenWrt_firmware_default_20261004",
          size_in_bytes: 23456,
          expired: false,
          created_at: "2026-10-04T08:55:00Z",
          expires_at: "2026-11-03T08:55:00Z"
        },
        {
          id: 881,
          name: "OpenWrt_NG_release_bundle_222",
          size_in_bytes: 34567,
          expired: false,
          created_at: "2026-10-04T08:56:00Z",
          expires_at: "2026-10-05T08:56:00Z"
        }
      ]
    });
  }
  if (method === "GET" && path === "/releases") {
    if (!recoveredReleasePresent) return Response.json([]);
    return Response.json([{
      tag_name: "2026.10.04-1910-run18-r77",
      name: "2026.10.04-1910-run18-r77",
      target_commitish: "9".repeat(40),
      body:
        "## 恢复发布\n\n- 原 OpenWrt NG Run: #18\n" +
        "- 原 Run ID: 222\n" +
        "- 原仓库构建 Commit: " + "8".repeat(40),
      html_url:
        "https://github.com/acme/router/releases/tag/2026.10.04-1910-run18-r77",
      published_at: "2026-10-04T11:10:00Z"
    }]);
  }

  if (
    method === "GET" &&
    path === "/actions/workflows/release-existing.yml/runs"
  ) {
    return Response.json({ workflow_runs: [] });
  }
  if (
    method === "POST" &&
    path === "/actions/workflows/release-existing.yml/dispatches"
  ) {
    const body = JSON.parse(options.body);
    assert.equal(body.ref, "main");
    assert.equal(body.return_run_details, true);
    assert.equal(body.inputs.run_id, "222");
    return Response.json({
      workflow_run_id: 333,
      html_url: "https://github.com/acme/router/actions/runs/333"
    });
  }
  if (method === "GET" && path === "/actions/runs/333") {
    return Response.json({
      id: 333,
      run_number: 77,
      run_attempt: 1,
      display_title: "Release Existing · source:222",
      status: "in_progress",
      conclusion: null,
      event: "workflow_dispatch",
      path: ".github/workflows/release-existing.yml",
      head_branch: "main",
      head_sha: "9".repeat(40),
      created_at: "2026-10-04T11:00:00Z",
      updated_at: "2026-10-04T11:01:00Z",
      run_started_at: "2026-10-04T11:00:10Z",
      html_url: "https://github.com/acme/router/actions/runs/333"
    });
  }
  if (method === "GET" && path === "/actions/runs/333/jobs") {
    return Response.json({
      jobs: [{
        id: 3301,
        name: "发布已有构建",
        status: "in_progress",
        conclusion: null,
        html_url: "https://github.com/acme/router/actions/runs/333/job/3301",
        steps: [
          { name: "Set up job", status: "completed", conclusion: "success" },
          { name: "校验来源 Run", status: "completed", conclusion: "success" },
          { name: "下载 Release 交接包", status: "in_progress", conclusion: null },
          { name: "发布 Release", status: "pending", conclusion: null }
        ]
      }]
    });
  }

  if (
    method === "GET" &&
    path === "/actions/workflows/update-checker.yml/runs"
  ) {
    return Response.json({ workflow_runs: [] });
  }
  if (
    method === "POST" &&
    path === "/actions/workflows/update-checker.yml/dispatches"
  ) {
    const body = JSON.parse(options.body);
    assert.equal(body.ref, "main");
    assert.equal(body.return_run_details, true);
    assert.equal(body.inputs.profile, "");
    assert.equal(body.inputs.force, true);
    return Response.json({
      workflow_run_id: 444,
      html_url: "https://github.com/acme/router/actions/runs/444"
    });
  }
  if (method === "GET" && path === "/actions/runs/444") {
    return Response.json({
      id: 444,
      run_number: 31,
      run_attempt: 1,
      display_title: "Update Checker · profile: · force:true",
      status: "in_progress",
      conclusion: null,
      event: "workflow_dispatch",
      path: ".github/workflows/update-checker.yml",
      head_branch: "main",
      head_sha: "9".repeat(40),
      created_at: "2026-10-04T11:02:00Z",
      updated_at: "2026-10-04T11:03:00Z",
      run_started_at: "2026-10-04T11:02:10Z",
      html_url: "https://github.com/acme/router/actions/runs/444"
    });
  }
  if (method === "GET" && path === "/actions/runs/444/jobs") {
    return Response.json({
      jobs: [{
        id: 4401,
        name: "检查上游状态",
        status: "in_progress",
        conclusion: null,
        html_url: "https://github.com/acme/router/actions/runs/444/job/4401",
        steps: [
          { name: "Set up job", status: "completed", conclusion: "success" },
          { name: "发现需要检查的 Profile", status: "completed", conclusion: "success" },
          { name: "比较上游状态", status: "in_progress", conclusion: null }
        ]
      }]
    });
  }

  return Response.json(
    { message: "unexpected managed workflow request " + path },
    { status: 500 }
  );
};

const managedWorkflowClient = new GitHubAppClient(
  {
    clientId: "Iv1.managed-workflows",
    clientSecret: "managed-workflows-secret",
    redirectUri: "https://example.test/api/v1/auth/callback"
  },
  managedWorkflowFetch
);

const releasableBuild = await managedWorkflowClient.getBuilderRun(
  "ghu_managed",
  "acme",
  "router",
  222
);
assert.equal(releasableBuild.release, null);
assert.equal(releasableBuild.releaseRecoveryEligible, true);
assert.equal(releasableBuild.releaseRecoveryReason, "");

const releaseDispatch = await managedWorkflowClient.triggerReleaseExisting(
  "ghu_managed",
  "acme",
  "router",
  222
);
assert.equal(releaseDispatch.accepted, true);
assert.equal(releaseDispatch.sourceRunId, 222);
assert.equal(releaseDispatch.runId, 333);

const releaseExistingRun = await managedWorkflowClient.getReleaseExistingRun(
  "ghu_managed",
  "acme",
  "router",
  333
);
assert.equal(releaseExistingRun.displayTitle, "Release Existing · source:222");
assert.equal(releaseExistingRun.progress?.current, "下载 Release 交接包");
assert.equal(releaseExistingRun.progress?.completed, 1);

const updateDispatch = await managedWorkflowClient.triggerUpdateChecker(
  "ghu_managed",
  "acme",
  "router",
  { profileId: "", force: true }
);
assert.equal(updateDispatch.accepted, true);
assert.equal(updateDispatch.profileId, "");
assert.equal(updateDispatch.force, true);
assert.equal(updateDispatch.runId, 444);

const updateRun = await managedWorkflowClient.getUpdateCheckerRun(
  "ghu_managed",
  "acme",
  "router",
  444
);
assert.equal(updateRun.displayTitle, "Update Checker · profile: · force:true");
assert.equal(updateRun.progress?.current, "比较上游状态");
assert.equal(updateRun.progress?.completed, 1);

await assert.rejects(
  () =>
    managedWorkflowClient.getReleaseExistingRun(
      "ghu_managed",
      "acme",
      "router",
      444
    ),
  (error) => {
    assert.equal(error.code, "unexpected_workflow_run");
    assert.equal(error.status, 404);
    return true;
  }
);

recoveredReleasePresent = true;
const recoveredBuild = await managedWorkflowClient.getBuilderRun(
  "ghu_managed",
  "acme",
  "router",
  222
);
assert.equal(recoveredBuild.release?.recovered, true);
assert.equal(recoveredBuild.releaseRecoveryEligible, false);
assert.equal(recoveredBuild.releaseRecoveryReason, "release_already_exists");

const calls = [];
const fakeFetch = async (url, options = {}) => {
  calls.push({ url: String(url), options });

  if (String(url).endsWith("/login/oauth/access_token")) {
    return new Response(
      JSON.stringify({
        access_token: "ghu_test_access",
        expires_in: 28_800,
        refresh_token: "ghr_test_refresh",
        refresh_token_expires_in: 15_552_000
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" }
      }
    );
  }

  if (String(url).endsWith("/user")) {
    return Response.json({
      login: "tester",
      avatar_url: "https://avatars.githubusercontent.com/u/1?v=4"
    });
  }

  if (String(url).includes("/user/installations?")) {
    return Response.json({
      installations: [
        {
          id: 101,
          permissions: {
            contents: "write",
            pull_requests: "write",
            actions: "write"
          }
        }
      ]
    });
  }

  if (String(url).includes("/user/installations/101/repositories?")) {
    return Response.json({
      repositories: [
        {
          name: "router",
          full_name: "acme/router",
          private: false,
          default_branch: "main",
          owner: { login: "acme" }
        }
      ]
    });
  }

  if (String(url).includes("/repos/acme/router/contents/profiles/.baseline?ref=main")) {
    return Response.json({
      type: "file",
      name: ".baseline",
      path: "profiles/.baseline",
      sha: "baseline-server",
      encoding: "base64",
      content: Buffer.from("default\n", "utf8").toString("base64")
    });
  }

  if (String(url).includes("/repos/acme/router/contents/profiles?ref=main")) {
    return Response.json([
      { type: "dir", name: "default", path: "profiles/default", sha: "abc" },
      { type: "file", name: "README.md", path: "profiles/README.md", sha: "def" }
    ]);
  }

  const parsed = new URL(String(url));
  const path = parsed.pathname;

  if (
    parsed?.pathname === "/repos/acme/router/contents/profiles/new-profile" &&
    parsed.searchParams.get("ref") === "d".repeat(40)
  ) {
    return Response.json({ message: "Not Found" }, { status: 404 });
  }

  if (
    parsed?.pathname === "/repos/acme/router/git/commits/" + "d".repeat(40) &&
    String(options.method || "GET").toUpperCase() === "GET"
  ) {
    return Response.json({
      sha: "d".repeat(40),
      tree: { sha: "server-base-tree" }
    });
  }

  if (
    parsed?.pathname === "/repos/acme/router/git/blobs" &&
    String(options.method || "GET").toUpperCase() === "POST"
  ) {
    return Response.json({ sha: "blob-server-test" }, { status: 201 });
  }

  if (
    parsed?.pathname === "/repos/acme/router/git/trees" &&
    String(options.method || "GET").toUpperCase() === "POST"
  ) {
    return Response.json({ sha: "server-new-tree" }, { status: 201 });
  }

  if (
    parsed?.pathname === "/repos/acme/router/git/commits" &&
    String(options.method || "GET").toUpperCase() === "POST"
  ) {
    return Response.json({ sha: "e".repeat(40) }, { status: 201 });
  }

  if (
    parsed?.pathname === "/repos/acme/router/git/refs" &&
    String(options.method || "GET").toUpperCase() === "POST"
  ) {
    return Response.json({ ref: "refs/heads/openwrt-ng/profile-new-profile-test" }, { status: 201 });
  }

  if (
    parsed?.pathname === "/repos/acme/router/pulls" &&
    String(options.method || "GET").toUpperCase() === "POST"
  ) {
    return Response.json({
      number: 18,
      html_url: "https://github.com/acme/router/pull/18"
    }, { status: 201 });
  }

  if (path === "/repos/acme/router") {
    return Response.json({ default_branch: "main" });
  }

  if (path === "/repos/acme/router/commits/main") {
    return Response.json({ sha: "d".repeat(40) });
  }

  if (
    path === "/repos/acme/router/contents/profiles/default" &&
    parsed.searchParams.get("ref") === "main"
  ) {
    return Response.json([{ type: "file", name: ".config" }]);
  }

  if (
    path === "/repos/acme/router/actions/workflows/build-openwrt.yml/runs"
  ) {
    return Response.json({
      workflow_runs: [{
        id: 123,
        run_number: 9,
        display_title: "Build · default · cp:abcdef1234567890",
        status: "completed",
        conclusion: "success",
        event: "workflow_dispatch",
        head_branch: "main",
        head_sha: "d".repeat(40),
        created_at: "2026-10-02T00:00:00Z",
        updated_at: "2026-10-02T00:10:00Z",
        html_url: "https://github.com/acme/router/actions/runs/123"
      }]
    });
  }

  if (
    path === "/repos/acme/router/actions/workflows/build-openwrt.yml/dispatches" &&
    String(options.method || "GET").toUpperCase() === "POST"
  ) {
    return new Response(null, { status: 204 });
  }

  if (path === "/repos/acme/router/actions/runs/123") {
    return Response.json({
      id: 123,
      run_number: 9,
      run_attempt: 1,
      display_title: "Build · default · cp:abcdef1234567890",
      status: "completed",
      conclusion: "success",
      event: "workflow_dispatch",
      path: ".github/workflows/build-openwrt.yml",
      head_branch: "main",
      head_sha: "d".repeat(40),
      created_at: "2026-10-02T00:00:00Z",
      updated_at: "2026-10-02T00:10:00Z",
      run_started_at: "2026-10-02T00:00:10Z",
      html_url: "https://github.com/acme/router/actions/runs/123"
    });
  }

  if (path === "/repos/acme/router/actions/runs/123/jobs") {
    return Response.json({ jobs: [] });
  }

  if (path === "/repos/acme/router/actions/runs/123/artifacts") {
    return Response.json({
      artifacts: [{
        id: 77,
        name: "OpenWrt_firmware_default_20261002",
        size_in_bytes: 12345,
        expired: false,
        created_at: "2026-10-02T00:09:00Z",
        expires_at: "2026-11-01T00:09:00Z"
      }]
    });
  }

  if (path === "/repos/acme/router/actions/artifacts/77/zip") {
    return new Response(null, {
      status: 302,
      headers: {
        Location: "https://downloads.example.test/self-hosted/77.zip"
      }
    });
  }

  if (path === "/repos/acme/router/releases") {
    return Response.json([]);
  }

  throw new Error("Unexpected fake GitHub request: " + url);
};

const config = {
  origin: "http://127.0.0.1",
  secureCookie: false,
  clientId: "Iv1.test",
  clientSecret: "client-secret",
  encryptionSecret: secret,
  sessionTtlMs: 3600_000,
  sessionIdleTtlMs: 900_000,
  githubAppSlug: "openwrt-ng-test",
  apiVersion: "2022-11-28"
};

const github = new GitHubAppClient(
  {
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.origin + "/api/v1/auth/callback",
    apiVersion: config.apiVersion
  },
  fakeFetch
);

const handler = createControlPlaneHandler({ config, store, github });
const server = createServer(handler);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const base = `http://127.0.0.1:${address.port}`;

try {
  const health = await fetch(base + "/api/v1/health");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    ok: true,
    version: 1,
    runtime: "self-hosted-node",
    configured: true
  });

  const publicConfig = await fetch(base + "/api/v1/config");
  assert.deepEqual(await publicConfig.json(), {
    configured: true,
    profileMergePolicy: "immediate",
    githubAppInstallUrl:
      "https://github.com/apps/openwrt-ng-test/installations/new"
  });

  const csrfStart = await fetch(base + "/api/v1/auth/start?return_to=/", {
    redirect: "manual"
  });
  const csrfAuthorize = new URL(csrfStart.headers.get("location"));
  const csrfState = csrfAuthorize.searchParams.get("state");
  const csrfCallback = await fetch(
    base +
      "/api/v1/auth/callback?code=test-code&state=" +
      encodeURIComponent(csrfState),
    { redirect: "manual" }
  );
  assert.equal(csrfCallback.status, 400);
  assert.deepEqual(await csrfCallback.json(), {
    error: "missing_oauth_browser_binding"
  });

  const start = await fetch(base + "/api/v1/auth/start?return_to=/", {
    redirect: "manual"
  });
  assert.equal(start.status, 302);
  const authorize = new URL(start.headers.get("location"));
  assert.equal(authorize.hostname, "github.com");
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  const state = authorize.searchParams.get("state");
  assert.ok(state);
  const oauthSetCookie = start.headers.get("set-cookie");
  assert.match(oauthSetCookie, /ong_oauth=/);
  assert.match(oauthSetCookie, /HttpOnly/);
  const oauthCookie = oauthSetCookie.split(";", 1)[0];

  const callback = await fetch(
    base +
      "/api/v1/auth/callback?code=test-code&state=" +
      encodeURIComponent(state),
    {
      redirect: "manual",
      headers: { Cookie: oauthCookie }
    }
  );
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("location"), "/");
  const setCookies =
    typeof callback.headers.getSetCookie === "function"
      ? callback.headers.getSetCookie()
      : [callback.headers.get("set-cookie")].filter(Boolean);
  const sessionSetCookie = setCookies.find((value) =>
    value.startsWith("ong_session=")
  );
  assert.ok(sessionSetCookie);
  assert.match(sessionSetCookie, /HttpOnly/);
  assert.doesNotMatch(
    setCookies.join("\n"),
    /ghu_test_access|ghr_test_refresh/
  );
  const cookie = sessionSetCookie.split(";", 1)[0];

  const session = await fetch(base + "/api/v1/session", {
    headers: { Cookie: cookie }
  });
  const sessionBody = await session.json();
  assert.equal(sessionBody.authenticated, true);
  assert.equal(sessionBody.user.login, "tester");
  assert.equal(
    sessionBody.user.avatarUrl,
    "https://avatars.githubusercontent.com/u/1?v=4"
  );
  assert.equal(JSON.stringify(sessionBody).includes("ghu_"), false);
  assert.equal(JSON.stringify(sessionBody).includes("ghr_"), false);

  const repos = await fetch(base + "/api/v1/repositories", {
    headers: { Cookie: cookie }
  });
  const reposBody = await repos.json();
  assert.equal(reposBody.repositories.length, 1);
  assert.equal(reposBody.repositories[0].fullName, "acme/router");
  assert.equal(reposBody.repositories[0].permissions.contents, "write");
  assert.equal(reposBody.repositories[0].permissions.pullRequests, "write");
  assert.equal(reposBody.repositories[0].permissions.actions, "write");
  assert.equal("installationId" in reposBody.repositories[0], false);

  const profiles = await fetch(
    base + "/api/v1/repositories/acme/router/profiles",
    { headers: { Cookie: cookie } }
  );
  const profilesBody = await profiles.json();
  assert.equal(profilesBody.baselineProfileId, "default");
  assert.deepEqual(profilesBody.profiles, [
    { id: "default", path: "profiles/default", sha: "abc", baseline: true }
  ]);

  const previewProfileTemplate = await fetch(
    base + "/api/v1/profile-templates/preview",
    {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: "http://127.0.0.1",
        "X-OpenWrt-NG-CSRF": "1",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(templateInput)
    }
  );
  assert.equal(previewProfileTemplate.status, 200);
  const previewProfileTemplateBody = await previewProfileTemplate.json();
  assert.equal(previewProfileTemplateBody.files.length, 7);

  const createProfileResponse = await fetch(
    base + "/api/v1/repositories/acme/router/profiles",
    {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: "http://127.0.0.1",
        "X-OpenWrt-NG-CSRF": "1",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(templateInput)
    }
  );
  assert.equal(createProfileResponse.status, 201);
  const createProfileResponseBody = await createProfileResponse.json();
  assert.equal(createProfileResponseBody.profileId, "new-profile");
  assert.equal(createProfileResponseBody.pullRequest.number, 18);

  const builds = await fetch(
    base + "/api/v1/repositories/acme/router/builds?profile=default",
    { headers: { Cookie: cookie } }
  );
  assert.equal(builds.status, 200);
  assert.equal((await builds.json()).runs[0].id, 123);

  const buildDetail = await fetch(
    base + "/api/v1/repositories/acme/router/builds/123",
    { headers: { Cookie: cookie } }
  );
  assert.equal(buildDetail.status, 200);
  assert.equal((await buildDetail.json()).run.id, 123);

  const artifactDownload = await fetch(
    base + "/api/v1/repositories/acme/router/builds/123/artifacts/77/download",
    {
      headers: { Cookie: cookie },
      redirect: "manual"
    }
  );
  assert.equal(artifactDownload.status, 302);
  assert.equal(
    artifactDownload.headers.get("location"),
    "https://downloads.example.test/self-hosted/77.zip"
  );

  const trigger = await fetch(
    base + "/api/v1/repositories/acme/router/profiles/default/builds",
    {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: "http://127.0.0.1",
        "X-OpenWrt-NG-CSRF": "1",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ publishRelease: false })
    }
  );
  assert.equal(trigger.status, 202);
  assert.equal((await trigger.json()).accepted, true);

  const logout = await fetch(base + "/api/v1/logout", {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: "http://127.0.0.1",
      "X-OpenWrt-NG-CSRF": "1"
    }
  });
  assert.equal(logout.status, 204);

  const afterLogout = await fetch(base + "/api/v1/session", {
    headers: { Cookie: cookie }
  });
  assert.deepEqual(await afterLogout.json(), { authenticated: false });

  const idleStore = new ControlPlaneStore(":memory:", secret);
  idleStore.createSession({
    sessionHash: hashOpaque("idle"),
    userLogin: "idle-user",
    avatarUrl: "",
    accessToken: "ghu_idle",
    refreshToken: "",
    githubExpiresAt: 0,
    refreshExpiresAt: 0,
    sessionExpiresAt: Date.now() + 60_000,
    now: Date.now() - 10_000
  });
  assert.equal(
    idleStore.getSession(hashOpaque("idle"), Date.now(), 5_000),
    null
  );
  idleStore.close();

  assert.ok(
    calls.some((call) =>
      call.url.includes("/user/installations/101/repositories")
    )
  );

  console.log("Control Plane server tests passed.");
} finally {
  await new Promise((resolve) => server.close(resolve));
  store.close();
}
