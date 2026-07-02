#!/usr/bin/env -S npx tsx
// WS3 — the EXIT preset family + player semantics, headless (linkedom, no WAAPI):
//  • exits (fadeOut/popOut/drawOff/wipeOut) leave their targets hidden at rest
//    after their beat; exit-only nodes stay visible BEFORE it.
//  • the RE-BASELINE rule: enter → exit → re-enter lands visible at the
//    re-enter preset's end state (incl. a drawOn re-enter after a fadeOut,
//    which never animates opacity itself), fully reversible via scrub.
//  • disabled tracks are invisible to spec computation.
//  • drawOn/drawOff never silently no-op: <use>-only geometry (pre-regen
//    fluxplot ticks) and geometry-less targets fall back to a fade.
//  • countUp: deterministic seek via static state; format inferred from text.
// Run: npx tsx scripts/verify-slide-exits.ts
import { parseHTML } from "linkedom";
import { computeSlideAnims, applyStatic } from "../src/lib/slide/player/player";
import { PRESETS, EXIT_PRESETS, ENTER_PRESETS } from "../src/lib/slide/player/presets";
import { createCountUp } from "../src/lib/slide/player/countup";
import { FLUX_DARK } from "../src/lib/slide/theme";
import type { RenderedSlide } from "../src/lib/slide/player/render";
import type { Slide, StageSize, Track } from "../src/lib/slide/types";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

const { document } = parseHTML("<!doctype html><html><body></body></html>");
(globalThis as { document?: unknown }).document = document;

const stage: StageSize = { width: 1280, height: 720 };
const opts = { theme: FLUX_DARK } as const;
const el = (id: string): HTMLElement => {
  const d = document.createElement("div");
  d.dataset.elId = id;
  return d as unknown as HTMLElement;
};
const style = (n: HTMLElement) => n.style as unknown as Record<string, string>;

// --- preset families ----------------------------------------------------------
for (const p of ["fadeOut", "popOut", "drawOff", "wipeOut"]) {
  assert(!!PRESETS[p] && EXIT_PRESETS.has(p) && !ENTER_PRESETS.has(p), `${p} exists and is classified as an exit`);
}

// --- 1. exit-only: visible before its beat, hidden after ----------------------
{
  const box = el("e1");
  const rendered: RenderedSlide = { elements: new Map([["e1", box]]) };
  const slide: Slide = {
    id: "s", elements: [], beats: [
      { id: "k0", tracks: [] },
      { id: "k1", tracks: [{ target: "e1", preset: "fadeOut", duration: 300 }] },
    ],
  };
  const specs = computeSlideAnims(slide, rendered, el("cam"), stage, opts);
  applyStatic(specs, 0);
  assert(style(box).opacity !== "0", "exit-only target is VISIBLE before its exit beat");
  applyStatic(specs, 1);
  assert(style(box).opacity === "0", "hidden at rest after fadeOut's beat");
  applyStatic(specs, 0);
  assert(style(box).opacity !== "0", "scrubbing back restores visibility (reversible)");
}

// --- 2. enter → exit → re-enter (the re-baseline rule) -------------------------
{
  const box = el("e2");
  const rendered: RenderedSlide = { elements: new Map([["e2", box]]) };
  const slide: Slide = {
    id: "s", elements: [], beats: [
      { id: "k0", tracks: [] },
      { id: "k1", tracks: [{ target: "e2", preset: "fadeRise", duration: 300 }] },
      { id: "k2", tracks: [{ target: "e2", preset: "popOut", duration: 250 }] },
      { id: "k3", tracks: [{ target: "e2", preset: "popIn", duration: 250 }] },
    ],
  };
  const specs = computeSlideAnims(slide, rendered, el("cam"), stage, opts);
  applyStatic(specs, 0);
  assert(style(box).opacity === "0", "hidden before its first enter");
  applyStatic(specs, 1);
  assert(style(box).opacity === "1", "shown after the enter");
  applyStatic(specs, 2);
  assert(style(box).opacity === "0" && style(box).transform.includes("scale(0.92)"), "hidden after popOut (exit end-state accumulated)");
  applyStatic(specs, 3);
  assert(style(box).opacity === "1", "re-enter re-baselines: visible again");
  assert(!style(box).transform.includes("0.92"), "the exit's scale is superseded, not accumulated");
  applyStatic(specs, 2);
  assert(style(box).opacity === "0", "scrub back to the exited state still hides (deterministic)");
}

// --- 3. drawOn re-enter after fadeOut (enter that never animates opacity) ------
{
  const wrap = el("e3");
  const svgNS = "http://www.w3.org/2000/svg";
  const path = document.createElementNS(svgNS, "path");
  path.setAttribute("d", "M 0 0 L 100 0");
  wrap.appendChild(path);
  const rendered: RenderedSlide = { elements: new Map([["e3", wrap]]) };
  const slide: Slide = {
    id: "s", elements: [], beats: [
      { id: "k0", tracks: [] },
      { id: "k1", tracks: [{ target: "e3", preset: "fade", duration: 200 }] },
      { id: "k2", tracks: [{ target: "e3", preset: "fadeOut", duration: 200 }] },
      { id: "k3", tracks: [{ target: "e3", preset: "drawOn", duration: 400 }] },
    ],
  };
  const specs = computeSlideAnims(slide, rendered, el("cam"), stage, opts);
  // the fade/fadeOut act on the WRAP; drawOn drills to the path — two DIFFERENT
  // nodes sharing one authoring key. The re-baseline window is per KEY, so the
  // re-enter supersedes the exit even across nodes.
  applyStatic(specs, 2);
  assert(style(wrap).opacity === "0", "wrap hidden after fadeOut");
  applyStatic(specs, 3);
  const pathStyle = (path as unknown as HTMLElement).style as unknown as Record<string, string>;
  assert(pathStyle.strokeDashoffset === "0", "drawOn re-enter fully drawn at rest");
  assert(style(wrap).opacity !== "0", "the WRAP's exit state is superseded by the cross-node re-enter (per-KEY window)");
  applyStatic(specs, 2);
  assert(style(wrap).opacity === "0", "scrub back: exited state returns (reversible)");
  applyStatic(specs, 1);
  assert(style(wrap).opacity === "1" && pathStyle.strokeDashoffset !== "0", "scrub to beat 1: entered wrap, path still undrawn (its intro is beat 3)");
}

// --- 4. disabled tracks are invisible to the engine ----------------------------
{
  const box = el("e4");
  const rendered: RenderedSlide = { elements: new Map([["e4", box]]) };
  const t: Track = { target: "e4", preset: "fade", duration: 300, disabled: true };
  const slide: Slide = { id: "s", elements: [], beats: [{ id: "k0", tracks: [] }, { id: "k1", tracks: [t] }] };
  const specs = computeSlideAnims(slide, rendered, el("cam"), stage, opts);
  assert(specs.length === 0, "a disabled track produces no specs (play + static + export all skip it)");
  applyStatic(specs, 0);
  assert(style(box).opacity !== "0", "its target stays visible at rest (mask is the override's job)");
}

// --- 5. drawOn/drawOff fallbacks (<use>-only + geometry-less targets) ----------
{
  const svgNS = "http://www.w3.org/2000/svg";
  // a pre-regen fluxplot tick: <g><g><use href="#tickpath"/></g></g> with the
  // real path hiding inside <defs> — nothing measurable outside it.
  const tick = document.createElementNS(svgNS, "g") as unknown as HTMLElement;
  const defs = document.createElementNS(svgNS, "defs");
  const defsPath = document.createElementNS(svgNS, "path");
  defsPath.setAttribute("d", "M 0 0 L 0 4.5");
  defs.appendChild(defsPath);
  const use = document.createElementNS(svgNS, "use");
  const inner = document.createElementNS(svgNS, "g");
  inner.appendChild(use);
  tick.appendChild(defs);
  tick.appendChild(inner);

  const anims = PRESETS.drawOn([tick as never], { target: "x" } as Track, { theme: FLUX_DARK, stage });
  assert(anims.length === 1 && anims[0].node === tick, "drawOn on a <use>-only tick falls back to ONE anim on the group");
  assert(JSON.stringify(anims[0].keyframes) === JSON.stringify([{ opacity: 0 }, { opacity: 1 }]), "…and it's a fade (enter), not a dashoffset no-op");
  assert(anims[0].enter, "the fallback still hides the part before its beat");

  const div = el("plain");
  const out = PRESETS.drawOff([div as never], { target: "x" } as Track, { theme: FLUX_DARK, stage });
  assert(JSON.stringify(out[0].keyframes) === JSON.stringify([{ opacity: 1 }, { opacity: 0 }]), "drawOff on a geometry-less div falls back to a fade-out");
  assert(!out[0].enter, "drawOff fallback stays an exit");

  const realLine = document.createElementNS(svgNS, "g") as unknown as HTMLElement;
  const line = document.createElementNS(svgNS, "line");
  realLine.appendChild(line);
  const on = PRESETS.drawOn([realLine as never], { target: "x" } as Track, { theme: FLUX_DARK, stage });
  assert(on.length === 1 && on[0].node === (line as never) && "strokeDashoffset" in on[0].keyframes[0], "real geometry still self-draws (no behavior change)");
}

// --- 6. countUp ----------------------------------------------------------------
{
  const stat = el("n1");
  stat.textContent = "n = 1,247 patients";
  const c = createCountUp(stat as never, { target: "n1", preset: "countUp" } as Track);
  c.seek(0);
  assert(stat.textContent === "n = 0 patients", "seek(0) shows the from-value with inferred prefix/suffix/separator");
  c.seek(0.5);
  assert(stat.textContent === "n = 624 patients" || stat.textContent === "n = 623 patients", `midpoint counts (${stat.textContent})`);
  c.seek(1);
  assert(stat.textContent === "n = 1,247 patients", "seek(1) restores the authored text verbatim");

  const pct = el("n2");
  pct.textContent = "94.2%";
  const c2 = createCountUp(pct as never, { target: "n2", preset: "countUp", params: { from: 50 } } as unknown as Track);
  c2.seek(0);
  assert(pct.textContent === "50.0%", "params.from + inferred decimals/suffix");
  c2.seek(1);
  assert(pct.textContent === "94.2%", "authored text restored at 1");

  // through the player: countUp rides the morph plumbing (static seek 0|1)
  const statEl = el("n3");
  statEl.textContent = "42 sites";
  const rendered: RenderedSlide = { elements: new Map([["n3", statEl]]) };
  const slide: Slide = {
    id: "s", elements: [], beats: [
      { id: "k0", tracks: [] },
      { id: "k1", tracks: [{ target: "n3", preset: "countUp", duration: 600 }] },
    ],
  };
  const specs = computeSlideAnims(slide, rendered, el("cam"), stage, opts);
  assert(specs.length === 1 && !!specs[0].morph, "countUp compiles to a driver spec (morph plumbing)");
  applyStatic(specs, 0);
  assert(statEl.textContent === "0 sites", "at rest before its beat: the from-value");
  applyStatic(specs, 1);
  assert(statEl.textContent === "42 sites", "at rest after its beat: the authored text");
}

console.log("\nSLIDE EXITS + COUNTUP (WS3) TESTS PASSED");
