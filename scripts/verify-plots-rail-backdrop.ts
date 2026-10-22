// Plots rail backdrop law (pure): every element of a transparent plot stays visible.
// electron/plotThumbRules.mjs analyzeInk + chooseBackdrop, tuned on 695 real images
// (notes/plots_rail_2026-10-22/P0.md). Pins:
//   * the fixtures (scripts/fixtures/plots-rail/, real matplotlib output, rendered here through
//     the thumbnail engine exactly as the worker does): light/seaborn/colour/yellow → paper,
//     dark-theme / white text → dark, black + white ink / white scatter points → grey,
//     opaque → its own background, WHITE MARKER RIMS (halos) never force a backdrop;
//   * the analysis on synthetic pixels: premultiplied demultiply, exposed vs interior ink,
//     halo rims, region outlines, opaque border, the presence floor;
//   * the law: a declared paper wins (knockout share), manual modes, stability (Auto never looks
//     at the active figure), the Peek "reads poorly" warning, cursor tone.
//   Run: node scripts/run-verifies.mjs --tier pure --only verify-plots-rail-backdrop
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { harness } from "./lib/harness.mjs";
import {
  analyzeInk, chooseBackdrop, presentBins, readsPoorlyOn, backdropTone, BACKDROPS, lostShare, INK_BINS,
} from "../electron/plotThumbRules.mjs";

const h = harness("verify-plots-rail-backdrop");
const repo = join(import.meta.dirname, "..");

h.section("real matplotlib fixtures through the engine");
{
  const { createThumbEngine } = await import(pathToFileURL(join(repo, "electron", "plotThumbEngine.mjs")).href);
  const { resolveFontFile } = await import(pathToFileURL(join(repo, "src", "lib", "text", "fontFiles.mjs")).href);
  const cache = mkdtempSync(join(tmpdir(), "flux-backdrop-"));
  try {
    const engine = createThumbEngine({ cacheDir: cache, resvgFrom: pathToFileURL(join(repo, "package.json")).href, resolveFont: (r: unknown) => resolveFontFile(r) });
    const dir = join(repo, "scripts", "fixtures", "plots-rail");
    const expect: Record<string, string> = {
      "light.svg": "paper", "seaborn.svg": "paper", "colour_scatter.svg": "paper", "yellow_bars.svg": "paper",
      "base50_panel.svg": "paper", "halo_markers.svg": "paper",
      "dark.svg": "dark", "white_text_only.svg": "dark",
      "mixed.svg": "mid", "white_points.svg": "mid",
      "opaque.svg": "own",
    };
    const files = readdirSync(dir).filter((f) => f.endsWith(".svg")).sort();
    h.eq(files.join(","), Object.keys(expect).sort().join(","), "every fixture has an expectation");
    for (const f of files) {
      const t = await engine.thumb(join(dir, f), 512, { roots: [dir], indexRoot: dir });
      const got = t.error ? `error: ${t.error}` : chooseBackdrop(t.stats, { manifestPaper: t.paper }).kind;
      h.eq(got, expect[f], `${f} → ${expect[f]}`);
    }
    const halo = await engine.thumb(join(dir, "halo_markers.svg"), 512, { roots: [dir], indexRoot: dir });
    h.ok(halo.stats.halo > 0, "the white marker rims are classified as halo, not content");
    const again = await engine.thumb(join(dir, "dark.svg"), 256, { roots: [dir], indexRoot: dir });
    const first = await engine.thumb(join(dir, "dark.svg"), 512, { roots: [dir], indexRoot: dir });
    h.eq(JSON.stringify(again.stats), JSON.stringify(first.stats), "the analysis does not depend on the bucket asked for (always the 512 render)");
  } finally { rmSync(cache, { recursive: true, force: true }); }
}

// ---- synthetic pixels --------------------------------------------------------------------
const W = 40, H = 40;
const img = (paint: (x: number, y: number) => [number, number, number, number] | null) => {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const c = paint(x, y); if (c) px.set(c, (y * W + x) * 4); }
  return px;
};
const inBox = (x: number, y: number, x0: number, y0: number, x1: number, y1: number) => x >= x0 && x < x1 && y >= y0 && y < y1;

h.section("the analysis on synthetic pixels");
{
  // A thin white stroke on transparency: all exposed thin ink, in the top bin.
  const white = analyzeInk(img((x, y) => (y === 20 && x > 4 && x < 36 ? [255, 255, 255, 255] : null)), W, H);
  h.ok(white.exposed > 0 && white.bins[INK_BINS - 1] === white.exposed, "a white stroke is exposed thin ink in the top luminance bin");
  h.eq(chooseBackdrop(white).kind, "dark", "white ink alone → dark");
  // Premultiplied resvg pixels: a half-transparent white edge reads as white, not grey.
  const pre = analyzeInk(img((x, y) => (y === 20 && x > 4 && x < 36 ? [128, 128, 128, 128] : null)), W, H, { premultiplied: true });
  h.ok(pre.bins[INK_BINS - 1] === pre.exposed, "premultiplied pixels are demultiplied before binning");
  const straight = analyzeInk(img((x, y) => (y === 20 && x > 4 && x < 36 ? [128, 128, 128, 128] : null)), W, H);
  h.ok(straight.bins[INK_BINS - 1] === 0, "…while the same bytes as straight alpha are grey (the flag matters)");
  // A big opaque white panel with black text INSIDE: only the panel's outline meets the backdrop.
  const panel = analyzeInk(img((x, y) => (inBox(x, y, 4, 4, 36, 36) ? (inBox(x, y, 15, 18, 25, 21) ? [0, 0, 0, 255] : [255, 255, 255, 255]) : null)), W, H);
  h.ok(panel.bins[0] === 0, "ink inside an opaque panel never meets the backdrop (not exposed)");
  h.ok(panel.edgeBins[INK_BINS - 1] > 0 && panel.bins[INK_BINS - 1] === 0, "the panel's white edge is a REGION OUTLINE, not thin ink");
  // A blue disc with a white rim: the rim hugs the disc → halo.
  const rim = analyzeInk(img((x, y) => { const d = Math.hypot(x - 20, y - 20); return d < 8 ? [32, 94, 166, 255] : d < 10 ? [255, 255, 255, 255] : null; }), W, H);
  h.ok(rim.halo > 0 && rim.bins[INK_BINS - 1] < 12, "a white rim round a blue marker is halo ink");
  h.eq(chooseBackdrop(rim).kind, "paper", "…so it does not force a dark backdrop");
  // An opaque image.
  const opaque = analyzeInk(img(() => [200, 10, 10, 255]), W, H);
  h.ok(opaque.opaqueBorder >= 0.9, "an image opaque at its edges brings its own background");
  h.eq(chooseBackdrop(opaque).kind, "own", "…and is shown as is");
  // The presence floor: a 6-pixel white speck among black strokes is noise.
  const speck = analyzeInk(img((x, y) => (y % 6 === 0 && x > 2 && x < 38 ? [0, 0, 0, 255] : x === 30 && y > 30 && y < 37 ? [255, 255, 255, 255] : null)), W, H);
  h.ok(!presentBins(speck).includes(INK_BINS - 1), "a speck under the 12 px floor is not present");
  h.eq(chooseBackdrop(speck).kind, "paper", "black strokes with a speck → paper");
}

h.section("the law");
{
  const stats = (lums: [number, number][]) => {
    const bins = new Array(INK_BINS).fill(0);
    let exposed = 0;
    for (const [bin, n] of lums) { bins[bin] += n; exposed += n; }
    return { v: 3, opaqueBorder: 0, exposed, halo: 0, bins, edgeBins: new Array(INK_BINS).fill(0) };
  };
  const black = 0, white = INK_BINS - 1;
  h.eq(chooseBackdrop(stats([[black, 500]])).kind, "paper", "black ink → paper");
  h.eq(chooseBackdrop(stats([[white, 500]])).kind, "dark", "white ink → dark");
  h.eq(chooseBackdrop(stats([[black, 500], [white, 200]])).kind, "mid", "black + white ink → grey");
  // A dark-theme fluxplot that declares dark paper: a little dark ink may vanish into it (knockout).
  const darkTheme = stats([[white, 900], [20, 300], [black, 30]]);
  h.ok(lostShare(darkTheme, "#1c1b1a") <= 0.1, "fixture: 2.5 % of the ink matches the declared dark paper");
  h.eq(chooseBackdrop(darkTheme, { manifestPaper: "#1c1b1a" }).kind, "manifest", "the declared paper wins when it swallows only knockout ink");
  // Ink truly lost into the declared paper (black on a declared black page — contrast 1:1) is
  // only forgiven up to the knockout share. (Black on the dark TONE #1c1b1a is 1.17:1 — as
  // visible as Flexoki gridlines on paper, so it is not "lost"; the author's dark page shows it.)
  h.eq(chooseBackdrop(stats([[white, 300], [black, 300]]), { manifestPaper: "#000000" }).kind, "mid", "…but not when half the ink would vanish into it");
  h.eq(chooseBackdrop(stats([[white, 500]]), { manifestPaper: "#ffffff" }).kind, "dark", "a declared white paper never hides white ink");
  for (const mode of ["paper", "dark", "checker"] as const) h.eq(chooseBackdrop(stats([[white, 5]]), { mode }).kind, mode, `manual mode ${mode} is obeyed`);
  h.eq(chooseBackdrop(stats([[black, 5]]), { mode: "destination", destination: "#123456" }).color, "#123456", "Destination uses the active figure's background");
  h.eq(chooseBackdrop(stats([[black, 5]]), { mode: "destination", destination: "transparent" }).kind, "paper", "…and falls back to paper when it has none");
  const s = stats([[white, 500]]);
  h.eq(JSON.stringify(chooseBackdrop(s)), JSON.stringify(chooseBackdrop(s, { destination: "#ffffff" })), "Auto never looks at the active figure (no grid-wide recolouring on a figure click)");
  h.ok(readsPoorlyOn(stats([[white, 500]]), "#ffffff") && !readsPoorlyOn(stats([[black, 500]]), "#ffffff"), "Peek's warning: white ink reads poorly on a white figure, black does not");
  h.eq(backdropTone({ kind: "paper", color: BACKDROPS.paper, reason: "" }), "light", "paper backdrop → the light-surface cursor");
  h.eq(backdropTone({ kind: "dark", color: BACKDROPS.dark, reason: "" }), "dark", "dark backdrop → the dark-surface cursor");
  h.eq(chooseBackdrop(null).kind, "paper", "unanalysed → paper");
}

await h.done();
