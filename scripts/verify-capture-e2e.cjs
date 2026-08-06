// Live gate for web-capture intake — the code that MOVES FILES OUT OF THE USER'S DOWNLOAD
// FOLDER. Drives the real engine (electron/captureIntake.cjs) against a temp download dir and
// a temp FluxLib, so nothing real is touched.
//
// Run:  DISPLAY=:0 ./node_modules/.bin/electron scripts/verify-capture-e2e.cjs --no-sandbox
//
// The property under test is CONTAINMENT: a user's downloads folder is full of their own
// files, and this feature must be incapable of touching anything the bookmarklet didn't write.
const { app } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const { createCaptureIntake, MIN_PDF_BYTES } = require("../electron/captureIntake.cjs");

let failures = 0;
const ok = (cond, name, detail = "") => {
  console.log(`${cond ? "  ok:" : "  ✗ FAIL:"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
};

const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(MIN_PDF_BYTES * 2, 0x41)]);

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "flux-capture-e2e-"));
  const dl = path.join(tmp, "Downloads");
  const lib = path.join(tmp, "FluxLib");
  const inbox = path.join(lib, "pdfs_to_assign");
  await fsp.mkdir(dl, { recursive: true });
  await fsp.mkdir(lib, { recursive: true });

  const engine = createCaptureIntake({
    captureDir: () => dl,
    fluxLibDir: () => lib,
    path,
    fs,
    fsp,
    loadRules: () => import("../electron/captureRules.js"),
  });

  // --- plant captures alongside files the user would be furious to lose ------------------
  await fsp.writeFile(path.join(dl, "flux-10.1126_science.aah5982.pdf"), PDF);
  await fsp.writeFile(path.join(dl, "flux-e0674252026.full.pdf"), PDF);
  await fsp.writeFile(path.join(dl, "flux-x.fluxcap"), JSON.stringify({ v: 1, url: "https://x/a", doi: "10.1/x" }));
  // Supplements captured in the same click as their article — any file type.
  await fsp.writeFile(path.join(dl, "flux-supp-10.1126_science.aah5982@@devivo-sm.pdf"), PDF);
  await fsp.writeFile(path.join(dl, "flux-supp-10.1126_science.aah5982@@movie1.mov"), Buffer.alloc(2048, 7));
  await fsp.writeFile(path.join(dl, "flux-supp-@@malformed.pdf"), PDF); // no slug: not a capture
  const decoys = ["tax-return-2025.pdf", "1-s2.0-S000634952-main.pdf", "flux-notes.txt", "flux.pdf", "flux-.pdf", "holiday.jpg"];
  for (const d of decoys) await fsp.writeFile(path.join(dl, d), "USER DATA");
  await fsp.writeFile(path.join(dl, "flux-tiny.pdf"), Buffer.from("%PDF-x")); // still-arriving stub

  const r = await engine.intake();

  console.log("\ncapture intake:");
  ok(r.pdfs.length === 2, "both captured PDFs were filed", JSON.stringify(r.pdfs));
  ok(r.sidecars.length === 1 && r.sidecars[0].name === "flux-x.fluxcap", "the sidecar came back for the renderer to resolve");
  ok(fs.existsSync(path.join(inbox, "flux-10.1126_science.aah5982.pdf")), "capture landed in pdfs_to_assign/");
  ok(!fs.existsSync(path.join(dl, "flux-10.1126_science.aah5982.pdf")), "capture left the download folder");
  ok(fs.existsSync(path.join(dl, "flux-x.fluxcap")), "sidecar is NOT deleted until the renderer resolves it");

  console.log("\nsupplements (captured in the same click as the article):");
  ok(r.supplements.length === 2, "both supplements were staged", JSON.stringify(r.supplements));
  const staging = path.join(inbox, "_captured_supplements");
  ok(fs.existsSync(path.join(staging, "flux-supp-10.1126_science.aah5982@@devivo-sm.pdf")), "a supplement PDF is staged, NOT filed as an article");
  ok(fs.existsSync(path.join(staging, "flux-supp-10.1126_science.aah5982@@movie1.mov")), "a non-PDF supplement is staged too");
  ok(!fs.existsSync(path.join(inbox, "flux-supp-10.1126_science.aah5982@@devivo-sm.pdf")), "…and never reaches the assign inbox itself");
  ok(fs.existsSync(path.join(dl, "flux-supp-@@malformed.pdf")), "a slug-less supplement name is left alone, not filed as a paper");
  {
    const rules = await import("../electron/captureRules.js");
    const p = rules.parseSupplementCapture("flux-supp-10.1126_science.aah5982@@devivo-sm.pdf");
    ok(rules.doiFromSlug(p.slug) === "10.1126/science.aah5982", "the staged name still identifies its paper", rules.doiFromSlug(p.slug));
  }

  console.log("\ncontainment — the user's own files:");
  for (const d of decoys) ok(fs.existsSync(path.join(dl, d)), `untouched: ${d}`);
  const inboxFiles = fs.readdirSync(inbox).filter((n) => fs.statSync(path.join(inbox, n)).isFile());
  ok(inboxFiles.length === 2, "only the two article PDFs are in the inbox", JSON.stringify(inboxFiles));

  console.log("\npartial downloads:");
  ok(fs.existsSync(path.join(dl, "flux-tiny.pdf")), "a sub-1KB 'PDF' is left alone (still arriving / a stub)");
  ok(!fs.existsSync(path.join(inbox, "flux-tiny.pdf")), "…and never reaches the inbox");

  console.log("\nidempotence + collisions:");
  const again = await engine.intake();
  ok(again.pdfs.length === 0, "a second pass moves nothing new", JSON.stringify(again.pdfs));
  await fsp.writeFile(path.join(dl, "flux-10.1126_science.aah5982.pdf"), PDF); // same name again
  const third = await engine.intake();
  ok(third.pdfs[0] === "flux-10.1126_science.aah5982-2.pdf", "a same-named capture is suffixed, never overwritten", JSON.stringify(third.pdfs));

  console.log("\ndiscard is name-scoped:");
  ok((await engine.discard("../../../etc/passwd")).error, "path traversal refused");
  ok((await engine.discard("tax-return-2025.pdf")).error, "a non-capture name refused");
  ok(fs.existsSync(path.join(dl, "tax-return-2025.pdf")), "…and that file still exists");
  ok((await engine.discard("flux-x.fluxcap")).ok === true, "a real sidecar is discarded");
  ok(!fs.existsSync(path.join(dl, "flux-x.fluxcap")), "…and is gone");

  console.log("\nmissing folder:");
  const dead = createCaptureIntake({ captureDir: () => null, fluxLibDir: () => lib, path, fs, fsp, loadRules: () => import("../electron/captureRules.js") });
  const empty = await dead.intake();
  ok(empty.pdfs.length === 0 && empty.sidecars.length === 0, "no download folder → clean no-op, no throw");

  await fsp.rm(tmp, { recursive: true, force: true });
  console.log(failures ? `\nCAPTURE E2E: FAIL (${failures})` : "\nCAPTURE E2E: PASS");
  app.exit(failures ? 1 : 0);
}

app.whenReady().then(main);
