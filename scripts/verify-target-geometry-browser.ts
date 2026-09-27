// Standalone Chrome oracle: real renderSlide placement/compensation vs the same
// shared bridge exported to flux-core. No Vite, no test-only renderer shortcut.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { harness } from "./lib/harness.mjs";
import { launch } from "./lib/driver.mjs";

const h = harness("verify-target-geometry-browser");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-target-geometry-"));
let browser: Awaited<ReturnType<typeof launch>>["browser"] | undefined;
try {
  const fixtures = await Promise.all(["mpl_boxplot", "mpl_scatter"].map(async (name) => ({
    svg: await fs.readFile(new URL(`./fixtures/plots/${name}_FLUXPLOT.svg`, import.meta.url), "utf8"),
    manifest: JSON.parse(await fs.readFile(new URL(`./fixtures/plots/${name}_FLUXPLOT.fluxplot.json`, import.meta.url), "utf8")),
  })));
  const bundled = await build({ stdin: { resolveDir: process.cwd(), loader: "ts", contents: `
    import { preparePlot, partDomId } from "./src/lib/plot/parse";
    import { targetOutlines } from "./src/lib/slide/targetGeometry";
    import { renderSlide } from "./src/lib/slide/player/render";
    import { compileSlide } from "./src/lib/slide/compile";
    import { FLUX_LIGHT } from "./src/lib/slide/theme";
    globalThis.probe = (fixtures) => {
      const results = [], prepared = fixtures.map(f => preparePlot(f.svg, f.manifest));
      const ctx = { manifest: id => prepared[Number(id)].manifest, plotRoot: id => prepared[Number(id)].root };
      const host = document.getElementById("stage");
      const cases = [
        { x: 10, y: 20, width: 200, height: 120, rotation: 0 },
        { x: 100, y: 50, width: 400, height: 240, rotation: 0 },
        { x: 30.25, y: 40.5, width: 180.5, height: 210.75, rotation: 0, contentScale: 2 },
        { x: 10, y: 20, width: 200, height: 120, rotation: 0, crop: { x: 60, y: 36, width: 120, height: 72 } },
        { x: 100, y: 50, width: 400, height: 240, rotation: 30, flipX: true, flipY: true },
        { x: 10, y: 20, width: 200, height: 120, rotation: 0, overrides: { "peaches.box": { dx: 9, dy: -4.5 } } },
      ];
      for (let asset = 0; asset < prepared.length; asset++) {
        const ids = asset === 0 ? ["peaches.box", "axis.x.spine", "peaches.whisker", "axis.x.tick.0"] : ["samples.point.0", "reference-line.mean-y"];
        // Stroke truth: the drawable's computed width (pt-true compensation already written)
        // × the linear scale of its screen CTM, back in stage px. The dashed reference line
        // also pins the dash factor.
        const strokeIds = new Set(["peaches.box", "axis.x.spine", "reference-line.mean-y"]);
        for (let c = 0; c < cases.length; c++) {
          // Curved rings use control-polygon bounds; projecting their local AABB
          // after rotation is a different (larger) conservative bound. Rotated
          // placement is pinned with the box and chains, whose bounds are exact.
          if (asset === 1 && cases[c].rotation) continue;
          const el = { id: "p", type: "plot", assetId: String(asset), ...cases[c] };
          const slide = { id: "s", elements: [el], beats: [{ id: "design", tracks: [] }] };
          renderSlide(host, slide, { width: 800, height: 600 }, { theme: FLUX_LIGHT, plotRoot: ctx.plotRoot, plotManifest: ctx.manifest });
          const frame = compileSlide(slide, { width: 800, height: 600 }, { plotManifest: ctx.manifest }).sample(0);
          const origin = host.getBoundingClientRect();
          for (const id of ids) {
            const node = document.getElementById(partDomId(el.id, id));
            const box = node.getBBox(), m = node.getScreenCTM();
            const corners = [[box.x,box.y],[box.x+box.width,box.y],[box.x+box.width,box.y+box.height],[box.x,box.y+box.height]]
              .map(([x,y]) => ({ x: m.a*x+m.c*y+m.e-origin.x, y: m.b*x+m.d*y+m.f-origin.y }));
            const xs = corners.map(p=>p.x), ys = corners.map(p=>p.y);
            const live = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs)-Math.min(...xs), h: Math.max(...ys)-Math.min(...ys) };
            const outline = targetOutlines({ element: el.id, parts: [id] }, frame, ctx);
            let stroke;
            if (strokeIds.has(id)) {
              const GEO = "path,line,polyline,polygon,rect,circle,ellipse";
              const drawable = node.matches(GEO) ? node : node.querySelector(GEO);
              const cs = getComputedStyle(drawable), dm = drawable.getScreenCTM();
              const k = Math.sqrt(Math.abs(dm.a * dm.d - dm.b * dm.c)) / (origin.width / 800);
              const dash = cs.strokeDasharray && cs.strokeDasharray !== "none" ? cs.strokeDasharray.split(/[\\s,]+/).map(parseFloat).filter(Number.isFinite).map(v => v * k) : null;
              stroke = { live: parseFloat(cs.strokeWidth) * k, predicted: outline[0]?.paint.strokeWidth, liveDash: dash, predictedDash: outline[0]?.paint.dash ?? null };
            }
            results.push({ label: asset+":"+c+":"+id, live, predicted: outline[0]?.bbox, count: outline.length, stroke });
          }
        }
      }
      return results;
    };
  ` }, bundle: true, format: "iife", platform: "browser", write: false, logLevel: "silent" });
  h.eq(bundled.warnings.length, 0, "browser runtime bundles without warnings");
  await fs.writeFile(path.join(tmp, "runtime.js"), bundled.outputFiles[0].contents);
  await fs.writeFile(path.join(tmp, "index.html"), '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'unsafe-inline\'"><div id="stage"></div><script src="runtime.js"></script>');
  const launched = await launch(); browser = launched.browser;
  const errors: string[] = [];
  launched.page.on("pageerror", (e: Error) => errors.push(String(e)));
  launched.page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await launched.page.goto(pathToFileURL(path.join(tmp, "index.html")).href);
  type Stroke = { live: number; predicted?: number; liveDash: number[] | null; predictedDash: number[] | null };
  const results = await launched.page.evaluate((f) => (globalThis as any).probe(f), fixtures) as { label: string; count: number; live: Record<string,number>; predicted?: Record<string,number>; stroke?: Stroke }[];
  h.eq(results.length, 34, "all four plot roles, the scatter point and a dashed line measured across sizes/crop/overrides");
  for (const r of results) {
    const error = r.predicted ? Math.max(...Object.keys(r.live).map(k => Math.abs(r.live[k]-r.predicted![k]))) : Infinity;
    h.ok(r.count === 1 && error < .5, `${r.label}: getBBox × screen CTM agrees within 0.5 stage px (max ${error.toFixed(6)})`);
  }
  const strokes = results.filter((r) => r.stroke);
  h.eq(strokes.length, 17, "stroke truth measured for the box and spine (6 placements each) and the dashed line (5)");
  for (const { label, stroke: s } of strokes) {
    const err = s!.predicted == null ? Infinity : Math.abs(s!.live - s!.predicted);
    h.ok(err < .05, `${label}: paint.strokeWidth ${s!.predicted?.toFixed(4)} vs live ${s!.live.toFixed(4)} stage px (within 0.05)`);
    if (s!.liveDash) {
      const dashErr = s!.predictedDash?.length === s!.liveDash.length ? Math.max(...s!.liveDash.map((v, i) => Math.abs(v - s!.predictedDash![i]))) : Infinity;
      h.ok(dashErr < .05, `${label}: paint.dash ${s!.predictedDash?.map((v) => v.toFixed(3)).join(",")} vs live ${s!.liveDash.map((v) => v.toFixed(3)).join(",")} stage px (within 0.05)`);
    }
  }
  h.eq(strokes.filter((r) => r.stroke!.liveDash).length, 5, "the dashed reference line is measured with its live dash in all 5 placements");
  h.eq(errors, [], "real renderSlide has no browser errors or CSP violations");
} finally {
  await browser?.close();
  await fs.rm(tmp, { recursive: true, force: true });
}
await h.done();
