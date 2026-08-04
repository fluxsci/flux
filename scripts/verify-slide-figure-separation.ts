#!/usr/bin/env -S npx tsx
// slide-migration §1/§7.1 — the HARD SEPARATION: slides must never appear in
// the paper's @fig reference menu or figure numbering. Structural proof:
//   • the paper's figureRefs come from readFigSource, which reads ONLY
//     fig/index.json — decks live under slides/ and are physically absent
//   • a full slide-authoring session (create deck, slides, elements, save)
//     leaves the fig/ tree byte-identical
//   • Send to canvas is the ONE sanctioned crossing — the sent figure DOES
//     appear in fig/index.json (it is now a paper figure; @fig is correct)
//   npx tsx scripts/verify-slide-figure-separation.ts

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as core from "../flux-core/index";
import * as slideOps from "../src/lib/slide/ops";

function assert(c: unknown, m: string) { if (!c) throw new Error("FAIL: " + m); console.log("  ok:", m); }

/** Stable snapshot of the whole fig/ tree (path → bytes). */
async function figTree(root: string): Promise<string> {
  const out: Record<string, string> = {};
  const walk = async (dir: string, rel: string) => {
    let es: import("node:fs").Dirent[] = [];
    try { es = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es.sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(dir, e.name), r);
      else out[r] = (await fs.readFile(path.join(dir, e.name))).toString("base64");
    }
  };
  await walk(path.join(root, "fig"), "");
  return JSON.stringify(out);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-sep-"));
try {
  await core.scaffold(root, { title: "Separation" });
  const { figureId } = await core.createFigure(root, { id: "paperfig", name: "Paper Figure" });
  await core.addFigText(root, figureId, { text: "REAL FIGURE", x: 20, y: 20 });

  const before = await figTree(root);
  const figIndexBefore = JSON.parse(await fs.readFile(path.join(root, "fig", "index.json"), "utf8"));

  // A full slide-authoring session: deck, slides, text, a figure COPY, beats.
  const { deckId } = await core.createDeck(root, { id: "talk", title: "Talk" });
  const { slideId } = await core.addSlide(root, deckId, { name: "S1", layout: "title" });
  await core.addTextToSlide(root, deckId, slideId, { text: "slide words", x: 10, y: 10 });
  await core.addFigureToSlide(root, deckId, slideId, figureId, {});
  const { beatId } = await core.addBeat(root, deckId, slideId, {});
  const deck = await core.loadDeck(root, deckId);
  await core.setAnimation(root, deckId, slideId, beatId, { target: deck.slides.at(-1)!.elements[0].id, preset: "fade" });
  await core.exportDeck(root, deckId, { out: path.join(root, "exports", "talk.html") });

  // Figure families (2026-08): family identity is a FIG-subsystem concept —
  // a round-tripped deck slide must never pick up family/number/nickname
  // (migrateFigureFamilies deliberately does not run on deck projections).
  assert(
    deck.slides.every((s) => !("family" in s) && !("number" in (s as object))),
    "deck slides carry no figure-family identity keys",
  );

  // 1. fig/ untouched — byte-identical tree.
  assert((await figTree(root)) === before, "a full slide-authoring session leaves the fig/ tree BYTE-IDENTICAL");

  // 2. The deck registry and the figure index are disjoint namespaces.
  const manifest = JSON.parse(await fs.readFile(path.join(root, "project.json"), "utf8"));
  assert(manifest.slides.some((s: { id: string }) => s.id === deckId), "the deck registered in project.json.slides[]");
  const figIndex = JSON.parse(await fs.readFile(path.join(root, "fig", "index.json"), "utf8"));
  assert(JSON.stringify(figIndex) === JSON.stringify(figIndexBefore), "fig/index.json (the @fig source) unchanged");
  const figIds = new Set((figIndex.figures ?? []).map((f: { id: string }) => f.id));
  assert(!figIds.has(deckId) && ![...(deck.slides.map((s) => s.id))].some((id) => figIds.has(id)), "no deck/slide id ever enters the figure index (the @fig namespace)");

  // 3. list_project's figures[] (the paper's other rollup) carries no slides.
  const listing = (await core.listProject(root)) as { figures?: { id: string }[] };
  assert(!(listing.figures ?? []).some((f) => f.id === deckId || deck.slides.some((s) => s.id === f.id)), "list_project figures[] carries no deck/slide ids");

  // 4. The ONE sanctioned crossing: the shared clone core makes a REAL figure.
  //    (GUI Send-to-canvas wraps the same cloneContentWithFreshIds + createFigure
  //    + the fig persistence core — asserted structurally by the roundtrip gate;
  //    here the headless twin proves the fig/ index gains exactly one figure.)
  {
    const model = await core.loadFigModel(root);
    const canvasId = model.project.canvases[0].id;
    const src = deck.slides[0];
    const before2 = model.project.figures.length;
    await core.mutateFigModel(root, "send_slide_to_canvas_test", async ({ project }: { project: typeof model.project }) => {
      const { cloneContentWithFreshIds } = await import("../src/lib/slide/deckProject");
      const ops = await import("../src/lib/ops");
      const { elements, groups } = cloneContentWithFreshIds(src.elements, src.groups);
      const fig = ops.createFigure(project, { canvasId, name: "From Slide", width: deck.stage.width, height: deck.stage.height });
      fig.elements = elements;
      if (Object.keys(groups).length) fig.groups = groups;
    });
    const after = await core.loadFigModel(root);
    assert(after.project.figures.length === before2 + 1, "send-to-canvas adds a REAL paper figure (it now correctly appears in @fig)");
    const idx = JSON.parse(await fs.readFile(path.join(root, "fig", "index.json"), "utf8"));
    // Figure families (2026-08): `name` is derived (family + number); a
    // descriptive createFigure name survives as the NICKNAME.
    assert(
      (idx.figures ?? []).some(
        (f: { name?: string; nickname?: string }) =>
          f.nickname === "From Slide" && /^Figure \d+$/.test(f.name ?? ""),
      ),
      "…and it is in fig/index.json (the @fig source; slide name → nickname, name derived)",
    );
  }

  // 5. Static guard: the slide bridge never imports the fig writer.
  const bridgeSrc = await fs.readFile(path.join(import.meta.dirname, "..", "src", "lib", "project", "slideBridge.ts"), "utf8");
  assert(!/saveFigFrom|executeFigSave|planFigSave/.test(bridgeSrc), "slideBridge has no code path into the fig/ writer (structural)");
  assert(/assertStoreTenant\("slide"/.test(bridgeSrc), "saveDeckFrom asserts slide tenancy (the cross-write backstop)");
  const figbridgeSrc = await fs.readFile(path.join(import.meta.dirname, "..", "src", "lib", "project", "figbridge.ts"), "utf8");
  assert(/assertStoreTenant\("figure"/.test(figbridgeSrc), "saveFigFrom asserts figure tenancy (the reverse backstop)");
  void slideOps;
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log("\nSLIDE ⇄ FIGURE SEPARATION: PASS");
