#!/usr/bin/env -S npx tsx
import { atomicWrite } from "../flux-core/fsx";
// WS-5.4 (fortify plan) — per-file divergence detection, driven through the REAL
// renderer bridges (figbridge + slideBridge) under Node with an fs-backed
// FileBridge shim:
//   · an external edit to ONE canvas file (index untouched — the case the old
//     index-only guard missed) flips figDiskDiverged and makes saveFigFrom throw
//     ConflictError with the external bytes SURVIVING;
//   · force ("Overwrite with mine") wins even when the model text still matches
//     our stale baseline (the skip-unchanged interaction);
//   · an externally DELETED canvas counts as divergence;
//   · decks: same mechanism, which they previously had NONE of.
//   npx tsx scripts/verify-canvas-divergence.ts

import "./lib/cssStub.mjs";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let failures = 0;
const ok = (m: string) => console.log("  ok:", m);
const fail = (m: string) => {
  console.error("  ✗ FAIL:", m);
  failures++;
};
const assert = (c: unknown, m: string) => (c ? ok(m) : fail(m));

// ---- an fs-backed FileBridge (the mem/demo bridge shape, but on a real tmp dir;
// no fsyncDir/journalAppend — the optional-member paths must tolerate that) ----
const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-diverge-"));
const bridge = {
  remove: (p: string) => fs.rm(p,{force:true}),
  exists: (p: string) => fs.access(p).then(() => true, () => false),
  readText: (p: string) => fs.readFile(p, "utf8"),
  writeText: (p: string, t: string) => atomicWrite(p, t),
  readFile: async (p: string) => {const bytes=await fs.readFile(p);return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)},
  writeFile: (p: string, b: Uint8Array) => atomicWrite(p, b),
  mkdir: (p: string) => fs.mkdir(p, { recursive: true }).then(() => {}),
};
(globalThis as Record<string, unknown>).window = { fig: bridge };

const { scaffold, createFigure } = await import("../flux-core/index");
const { loadFigInto, saveFigFrom, figDiskDiverged } = await import("../src/lib/project/figbridge");
const { project: figProject, embeddedProjectRoot } = await import("../src/lib/store");
const { ConflictError } = await import("../src/lib/autosave");
const slideBridge = await import("../src/lib/project/slideBridge");
const { deckOverlay, commitDeckLive } = await import("../src/lib/slide/store");
const { setStoreTenant } = await import("../src/lib/tenancy");

try {
  // ---- figure subsystem -------------------------------------------------------
  await scaffold(root, { title: "Diverge" });
  await createFigure(root, { name: "Alpha" });
  await loadFigInto(root, "Diverge");
  assert(!(await figDiskDiverged(root)), "freshly loaded: not diverged");

  const idx = JSON.parse(await fs.readFile(path.join(root, "fig", "index.json"), "utf8"));
  const canvasId = idx.canvases[0].id as string;
  const cvPath = path.join(root, "fig", "canvases", `${canvasId}.json`);
  const indexBytes = await fs.readFile(path.join(root, "fig", "index.json"), "utf8");

  // External in-place canvas edit: same figure set → the index stays IDENTICAL.
  const cf = JSON.parse(await fs.readFile(cvPath, "utf8"));
  cf.figures[0].x = 777; // the agent nudged a figure
  const externalText = JSON.stringify(cf, null, 2) + "\n";
  await fs.writeFile(cvPath, externalText);
  assert(
    (await fs.readFile(path.join(root, "fig", "index.json"), "utf8")) === indexBytes,
    "external canvas edit left the index byte-identical (the blind spot)",
  );
  assert(await figDiskDiverged(root), "canvas-only external edit IS detected");

  // The GUI has its own local edit → autosave must refuse, external bytes survive.
  figProject.update((p) => {
    p.figures[0].name = "Alpha (mine)";
    return p;
  });
  let threw: unknown;
  try {
    await saveFigFrom(root);
  } catch (e) {
    threw = e;
  }
  assert(threw instanceof ConflictError, "saveFigFrom threw ConflictError (not a plain error)");
  assert((await fs.readFile(cvPath, "utf8")) === externalText, "external canvas bytes SURVIVED the refused save");

  // Overwrite-with-mine: force wins even though our model still serializes to
  // the stale baseline for the canvas (skip-unchanged must not skip it).
  figProject.update((p) => {
    p.figures[0].name = "Alpha"; // back to exactly what our baseline says
    return p;
  });
  await saveFigFrom(root, { force: true });
  const afterForce = JSON.parse(await fs.readFile(cvPath, "utf8"));
  assert(afterForce.figures[0].x !== 777, "force-save clobbered the external edit (editor wins)");
  assert(!(await figDiskDiverged(root)), "after force-save: baselines re-adopted, not diverged");

  // External DELETION of a baselined canvas is divergence too.
  const savedBytes = await fs.readFile(cvPath);
  await fs.rm(cvPath);
  assert(await figDiskDiverged(root), "externally DELETED canvas counts as diverged");
  await fs.writeFile(cvPath, savedBytes);
  assert(!(await figDiskDiverged(root)), "restoring the file clears the divergence");

  // The actual overwrite operation preserves unreadable/deleted branches and
  // chooses the editor caption in BOTH representations, before reopening.
  for(const kind of ["deleted-canvas","corrupt-canvas","corrupt-index","caption-dual"]){
    await loadFigInto(root,"Diverge");
    const indexPath=path.join(root,"fig/index.json");
    const get=(await import("svelte/store")).get;
    const figureId=get(figProject).figures[0].id;
    const captionPath=path.join(root,`fig/captions/${figureId}.md`);
    figProject.update(p=>{p.figures[0].captions={__figure__:"EDITOR CAPTION"};return p});
    if(kind==="deleted-canvas")await fs.rm(cvPath);
    if(kind==="corrupt-canvas")await fs.writeFile(cvPath,"{CORRUPT CANVAS");
    if(kind==="corrupt-index")await fs.writeFile(indexPath,"{CORRUPT INDEX");
    if(kind==="caption-dual")await fs.writeFile(captionPath,"EXTERNAL CAPTION\n");
    const beforeRecords=await fs.readdir(path.join(root,".meta/figure-conflicts"));
    await saveFigFrom(root,{force:true});
    const afterRecords=await fs.readdir(path.join(root,".meta/figure-conflicts"));
    const added=afterRecords.filter(n=>!beforeRecords.includes(n));assert(added.length===1,kind+": exactly one preservation record");
    const record=JSON.parse(await fs.readFile(path.join(root,".meta/figure-conflicts",added[0]),"utf8"));
    assert(record.winner==="editor including captions",kind+": explicit caption winner");
    if(kind==="deleted-canvas")assert(record.theirs[`fig/canvases/${canvasId}.json`]===null,"deleted file recorded as absent");
    if(kind==="corrupt-canvas")assert(record.theirs[`fig/canvases/${canvasId}.json`]==="{CORRUPT CANVAS","corrupt canvas bytes recoverable");
    if(kind==="corrupt-index")assert(record.theirs["fig/index.json"]==="{CORRUPT INDEX","corrupt index bytes recoverable");
    if(kind==="caption-dual")assert(record.theirs[`fig/captions/${figureId}.md`]==="EXTERNAL CAPTION\n","external caption recoverable");
    await loadFigInto(root,"Diverge");assert(get(figProject).figures[0].captions?.__figure__==="EDITOR CAPTION",kind+": editor caption reopens");
    assert((await fs.readFile(captionPath,"utf8")).includes("EDITOR CAPTION"),kind+": Markdown mirror agrees");
  }
  const beforeFuture=await fs.readFile(cvPath,"utf8"),future=JSON.parse(beforeFuture);future.schemaVersion="99.0.0";const futureBytes=JSON.stringify(future);await fs.writeFile(cvPath,futureBytes);
  let futureRefused=false;try{await saveFigFrom(root,{force:true})}catch{futureRefused=true}assert(futureRefused,"force refuses a future schema");assert(await fs.readFile(cvPath,"utf8")===futureBytes,"future bytes never downgraded");await fs.writeFile(cvPath,beforeFuture);

  // ---- deck mirror --------------------------------------------------------------
  const created = await slideBridge.createDeckInProject(root, { title: "Talk" });
  const deckId = created.id;
  assert(!!deckId, "created a deck");
  setStoreTenant("slide"); // claim the resident adapter before its asynchronous load
  embeddedProjectRoot.set(root);
  await slideBridge.loadDeckInto(root, deckId);
  assert(!(await slideBridge.deckDiskDiverged(root, deckId)), "deck freshly loaded: not diverged");

  const deckPath = path.join(root, "slides", deckId, "deck.json");
  const external = JSON.parse(await fs.readFile(deckPath, "utf8"));
  external.title = "Talk (agent)";
  const externalDeck = JSON.stringify(external, null, 2) + "\n";
  await fs.writeFile(deckPath, externalDeck);
  assert(await slideBridge.deckDiskDiverged(root, deckId), "external deck edit IS detected");

  setStoreTenant("slide"); // the slide-mode lifecycle claim (saveDeckFrom asserts it)
  commitDeckLive((d) => {
    d.title = "Talk (mine)";
  });
  threw = undefined;
  try {
    await slideBridge.saveDeckFrom(root);
  } catch (e) {
    threw = e;
  }
  assert(threw instanceof ConflictError, "saveDeckFrom threw ConflictError");
  assert((await fs.readFile(deckPath, "utf8")) === externalDeck, "external deck bytes SURVIVED the refused save");

  await slideBridge.saveDeckFrom(root, { force: true });
  const deckAfter = JSON.parse(await fs.readFile(deckPath, "utf8"));
  assert(deckAfter.title === "Talk (mine)", "deck force-save: editor wins");
  assert(!(await slideBridge.deckDiskDiverged(root, deckId)), "deck baseline re-adopted after force-save");

  // Reload-theirs path: loadDeckInto re-seeds the baseline from disk.
  await fs.writeFile(deckPath, externalDeck);
  await slideBridge.loadDeckInto(root, deckId);
  assert(!(await slideBridge.deckDiskDiverged(root, deckId)), "reload-theirs re-seeds the deck baseline");
  const d = (await import("svelte/store")).get(deckOverlay);
  assert(d?.title === "Talk (agent)", "reload-theirs actually loaded the external version");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log(failures ? `\nCANVAS DIVERGENCE: FAIL (${failures})` : "\nCANVAS DIVERGENCE: PASS");
process.exit(failures ? 1 : 0);
