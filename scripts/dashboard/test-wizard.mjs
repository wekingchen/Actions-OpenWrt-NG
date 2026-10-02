import { writeFile } from "node:fs/promises";
import { buildProfileFiles, createZipBytes } from "../../dashboard/assets/wizard-core.js";

const input = {
  profileId: "test-profile",
  profileName: "Test Profile",
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
  watchSources: "packages|https://github.com/openwrt/packages|master"
};

const files = buildProfileFiles(input);
if (files.length !== 6) throw new Error(`expected 6 files, got ${files.length}`);
const env = files.find((file) => file.path.endsWith("/profile.env"))?.text || "";
for (const needle of [
  "PROFILE_NAME='Test Profile'",
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
await writeFile("/tmp/openwrt-ng-profile-test.zip", zip);
console.log(`Wizard test OK: files=${files.length} zip_bytes=${zip.length}`);
