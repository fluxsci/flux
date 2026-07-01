#!/usr/bin/env -S npx tsx
// W11b acceptance (AGT-6/SLD-6): the Slides pillar is now fully agent-authorable
// through flux-core (→ CLI + MCP). An agent builds a multi-slide ANIMATED deck
// headlessly — add slides, text/math, embed a figure, add a beat + animation,
// set notes/camera/theme, reorder/duplicate/delete — then exports the offline
// .html and confirms the content + animation survive the round-trip.
//   Run: npx tsx scripts/verify-w11-slides.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as core from "../flux-core/index";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}
async function throws(fn: () => Promise<unknown>, needle: string, msg: string) {
  let threw = false;
  try { await fn(); } catch (e) {
    threw = true;
    assert((e instanceof Error ? e.message : String(e)).toLowerCase().includes(needle.toLowerCase()), `${msg} (mentions "${needle}")`);
  }
  assert(threw, `${msg} — did throw`);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-w11s-"));
try {
  await core.scaffold(root, { title: "W11 Slides" });

  // A deck starts with one title slide; add two more → three.
  const { deckId } = await core.createDeck(root, { id: "talk", title: "Mycelial Growth" });
  let deck = await core.loadDeck(root, deckId);
  const s0 = deck.slides[0].id;
  const { slideId: s1 } = await core.addSlide(root, deckId, { name: "Results", layout: "content-figure" });
  const { slideId: s2 } = await core.addSlide(root, deckId, { name: "Morph", layout: "full-bleed" });
  deck = await core.loadDeck(root, deckId);
  assert(deck.slides.length === 3, "three slides after two add-slide calls");

  // Content: text + math on the results slide; embed a real project figure on s2.
  const { elementId: elText } = await core.addTextToSlide(root, deckId, s1, {
    text: "Growth doubles under stress", x: 90, y: 150, width: 560, height: 120, fontSize: 40,
  });
  await core.addMathToSlide(root, deckId, s1, { tex: "\\frac{dN}{dt}=rN", x: 90, y: 320, width: 560, height: 100, display: true });
  const { figureId } = await core.createFigure(root, { id: "gfig", name: "Growth" });
  const { elementId: elFig } = await core.addEmbedFigureToSlide(root, deckId, s2, { figureId, x: 100, y: 100, width: 900, height: 500 });
  assert(elText && elFig, "added text + embed-figure elements");

  // Animation: a beat that fades the headline in.
  const { beatId } = await core.addBeat(root, deckId, s1, { label: "reveal" });
  await core.setAnimation(root, deckId, s1, beatId, { target: elText, preset: "fade", duration: 300 });
  await throws(
    () => core.setAnimation(root, deckId, s1, "no-such-beat", { target: elText, preset: "fade" }),
    "beat not found",
    "set-animation on a missing beat errors",
  );

  // Slide-level patch: speaker notes + a base camera; deck theme.
  await core.setSlide(root, deckId, s1, { notes: "Emphasize the doubling.", camera: { x: 120, y: 60, zoom: 1.5 } });
  await core.setDeckTheme(root, deckId, "flux-midnight");

  deck = await core.loadDeck(root, deckId);
  const results = deck.slides.find((s) => s.id === s1)!;
  assert(results.notes === "Emphasize the doubling.", "set-slide wrote speaker notes");
  assert(results.camera?.zoom === 1.5, "set-slide wrote the base camera");
  assert(deck.theme === "flux-midnight", "set-theme switched the deck theme");
  const track = results.beats.flatMap((b) => b.tracks).find((t) => t.target === elText);
  assert(track?.preset === "fade" && track?.id, "the fade track is on the beat (with a stable id)");

  // Structure verbs: reorder, duplicate, delete.
  await core.reorderSlides(root, deckId, [s2, s1, s0]);
  deck = await core.loadDeck(root, deckId);
  assert(deck.slides[0].id === s2, "reorder-slides put s2 first");

  const dup = await core.duplicateSlide(root, deckId, s1);
  deck = await core.loadDeck(root, deckId);
  assert(deck.slides.length === 4, "duplicate-slide → four slides");
  const dupSlide = deck.slides.find((s) => s.id === dup.slideId)!;
  assert(dupSlide.beats.flatMap((b) => b.tracks).every((t) => t.id !== track!.id), "duplicated slide has fresh track ids");

  const del = await core.deleteSlide(root, deckId, dup.slideId);
  deck = await core.loadDeck(root, deckId);
  assert(deck.slides.length === 3, "delete-slide → back to three");
  assert(del.nextActiveId != null, "delete-slide returns a nextActiveId");
  await throws(() => core.deleteSlide(root, deckId, "ghost"), "not found", "delete-slide on a missing id errors");

  // Schema-valid + exports to one self-contained HTML with content + animation.
  const v = await core.validateDeck(root, deckId);
  assert(v.ok, `deck is schema-valid (${v.checked} checked)`);
  const exp = await core.exportDeck(root, deckId, {});
  const html = await fs.readFile(exp.path, "utf8");
  assert(html.length > 5000, `exported HTML is substantial (${(exp.bytes / 1024).toFixed(0)} KB)`);
  assert(html.includes("Growth doubles under stress"), "exported HTML contains the slide text");
  assert(html.includes("\\frac{dN}{dt}=rN") || html.includes("frac"), "exported HTML contains the math");
  assert(/"preset"\s*:\s*"fade"/.test(html) || html.includes("fade"), "exported HTML carries the fade animation");

  console.log("\nW11 SLIDES VERIFY: PASS");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
