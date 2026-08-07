// Pure gate for the capture RECEIVING half: the download-folder filter, the sidecar parser,
// and the install page. (The bookmarklet's own behaviour is gated by verify-bookmarklet.ts.)
//
// The property that matters most here is containment: this feature watches the user's
// downloads folder, and moves files out of it. It must touch ONLY what the bookmarklet wrote.
//
// Run: npx tsx scripts/verify-capture-intake.ts
import { createRequire } from "node:module";
import { isCaptureFile, parseFluxCapture, CAPTURE_PREFIX, CAPTURE_EXT } from "../src/lib/references/capture";

const require = createRequire(import.meta.url);

let failures = 0;
function ok(cond: boolean, name: string, detail = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
}

// --- 1: containment — what the watcher will and won't act on ------------------------------
// isCaptureFile IS what electron/main.cjs classifies watched downloads with (it loads the
// same electron/captureRules.js), so this asserts the shipped rule, not a copy of it.
const watched = isCaptureFile;
for (const n of ["flux-10.1126_science.aah5982.pdf", "flux-e0674252026.full.pdf", "flux-x.fluxcap", "FLUX-Y.PDF"])
  ok(watched(n), "acted on: a real capture", n);
// Anything a user might plausibly have in Downloads must be invisible to us.
for (const n of ["paper.pdf", "1-s2.0-S0006349521008870-main.pdf", "flux.pdf", "flux-.pdf", "notes.txt", "flux-notes.txt", "flux-archive.zip", "Screenshot.png", "invoice-flux-2026.pdf"])
  ok(!watched(n), "IGNORED: an ordinary download", n);

// --- 2: the sidecar parser never throws and never invents -------------------------------
{
  const good = JSON.stringify({ v: 1, url: "https://x/a", doi: "10.1/x", title: "T", pdfUrl: "https://x/p.pdf", reason: "no-pdf-on-page", capturedAt: "2026-01-01T00:00:00Z" });
  const p = parseFluxCapture(good);
  ok(p?.doi === "10.1/x" && p?.url === "https://x/a", "sidecar round-trips");
  ok(parseFluxCapture("{oops") === null, "corrupt JSON → null (a stray file can't crash the watcher)");
  ok(parseFluxCapture("") === null, "empty → null");
  ok(parseFluxCapture(JSON.stringify({ v: 1, title: "only a title" })) === null, "nothing resolvable → null");
  ok(parseFluxCapture(JSON.stringify({ v: 1, url: "https://x/a" }))?.doi === "", "URL-only sidecar is usable, doi empty");
}

// --- 4: the two halves agree on the filename contract -------------------------------------
ok(CAPTURE_PREFIX === "flux-", "prefix constant matches what the bookmarklet writes");
ok(CAPTURE_EXT === ".fluxcap", "sidecar extension constant matches");
{
  // The extension is now the only producer; its worker must use the shared constants rather
  // than literals, so the filename contract can't drift from the watcher's.
  const bg = require("node:fs").readFileSync("extension/background.js", "utf8");
  ok(/flux-\$\{slug\}\.pdf/.test(bg), "the extension writes the article under the shared prefix");
  ok(/\$\{SUPP_PREFIX\}\$\{slug\}\$\{SUPP_SEP\}/.test(bg), "…and supplements under the shared supplement prefix");
  ok(/CAPTURE_SUBDIR/.test(bg), "…into the shared subfolder");
}

// --- 4b: the OLD flux:// path AND the bookmarklet are really gone ---------------------------------------
{
  const fs = require("node:fs") as typeof import("node:fs");
  ok(!fs.existsSync("electron/fluxUrl.cjs"), "electron/fluxUrl.cjs deleted");
  const main = fs.readFileSync("electron/main.cjs", "utf8");
  ok(!/setAsDefaultProtocolClient|capture:add|parseFluxUrl/.test(main), "main.cjs has no flux:// protocol handling left");
  const builder = fs.readFileSync("electron-builder.yml", "utf8");
  ok(!/^protocols:/m.test(builder), "electron-builder.yml no longer registers the flux:// scheme");
  const contract = fs.readFileSync("electron/ipc/contract.cjs", "utf8");
  ok(!/capture:add/.test(contract), "the capture:add channel is out of the IPC contract");
  // The bookmarklet is gone entirely — the extension replaced it.
  ok(!fs.existsSync("src/shell/modes/library/bookmarklet.ts"), "the bookmarklet source is deleted");
  ok(!fs.existsSync("electron/captureInstall.cjs"), "its install page is deleted");
  ok(!/capture:openInstallPage/.test(contract), "…and its IPC channel is out of the contract");
  const lib = fs.readFileSync("src/shell/modes/library/LibraryMode.svelte", "utf8");
  ok(!/BOOKMARKLET_HREF|bookmarklet/i.test(lib), "the Library holds no bookmarklet references");
  ok(/captureExtensionInfo|revealCaptureExtension|installCaptureXpi/.test(fs.readFileSync("electron/preload.cjs", "utf8")), "the extension onboarding channels ARE exposed");
  ok(/capture:dir/.test(contract) && /capture:intake/.test(contract) && /capture:extensionInfo/.test(contract), "the new capture channels ARE declared");
  // main must classify with the SHARED rule, never its own regex (the drift that rotted the
  // supplement filter started exactly this way).
  ok(/captureRules\.isCaptureFile/.test(main), "main.cjs classifies via the shared rule, not a private regex");
  ok(!/\^flux-\.\+/.test(main), "main.cjs holds no duplicate capture-filename regex");
}

console.log(failures ? `\n${failures} FAILED` : "\nall green");
process.exit(failures ? 1 : 0);
