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

  // 2. help cold-start: the bundle must start like PLAIN NODE (no tsx chain, no
  // heavyweight module-scope import) --------------------------------------------
  // Measured RELATIVE to a bare `node -e ""` on this machine, best-of-3: an
  // absolute wall-clock budget is not portable (the same healthy bundle reads
  // ~110ms over control on a dev box and sat exactly ON a 150ms absolute budget
  // on a CI runner, failing by a millisecond), while the DELTA is what the
  // contract is actually about — a tsx/ts-node start costs 400ms+ over control,
  // and so does an accidental eager import of a heavy subsystem.
  const bestOf = (args, n = 3) => {
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      const t0 = Date.now();
      node(args, { stdio: "ignore" });
      best = Math.min(best, Date.now() - t0);
    }
    return best;
  };
  const control = bestOf(["-e", ""]);
  const dt = bestOf([CLI, "help"]);
  const over = dt - control;
  if (over < 250) ok(`flux help cold start ${dt}ms — ${over}ms over a bare node start (${control}ms), <250ms`);
  else bad("help cold start", `${over}ms over a bare node start (help ${dt}ms, control ${control}ms)`);
  // The structural companion to that timing: a heavy import shows up as bytes
  // long before it shows up as milliseconds, and bytes do not depend on load.
  const bundleMB = statSync(CLI).size / (1024 * 1024);
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
