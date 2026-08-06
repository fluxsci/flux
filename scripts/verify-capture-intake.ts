// Pure gate for the capture RECEIVING half: the download-folder filter, the sidecar parser,
// and the install page. (The bookmarklet's own behaviour is gated by verify-bookmarklet.ts.)
//
// The property that matters most here is containment: this feature watches the user's
// downloads folder, and moves files out of it. It must touch ONLY what the bookmarklet wrote.
//
// Run: npx tsx scripts/verify-capture-intake.ts
import { createRequire } from "node:module";
import { isCaptureFile, parseFluxCapture, CAPTURE_PREFIX, CAPTURE_EXT } from "../src/lib/references/capture";
import { BOOKMARKLET_HREF } from "../src/shell/modes/library/bookmarklet";

const require = createRequire(import.meta.url);
const { captureInstallHtml, FLUX_ICON_DATA_URI } = require("../electron/captureInstall.cjs");

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

// --- 3: the install page ------------------------------------------------------------------
{
  const html = captureInstallHtml(BOOKMARKLET_HREF);
  ok(html.startsWith("<!doctype html>"), "install page is a real document");
  ok(html.includes(`href="${BOOKMARKLET_HREF.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")}"`), "the SHIPPED bookmarklet is the link's href (one source of truth)");
  // The dragged bookmark inherits the source page's favicon — that is the whole reason the
  // icon is here, and a blank-page icon is what the user complained about.
  ok(/<link rel="icon" href="data:image\/png;base64,/.test(html), "page declares a data-URI favicon (the bookmark inherits it)");
  ok(FLUX_ICON_DATA_URI.length > 500, "the icon is real bytes, not a placeholder", `${FLUX_ICON_DATA_URI.length} chars`);
  ok(html.includes(FLUX_ICON_DATA_URI) && html.split(FLUX_ICON_DATA_URI).length === 3, "icon used twice: favicon + on the button itself");
  // Firefox's CSP behaviour is a real limitation; the page must say so rather than let the
  // user discover it as silence.
  ok(/Firefox/.test(html) && /Content-Security-Policy/.test(html) && /866522/.test(html), "documents the Firefox CSP limitation, with the bug reference");
  ok(/security\.csp\.enable/.test(html) && /Don't disable/.test(html), "warns AGAINST the dangerous workaround");
  ok(/Ctrl\+Shift\+B/.test(html), "says how to show the bookmarks bar");
  ok(!/javascript:[^"]*<script/.test(html), "no script injection through the href");
}
{
  // Escaping: a hostile href must not break out of the attribute.
  const html = captureInstallHtml('javascript:void("</a><script>alert(1)</script>")');
  ok(!html.includes("<script>alert(1)</script>"), "href is HTML-escaped into the attribute");
}

// --- 4: the two halves agree on the filename contract -------------------------------------
ok(CAPTURE_PREFIX === "flux-", "prefix constant matches what the bookmarklet writes");
ok(CAPTURE_EXT === ".fluxcap", "sidecar extension constant matches");
ok(BOOKMARKLET_HREF.includes("'flux-'+slug+'.pdf'"), "bookmarklet writes the PDF under the shared prefix");
ok(BOOKMARKLET_HREF.includes("'flux-'+slug+'.fluxcap'"), "bookmarklet writes the sidecar under the shared prefix");

// --- 5: the OLD flux:// capture path is really gone ---------------------------------------
{
  const fs = require("node:fs") as typeof import("node:fs");
  ok(!fs.existsSync("electron/fluxUrl.cjs"), "electron/fluxUrl.cjs deleted");
  const main = fs.readFileSync("electron/main.cjs", "utf8");
  ok(!/setAsDefaultProtocolClient|capture:add|parseFluxUrl/.test(main), "main.cjs has no flux:// protocol handling left");
  const builder = fs.readFileSync("electron-builder.yml", "utf8");
  ok(!/^protocols:/m.test(builder), "electron-builder.yml no longer registers the flux:// scheme");
  const contract = fs.readFileSync("electron/ipc/contract.cjs", "utf8");
  ok(!/capture:add/.test(contract), "the capture:add channel is out of the IPC contract");
  ok(/capture:dir/.test(contract) && /capture:openInstallPage/.test(contract), "the new capture channels ARE declared");
  // main must classify with the SHARED rule, never its own regex (the drift that rotted the
  // supplement filter started exactly this way).
  ok(/captureRules\.isCaptureFile/.test(main), "main.cjs classifies via the shared rule, not a private regex");
  ok(!/\^flux-\.\+/.test(main), "main.cjs holds no duplicate capture-filename regex");
}

console.log(failures ? `\n${failures} FAILED` : "\nall green");
process.exit(failures ? 1 : 0);
