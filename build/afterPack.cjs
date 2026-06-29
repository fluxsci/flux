// Ad-hoc sign the macOS .app when no Developer ID is configured, so the build
// launches on Apple Silicon (arm64 refuses to run binaries with no/broken
// signature). No-op on Linux/Windows and when real signing (CSC_LINK) is active —
// in that case electron-builder's own signing step handles it.
const { execFileSync } = require("node:child_process");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return; // macOS only
  if (process.env.CSC_LINK) return; // real Developer ID signing path handles it
  const app = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`;
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], {
    stdio: "inherit",
  });
};
