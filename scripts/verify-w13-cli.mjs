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
import { readFileSync, existsSync, rmSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(repoRoot, "dist", "flux-cli.mjs");
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
  if (existsSync(CLI) && existsSync(SIDECAR)) ok("dist/flux-cli.mjs + slide-export-assets.json exist");
  else bad("build artifacts", "run `npm run build` first");

  const head = readFileSync(CLI, "utf8").slice(0, 64);
  if (head.startsWith("#!/usr/bin/env node\n")) ok("bundle has a line-1 plain-node shebang");
  else bad("shebang", JSON.stringify(head.slice(0, 30)));

  // 2. help cold-start < 150ms ------------------------------------------------
  const t0 = Date.now();
  node([CLI, "help"], { stdio: "ignore" });
  const dt = Date.now() - t0;
  if (dt < 150) ok(`flux help cold start ${dt}ms (<150ms)`);
  else bad("help cold start", `${dt}ms`);

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
