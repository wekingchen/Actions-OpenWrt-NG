import { writeFile } from "node:fs/promises";
import { buildProfileFiles, createZipBytes } from "../../dashboard/assets/wizard-core.js";

const input = {
  profileId: "test-profile",
  profileName: "Test Profile O'Reilly",
  sourceRepo: "https://github.com/openwrt/openwrt",
  sourceBranch: "main",
  adapter: "direct-openwrt",
  configText: "CONFIG_TARGET_x86=y\nCONFIG_TARGET_x86_64=y\n",
  autoUpdate: true,
  uploadRelease: true,
  uploadFirmware: true,
  maximizeSpace: false,
  streamLog: true,
  requiredPackages: "curl\nluci\n",
  watchSources: "packages|https://github.com/openwrt/packages|master",
  extraFeeds: "src-git --force helloworld https://github.com/fw876/helloworld.git"
};

const files = buildProfileFiles(input);
if (files.length !== 7) throw new Error(`expected 7 files, got ${files.length}`);
const feeds = files.find((file) => file.path.endsWith("/feeds.conf"))?.text || "";
if (!feeds.includes("src-git --force helloworld ")) {
  throw new Error("feeds.conf missing forced helloworld");
}
const env = files.find((file) => file.path.endsWith("/profile.env"))?.text || "";
for (const needle of [
  "PROFILE_NAME='Test Profile O'\"'\"'Reilly'",
  "AUTO_UPDATE='true'",
  "UPLOAD_RELEASE='true'",
  "profiles/test-profile/.config"
]) {
  if (!env.includes(needle)) throw new Error(`profile.env missing: ${needle}`);
}

const zip = createZipBytes(files);
if (zip.length < 100) throw new Error("ZIP unexpectedly small");
if (zip[0] !== 0x50 || zip[1] !== 0x4b || zip[2] !== 0x03 || zip[3] !== 0x04) {
  throw new Error("invalid ZIP local header");
}
const output = process.argv[2] || "/tmp/openwrt-ng-profile-test.zip";
await writeFile(output, zip);
console.log(`Wizard test OK: files=${files.length} zip_bytes=${zip.length} output=${output}`);

const duplicateLabel = { ...input, watchSources: "source|https://github.com/openwrt/packages|master" };
let duplicateRejected = false;
try {
  buildProfileFiles(duplicateLabel);
} catch (error) {
  duplicateRejected = String(error.message).includes("label 重复");
}
if (!duplicateRejected) throw new Error("reserved watch label 'source' was not rejected");

const invalidPackage = { ...input, requiredPackages: "curl bad package" };
let packageRejected = false;
try {
  buildProfileFiles(invalidPackage);
} catch (error) {
  packageRejected = String(error.message).includes("Manifest 包名格式不合法");
}
if (!packageRejected) throw new Error("invalid required package was not rejected");

const invalidProfileIds = [".", "..", ".hidden", "-leading", "_leading", "a".repeat(65)];
for (const profileId of invalidProfileIds) {
  let rejected = false;
  try {
    buildProfileFiles({ ...input, profileId });
  } catch (error) {
    rejected = String(error.message).includes("Profile ID");
  }
  if (!rejected) throw new Error(`unsafe Profile ID was not rejected: ${profileId}`);
}

let invalidConfigRejected = false;
try {
  buildProfileFiles({ ...input, configText: "this is not a Kconfig file\n" });
} catch (error) {
  invalidConfigRejected = String(error.message).includes("OpenWrt/Kconfig");
}
if (!invalidConfigRejected) throw new Error("non-Kconfig input was not rejected");
