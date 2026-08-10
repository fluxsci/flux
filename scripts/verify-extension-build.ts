// Bundle gate for the "Add to FluxLib" browser extension — the half of the extension's
// promise that can only be checked AFTER a build.
//
// This lives apart from verify-extension.ts on purpose. Everything here reads extension/dist,
// which is a build output and is gitignored, so on a fresh checkout it does not exist. These
// assertions rode in the hermetic `pure` tier for four days and turned main red on every push:
// CI runs pure BEFORE `npm run build`, so the directory was never there and the gate failed
// deterministically while passing on any machine that happened to have a stale dist/ lying
// around. A gate that only passes when you already built is a post-build gate; it belongs in
// the tier that runs after the build.
//
// Run: npm run build && npx tsx scripts/verify-extension-build.ts
import { readFileSync, existsSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { readZip } from "./lib/readZip.mjs";

let failures = 0;
function ok(cond: boolean, name: string, detail = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
}

const DIST = "extension/dist";

// --- 1: the build is a copy, not a fork ---------------------------------------------------
// The extension vendors Flux's own rule modules; if a copy ever drifts from the original the
// whole reason for vendoring is gone.
ok(existsSync(DIST), "extension/dist exists (run `npm run build`)");
if (existsSync(DIST)) {
  for (const f of ["captureRules.js", "supplementRules.js"]) {
    const a = readFileSync(path.join("electron", f), "utf8");
    const b = existsSync(path.join(DIST, "vendor", f)) ? readFileSync(path.join(DIST, "vendor", f), "utf8") : "";
    ok(a === b, `vendored ${f} is byte-identical to Flux's own`, b ? "differs" : "missing");
  }
  // The worker too — dist/ is what the browser actually loads, so a stale copy means the user
  // is running yesterday's bug no matter what the source says.
  for (const f of ["background.js", "page.js"]) {
    const a = readFileSync(path.join("extension", f), "utf8");
    const b = existsSync(path.join(DIST, f)) ? readFileSync(path.join(DIST, f), "utf8") : "";
    ok(a === b, `built ${f} matches its source (re-run scripts/build-extension.mjs)`, b ? "differs" : "missing");
  }
  const m = JSON.parse(readFileSync(path.join(DIST, "manifest.json"), "utf8"));
  ok(m.manifest_version === 3, "manifest v3");
  ok(m.background?.service_worker === "background.js", "Chrome: background.service_worker set");
  ok(Array.isArray(m.background?.scripts) && m.background.scripts.includes("background.js"), "Firefox: background.scripts set");
  ok(m.background?.type === "module", "background is an ES module (it imports the shared rules)");
  ok(!!m.browser_specific_settings?.gecko?.id, "Firefox: a gecko id is declared (required to load/sign)");
  for (const p of ["scripting", "downloads", "activeTab"]) ok(m.permissions?.includes(p), `permission: ${p}`);
  ok(m.host_permissions?.some((h: string) => h.includes("https")), "host permissions cover https — this is what beats page CSP");
  for (const s of ["16", "32", "48", "128"]) ok(existsSync(path.join(DIST, "icons", `${s}.png`)), `icon ${s}px present`);
  // The injected reader is serialized by executeScript, so it must not close over anything.
  const page = readFileSync(path.join(DIST, "page.js"), "utf8");
  ok(!/^\s*import\s/m.test(page.replace(/^\/\/.*$/gm, "")), "page.js imports nothing (executeScript serializes it)");

  // The version line. AMO refuses a version it has already seen, so the extension keeps its own
  // monotonic line — and the build must carry it through rather than substituting its own.
  // (That the build does not *derive* the version from package.json is checked in the pure tier,
  // where it is a property of the build script's source.)
  const srcV = JSON.parse(readFileSync("extension/manifest.json", "utf8")).version;
  const distV = JSON.parse(readFileSync(path.join(DIST, "manifest.json"), "utf8")).version;
  ok(srcV === distV, "built version matches the source manifest", `${srcV} vs ${distV}`);
}

// --- 2: source → dist → the signed .xpi ----------------------------------------------------
// `git pull && npm run build && npx electron .` is how everyone else runs Flux. Chromium users
// are served by dist/ (npm run build makes it). FIREFOX users cannot help themselves at all:
// only the maintainer holds AMO credentials, and Firefox refuses to permanently install an
// unsigned add-on — so the signed .xpi is COMMITTED, and it has to be built from the source
// sitting next to it. A stale one means every Firefox user silently runs old code, which is
// precisely how web capture came to spend weeks filing no supplements at all.
//
// That the .xpi exists, is singular, is signed, and carries the current version are all
// properties of committed files and are checked in the pure tier. What needs a build is the
// last link: the bytes inside the archive ARE the bytes of this checkout. dist/ is proven to
// match extension/*.js above, so this closes source → dist → .xpi.
{
  const SIGNED = "extension/signed";
  const xpis = existsSync(SIGNED) ? readdirSync(SIGNED).filter((f) => f.endsWith(".xpi")) : [];
  if (xpis.length === 1 && existsSync(DIST)) {
    let entries: Map<string, Buffer> | null = null;
    try {
      entries = readZip(readFileSync(path.join(SIGNED, xpis[0])));
    } catch (e) {
      ok(false, "the signed .xpi is a readable archive", e instanceof Error ? e.message : String(e));
    }
    if (entries) {
      for (const f of ["background.js", "page.js", "vendor/captureRules.js", "vendor/captureShared.js", "vendor/supplementRules.js"]) {
        const inXpi = entries.get(f);
        const onDisk = existsSync(path.join(DIST, f)) ? readFileSync(path.join(DIST, f)) : null;
        ok(!!inXpi && !!onDisk && inXpi.equals(onDisk), `the signed .xpi's ${f} matches this source (re-run npm run sign:extension)`);
      }
    }
  } else {
    // Not this gate's job to complain about a missing/duplicated .xpi — the pure tier already
    // does, and failing twice for one cause makes a run harder to read, not safer.
    ok(true, "signed .xpi comparison skipped (its existence is gated in the pure tier)", "");
  }
}

console.log(failures ? `\n${failures} FAILED` : "\nall green");
process.exit(failures ? 1 : 0);
