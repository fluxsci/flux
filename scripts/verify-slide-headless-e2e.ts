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
import { scaffold, createFigure, addFigText } from "../flux-core/index";

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
  const { stderr: exportErr } = await flux("export-deck", "talk");
  assert(/exported/i.test(exportErr), "export-deck reported success");

  // --- deck shape on disk -----------------------------------------------------------
  const deck = JSON.parse(await fs.readFile(path.join(root, "slides", "talk", "deck.json"), "utf8"));
  assert(deck.schemaVersion === "0.2.0", "deck is the 0.2.0 slides-are-figures format");
  const slide = deck.slides.find((s: { id: string }) => s.id === slideId);
  assert(slide.elements.every((e: { type: string }) => ["text", "rect", "ellipse", "line", "path", "image", "plot"].includes(e.type)), "every element is the FIGURE union");
  assert(slide.elements.some((e: { text?: string }) => e.text === "PANEL A"), "the copied figure content is real elements in the deck");

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
