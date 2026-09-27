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
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, mkdtempSync, copyFileSync, cpSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { harness } from "./lib/harness.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(repoRoot, "dist", "flux-cli.mjs"); // the `flux` launcher
const CORE = path.join(repoRoot, "dist", "flux-cli-core.mjs"); // the full bundle it fronts
const SIDECAR = path.join(repoRoot, "dist", "slide-export-assets.json");
// Outside the repo: Node resolves packages through the entry's ANCESTORS,
// regardless of cwd, so a scripts/.w13-tmp copy could borrow checkout packages.
const TMP = mkdtempSync(path.join(os.tmpdir(), "flux-w13-"));
const PROJ = path.join(TMP, "proj");
const FAKE = path.join(TMP, "app.asar.unpacked", "dist");
const require = createRequire(import.meta.url);
const h = harness("verify-w13-cli");

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
  // A REAL verb pays what help no longer does: the launcher imports the core
  // bundle (~6 MB of V8 compile) before any work. `help <verb>` is the cheapest
  // such path (no project, no FluxConfig), so its cold start is the bundle's
  // cost floor for every agent call. One-shot commands are the 1 s navigation
  // class (guide section 6); the number is reported so a regression shows as a
  // trend long before it reaches the budget.
  const verbDt = timed([CLI, "help", "new"]);
  const verbTiming = `${verbDt}ms (bare node ${control}ms; overhead ${verbDt - control}ms; budget <1000ms)`;
  if (verbDt < 1000) ok(`flux help new (core bundle) cold start ${verbTiming}`);
  else bad("verb cold start", verbTiming);
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

  // 5. PNG through source-dist and the packaged CLI entry, outside the checkout.
  const plot = path.join(TMP, "red.svg"), pngPath = path.join(TMP, "figure.png");
  writeFileSync(plot, '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24" fill="#ff0000"/></svg>');
  const isolatedCli = path.join(FAKE, "flux-cli.mjs");
  const isolatedEnv = { ...process.env, NODE_PATH: "" };
  const isolated = { cwd: TMP, env: isolatedEnv, stdio: "pipe" };
  node([isolatedCli, "compose-figure", plot, "--root", PROJ, "--id", "packaged-png", "--no-label", "--no-caption"], isolated);
  const renderArgs = ["render-figure", PROJ, "packaged-png", "--png", "--out", pngPath];
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const validPng = () => {
    const bytes = readFileSync(pngPath);
    return bytes.subarray(0, 8).equals(signature) && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0;
  };
  node([CLI, ...renderArgs], isolated);
  if (validPng()) ok("ordinary dist CLI renders a valid PNG from unrelated cwd");
  else bad("dist PNG signature/dimensions");
  rmSync(pngPath);
  let missingFailed = false;
  try { node([isolatedCli, ...renderArgs], isolated); }
  catch (error) { missingFailed = /rasterization failed/.test(String(error.stderr)) && !existsSync(pngPath); }
  if (missingFailed) ok("isolated CLI cannot borrow resvg from the checkout");
  else bad("PNG negative control", "render must fail until the prebuilt packages are shipped");
  const resvgDir = path.dirname(require.resolve("@resvg/resvg-js/package.json"));
  const resvg = JSON.parse(readFileSync(path.join(resvgDir, "package.json"), "utf8"));
  cpSync(resvgDir, path.join(FAKE, "..", "node_modules", "@resvg", "resvg-js"), { recursive: true });
  for (const name of Object.keys(resvg.optionalDependencies)) {
    let entry;
    try { entry = require.resolve(`${name}/package.json`); } catch { continue; } // only installed platform prebuilts
    cpSync(path.dirname(entry), path.join(FAKE, "..", "node_modules", name), { recursive: true });
  }
  node([isolatedCli, ...renderArgs], isolated);
  if (validPng()) ok("packaged CLI entry renders a valid PNG using unpacked resvg");
  else bad("packaged PNG signature/dimensions");

  // Also exercise resolution when Electron supplies an app.asar module URL:
  // the raster child must find the real-disk sibling, never the archive path.
  const archiveDist = path.join(TMP, "app.asar", "dist");
  mkdirSync(archiveDist, { recursive: true });
  copyFileSync(CLI, path.join(archiveDist, "flux-cli.mjs"));
  copyFileSync(CORE, path.join(archiveDist, "flux-cli-core.mjs"));
  rmSync(pngPath);
  node([path.join(archiveDist, "flux-cli.mjs"), ...renderArgs], isolated);
  if (validPng()) ok("app.asar module URL resolves PNG dependency in app.asar.unpacked");
  else bad("archive-to-unpacked PNG resolution");

  // 6. if a packaged build exists, assert the unpacked layout is correct -------
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

for (const [pass, name] of results) {
  h.ok(pass, name);
}
await h.done();
