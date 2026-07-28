#!/usr/bin/env -S npx tsx
// slide-migration §3.10/§7.1 — the headless agent contract (the /flux skill's
// deck-building path), driven through the REAL CLI with the app closed:
//   new-deck → add-slide → add-text → add-figure (the repurposed
//   add_slide_figure: copy semantics) → add-beat → set-animation → export-deck
// and the exported .html presents: self-contained (no external URLs), carries
// the deck payload + runtime, and boots headlessly to slide 1 / advances a
// beat with zero network requests.
//   npx tsx scripts/verify-slide-headless-e2e.ts

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scaffold, createFigure, addFigText, importPlots, addFigureToSlide, addBeat, setMorph } from "../flux-core/index";

const execFileP = promisify(execFile);
function assert(c: unknown, m: string) { if (!c) throw new Error("FAIL: " + m); console.log("  ok:", m); }

const repo = path.join(import.meta.dirname, "..");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-slide-e2e-"));

async function flux(...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileP("npx", ["tsx", path.join(repo, "flux-cli.ts"), ...args, "--root", root], {
    cwd: repo,
    timeout: 120_000,
  });
}

try {
  await scaffold(root, { title: "E2E Talk" });
  // a real paper figure to copy in (two texts so the copy is multi-element)
  await createFigure(root, { id: "resfig", name: "Results" });
  await addFigText(root, "resfig", { text: "PANEL A", x: 40, y: 60 });
  await addFigText(root, "resfig", { text: "PANEL B", x: 40, y: 420 });

  // --- the CLI session (app closed) ---------------------------------------------
  await flux("new-deck", "--id", "talk", "--title", "Defense");
  const { stdout: slideOut } = await flux("add-slide", "talk", "--name", "Results", "--layout", "blank");
  const slideId = (await (async () => {
    const deck = JSON.parse(await fs.readFile(path.join(root, "slides", "talk", "deck.json"), "utf8"));
    return deck.slides.at(-1).id as string;
  })());
  void slideOut;
  const { stdout: textOut } = await flux("add-text", "talk", slideId, "Growth doubles under stress", "--x", "40", "--y", "30", "--size-pt", "18");
  const textId = textOut.trim();
  assert(/^text-|^el-|^t/.test(textId) || textId.length > 3, `add-text printed the element id (${textId})`);
  const { stdout: figOut } = await flux("add-figure", "talk", slideId, "resfig");
  const figIds = figOut.trim().split("\n").filter(Boolean);
  assert(figIds.length === 2, `add-figure copied 2 elements (got ${figIds.length})`);
  const { stdout: beatOut } = await flux("add-beat", "talk", slideId, "--label", "reveal");
  const beatId = beatOut.trim();
  await flux("set-animation", "talk", slideId, beatId, "--target", textId, "--preset", "fadeRise", "--duration", "400");
  await flux("set-animation", "talk", slideId, beatId, "--target", figIds[0], "--preset", "fade", "--duration", "300");

  // --- cascade-tracks EXECUTES through the registry (not just parses) ---------------
  // The handler crosses index.ts's explicit re-export list, which once silently
  // dropped cascadeTracksVerb — this is the invocation pin behind registry-parity (e).
  const beatTracks = async () =>
    (JSON.parse(await fs.readFile(path.join(root, "slides", "talk", "deck.json"), "utf8")) as
      { slides: { id: string; beats: { id: string; tracks: { id: string; start?: number }[] }[] }[] })
      .slides.find((s) => s.id === slideId)!.beats.find((b) => b.id === beatId)!.tracks;
  const cascIds = (await beatTracks()).map((t) => t.id);
  assert(cascIds.length === 2, `the reveal beat carries 2 tracks (got ${cascIds.length})`);
  const { stderr: cascErr } = await flux("cascade-tracks", "talk", slideId, "start",
    "--tracks", cascIds.join(","), "--delta", "250", "--first-fixed");
  assert(/cascaded start across 2 track/.test(cascErr), "cascade-tracks reported both tracks");
  const starts = (await beatTracks()).map((t) => t.start ?? 0);
  assert(starts[0] === 0 && starts[1] === 250,
    `first-fixed start cascade stepped 0/250 in lane order (got ${starts.join("/")})`);

  const { stderr: exportErr } = await flux("export-deck", "talk");
  assert(/exported/i.test(exportErr), "export-deck reported success");

  // --- deck shape on disk -----------------------------------------------------------
  const deck = JSON.parse(await fs.readFile(path.join(root, "slides", "talk", "deck.json"), "utf8"));
  assert(deck.schemaVersion === "0.3.0", "deck is the 0.3.0 animation-rework format");
  const slide = deck.slides.find((s: { id: string }) => s.id === slideId);
  assert(slide.elements.every((e: { type: string }) => ["text", "rect", "ellipse", "line", "path", "image", "plot"].includes(e.type)), "every element is the FIGURE union");
  assert(slide.elements.some((e: { text?: string }) => e.text === "PANEL A"), "the copied figure content is real elements in the deck");

  // --- set-morph persists explicit target paths for fig-derived plots ----------------
  // A morph target lives only in the track's `to` (never as an element); a bare
  // assetId left the GUI preview unable to resolve figure-derived targets (no
  // plots/ entry) and the morph silently held at A in the app while the export
  // worked. setMorph must probe the conventional locations and persist them.
  const plotSvg = (ys: number[]) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="400"><g id="s.line"><path d="M40 ${ys[0]} L440 ${ys[1]}" stroke="#000" fill="none"/></g></svg>`;
  const plotManifest = (ys: number[]) => JSON.stringify({
    spec: "fluxplot", schemaVersion: "1", plotType: "line", svg: "", size: { width: 480, height: 400, unit: "px" },
    axes: [{ x: { scale: "linear", domain: [0, 5], anchors: [{ data: 0, svg: 40 }, { data: 5, svg: 440 }] },
             y: { scale: "linear", domain: [0, 10], anchors: [{ data: 0, svg: 380 }, { data: 10, svg: 20 }] } }],
    series: [{ id: "s", svg: { line: "s.line" }, data: { x: [1, 4], y: ys } }],
  });
  await fs.writeFile(path.join(root, "mA.svg"), plotSvg([300, 100]));
  await fs.writeFile(path.join(root, "mA.fluxplot.json"), plotManifest([2, 8]));
  await fs.writeFile(path.join(root, "mB.svg"), plotSvg([100, 300]));
  await fs.writeFile(path.join(root, "mB.fluxplot.json"), plotManifest([8, 2]));
  await createFigure(root, { id: "morphfig", name: "Morph pair" });
  const impA = await importPlots(root, "morphfig", [path.join(root, "mA.svg")]);
  const impB = await importPlots(root, "morphfig", [path.join(root, "mB.svg")]);
  const [aId, bId] = [impA.panels[0].assetId, impB.panels[0].assetId];
  const { elementIds: morphEls } = await addFigureToSlide(root, "talk", slideId, "morphfig", { x: 40, y: 120 });
  const plotEl = (JSON.parse(await fs.readFile(path.join(root, "slides", "talk", "deck.json"), "utf8")) as
    { slides: { id: string; elements: { id: string; type: string; assetId?: string }[] }[] })
    .slides.find((s) => s.id === slideId)!.elements.find((e) => morphEls.includes(e.id) && e.type === "plot" && e.assetId === aId);
  assert(!!plotEl, "the fig-derived plot A landed on the slide");
  const { beatId: morphBeat } = await addBeat(root, "talk", slideId, { label: "morph" });
  await setMorph(root, "talk", slideId, morphBeat, plotEl!.id, bId, { duration: 500 });
  const deckM = JSON.parse(await fs.readFile(path.join(root, "slides", "talk", "deck.json"), "utf8"));
  const mTrack = deckM.slides.find((s: { id: string }) => s.id === slideId)
    .beats.flatMap((b: { tracks: unknown[] }) => b.tracks)
    .find((t: { preset: string }) => t.preset === "morph") as { to?: { assetId?: string; svgPath?: string; manifestPath?: string } };
  assert(mTrack?.to?.assetId === bId, "morph track targets plot B");
  assert(mTrack?.to?.svgPath === `fig/assets/${bId}.svg`, `set-morph persisted the fig-derived svgPath (got ${mTrack?.to?.svgPath})`);
  assert(mTrack?.to?.manifestPath === `fig/assets/${bId}.fluxplot.json`, "set-morph persisted the sibling manifestPath");
  await flux("export-deck", "talk"); // re-export with the morph slide in place

  // --- the export is self-contained ---------------------------------------------------
  const html = await fs.readFile(path.join(root, "exports", "talk.html"), "utf8");
  assert(html.includes("Growth doubles under stress") && html.includes("PANEL A"), "exported HTML carries the authored content");
  assert(!/\bhttps?:\/\/(?!www\.w3\.org)/.test(html.replace(/xmlns(:\w+)?="[^"]*"/g, "")), "no external http(s) references (offline by construction)");
  assert(html.includes("FluxSlideRuntime"), "the runtime IIFE is inlined");

  // --- and it PRESENTS: boot headless, advance a beat, zero network ------------------
  const { launch } = await import("./lib/driver.mjs");
  const { browser, page } = await launch();
  try {
    const requests: string[] = [];
    page.on("request", (r: { url(): string }) => {
      if (!r.url().startsWith("file://") && !r.url().startsWith("data:")) requests.push(r.url());
    });
    await page.goto("file://" + path.join(root, "exports", "talk.html"), { waitUntil: "networkidle0" });
    const boot = await page.evaluate(() => {
      const hook = (window as unknown as { fluxDeck?: { state(): { slide: number; beat: number }; slideCount: number; beatsOf(s: number): number } }).fluxDeck;
      const stageText = document.getElementById("flux-stage")?.textContent ?? "";
      return { hasHook: !!hook, state: hook?.state(), slideCount: hook?.slideCount, stageText: stageText.slice(0, 400) };
    });
    assert(boot.hasHook && boot.slideCount === 2, `runtime booted (${boot.slideCount} slides)`);
    assert(boot.state?.slide === 0 && boot.state?.beat === 0, "opens at slide 1, resting beat");
    // advance to the animated slide + its beat
    await page.evaluate(() => {
      const hook = (window as unknown as { fluxDeck: { goTo(s: number, b: number): void } }).fluxDeck;
      hook.goTo(1, 1);
    });
    const after = await page.evaluate(() => {
      const hook = (window as unknown as { fluxDeck: { state(): { slide: number; beat: number } } }).fluxDeck;
      const stageText = document.getElementById("flux-stage")?.textContent ?? "";
      return { state: hook.state(), hasContent: stageText.includes("Growth doubles under stress") && stageText.includes("PANEL A") };
    });
    assert(after.state.slide === 1 && after.state.beat === 1, "advanced to the animated beat");
    assert(after.hasContent, "the presented slide shows the text + the copied figure content");
    assert(requests.length === 0, `zero network requests while presenting (got ${requests.length})`);
  } finally {
    await browser.close();
  }

  console.log("\nSLIDE HEADLESS E2E (CLI new-deck→…→export, presents offline): PASS");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
