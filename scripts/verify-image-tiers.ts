// Display tiers for raster images: the policy (src/lib/figure/imageTiers.ts).
//
// The owner's Figure 22 (nine 28 MP PNGs) froze the editor 520–1,033 ms after every zoom, drag and nudge
// because the live DOM — and therefore every scene capture — carried the originals (2026-11-09). The
// contract this gate holds: what an image element paints is bounded by the SCREEN (a tier never more
// than 2× the pixels needed, never above the cap), sharp wherever the cap allows, and past the cap a
// detail of the visible part only — which no scene capture may contain.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { harness } from "./lib/harness.mjs";
import {
  TIER_MIN_SOURCE_PIXELS, TIER_MAX_PIXELS, TIER_MIN_SIDE, DETAIL_MAX_PIXELS, DISPLAY_CACHE_VERSION,
  needsTiers, tierSize, sharpestLevel, coarsestLevel, levelFor, ladder, tierIsSoft, detailPlan, detailServes, detailBeatsTier, cacheMetaValid,
} from "../src/lib/figure/imageTiers";

const h = harness("verify-image-tiers");
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIZES: [number, number][] = [[11251, 2511], [9900, 2850], [2001, 683], [4000, 3000], [800, 800], [30000, 400], [1024, 8192]];

h.section("A. which images are tiered");
h.ok(!needsTiers(700, 800) && needsTiers(1000, 700), `only images over ${TIER_MIN_SOURCE_PIXELS} px are tiered`);
h.ok(!needsTiers(0, 100) && !needsTiers(NaN, 100), "an unsized image is never tiered");

h.section("B. the ladder is bounded and ordered");
for (const [w, hgt] of SIZES) {
  if (!needsTiers(w, hgt)) continue;
  const first = sharpestLevel(w, hgt), last = coarsestLevel(w, hgt), levels = ladder(w, hgt);
  const sharp = tierSize(w, hgt, first), sharper = tierSize(w, hgt, first - 1), coarse = tierSize(w, hgt, last);
  h.ok(sharp.width * sharp.height <= TIER_MAX_PIXELS && (first === 1 || sharper.width * sharper.height > TIER_MAX_PIXELS), `${w}×${hgt}: the sharpest tier (L${first}, ${sharp.width}×${sharp.height}) is the largest under the cap`);
  h.ok(last >= first && (Math.max(coarse.width, coarse.height) >= TIER_MIN_SIDE || last === first), `${w}×${hgt}: the coarsest tier (L${last}) keeps ${TIER_MIN_SIDE} px on its long side`);
  h.ok(levels.length === last - first + 1 && levels.every((t, i) => !i || t.width < levels[i - 1].width), `${w}×${hgt}: ${levels.length} tiers, strictly smaller down the ladder`);
  const total = levels.reduce((n, t) => n + t.width * t.height, 0);
  h.ok(total <= 2.1 * TIER_MAX_PIXELS, `${w}×${hgt}: the whole ladder is ${(total / 1e6).toFixed(2)} MP (one decode makes it all)`);
}

h.section("C. the tier follows the screen");
let worst = 0;
for (const [w, hgt] of SIZES) {
  if (!needsTiers(w, hgt)) continue;
  const first = sharpestLevel(w, hgt), last = coarsestLevel(w, hgt);
  for (let d = 0.004; d < 1.6; d *= 1.07) {
    const level = levelFor(w, hgt, d), t = tierSize(w, hgt, level), have = t.width / w;
    if (level > first && level < last) {
      if (!(have >= d * 0.999)) h.fail(`${w}×${hgt} at density ${d.toFixed(4)}: tier L${level} is softer than the screen (${have.toFixed(4)})`);
      const next = tierSize(w, hgt, level + 1).width / w;
      if (next >= d * 1.001) h.fail(`${w}×${hgt} at density ${d.toFixed(4)}: tier L${level + 1} would already be sharp enough`);
      worst = Math.max(worst, (have / d) ** 2);
    }
    if (level === first && have < d && !tierIsSoft(w, hgt, d) && have < Math.min(1, d) * 0.8) h.fail(`${w}×${hgt} at ${d.toFixed(3)}: the cap binds but no detail is asked for`);
    if (tierIsSoft(w, hgt, d) && level !== first) h.fail(`${w}×${hgt} at ${d.toFixed(3)}: a detail is asked for below the cap`);
  }
}
h.ok(worst > 1 && worst <= 2.05, `between the ends of the ladder a tier holds at most ${worst.toFixed(2)}× the pixels the screen needs`);
h.eq(levelFor(11251, 2511, 0), coarsestLevel(11251, 2511), "no density → the coarsest tier");
h.eq(levelFor(11251, 2511, 50), sharpestLevel(11251, 2511), "any density past the cap → the sharpest tier");
// The owner's case: 11251 px drawn 313 px wide (zoom 0.6) → a few hundred px, not 28 MP.
{ const t = tierSize(11251, 2511, levelFor(11251, 2511, 313 / 11251)); h.ok(t.width >= 313 && t.width <= 313 * 1.5 && t.width * t.height < 60_000, `the owner's image at fit shows ${t.width}×${t.height} (${(t.width * t.height / 1000).toFixed(0)} kpx, was 28 MP)`); }

h.section("D. the detail is the visible part, bounded");
for (const [w, hgt] of SIZES) {
  if (!needsTiers(w, hgt)) continue;
  for (const d of [0.3, 0.8, 1, 2.4, 9]) for (const f of [0.02, 0.1, 0.5, 1]) {
    const visible = { x: w * 0.3, y: hgt * 0.2, width: w * f * 0.6, height: hgt * f * 0.6 };
    const plan = detailPlan(w, hgt, visible, d);
    if (!plan) { h.fail(`${w}×${hgt}: no detail for a visible rect`); continue; }
    const s = plan.source;
    if (!(s.x >= 0 && s.y >= 0 && s.x + s.width <= w && s.y + s.height <= hgt)) h.fail(`${w}×${hgt}: the detail leaves the image`);
    if (!(s.x <= visible.x && s.y <= visible.y && s.x + s.width >= visible.x + visible.width - 1e-6 && s.y + s.height >= visible.y + visible.height - 1e-6)) h.fail(`${w}×${hgt}: the detail does not cover what is visible`);
    if (plan.width * plan.height > DETAIL_MAX_PIXELS * 1.01) h.fail(`${w}×${hgt}: a ${plan.width}×${plan.height} detail is over the budget`);
    if (plan.density > 1 + 1e-9 || plan.density > d + 1e-9) h.fail(`${w}×${hgt}: a detail denser than the source or the screen`);
    if (!detailServes(w, hgt, plan, visible, d)) h.fail(`${w}×${hgt}: a fresh detail does not serve its own view (the request would loop)`);
  }
}
h.ok(true, "every detail stays inside the image, covers the view, fits the budget, is never denser than its source, and serves its own view");
{
  const visible = { x: 4000, y: 800, width: 900, height: 600 }, plan = detailPlan(11251, 2511, visible, 2)!;
  h.ok(plan.density === 1 && plan.width === plan.source.width, "past 1:1 the detail is the source's own pixels");
  h.ok(detailServes(11251, 2511, plan, { ...visible, x: visible.x + 150 }, 2), "a small pan stays inside the detail's margin (no new request)");
  h.ok(!detailServes(11251, 2511, plan, { ...visible, x: visible.x + 900 }, 2), "a pan past the margin asks for a new one");
  const whole = { x: 0, y: 0, width: 11251, height: 2511 }, coarse = detailPlan(11251, 2511, whole, 0.9)!;
  h.ok(coarse.density < 0.5 && !detailServes(11251, 2511, coarse, visible, 2), "a budget-limited detail does not serve a deeper view");
  h.ok(detailServes(11251, 2511, coarse, whole, 0.9) && detailServes(11251, 2511, coarse, whole, 5), "…but it serves the view it was made for at any density (the budget is the limit, not the screen)");
  h.ok(detailBeatsTier(11251, 2511, plan) && !detailBeatsTier(11251, 2511, detailPlan(30000, 400, { x: 0, y: 0, width: 30000, height: 400 }, 0.3)!), "a detail is drawn only when clearly denser than the sharpest tier");
  h.eq(detailPlan(11251, 2511, { x: 10, y: 10, width: 0, height: 5 }, 1), null, "nothing visible → no detail");
  const snapped = detailPlan(11251, 2511, { x: 4010, y: 805, width: 900, height: 600 }, 2)!;
  h.eq([snapped.source.x % 64, snapped.source.y % 64], [0, 0], "details snap to a 64 px grid (the same resting view asks for the same detail)");
}

h.section("E. the cache names its source");
{
  const src = { size: 17032639, mtimeMs: 1794119962746.8625 };
  const meta = { version: DISPLAY_CACHE_VERSION, source: { ...src }, natural: { width: 11251, height: 2511 }, levels: [4, 5, 6] };
  h.ok(cacheMetaValid(meta, src), "a cache made from this exact file is valid");
  h.ok(!cacheMetaValid(meta, { ...src, size: src.size + 1 }) && !cacheMetaValid(meta, { ...src, mtimeMs: src.mtimeMs + 1 }), "another size or mtime: stale");
  h.ok(!cacheMetaValid({ ...meta, version: DISPLAY_CACHE_VERSION + 1 }, src) && !cacheMetaValid(meta, null) && !cacheMetaValid(null, src) && !cacheMetaValid({ ...meta, levels: "all" }, src), "another version, a missing source, a malformed meta: stale");
}

h.section("F. the wiring that makes it hold");
{
  const element = fs.readFileSync(path.join(repo, "src/lib/Element.svelte"), "utf8");
  h.ok(/display\?\.tier\?\.href \?\? \(display\?\.pending \? undefined : \$assetData\[element\.assetId\]\)/.test(element), "the image element paints the tier; while a tier is pending the original stays out of the DOM");
  h.ok((element.match(/class="image-detail"/g) ?? []).length === 2, "both image branches (cropped, uncropped) draw the detail with the capture-excluded class");
  const proxy = fs.readFileSync(path.join(repo, "src/lib/interact/zoomProxy.ts"), "utf8");
  h.ok(/captureExcluded = .*image-detail/.test(proxy) && /querySelectorAll\('\.figure-detail, \.image-detail'\)/.test(proxy), "no scene capture contains an image detail");
  const canvas = fs.readFileSync(path.join(repo, "src/lib/Canvas.svelte"), "utf8");
  h.ok(/frame \? 0 : \$displayRevision/.test(canvas), "a tier change re-keys the scene snapshot");
  h.ok(/assetData: displayAssetData\(\)/.test(canvas), "the overview capture embeds tiers, never originals the canvas does not paint");
  const display = fs.readFileSync(path.join(repo, "src/lib/figure/imageDisplay.ts"), "utf8");
  h.ok(!/createImageBitmap|OffscreenCanvas|new Image\(/.test(display), "the display service never decodes or resamples on the main thread");
}
await h.done();
