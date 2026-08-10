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
  // NAMED BY THE PRODUCER, not by hand. This gate used to write the filenames it expected as
  // literals, which is why it stayed green through the whole period in which the extension was
  // producing names the receiver rejected: it was testing the receiver against itself. The
  // builders below are the exact ones extension/background.js calls.
  const rules = await import("../electron/captureRules.js");
  const { articleCaptureName, sidecarCaptureName, supplementCaptureName } = rules;
  const SCIENCE = "10.1126/science.aah5982";
  const NATURE = "10.1038/s41586-020-2731-9";
  const N = {
    science: articleCaptureName(SCIENCE),
    jneuro: articleCaptureName("e0674252026.full"),
    sidecar: sidecarCaptureName("x"),
    scienceSupp: supplementCaptureName(SCIENCE, "devivo-sm.pdf"),
    scienceMovie: supplementCaptureName(SCIENCE, "movie1.mov"),
    nature: articleCaptureName(NATURE),
    natureSupp: supplementCaptureName(NATURE, "MOESM1_ESM.pdf"),
  };
  await fsp.writeFile(path.join(dl, N.science), PDF);
  await fsp.writeFile(path.join(dl, N.jneuro), PDF);
  await fsp.writeFile(path.join(dl, N.sidecar), JSON.stringify({ v: 1, url: "https://x/a", doi: "10.1/x" }));
  // Supplements captured in the same click as their article — any file type.
  await fsp.writeFile(path.join(dl, N.scienceSupp), PDF);
  await fsp.writeFile(path.join(dl, N.scienceMovie), Buffer.alloc(2048, 7));
  await fsp.writeFile(path.join(dl, "flux-supp-@@malformed.pdf"), PDF); // no slug: not a capture
  // The shape the shipped bug produced: assembled, then sanitized, so the separator is gone.
  // It is NOT a capture, and must be left strictly alone like any other file of the user's.
  const MANGLED = `flux-supp-${rules.captureSlug(SCIENCE)}_devivo-sm.pdf`;
  await fsp.writeFile(path.join(dl, MANGLED), PDF);
  const decoys = ["tax-return-2025.pdf", "1-s2.0-S000634952-main.pdf", "flux-notes.txt", "flux.pdf", "flux-.pdf", "holiday.jpg"];
  for (const d of decoys) await fsp.writeFile(path.join(dl, d), "USER DATA");
  await fsp.writeFile(path.join(dl, "flux-tiny.pdf"), Buffer.from("%PDF-x")); // still-arriving stub
  // The EXTENSION writes into <downloads>/flux/ so a multi-file capture doesn't scatter.
  await fsp.mkdir(path.join(dl, "flux"), { recursive: true });
  await fsp.writeFile(path.join(dl, "flux", N.nature), PDF);
  await fsp.writeFile(path.join(dl, "flux", N.natureSupp), PDF);
  await fsp.mkdir(path.join(dl, "flux", "nested"), { recursive: true });
  await fsp.writeFile(path.join(dl, "flux", "nested", "flux-deep.pdf"), PDF); // too deep: ignored

  // --- the read-only count the Assign button runs on ------------------------------------
  // Intake happens only when the user asks (startup or that button), so the count is what
  // makes the offer. It must agree with intake exactly — a number that over-promises would
  // put a button on screen that then files nothing — and must move nothing to produce it.
  console.log("\nwaiting count (read-only):");
  const before = fs.readdirSync(dl).sort();
  const waiting = await engine.count();
  ok(waiting === 7, "counts exactly the captures intake will take", String(waiting));
  ok(JSON.stringify(fs.readdirSync(dl).sort()) === JSON.stringify(before), "counting moved nothing");
  ok(!fs.existsSync(inbox), "…and created no inbox");

  const r = await engine.intake();
  ok(r.pdfs.length + r.sidecars.length + r.supplements.length === waiting, "intake took exactly what the count promised");

  console.log("\ncapture intake:");
  ok(r.pdfs.length === 3, "captured PDFs from BOTH drop points were filed", JSON.stringify(r.pdfs));
  ok(r.pdfs.includes(N.nature), "the extension's flux/ subfolder is picked up too");
  ok(fs.existsSync(path.join(dl, "flux", "nested", "flux-deep.pdf")), "a file nested deeper than flux/ is NOT touched");
  ok(r.sidecars.length === 1 && r.sidecars[0].name === N.sidecar, "the sidecar came back for the renderer to resolve");
  ok(fs.existsSync(path.join(inbox, N.science)), "capture landed in pdfs_to_assign/");
  ok(!fs.existsSync(path.join(dl, N.science)), "capture left the download folder");
  ok(fs.existsSync(path.join(dl, N.sidecar)), "sidecar is NOT deleted until the renderer resolves it");

  console.log("\nsupplements (captured in the same click as the article):");
  ok(r.supplements.length === 3, "supplements from both drop points were staged", JSON.stringify(r.supplements));
  const staging = path.join(inbox, "_captured_supplements");
  ok(fs.existsSync(path.join(staging, N.scienceSupp)), "a supplement PDF is staged, NOT filed as an article");
  ok(fs.existsSync(path.join(staging, N.scienceMovie)), "a non-PDF supplement is staged too");
  ok(!fs.existsSync(path.join(inbox, N.scienceSupp)), "…and never reaches the assign inbox itself");
  ok(fs.existsSync(path.join(dl, "flux-supp-@@malformed.pdf")), "a slug-less supplement name is left alone, not filed as a paper");
  {
    const p = rules.parseSupplementCapture(N.scienceSupp);
    ok(rules.doiFromSlug(p.slug) === SCIENCE, "the staged name still identifies its paper — producer to receiver, end to end", rules.doiFromSlug(p.slug));
  }
  // The shipped bug's output, planted alongside: the separator is gone, so this is not a
  // capture and intake must treat it exactly like one of the user's own files.
  ok(fs.existsSync(path.join(dl, MANGLED)), "a separator-less supplement name is NOT picked up (it isn't a capture)", MANGLED);
  ok(!fs.existsSync(path.join(staging, MANGLED)) && !fs.existsSync(path.join(inbox, MANGLED)), "…and reaches neither staging nor the inbox");

  console.log("\ncontainment — the user's own files:");
  for (const d of decoys) ok(fs.existsSync(path.join(dl, d)), `untouched: ${d}`);
  const inboxFiles = fs.readdirSync(inbox).filter((n) => fs.statSync(path.join(inbox, n)).isFile());
  ok(inboxFiles.length === 3, "only article PDFs are in the inbox", JSON.stringify(inboxFiles));

  console.log("\npartial downloads:");
  ok(fs.existsSync(path.join(dl, "flux-tiny.pdf")), "a sub-1KB 'PDF' is left alone (still arriving / a stub)");
  ok(!fs.existsSync(path.join(inbox, "flux-tiny.pdf")), "…and never reaches the inbox");

  console.log("\nidempotence + collisions:");
  const again = await engine.intake();
  ok(again.pdfs.length === 0, "a second pass moves nothing new", JSON.stringify(again.pdfs));
  await fsp.writeFile(path.join(dl, N.science), PDF); // same name again
  const third = await engine.intake();
  ok(third.pdfs[0] === N.science.replace(/\.pdf$/, "-2.pdf"), "a same-named capture is suffixed, never overwritten", JSON.stringify(third.pdfs));

  console.log("\ndiscard is name-scoped:");
  ok((await engine.discard("../../../etc/passwd")).error, "path traversal refused");
  ok((await engine.discard("tax-return-2025.pdf")).error, "a non-capture name refused");
  ok(fs.existsSync(path.join(dl, "tax-return-2025.pdf")), "…and that file still exists");
  ok((await engine.discard(MANGLED)).error, "a separator-less supplement name is refused as a non-capture");
  ok(fs.existsSync(path.join(dl, MANGLED)), "…and that file still exists");
  ok((await engine.discard(N.sidecar)).ok === true, "a real sidecar is discarded");
  ok(!fs.existsSync(path.join(dl, N.sidecar)), "…and is gone");
  ok((await engine.count()) === 0, "…so nothing is left waiting, and the button goes away");

  console.log("\nunresolvable captures are set aside, not retried forever:");
  await fsp.writeFile(path.join(dl, "flux-stuck.fluxcap"), JSON.stringify({ v: 1, url: "https://walled.example/x.pdf", doi: "" }));
  const parked = await engine.park("flux-stuck.fluxcap", "HTTP 403");
  ok(parked.ok === true, "park() moves it out of the download folder", JSON.stringify(parked));
  ok(!fs.existsSync(path.join(dl, "flux-stuck.fluxcap")), "…so it can't re-fail on every startup");
  const unres = path.join(inbox, "_unresolved");
  ok(fs.existsSync(path.join(unres, "flux-stuck.fluxcap")), "…the capture itself is preserved, never deleted");
  ok(fs.readFileSync(path.join(unres, "flux-stuck.fluxcap.txt"), "utf8").includes("HTTP 403"), "…beside a note saying why");
  ok((await engine.park("../../etc/passwd", "x")).error, "park refuses a traversal name");
  ok((await engine.park("tax-return-2025.pdf", "x")).error, "park refuses a non-capture");
  ok(fs.existsSync(path.join(dl, "tax-return-2025.pdf")), "…and leaves that file alone");

  console.log("\nmissing folder:");
  const dead = createCaptureIntake({ captureDir: () => null, fluxLibDir: () => lib, path, fs, fsp, loadRules: () => import("../electron/captureRules.js") });
  const empty = await dead.intake();
  ok(empty.pdfs.length === 0 && empty.sidecars.length === 0, "no download folder → clean no-op, no throw");

  await fsp.rm(tmp, { recursive: true, force: true });
  console.log(failures ? `\nCAPTURE E2E: FAIL (${failures})` : "\nCAPTURE E2E: PASS");
  app.exit(failures ? 1 : 0);
}

app.whenReady().then(main);
