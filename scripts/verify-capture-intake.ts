// Pure gate for the capture RECEIVING half: the download-folder filter, the sidecar parser,
// and the install page. (The bookmarklet's own behaviour is gated by verify-bookmarklet.ts.)
//
// The property that matters most here is containment: this feature watches the user's
// downloads folder, and moves files out of it. It must touch ONLY what the bookmarklet wrote.
//
// Run: npx tsx scripts/verify-capture-intake.ts
import { createRequire } from "node:module";
import { isCaptureFile, parseFluxCapture, parseSupplementCapture, captureSlug, supplementCaptureName, CAPTURE_PREFIX, CAPTURE_EXT } from "../src/lib/references/capture";

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
  // The extension is the only producer. It must not just use the shared CONSTANTS but the
  // shared NAME BUILDERS: assembling a name from the constants and then sanitizing the result
  // is what silently ate the `@@` separator, and constants alone can't prevent that.
  const bg = require("node:fs").readFileSync("extension/background.js", "utf8");
  ok(/articleCaptureName\(slug\)/.test(bg), "the extension names the article through the shared builder");
  ok(/supplementCaptureName\(slug, name\)/.test(bg), "…and supplements through the shared builder");
  ok(/sidecarCaptureName\(slug\)/.test(bg), "…and the sidecar too");
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

// --- 5: intake is USER-INITIATED, never ambient -------------------------------------------
// The property: files leave the user's download folder at exactly TWO moments — app startup,
// and the Library's Assign button. Intake used to also run on every window focus, on every
// FluxLib change, and on every watcher event, so downloads were rearranged at moments the user
// had not asked for and could not predict. Nothing may quietly put a third trigger back.
{
  const fs = require("node:fs") as typeof import("node:fs");
  const MOD = "src/lib/references/captureIntake.svelte.ts";
  const mod = fs.readFileSync(MOD, "utf8");
  ok(!/addEventListener\(\s*["']focus["']/.test(mod), "no focus listener pulls the download folder");
  ok(!/visibilitychange/.test(mod), "…and no visibilitychange listener either");
  // A FluxLib bump still finishes the job an earlier pull started (a supplement waiting on its
  // paper's citekey) — but over FluxLib's own staging folder, never the downloads.
  ok(
    /sweepStagedSupplements\(\)/.test(mod.slice(mod.indexOf("fluxLibRevision.subscribe"))),
    "a FluxLib change sweeps STAGING only, never the download folder",
  );

  const watch = fs.readFileSync("src/lib/project/projectWatch.ts", "utf8");
  ok(/refreshCaptureWaiting/.test(watch) && !/runCaptureIntake/.test(watch), "the watcher refreshes the waiting COUNT; it does not file");

  // Repo-wide: who actually calls it?
  const callers: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|svelte)$/.test(e.name) && p !== MOD && /runCaptureIntake\s*\(/.test(fs.readFileSync(p, "utf8"))) callers.push(p);
    }
  };
  walk("src");
  ok(
    callers.length === 1 && callers[0] === "src/shell/modes/library/LibraryMode.svelte",
    "the ONLY caller outside the module is the Library's Assign button",
    callers.join(", ") || "no caller at all",
  );
  ok(/captureIntakeOnStartup\(\)/.test(fs.readFileSync("src/shell/Shell.svelte", "utf8")), "…plus startup, via captureIntakeOnStartup()");

  // The button needs a number BEFORE anything moves, so the count must be genuinely read-only.
  const contract = fs.readFileSync("electron/ipc/contract.cjs", "utf8");
  ok(/\{ channel: "capture:count", kind: "invoke", scope: "read" \}/.test(contract), "capture:count is declared READ scope");
  const engine = fs.readFileSync("electron/captureIntake.cjs", "utf8");
  const countBody = engine.slice(engine.indexOf("async function count()"), engine.indexOf("async function intake()"));
  ok(countBody.length > 0 && !/rename|copyFile|mkdir|\brm\(/.test(countBody), "…and count() really is read-only (no rename/copyFile/mkdir/rm)");
}

// --- 6: a staged supplement finds its paper -----------------------------------------------
// The join between a captured supplement and the paper it belongs to. It ran through
// `doiFromSlug`, which GUESSES the inverse of `captureSlug` by treating the first "_" after the
// registrant prefix as the slash. captureSlug is not reversible — it maps every run of unusual
// characters to a single "_" — so any DOI with a slash in its suffix came back wrong and its
// supplement waited forever: 61 of the 1627 DOIs in the author's own library. The fix is to
// stop inverting and compare in the LOSSY space, slugging both sides.
{
  const fs = require("node:fs") as typeof import("node:fs");
  const bareDoi = (d: string): string => d.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim().toLowerCase();
  /** Exactly the join fileStagedSupplements does. */
  const matches = (libraryDoi: string, capturedDoi: string): boolean => {
    const file = supplementCaptureName(capturedDoi, "mmc1.pdf");
    const slug = parseSupplementCapture(file)?.slug ?? "";
    return captureSlug(bareDoi(libraryDoi)).toLowerCase() === slug.toLowerCase();
  };

  // The shapes that were broken — a slash in the suffix is completely ordinary.
  for (const doi of ["10.1093/jcr/ucy008", "10.1016/S0896-6273(00)80510-3", "10.1002/(SICI)1096-9861(19960422)368:2<269::AID-CNE7>3.0.CO;2-3", "10.5962/bhl.title.32770"])
    ok(matches(doi, doi), `a supplement finds its paper: ${doi}`, supplementCaptureName(doi, "mmc1.pdf"));
  // …and the shapes that always worked still do, including publisher case differences.
  for (const doi of ["10.1126/science.aah5982", "10.1038/s41586-020-2731-9", "10.1016/j.cell.2026.07.017"]) ok(matches(doi, doi), `still finds its paper: ${doi}`);
  ok(matches("10.48550/arxiv.2303.08774", "10.48550/arXiv.2303.08774"), "the join is case-insensitive (the library lowercases, the publisher doesn't)");
  ok(!matches("10.1126/science.aah5982", "10.1038/s41586-020-2731-9"), "a DIFFERENT paper does not match");

  // And the receiver really does it this way — not through the guess.
  const mod = fs.readFileSync("src/lib/references/captureIntake.svelte.ts", "utf8");
  const fn = mod.slice(mod.indexOf("async function fileStagedSupplements"), mod.indexOf("let running = false"));
  ok(/captureSlug\(/.test(fn), "the staging sweep slugs the library side to match");
  ok(/bySlug\.get\(parsed\.slug/.test(fn), "…and looks the captured slug up DIRECTLY, never a guessed-back DOI");
}

// --- 7: the Library offers the NEWEST signed add-on -----------------------------------------
// `npm run sign:extension` bumps the version and leaves the previous .xpi in place, so
// extension/signed/ accumulates. Picking the first one readdir returned offered a stale build —
// worst of all right after someone signs a fix, which is exactly when they click that button.
{
  const { newestXpi } = require("../electron/captureIntake.cjs");
  const H = "25d5c205510546b881cc";
  ok(newestXpi([`${H}-0.1.0.xpi`, `${H}-0.1.1.xpi`]) === `${H}-0.1.1.xpi`, "0.1.1 beats 0.1.0");
  ok(newestXpi([`${H}-0.1.1.xpi`, `${H}-0.1.0.xpi`]) === `${H}-0.1.1.xpi`, "…in either readdir order");
  ok(newestXpi([`${H}-0.9.0.xpi`, `${H}-0.10.0.xpi`]) === `${H}-0.10.0.xpi`, "…and it's numeric, not lexicographic (0.10 > 0.9)");
  ok(newestXpi([`${H}-1.0.xpi`, `${H}-1.0.1.xpi`]) === `${H}-1.0.1.xpi`, "…and a longer version wins the tie");
  ok(newestXpi(["notes.txt", `${H}-0.1.1.xpi`]) === `${H}-0.1.1.xpi`, "non-xpi files are ignored");
  ok(newestXpi([]) === null && newestXpi(["notes.txt"]) === null, "nothing to offer → null");
  const main = require("node:fs").readFileSync("electron/main.cjs", "utf8");
  ok(/newestXpi\(fs\.readdirSync\(dir\)\)/.test(main), "…and main.cjs uses it rather than the first hit");
}

console.log(failures ? `\n${failures} FAILED` : "\nall green");
process.exit(failures ? 1 : 0);
