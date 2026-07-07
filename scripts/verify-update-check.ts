// 5.3 — packaged update check. Two parts:
//  1. LOGIC: unit-test the pure decision helpers (electron/updateCheck.cjs) — version
//     comparison + the GitHub-payload → offer decision — without booting Electron.
//  2. SOURCE: assert the wiring that can only run in a packaged app (main handler is
//     packaged-only + throttled; preload/types expose it; Shell gates on the opt-out
//     and toasts; Settings owns the toggle).
//   Run: npx tsx scripts/verify-update-check.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const { versionIsNewer, pickRelease } = require("../electron/updateCheck.cjs");
const read = (p: string) => readFileSync(join(root, p), "utf8");

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error("  FAIL:", msg);
    failures++;
  } else {
    console.log("  ok:", msg);
  }
}

// --- 1. versionIsNewer ---------------------------------------------------------------
console.log("update-check — versionIsNewer (pure):");
assert(versionIsNewer("0.2.0", "0.1.0") === true, "minor bump is newer");
assert(versionIsNewer("0.1.1", "0.1.0") === true, "patch bump is newer");
assert(versionIsNewer("1.0.0", "0.9.9") === true, "major bump beats a high minor/patch");
assert(versionIsNewer("0.1.10", "0.1.9") === true, "components compare numerically, not lexically (10 > 9)");
assert(versionIsNewer("v0.2.0", "0.1.0") === true, "a leading v on the tag is tolerated");
assert(versionIsNewer("0.2.0-beta.1", "0.1.0") === true, "a -prerelease suffix is ignored for the core comparison");
assert(versionIsNewer("0.1.0", "0.1.0") === false, "same version is not newer");
assert(versionIsNewer("0.1.0", "0.2.0") === false, "older is not newer");
assert(versionIsNewer("0.1.0-beta", "0.1.0") === false, "a prerelease of the current core is not offered over the release");
assert(versionIsNewer("garbage", "0.1.0") === false, "unparseable latest reads as 0.0.0 (not newer)");

// --- 2. pickRelease ------------------------------------------------------------------
console.log("\nupdate-check — pickRelease (pure):");
const FB = "https://github.com/kortdriessen/flux/releases/latest";
const newer = pickRelease({ tag_name: "v0.2.0", html_url: "https://example.com/r/0.2.0" }, "0.1.0", FB);
assert(newer?.version === "0.2.0" && newer?.url === "https://example.com/r/0.2.0", "newer release → { version (v-stripped), html_url }");
const viaName = pickRelease({ name: "0.3.0" }, "0.1.0", FB);
assert(viaName?.version === "0.3.0" && viaName?.url === FB, "falls back to name + the fallback URL when tag_name/html_url absent");
assert(pickRelease({ tag_name: "v0.1.0" }, "0.1.0", FB) === null, "current version → null (no offer)");
assert(pickRelease({ tag_name: "v0.0.9" }, "0.1.0", FB) === null, "older release → null");
assert(pickRelease({}, "0.1.0", FB) === null, "no tag/name → null");
assert(pickRelease(null, "0.1.0", FB) === null, "null payload → null (never throws)");

// --- 3. main handler wiring (packaged-only + throttled + uses pickRelease) ------------
console.log("\nupdate-check — main handler (source):");
const main = read("electron/main.cjs");
assert(/ipcMain\.handle\("update:check"/.test(main), "main registers the update:check handler");
assert(/pickRelease\b/.test(main) && /require\("\.\/updateCheck\.cjs"\)/.test(main), "main delegates the decision to updateCheck.cjs (pickRelease)");
assert(/if \(!app\.isPackaged\) return null/.test(main), "handler is packaged-only (dev never self-checks)");
assert(/UPDATE_THROTTLE_MS\b/.test(main) && /lastUpdateCheck/.test(main), "handler throttles to ≤1/day via prefs.lastUpdateCheck");
assert(/writePrefs\(\{ \.\.\.prefs, lastUpdateCheck:/.test(main), "records the attempt up front so repeated launches don't re-hit GitHub");
assert(/api\.github\.com\/repos\/kortdriessen\/flux\/releases\/latest/.test(main), "fetches the GitHub releases/latest endpoint");
assert(/AbortSignal\.timeout\(/.test(main), "the fetch is time-boxed (offline can't hang startup)");

// --- 4. preload + types + memBridge --------------------------------------------------
console.log("\nupdate-check — bridge surface (source):");
assert(/checkForUpdate: \(\) => ipcRenderer\.invoke\("update:check"\)/.test(read("electron/preload.cjs")), "preload exposes fig.checkForUpdate");
assert(/checkForUpdate\?\(\): Promise<\{ version: string; url: string \} \| null>/.test(read("src/lib/project/types.ts")), "FileBridge types checkForUpdate");
assert(/async checkForUpdate\(\)/.test(read("src/lib/project/memBridge.ts")), "the dev fixture stubs checkForUpdate (returns null)");

// --- 5. renderer trigger gates on the opt-out + toasts with a Download action ---------
console.log("\nupdate-check — Shell trigger (source):");
const shell = read("src/shell/Shell.svelte");
assert(/get\(settings\)\.updateCheck/.test(shell), "the trigger honors the settings.updateCheck opt-out");
assert(/checkForUpdate\?\.\(\)/.test(shell), "calls fileBridge().checkForUpdate()");
assert(/pushToast\("info", `Flux \$\{u\.version\} is available`/.test(shell), "a newer release raises an info toast naming the version");
assert(/openExternal\?\.\(u\.url\)/.test(shell) && /label: "Download"/.test(shell), "the toast's Download action opens the release URL");
assert(/void maybeCheckForUpdate\(\)/.test(shell), "the check fires once the bridge is present (alongside onCapture/onAppError)");

// --- 6. the opt-out toggle exists and defaults on ------------------------------------
console.log("\nupdate-check — Settings opt-out (source):");
assert(/updateCheck: true/.test(read("src/lib/settings.ts")), "settings.updateCheck defaults to true (on)");
assert(/\$settings\.updateCheck/.test(read("src/lib/Settings.svelte")), "Settings.svelte renders the update-check toggle");

if (failures) {
  console.error(`\nUPDATE-CHECK VERIFY: FAIL — ${failures} assertion(s)`);
  process.exit(1);
}
console.log("\nUPDATE-CHECK VERIFY: PASS");
