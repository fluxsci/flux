#!/usr/bin/env -S npx tsx
// Machine-config path invariants (CLAUDE.md "Machine config paths").
//   npx tsx scripts/verify-fluxconfig.ts
//
// 1. userDataDir is the LOWERCASE app dir on every platform, and flux-core and
//    electron/fluxPaths.cjs resolve byte-identically (the ~/.config/Flux vs
//    ~/.config/flux split-brain can never come back).
// 2. No line in the machine-path source surface builds a capital-F "Flux"
//    path. Display strings that must say "Flux" carry a `// flux-cap-ok`
//    marker. electron-builder.yml (productName, the flux:// protocol display
//    name) is display metadata and deliberately outside the scanned set.
//
// If this test fails, fix the path — don't extend the allowlist.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function assert(c: unknown, m: string) { if (!c) throw new Error("FAIL: " + m); console.log("  ok:", m); }

// --- 1. lowercase + flux-core ≡ fluxPaths parity --------------------------

const core = await import("../flux-core/fluxlib");
const shared = await import("../electron/fluxPaths.cjs");

for (const p of ["linux", "darwin", "win32"] as const) {
  const a = core.userDataDir(p);
  const b = shared.userDataDir(p);
  assert(a === b, `flux-core and fluxPaths agree on ${p}: ${a}`);
  assert(path.basename(a) === "flux", `${p} userData dir segment is lowercase "flux"`);
}
assert(core.userDataDir() === shared.userDataDir(), "default-platform resolution agrees");

// --- 2. source scan: no capital-F Flux paths without a flux-cap-ok marker --

// Exact quoted token — matches "Flux"/'Flux'/`Flux` but not "FluxLib",
// "FluxConfig", "FluxFig", or prose mentioning Flux unquoted.
const capToken = /["'`]Flux["'`]/;
// Capital-F path fragments embedded inside longer strings (fixtures, docs).
const capLiterals = [".config/Flux", "Application Support/Flux", "AppData/Roaming/Flux"];

function* walk(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

const scanned: string[] = [];
const wanted = (f: string, exts: string[]) => exts.some((x) => f.endsWith(x));
for (const dir of ["flux-core", "electron"]) {
  for (const f of walk(path.join(repoRoot, dir))) {
    if (wanted(f, [".ts", ".cts", ".cjs"])) scanned.push(f);
  }
}
for (const f of walk(path.join(repoRoot, "src"))) {
  if (wanted(f, [".ts", ".svelte"])) scanned.push(f);
}
scanned.push(path.join(repoRoot, "flux-cli.ts"), path.join(repoRoot, "flux-mcp.ts"));

assert(scanned.length > 50, `scan set is real (${scanned.length} files)`);

const offenders: string[] = [];
for (const f of scanned) {
  const lines = fs.readFileSync(f, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (line.includes("flux-cap-ok")) return;
    if (capToken.test(line) || capLiterals.some((l) => line.includes(l))) {
      offenders.push(`${path.relative(repoRoot, f)}:${i + 1}: ${line.trim().slice(0, 100)}`);
    }
  });
}
if (offenders.length) console.error(offenders.join("\n"));
assert(offenders.length === 0, `no unmarked capital-F "Flux" paths in ${scanned.length} files`);

// --- 3. ensureFluxConfig migration simulation (hermetic tmp-dir) -----------
// Redirects HOME + XDG_CONFIG_HOME into a scratch dir (os.homedir() honors
// $HOME on POSIX; fluxPaths resolves at call time) — the REAL ~/FluxLib and
// ~/.config are never touched (pure-tier contract). Skipped on win32.

if (process.platform !== "win32") {
  const os = await import("node:os");
  const realHome = process.env.HOME;
  const realXdg = process.env.XDG_CONFIG_HOME;
  const realNoMigrate = process.env.FLUX_NO_MIGRATE;
  // The runner sets FLUX_NO_MIGRATE=1 for every verify child (so tests that
  // spawn the real CLI/MCP can't migrate the developer's HOME) — clear it
  // here: these sims run the real engine against a scratch HOME on purpose.
  delete process.env.FLUX_NO_MIGRATE;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "verify-fluxconfig-"));

  const freshFixture = (name: string, opts: { customLibDir?: string; preexistingCfg?: boolean } = {}) => {
    const home = path.join(scratch, name, "home");
    const xdg = path.join(scratch, name, "xdg");
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = xdg;
    const lib = opts.customLibDir ? path.join(home, opts.customLibDir) : path.join(home, "FluxLib");
    fs.mkdirSync(path.join(lib, "items", "x"), { recursive: true });
    fs.mkdirSync(path.join(lib, "pdfs_to_assign"), { recursive: true });
    fs.writeFileSync(path.join(lib, "library.bib"), "% seed\n");
    fs.writeFileSync(path.join(lib, "items", "x", "a.pdf"), "pdfbytes");
    fs.writeFileSync(path.join(lib, "keys.json"), "{}", { mode: 0o600 });
    const legacyCfg = path.join(xdg, "Flux"); // flux-cap-ok (building the migration SOURCE fixture)
    fs.mkdirSync(legacyCfg, { recursive: true });
    fs.writeFileSync(
      path.join(legacyCfg, "preferences.json"),
      JSON.stringify({ schemaVersion: "0.1.0", fluxLibPath: lib, lastUpdateCheck: 42 }, null, 2),
    );
    fs.writeFileSync(path.join(legacyCfg, "textstyles.json"), JSON.stringify({ schemaVersion: "0.1.0", styles: [] }));
    if (opts.preexistingCfg) fs.mkdirSync(path.join(home, "FluxConfig"), { recursive: true });
    return { home, xdg, lib };
  };

  const snapshot = (root: string): string => {
    const rows: string[] = [];
    const rec = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const p = path.join(d, e.name);
        const st = fs.statSync(p);
        rows.push(`${path.relative(root, p)} ${e.isDirectory() ? "dir" : `${st.size} ${st.mtimeMs}`}`);
        if (e.isDirectory()) rec(p);
      }
    };
    rec(root);
    return rows.join("\n");
  };

  try {
    // fluxPaths + flux-core resolve env at call time — safe to import once here.
    const fp = await import("../electron/fluxPaths.cjs");

    // -- full first-run migration
    const f1 = freshFixture("t1");
    const info = await fp.ensureFluxConfig();
    const cfg = path.join(f1.home, "FluxConfig");
    assert(info.fluxConfigPath === cfg, "info.fluxConfigPath is ~/FluxConfig");
    assert(info.fluxLibPath === path.join(cfg, "FluxLib"), "info.fluxLibPath is derived <cfg>/FluxLib");
    const prefsAfter = JSON.parse(fs.readFileSync(path.join(f1.xdg, "flux", "preferences.json"), "utf8"));
    assert(prefsAfter.fluxConfigPath === cfg, "prefs gained fluxConfigPath");
    assert(!("fluxLibPath" in prefsAfter), "prefs dropped the deprecated fluxLibPath");
    assert(prefsAfter.lastUpdateCheck === 42, "legacy pref keys survived the merge");
    assert(!fs.existsSync(path.join(f1.xdg, "Flux")), "legacy capital-F config dir removed"); // flux-cap-ok
    assert(fs.existsSync(path.join(f1.xdg, "flux", "textstyles.json")), "textstyles migrated to lowercase dir");
    assert(fs.existsSync(path.join(cfg, "FluxLib", "library.bib")), "FluxLib moved into FluxConfig");
    assert(fs.existsSync(path.join(cfg, "FluxLib", "items", "x", "a.pdf")), "items moved intact");
    assert((fs.statSync(path.join(cfg, "FluxLib", "keys.json")).mode & 0o777) === 0o600, "keys.json stayed 0600");
    const uc1 = path.join(cfg, "Context", "UserContext");
    assert(fs.readFileSync(path.join(uc1, "RULES.md"), "utf8").includes("panel labels"), "UserContext RULES.md seeded with base rules");
    assert(fs.existsSync(path.join(uc1, "WHO-AM-I.md")), "UserContext WHO-AM-I.md seeded");
    assert(!fs.existsSync(path.join(cfg, "Guidelines")), "no legacy Guidelines dir on a fresh machine");
    const fc1 = path.join(cfg, "Context", "FluxContext");
    assert(fs.readFileSync(path.join(fc1, "PRINCIPAL.md"), "utf8").includes("Boot sequence"), "FluxContext stock docs synced");
    const unsubbed = fs.readdirSync(fc1).filter(
      (n) => n.endsWith(".md") && /\{\{FLUX_(CLI|MCP|MCP_PATH)\}\}/.test(fs.readFileSync(path.join(fc1, n), "utf8")),
    );
    assert(unsubbed.length === 0, `every synced FluxContext doc substituted its placeholders (${unsubbed.join(", ") || "all clean"})`);
    assert(JSON.parse(fs.readFileSync(path.join(cfg, "agents.json"), "utf8")).principal.command.length > 0, "agents.json roster seeded");
    assert(info.agentsConfigPath === path.join(cfg, "agents.json"), "configInfo reports agentsConfigPath");
    assert(info.userContextPath === uc1 && info.fluxContextPath === fc1, "configInfo reports the Context paths");
    const marker = JSON.parse(fs.readFileSync(path.join(cfg, ".fluxconfig.json"), "utf8"));
    assert(Array.isArray(marker.events) && marker.events.some((e: { action: string }) => e.action === "move-fluxlib"), "marker records the FluxLib move");

    // -- second run is a byte-for-byte no-op
    const before = snapshot(path.join(scratch, "t1"));
    const again = await fp.ensureFluxConfig();
    assert(again.fluxLibPath === info.fluxLibPath, "re-run resolves identically");
    assert(snapshot(path.join(scratch, "t1")) === before, "re-run is a no-op (snapshot unchanged)");

    // -- resolver honors post-migration + pre-migration states
    assert(fp.resolveFluxLibPathSync({ fluxConfigPath: cfg }) === path.join(cfg, "FluxLib"), "resolver: derived wins when it exists");
    const f2 = freshFixture("t2");
    assert(fp.resolveFluxLibPathSync({}) === path.join(f2.home, "FluxLib"), "resolver: legacy ~/FluxLib before migration");

    // -- concurrent first runs (same process) serialize on the config lock
    const [c1, c2] = await Promise.all([fp.ensureFluxConfig(), fp.ensureFluxConfig()]);
    assert(c1.fluxLibPath === c2.fluxLibPath, "concurrent runs agree");
    assert(fs.existsSync(path.join(f2.home, "FluxConfig", "FluxLib", "library.bib")), "concurrent runs migrated exactly once");

    // -- custom fluxLibPath pref is honored as the move source
    const f3 = freshFixture("t3", { customLibDir: "my_refs" });
    await fp.ensureFluxConfig();
    assert(fs.existsSync(path.join(f3.home, "FluxConfig", "FluxLib", "library.bib")), "custom-path library moved to <cfg>/FluxLib");
    assert(!fs.existsSync(path.join(f3.home, "my_refs")), "custom-path source dir gone after move");

    // -- pre-existing empty ~/FluxConfig is filled in place
    const f4 = freshFixture("t4", { preexistingCfg: true });
    await fp.ensureFluxConfig();
    assert(fs.existsSync(path.join(f4.home, "FluxConfig", "FluxLib", "library.bib")), "pre-existing empty FluxConfig filled in place");

    // -- transitional symlink (old lib path -> <cfg>/FluxLib) is NOT "stranded"
    // (the real machine keeps ~/FluxLib as a symlink until every old-code
    // session is gone; old code re-persists fluxLibPath, so re-merges recur)
    const f6 = freshFixture("t6");
    await fp.ensureFluxConfig();
    fs.symlinkSync(path.join(f6.home, "FluxConfig", "FluxLib"), path.join(f6.home, "FluxLib"));
    fs.mkdirSync(path.join(f6.xdg, "Flux"), { recursive: true }); // flux-cap-ok (old code recreates it)
    fs.writeFileSync(
      path.join(f6.xdg, "Flux", "preferences.json"), // flux-cap-ok
      JSON.stringify({ schemaVersion: "0.1.0", fluxLibPath: path.join(f6.home, "FluxLib") }),
    );
    const r6 = await fp.ensureFluxConfig();
    assert(r6.fluxLibPath === path.join(f6.home, "FluxConfig", "FluxLib"), "re-merge after old-code prefs recreation resolves derived");
    const marker6 = JSON.parse(fs.readFileSync(path.join(f6.home, "FluxConfig", ".fluxconfig.json"), "utf8"));
    assert(!marker6.events.some((e: { action: string }) => e.action === "stranded-fluxlib-warning"), "symlinked legacy lib is not flagged as stranded");
    const prefs6 = JSON.parse(fs.readFileSync(path.join(f6.xdg, "flux", "preferences.json"), "utf8"));
    assert(!("fluxLibPath" in prefs6) && prefs6.fluxConfigPath, "re-merge drops the re-persisted fluxLibPath again");

    // -- pre-Context machine: Guidelines/ migrates into Context/UserContext
    const f7 = freshFixture("t7");
    const g7 = path.join(f7.home, "FluxConfig", "Guidelines");
    fs.mkdirSync(g7, { recursive: true });
    fs.writeFileSync(path.join(g7, "README.md"), fp.GUIDELINES_README); // untouched stock seed
    fs.writeFileSync(path.join(g7, "base_rules.md"), "# my edited rules\nuse panel labels always\n");
    fs.writeFileSync(path.join(g7, "style_notes.md"), "serif everywhere\n");
    await fp.ensureFluxConfig();
    const uc7 = path.join(f7.home, "FluxConfig", "Context", "UserContext");
    assert(!fs.existsSync(g7), "Guidelines dir gone after migration");
    assert(fs.readFileSync(path.join(uc7, "RULES.md"), "utf8").includes("my edited rules"), "user-edited base_rules became RULES.md");
    assert(fs.readFileSync(path.join(uc7, "style_notes.md"), "utf8").includes("serif"), "extra guideline files migrated intact");
    assert(!fs.existsSync(path.join(uc7, "README.md")), "untouched stock Guidelines README dropped, not migrated");
    assert(fs.existsSync(path.join(uc7, "WHO-AM-I.md")), "WHO-AM-I.md seeded alongside migrated files");

    // -- moveFluxConfig (Settings "Move…"): same-fs rename + destination guards
    const f5 = freshFixture("t5");
    await fp.ensureFluxConfig();
    const newParent = path.join(f5.home, "elsewhere");
    fs.mkdirSync(newParent, { recursive: true });
    const mv = await fp.moveFluxConfig(newParent);
    assert("ok" in mv && mv.path === path.join(newParent, "FluxConfig"), "moveFluxConfig renames under the new parent");
    assert(fs.existsSync(path.join(newParent, "FluxConfig", "FluxLib", "library.bib")), "library moved with FluxConfig");
    assert(!fs.existsSync(path.join(f5.home, "FluxConfig")), "old FluxConfig location gone");
    const prefs5 = JSON.parse(fs.readFileSync(path.join(f5.xdg, "flux", "preferences.json"), "utf8"));
    assert(prefs5.fluxConfigPath === path.join(newParent, "FluxConfig"), "pointer pref updated by the move");
    assert(fp.resolveFluxLibPathSync(prefs5) === path.join(newParent, "FluxConfig", "FluxLib"), "resolver follows the move");
    const marker5 = JSON.parse(fs.readFileSync(path.join(newParent, "FluxConfig", ".fluxconfig.json"), "utf8"));
    assert(marker5.events.some((e: { action: string }) => e.action === "move-fluxconfig"), "marker records the Settings move");
    assert("error" in (await fp.moveFluxConfig(newParent)), "reject moving to the same location");
    assert("error" in (await fp.moveFluxConfig(path.join(newParent, "FluxConfig"))), "reject moving into itself");
    assert("error" in (await fp.moveFluxConfig("")), "reject empty destination");
  } finally {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    if (realXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = realXdg;
    if (realNoMigrate === undefined) delete process.env.FLUX_NO_MIGRATE;
    else process.env.FLUX_NO_MIGRATE = realNoMigrate;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
} else {
  console.log("  (migration simulation skipped on win32)");
}

console.log("\nFLUXCONFIG PATH INVARIANTS PASSED");
