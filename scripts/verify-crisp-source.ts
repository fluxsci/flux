// verify-crisp-source.ts — figure-v1 P6 source tripwires (pure tier).
// presence: main-process / build-config source shapes — not headless-drivable (WS-7.5).
//
// Guards the SHAPE of the crisp-at-rest fix in src/lib/Canvas.svelte so a
// refactor can never silently undo it (à la verify-writer-latency.ts). The
// live behavioral gate is scripts/verify-crisp.mjs (ui-extra, DSF 2); this
// file asserts the two hand-won invariants against source:
//
//   A. one repaint per zoom gesture — the scene SVG scales by renderZoom (the
//      baked scale) and the wrapper carries only a compositor residual
//      scale(zoom/renderZoom); NO live $viewport read may exist inside the
//      scene-svg template (one missed read silently reintroduces per-tick
//      content repaints), and the cull keys off renderZoom.
//   B. will-change lifecycle — the .scene CSS rule has NO permanent
//      will-change; promotion is inline-only while sceneHot; `contain: paint`
//      is forbidden (clips panned content).
//
// Run: npx tsx scripts/verify-crisp-source.ts

import { readFileSync } from "node:fs";

let failed = 0;
function assert(cond: unknown, msg: string) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    console.log(`  ✗ ${msg}`);
    failed++;
  }
}

const src = readFileSync("src/lib/Canvas.svelte", "utf8");
// Comment-stripped view for DECLARATION-level checks (the rationale comments
// themselves name the forbidden constructs, so word-greps would self-trigger).
const stripped = src
  .replace(/\/\*[\s\S]*?\*\//g, "") // CSS + block comments
  .replace(/<!--[\s\S]*?-->/g, "") // template comments
  .replace(/^\s*\/\/.*$/gm, ""); // full-line JS comments (the rationale block)

// ---- B. will-change lifecycle --------------------------------------------------
const styleSection = stripped.slice(stripped.indexOf("<style>"));
const sceneRule = /\.scene\s*\{([\s\S]*?)\}/.exec(styleSection)?.[1] ?? "";
assert(sceneRule.length > 0, "the .scene CSS rule exists");
assert(!/will-change\s*:/.test(sceneRule), "the .scene CSS rule declares NO will-change (permanent promotion = budget-limited tiles = blur at rest)");
assert(/transform-origin:\s*0 0/.test(sceneRule), ".scene keeps transform-origin: 0 0 (the residual scale composes about the pan origin)");
assert(
  /style:will-change=\{sceneHot \? "transform" : null\}/.test(src),
  'promotion is inline-only: style:will-change={sceneHot ? "transform" : null} on the scene wrapper',
);
assert(!/contain\s*:\s*paint/.test(stripped), "no `contain: paint` declaration anywhere (it clips panned content — forbidden)");
assert(/SCENE_COOL_MS\s*=\s*\d+/.test(src), "SCENE_COOL_MS exists (trailing demotion window)");
assert(/sceneHot = false; \/\/ idle demotion/.test(src), "the idle demotion branch survives (full-quality re-raster + tile release)");

// ---- A. one repaint per zoom gesture --------------------------------------------
assert(/let renderZoom\b/.test(src), "renderZoom exists (the scale baked into the scene SVG)");
assert(/ZOOM_SETTLE_MS\s*=\s*\d+/.test(src), "ZOOM_SETTLE_MS exists (settle-fold delay)");
assert(
  /\$: if \(\$viewport\.zoom !== renderZoom\) scheduleZoomFold\(\);/.test(src),
  "every zoom change (wheel, Toolbar, programmatic viewport.set) schedules the settle fold",
);
assert(
  /renderZoom = get\(viewport\)\.zoom; \/\/ THE one content repaint/.test(src),
  "the settle fold bakes renderZoom = zoom (the ONE content repaint per gesture)",
);
assert(/on:pointerdown\|capture=\{foldZoomNow\}/.test(src), "gesture pointerdowns fold immediately (capture phase on the host)");

// Scene wrapper: pan translate + compositor-only residual.
assert(
  /translate3d\(\$\{\$viewport\.panX\}px, \$\{\$viewport\.panY\}px, 0\) scale\(\$\{\$viewport\.zoom \/ renderZoom\}\)/.test(src),
  "the scene wrapper transform is translate3d(pan) scale(zoom/renderZoom) — residual is compositor-only",
);
// Scene SVG: the baked scale.
assert(/<g transform=\{`scale\(\$\{renderZoom\}\)`\}>/.test(src), "the scene SVG scales by renderZoom, not live zoom");

// NO live $viewport read inside the scene-svg template (the wrapper residual is
// the one allowed live-zoom read, and it sits on the wrapper div ABOVE this slice).
const sceneStart = src.indexOf('class="scene-svg"');
const sceneEnd = src.indexOf("<!-- OVERLAY", sceneStart);
assert(sceneStart > 0 && sceneEnd > sceneStart, "the scene-svg template slice is locatable");
const sceneTemplate = src.slice(sceneStart, sceneEnd);
assert(
  !/\$viewport/.test(sceneTemplate),
  "the scene-svg template contains ZERO $viewport reads (a live-zoom read would reintroduce per-tick content repaints)",
);
assert(/font-size=\{12 \/ renderZoom\}/.test(sceneTemplate), "the empty-hint sizes divide by renderZoom");
assert(/font-size=\{13 \/ renderZoom\}/.test(sceneTemplate), "the figure label sizes divide by renderZoom");

// Culling: keys off renderZoom, frozen while unsettled. Scope the live-zoom
// check to the cull block itself — the ruler tick builders legitimately read
// live zoom (screen-space overlay).
const cullBlock = /\$: \{[\s\S]*?const z = renderZoom;[\s\S]*?cullRect = ready[\s\S]*?\}\n {2}\}/.exec(src)?.[0] ?? "";
assert(cullBlock.length > 0, "the cull block derives its key from renderZoom (const z = renderZoom)");
assert(/if \(!zoomUnsettled && key !== cullKey\)/.test(cullBlock), "the cull recompute is skipped while the zoom is unsettled");
assert(!/\$viewport\.zoom/.test(cullBlock), "the cull block never reads live $viewport.zoom (pan-quantized re-cull only)");

// ---- rationale block survives ---------------------------------------------------
assert(
  /RATIONALE \(diagnosis: notes\/Flux_Electron_Compositor_Notes\.md, Phase 0a\)/.test(src),
  "the P6 rationale comment block survives (diagnosis pointer)",
);
assert(/content-bounds × zoom²/.test(src), "the rationale keeps the layer-growth mechanism (content-bounds × zoom²)");
assert(/`contain: paint`[\s\S]{0,40}FORBIDDEN/.test(src), "the rationale keeps the `contain: paint` FORBIDDEN ruling");

console.log(failed === 0 ? "\nCRISP SOURCE GUARD: PASS" : `\nCRISP SOURCE GUARD: FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
