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

console.log("\nFLUXCONFIG PATH INVARIANTS PASSED");
