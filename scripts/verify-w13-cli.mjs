// W13 verify: the bundled CLI + packaged slide export (SHL-1, AGT-9).
//
// Run:  node scripts/verify-w13-cli.mjs   (after `npm run build`)
//
// Proves: the bundle exists with a plain-node shebang; `flux help` cold-starts
// fast (no tsx); a deck exports to a self-contained HTML through the bundle; and —
// the ship-blocker — the bundle exports correctly when isolated from node_modules
// and src/ (i.e. from app.asar.unpacked in a packaged app), reading only its
// prebaked sidecar.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, rmSync, mkdirSync, copyFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(repoRoot, "dist", "flux-cli.mjs"); // the `flux` launcher
const CORE = path.join(repoRoot, "dist", "flux-cli-core.mjs"); // the full bundle it fronts
const SIDECAR = path.join(repoRoot, "dist", "slide-export-assets.json");
const TMP = path.join(repoRoot, "scripts", ".w13-tmp");
const PROJ = path.join(TMP, "proj");
const FAKE = path.join(TMP, "asar-unpacked", "dist"); // simulates app.asar.unpacked/dist

const results = [];
const ok = (n) => results.push([true, n]);
const bad = (n, e) => results.push([false, e ? `${n} — ${e}` : n]);
const node = (args, opts = {}) => execFileSync(process.execPath, args, { encoding: "utf8", ...opts });

try {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });

  // 1. bundle + sidecar exist, plain-node shebang -----------------------------
  if (existsSync(CLI) && existsSync(CORE) && existsSync(SIDECAR)) ok("dist/flux-cli.mjs + flux-cli-core.mjs + slide-export-assets.json exist");
  else bad("build artifacts", "run `npm run build` first");

  const head = readFileSync(CLI, "utf8").slice(0, 64);
  if (head.startsWith("#!/usr/bin/env node\n")) ok("bundle has a line-1 plain-node shebang");
  else bad("shebang", JSON.stringify(head.slice(0, 30)));

  // 2. help cold-start <150ms, including Node startup -------------------------
  // Keep the original absolute responsiveness budget. A bare-Node control is
  // diagnostic context for a slow host, not permission to subtract startup cost
  // or select only the fastest CLI sample. Measure the first help invocation.
  const timed = (args) => {
    const t0 = Date.now();
    node(args, { stdio: "ignore" });
    return Date.now() - t0;
  };
  const control = Math.min(...Array.from({ length: 3 }, () => timed(["-e", ""])));
  const dt = timed([CLI, "help"]);
  const over = dt - control;
  const timing = `${dt}ms (bare node ${control}ms; overhead ${over}ms; budget <150ms)`;
  if (dt < 150) ok(`flux help cold start ${timing}`);
  else bad("help cold start", timing);
  // The launcher's help fast path must print exactly what the full CLI prints.
  for (const args of [[], ["help"]]) {
    const fast = node([CLI, ...args]), full = node([CORE, ...args]);
    const form = ["flux", ...args].join(" ");
    if (fast === full && fast.includes("Registry commands")) ok(`launcher "${form}" prints the core bundle's help byte-for-byte`);
    else bad("launcher help drift", `${form}: ${fast.length} vs ${full.length} chars (rebuild with npm run build:cli)`);
  }
  // The structural companion to that timing: a heavy import shows up as bytes
  // long before it shows up as milliseconds, and bytes do not depend on load.
  // The budget is on the CORE bundle, which every verb but help still parses.
  const bundleMB = statSync(CORE).size / (1024 * 1024);
  if (bundleMB < 8) ok(`bundle is ${bundleMB.toFixed(1)} MB (<8 MB — no accidental heavyweight import)`);
  else bad("bundle size", `${bundleMB.toFixed(1)} MB`);

  // 3. scaffold → deck → slide → export (through the bundle) -------------------
  node([CLI, "new", PROJ, "--title", "W13"], { stdio: "ignore" });
  node([CLI, "new-deck", "--title", "Ship", "--root", PROJ], { stdio: "ignore" });
  // The CLI prints status to stderr; read the created deck id from disk instead.
  const decks = readdirSync(path.join(PROJ, "slides")).filter((d) => d.startsWith("deck_"));
  const deckId = decks[0];
  if (deckId) ok(`new-deck → ${deckId}`);
  else bad("new-deck", "no deck folder created");
  node([CLI, "add-slide", deckId, "--name", "Intro", "--root", PROJ], { stdio: "ignore" });
  node([CLI, "export-deck", deckId, "--root", PROJ], { stdio: "ignore" });
  const exp = path.join(PROJ, "exports", `${deckId}.html`);
  const html = existsSync(exp) ? readFileSync(exp, "utf8") : "";
  // Self-containment = no network <script src>/<link href> and no external font
  // URL (SVG xmlns="http://…" namespaces are URIs, not fetches — don't flag them).
  const netRef = /<(?:script|link)[^>]+\b(?:src|href)\s*=\s*["']https?:/i.test(html) ||
    /url\(\s*["']?https?:/i.test(html);
  if (html.includes("FluxSlideRuntime") && html.includes("Gelasio") && !netRef)
    ok(`export via bundle → self-contained HTML (${(html.length / 1024) | 0} KB)`);
  else bad("export via bundle", `runtime=${html.includes("FluxSlideRuntime")} gelasio=${html.includes("Gelasio")} netRef=${netRef}`);

  // 4. THE SHIP-BLOCKER: export from an isolated copy (no node_modules / src) --
  mkdirSync(FAKE, { recursive: true });
  copyFileSync(CLI, path.join(FAKE, "flux-cli.mjs"));
  copyFileSync(CORE, path.join(FAKE, "flux-cli-core.mjs"));
  copyFileSync(SIDECAR, path.join(FAKE, "slide-export-assets.json"));
  rmSync(exp, { force: true });
  // Run with cwd inside the isolated tree so a stray node_modules lookup can't
  // reach the repo; the bundle must rely only on its unpacked sidecar.
  node([path.join(FAKE, "flux-cli.mjs"), "export-deck", deckId, "--root", PROJ], {
    stdio: "ignore",
    cwd: path.dirname(FAKE),
  });
  const html2 = existsSync(exp) ? readFileSync(exp, "utf8") : "";
  if (html2.includes("FluxSlideRuntime") && html2.includes("Gelasio"))
    ok("export from isolated bundle (packaged-app layout) works");
  else bad("isolated export", "HTML missing runtime/fonts — packaged export would fail");

  // 5. if a packaged build exists, assert the unpacked layout is correct -------
  const rel = path.join(repoRoot, "release");
  const unpackedGuess = existsSync(rel)
    ? readdirSync(rel)
        .map((d) => path.join(rel, d, "resources", "app.asar.unpacked", "dist", "flux-cli.mjs"))
        .find((p) => existsSync(p))
    : null;
  if (unpackedGuess) ok(`packaged bundle unpacked at ${path.relative(repoRoot, unpackedGuess)}`);
  else results.push([true, "(no packaged build yet — run `npm run pack` for the full check)"]);
} catch (e) {
  bad("threw", e.message);
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

let failed = 0;
for (const [pass, name] of results) {
  console.log(`${pass ? "✓" : "✗"} ${name}`);
  if (!pass) failed++;
}
console.log(failed === 0 ? "W13 VERIFY: PASS" : `W13 VERIFY: FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
