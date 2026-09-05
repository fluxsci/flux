#!/usr/bin/env -S npx tsx
// W14 — Coexistence polish.
//  • AGT-12 (tested for real): compose-figure pre-flights every input, so a bad plot path
//    partway through no longer leaves the earlier plots' asset files orphaned on disk — a
//    botched compose writes nothing. A valid compose still works.
//  • AGT-10 (presence): the live-bridge onDispatch flushes the figure subsystem before
//    replying, so an agent's get_figure_image right after dispatch_command isn't stale. The
//    flush path is Electron-only (loopback bridge); dispatchCommand itself is covered by
//    verify-an-bridge, so here we assert the wiring is present.
//  • SLD-13 (presence): the player's prevSlide now cancelActive()s (bumps gen), so a stale
//    settle() can't fire beatEnd on the newly-shown slide. Covered end-to-end by the slide
//    e2e regression's prev/next navigation; asserted present here.
//   Run: npx tsx scripts/verify-w14-coexistence.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as core from "../flux-core/index";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}
async function listOrEmpty(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-w14-"));
try {
  await core.scaffold(root, { title: "W14" });
  const plotsDir = path.join(root, "plots");
  await fs.mkdir(plotsDir, { recursive: true });
  const good1 = path.join(plotsDir, "a.svg");
  const good2 = path.join(plotsDir, "b.svg");
  const missing = path.join(plotsDir, "does-not-exist.svg");
  for (const p of [good1, good2]) {
    await fs.writeFile(p, `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="90"></svg>`);
  }

  // --- AGT-12: a bad input midway writes NOTHING (no orphaned assets) ----------------------
  const assetsDir = path.join(root, "fig", "assets");
  const before = await listOrEmpty(assetsDir);
  let threw = false;
  try {
    await core.composeFigure(root, [good1, missing, good2], { id: "bad-compose" });
  } catch (e) {
    threw = true;
    assert(/not readable/.test(String((e as Error).message)), "compose-figure rejects the missing input");
  }
  assert(threw, "compose-figure with a bad input threw (didn't half-succeed)");
  const after = await listOrEmpty(assetsDir);
  assert(after.length === before.length, `no orphaned asset files written (assets/: ${before.length} → ${after.length})`);

  // --- and a valid compose still works end-to-end -----------------------------------------
  const res = await core.composeFigure(root, [good1, good2], { id: "good-compose" });
  assert(res.figureId === "good-compose" && res.panels.length === 2, "valid compose writes a 2-panel figure");
  assert((await listOrEmpty(assetsDir)).length >= 2, "valid compose wrote its asset files");

  // --- AGT-10 + SLD-13: presence of the wiring (Electron-only / DOM-timing paths) ----------
  const dir = path.dirname(new URL(import.meta.url).pathname);
  const install = await fs.readFile(path.join(dir, "..", "src", "lib", "bridge", "install.ts"), "utf8");
  assert(/await flushById\("figure"\)/.test(install), "AGT-10: onDispatch flushes the figure subsystem before replying");
  const { parseHTML } = await import("linkedom");
  const { document } = parseHTML("<html><body></body></html>");
  Object.assign(globalThis, { document });
  const { createPlayer } = await import("../src/lib/slide/player/player");
  const { createDeck } = await import("../src/lib/slide/ops");
  const { FLUX_DARK } = await import("../src/lib/slide/theme");
  const deck = createDeck({ withTitleSlide: false }); deck.defaults.transition = "none";
  const slide = { id: "a", elements: [{ id: "r", type: "rect" as const, x: 0, y: 0, width: 20, height: 20, rotation: 0, fill: "red", stroke: "none", strokeWidth: 0 }], beats: [{ id: "base", tracks: [] }, { id: "show", tracks: [{ target: "r", preset: "fade" as const, duration: 1000 }] }] };
  deck.slides = [slide, { ...structuredClone(slide), id: "b" }];
  const oldRaf = globalThis.requestAnimationFrame, oldCancel = globalThis.cancelAnimationFrame;
  const callbacks: FrameRequestCallback[] = [];
  Object.assign(globalThis, { requestAnimationFrame: (cb: FrameRequestCallback) => callbacks.push(cb), cancelAnimationFrame: () => {} });
  try {
    const player = createPlayer(document.createElement("div"), deck, { theme: FLUX_DARK, reducedMotion: false });
    let ended = 0; player.on("beatEnd", () => ended++);
    player.play({ slide: 1, fromBeat: 1 }); player.prevSlide();
    for (const callback of callbacks) callback(performance.now() + 2000);
    assert(player.state().slide === 0 && !player.state().playing && ended === 0, "SLD-13: previous-slide navigation rejects a stale animation completion");
    player.destroy();
  } finally { Object.assign(globalThis, { requestAnimationFrame: oldRaf, cancelAnimationFrame: oldCancel }); }

  console.log("\nW14 COEXISTENCE VERIFY: PASS");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
