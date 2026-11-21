// verify-fluximg-slide-parts-gui (ui tier; dev server up, FLUX_URL for a worktree): an image's OBJECTS on a slide in the
// headless app (fluximg stage 2, W8). Real keys and pointer events; every check reads model state, undo counts or DOM.
//   * The image's X-ray (Shift+Alt+R, and the F-menu's door): its layers (eye) and objects (no eye) as rows, the styling
//     column's value as each object's preview; hovering an object row outlines it on the canvas.
//   * Picked object rows → m 1 → ONE part-bound Appear track (staggered), one undo step; a layer row → a staggered Appear of
//     the layer; the Animation properties order it by a table column (stagger.by = { column: <name> }).
//   * "Edit after step N" draws the objects that have not appeared yet hidden (absent from the image's layer markup).
//   * Become by key: the layer picked, b, click the traces plot → a hand-off; the Animation properties show "3 pairs by
//     key"; the Pair select offers and writes "key"; each is one undo step. A preview of the step plays it.
//   * A clean console.
// Screenshots (for the lead, never asserted on): test-results/scratch/shots/xray-image-objects.png,
// test-results/scratch/shots/become-by-key-midflight.png
// Run: FLUX_URL=http://127.0.0.1:<port>/ env -u WAYLAND_DISPLAY -u DISPLAY node --import tsx scripts/verify-fluximg-slide-parts-gui.mjs
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { launch, gotoApp, clickMode, realErrors, waitFor, waitForFrame, sleep, APP_URL } from "./lib/driver.mjs";
import { harness } from "./lib/harness.mjs";
import { fixtures, writeFixture } from "./lib/fluximgFixtures.ts";

const h = harness("verify-fluximg-slide-parts-gui");
const SHOTS = "test-results/scratch/shots";
mkdirSync(SHOTS, { recursive: true });
const scratch = mkdtempSync(path.join(tmpdir(), "fx-parts-gui-"));
await writeFixture(scratch, fixtures().find((f) => f.name === "mean_f64_layers"));
function bundleFiles(name) {
  const root = path.join(scratch, `${name}.fluximg`), out = {};
  const walk = (d) => { for (const n of readdirSync(d)) { const p = path.join(d, n); if (statSync(p).isDirectory()) walk(p); else out[path.relative(root, p).split(path.sep).join("/")] = readFileSync(p).toString("base64"); } };
  walk(root);
  return out;
}

// A synthetic fluxplot-style plot of traces whose series NAMES are three of the footprints' keys (s1, s2, s3) and one that
// is no key (q9): the shape of the X-ray gates' band-power fixture (scripts/fixtures/xray-context), lines only.
const TRACES = ["s1", "s2", "s3", "q9"];
function tracesManifest() {
  return {
    spec: "fluxplot", schemaVersion: "0.3.0", plotType: "line", svg: "", size: { width: 300, height: 200, unit: "px" },
    axes: [{ x: { scale: "linear", label: "time", domain: [0, 10], anchors: [{ data: 0, svg: 40 }, { data: 10, svg: 280 }], ticks: [] },
      y: { scale: "linear", label: "dF/F", domain: [0, 4], anchors: [{ data: 0, svg: 180 }, { data: 4, svg: 20 }], ticks: [] } }],
    series: TRACES.map((name) => ({ id: `trace-${name}`, name, svg: { line: `trace-${name}.line` } })),
    build: { order: [] },
    parts: { id: "figure", role: "figure", kind: "container", children: [{ id: "plot-area", role: "plot-area", kind: "container", children: [
      { id: "axis.x", role: "axis", axis: "x", kind: "container", children: [{ ref: "axis.x.spine", kind: "line" }] },
      { id: "axis.y", role: "axis", axis: "y", kind: "container", children: [{ ref: "axis.y.spine", kind: "line" }] },
      ...TRACES.map((name) => ({ id: `trace-${name}`, role: "series", kind: "container", children: [{ ref: `trace-${name}.line`, kind: "line" }] })),
    ] }] },
  };
}
function tracesSvg() {
  const t = [`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" viewBox="0 0 300 200"><g id="figure">`,
    `<path id="axis.x.spine" d="M40 180H280" stroke="#100f0f"/><path id="axis.y.spine" d="M40 20V180" stroke="#100f0f"/>`];
  TRACES.forEach((name, i) => t.push(`<path id="trace-${name}.line" d="M40 ${160 - i * 35}L100 ${140 - i * 35}L160 ${150 - i * 35}L220 ${120 - i * 35}L280 ${135 - i * 35}" fill="none" stroke="${["#4385be", "#da702c", "#8b7ec8", "#35ab49"][i]}" stroke-width="1.5"/>`));
  t.push(`</g></svg>`);
  return t.join("");
}

const { browser, page } = await launch({ width: 1500, height: 960 });
const errs = realErrors(page);
const F = (fn, arg) => page.evaluate(fn, arg);
const authored = () => F(() => { const f = window.__flux, sid = f.get(f.fig.activeFigureId); return structuredClone(f.slide.currentDeck().slides.find((s) => s.id === sid)); });
const past = () => F(() => window.__flux.fig.historyStats().past);
const press = async (key, mods = []) => { for (const m of mods) await page.keyboard.down(m); await page.keyboard.press(key); for (const m of mods.slice().reverse()) await page.keyboard.up(m); await waitForFrame(page); };
const rows = () => F(() => [...document.querySelectorAll(".xray .row")].map((r) => ({ rid: r.dataset.rid, kind: r.dataset.kind, label: r.querySelector(".rlabel")?.textContent.trim(), preview: r.querySelector(".rprev")?.textContent.trim() ?? "", swatch: !!r.querySelector(".rprev .sw"), eye: !!r.querySelector("button.eye"), tw: !!r.querySelector("button.tw") })));
const box = (sel) => F((sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; }, sel);

try {
  await gotoApp(page, { url: `${APP_URL}?fixture=demo`, settle: 2500 });
  await clickMode(page, "Slide", { settle: 2600 });
  await waitFor(page, () => !!window.__flux?.get(window.__flux.slide.deckOverlay), null, { timeout: 15000, label: "deck loaded" });
  const ids = await F(async ({ files, svg, manifest }) => {
    const f = window.__flux, root = f.get(f.fig.embeddedProjectRoot) ?? f.get(f.fig.projectDir), sid = f.get(f.fig.activeFigureId);
    window.__fluxSeedFluximg("plots/cells.fluximg", files);
    const assetId = f.fluximg.place.fluximgAssetId("cells", "gui");
    const result = await window.fig.importFluximg({ root, sourcePath: "plots/cells.fluximg", assetId });
    const asset = f.fluximg.place.fluximgAsset(assetId, result, "plots/cells.fluximg");
    f.io.reimportPlot("w8-traces", svg, manifest);
    let id;
    f.fig.commit((p) => {
      const s = p.figures.find((x) => x.id === sid);
      s.elements = [];
      id = f.ops.addFluximg(p, { figureId: sid, asset, x: 40, y: 40, width: 300 });
      const el = s.elements.find((e) => e.id === id);
      // the footprints shown and coloured by their dendrite (a category, with one object without a value)
      el.view = { ...(el.view ?? {}), layers: { ...(el.view?.layers ?? {}), footprints: { visible: true, styleBy: { color: { column: "dendrite" } } } } };
      s.elements.push({ type: "plot", id: "traces", x: 380, y: 40, width: 240, height: 160, rotation: 0, assetId: "w8-traces", overrides: {}, source: { svgPath: "plots/traces.svg" } });
    });
    f.slide.commitDeckLive((d) => { const s = d.slides.find((x) => x.id === sid); s.beats = [s.beats[0], { id: "p1", label: "Step 1", tracks: [] }, { id: "p2", label: "Step 2", tracks: [] }, { id: "p3", label: "Step 3", tracks: [] }]; });
    f.slide.setEditDestination({ kind: "design" });
    f.fig.resetHistory();
    return { img: id };
  }, { files: bundleFiles("mean_f64_layers"), svg: tracesSvg(), manifest: tracesManifest() });
  const IMG = ids.img;
  await waitFor(page, (id) => !!document.querySelector(`[data-editor-element-id="${id}"] [data-layer="footprints"] [data-key="s1"]`), IMG, { label: "the footprints drawn", timeout: 15000 });

  // ------------------------------------------------------------------------------------------------------------
  h.section("the image's X-ray: layers and objects");
  await F((id) => window.__flux.fig.selectOnly(id), IMG);
  await page.mouse.move(1300, 150);
  await press("KeyR", ["Shift", "Alt"]);
  await waitFor(page, () => document.querySelectorAll(".xray .row").length > 1, null, { label: "x-ray rows", timeout: 8000 });
  await F(() => { for (const b of document.querySelectorAll(".xray .row[data-rid*='layer:footprints'] button.tw")) b.click(); });
  await waitFor(page, () => document.querySelectorAll(".xray .row[data-rid*='footprints/']").length >= 4, null, { label: "footprints listed", timeout: 5000 });
  let r = await rows();
  const layerRow = r.find((x) => x.rid.endsWith("layer:footprints")), objRows = r.filter((x) => /footprints\/s\d/.test(x.rid));
  h.ok(!!layerRow && layerRow.kind === "part" && layerRow.eye && layerRow.tw, `the label layer is a row with an eye and a twisty ("${layerRow?.label}")`);
  h.eq(objRows.map((x) => x.label), ["s1", "s2", "s3", "s7"], "its objects are rows named by key, in the layer's order");
  h.ok(objRows.every((x) => !x.eye && x.kind === "part"), "object rows have no eye (there is no per-object visibility)");
  h.ok(objRows.slice(0, 3).every((x) => x.swatch) && objRows.map((x) => x.preview).join(",") === "d1,d1,d2,–", `the styling column's value is each object's preview, with its colour (${objRows.map((x) => x.preview).join(", ")})`);
  h.ok(r.some((x) => x.rid.endsWith("layer:discs")) && r.some((x) => x.rid.endsWith("layer:prox_lines")) && !r.some((x) => /layer:(activity|footprint_weights)/.test(x.rid)), "every object layer is a row; intensity layers are not");
  // hover lights the object
  const s2row = await box(".xray .row[data-rid$='footprints/s2']");
  await page.mouse.move(s2row.cx, s2row.cy);
  await waitFor(page, () => !!document.querySelector("[data-xray-hover]"), null, { label: "the hover outline", timeout: 3000 });
  const outline = await box("[data-xray-hover]"), shape = await box(`[data-editor-element-id="${IMG}"] [data-layer="footprints"] [data-key="s2"]`);
  h.ok(!!outline && !!shape && Math.abs(outline.cx - shape.cx) < 3 && Math.abs(outline.cy - shape.cy) < 3, "hovering an object row outlines that object on the slide");
  await page.screenshot({ path: `${SHOTS}/xray-image-objects.png` });

  // ------------------------------------------------------------------------------------------------------------
  h.section("Animate from the X-ray");
  await F(() => { const f = window.__flux; f.slide.activeBeat.set(2); });
  const pickRow = async (suffix, add = false) => { const b = await box(`.xray .row[data-rid$='${suffix}'] .rlabel`); if (add) await page.keyboard.down("Control"); await page.mouse.click(b.cx, b.cy); if (add) await page.keyboard.up("Control"); await waitForFrame(page); };
  await pickRow("footprints/s1"); await pickRow("footprints/s3", true);
  let p0 = await past();
  await press("m"); await press("1");
  await waitFor(page, () => { const f = window.__flux, sid = f.get(f.fig.activeFigureId); return f.slide.currentDeck().slides.find((s) => s.id === sid).beats.some((b) => b.tracks.some((t) => t.parts?.includes("footprints/s1"))); }, null, { label: "an object track", timeout: 4000 });
  let s = await authored();
  let tr = s.beats.flatMap((b) => b.tracks).find((t) => t.parts?.includes("footprints/s1"));
  h.ok(tr && tr.target === IMG && tr.preset === "fade" && JSON.stringify(tr.parts) === JSON.stringify(["footprints/s1", "footprints/s3"]) && !!tr.stagger, `two picked objects → ONE fade bound to them, staggered (${JSON.stringify({ parts: tr?.parts, stagger: tr?.stagger })})`);
  h.eq(await past(), p0 + 1, "…one undo step");
  await press("z", ["Control"]);
  h.ok(!(await authored()).beats.some((b) => b.tracks.length), "undo removes it");
  // a whole layer, staggered, then ordered by a column (the X-ray is opened again if the action closed it)
  if (!(await F(() => !!document.querySelector(".xray .row[data-rid$='layer:footprints']")))) {
    await F((id) => window.__flux.fig.selectOnly(id), IMG); await page.mouse.move(1300, 150); await press("KeyR", ["Shift", "Alt"]);
    await waitFor(page, () => !!document.querySelector(".xray .row[data-rid$='layer:footprints']"), null, { label: "x-ray again", timeout: 5000 });
  }
  await pickRow("layer:footprints");
  p0 = await past();
  await press("m"); await press("1");
  await waitFor(page, () => { const f = window.__flux, sid = f.get(f.fig.activeFigureId); return f.slide.currentDeck().slides.find((s) => s.id === sid).beats.some((b) => b.tracks.some((t) => t.part === "layer:footprints")); }, null, { label: "a layer track", timeout: 4000 });
  s = await authored();
  tr = s.beats.flatMap((b) => b.tracks).find((t) => t.part === "layer:footprints");
  h.ok(tr && tr.stagger && (tr.stagger.totalMs ?? tr.stagger.perMs) > 0 && !tr.stagger.by, `a layer row → one staggered Appear of the layer, in its order (${JSON.stringify(tr?.stagger)})`);
  h.eq(await past(), p0 + 1, "…one undo step");
  await press("Escape");
  await F((id) => { const f = window.__flux; f.slide.selTrackIds.set([id]); }, tr.id);
  await F(() => { for (const b of document.querySelectorAll(".inspector-tabs button")) if (b.textContent.trim() === "Animation") b.click(); });
  await waitFor(page, () => !!document.querySelector('select[aria-label="Stagger order"]'), null, { label: "the stagger row", timeout: 5000 });
  const options = await F(() => [...document.querySelector('select[aria-label="Stagger order"]').options].map((o) => o.value));
  h.ok(options.includes("col:pixels") && options.includes("col:dendrite") && !options.includes("count"), `the stagger row offers the layer's columns (${options.join(", ")})`);
  await page.select('select[aria-label="Stagger order"]', "col:pixels");
  await waitForFrame(page);
  tr = (await authored()).beats.flatMap((b) => b.tracks).find((t) => t.part === "layer:footprints");
  h.eq(tr?.stagger?.by, { column: "pixels" }, "ordering by a column writes stagger.by = { column: 'pixels' }");
  const issues = await F((id) => { const f = window.__flux, sid = f.get(f.fig.activeFigureId); return f.slide.compileIssues ? f.slide.compileIssues(sid) : null; }, tr.id);
  void issues;

  // ------------------------------------------------------------------------------------------------------------
  h.section("Edit after step 1: unborn objects hidden");
  await F(() => { const f = window.__flux; f.slide.activeBeat.set(1); f.slide.editAfterBeat(1); });
  // Unborn objects are drawn as unborn plot parts are: left out, or ghosted at 0.25 while "Show hidden" is on.
  const unbornState = () => F((id) => { const f = window.__flux, ghost = !!f.get(f.slide.slideCanvasPresentation)?.ghostHidden || !!document.querySelector(".slide-mode")?.classList.contains("show-hidden");
    const w = document.querySelector(`[data-editor-element-id="${id}"]`), fp = [...(w?.querySelectorAll('[data-layer="footprints"] [data-key]') ?? [])];
    return { n: fp.length, opacities: fp.map((n) => Number(n.getAttribute("opacity") ?? 1)), discs: w?.querySelectorAll('[data-layer="discs"] [data-key]').length ?? 0 }; }, IMG);
  await waitFor(page, (id) => { const w = document.querySelector(`[data-editor-element-id="${id}"]`); const fp = [...(w?.querySelectorAll('[data-layer="footprints"] [data-key]') ?? [])]; return fp.every((n) => Number(n.getAttribute("opacity") ?? 1) <= 0.25); }, IMG, { label: "unborn footprints hidden", timeout: 5000 });
  const u1 = await unbornState();
  h.ok(u1.n === 0 || u1.opacities.every((o) => o > 0 && o <= 0.25), `at Edit after step 1 the footprints (appearing at step 2) are drawn unborn: ${u1.n ? `ghosted at ${u1.opacities.join(", ")} (Show hidden on, as plot parts)` : "left out"}`);
  await F(() => { const f = window.__flux; f.slide.activeBeat.set(2); f.slide.editAfterBeat(2); });
  await waitFor(page, (id) => { const fp = [...document.querySelectorAll(`[data-editor-element-id="${id}"] [data-layer="footprints"] [data-key]`)]; return fp.length === 4 && fp.slice(0, 3).every((n) => Number(n.getAttribute("opacity") ?? 1) > 0.9); }, IMG, { label: "footprints shown after step 2", timeout: 5000 });
  h.ok(true, "after step 2 they are drawn as at rest");
  await F(() => window.__flux.slide.setEditDestination({ kind: "design" }));

  // ------------------------------------------------------------------------------------------------------------
  h.section("Become by key: pick the layer, b, the traces plot");
  if (await F(() => !!document.querySelector(".xray"))) await press("Escape");
  await F(({ id }) => { const f = window.__flux; f.slide.activeBeat.set(3); f.fig.selectOnly(id); f.fig.setPartSelections([{ elementId: id, partId: "layer:footprints" }]); }, { id: IMG });
  p0 = await past();
  await press("b");
  await waitFor(page, () => !!document.querySelector(".become-bar"), null, { label: "the pick armed", timeout: 4000 });
  const plotBox = await box('[data-editor-element-id="traces"]');
  await page.mouse.move(plotBox.x + 4, plotBox.y + 4); await page.mouse.move(plotBox.x + 6, plotBox.y + 6);
  await page.keyboard.down("Alt"); await page.mouse.click(plotBox.cx, plotBox.cy); await page.keyboard.up("Alt");
  await waitForFrame(page);
  if (await F(() => !!document.querySelector(".become-bar"))) { await press("Enter"); }
  await waitFor(page, () => { const f = window.__flux, sid = f.get(f.fig.activeFigureId); return f.slide.currentDeck().slides.find((s) => s.id === sid).beats[3].tracks.some((t) => t.to?.become); }, null, { label: "the hand-off", timeout: 5000 });
  s = await authored();
  const bk = s.beats[3].tracks.find((t) => t.to?.become);
  h.ok(bk && bk.target === IMG && bk.part === "layer:footprints" && bk.to.become.mode === "handoff" && bk.to.become.ref.element === "traces", `the footprints hand off to the traces (${JSON.stringify(bk?.to?.become)})`);
  h.eq(await past(), p0 + 1, "…one undo step");
  await F((id) => window.__flux.slide.selTrackIds.set([id]), bk.id);
  await F(() => { for (const b of document.querySelectorAll(".inspector-tabs button")) if (b.textContent.trim() === "Animation") b.click(); });
  await waitFor(page, () => !!document.querySelector(".keypairs"), null, { label: "the pair count", timeout: 5000 });
  const kp = await F(() => ({ n: document.querySelector(".keypairs").getAttribute("data-key-pairs"), text: document.querySelector(".keypairs").textContent.trim() }));
  h.ok(kp.n === "3" && /auto pairs by key/.test(kp.text), `the Animation properties show the pairing: "${kp.text}"`);
  const pairOpts = await F(() => [...document.querySelector('select[aria-label="Hand-off pair"]').options].map((o) => o.value));
  h.ok(pairOpts.includes("key"), `the Pair select offers by key (${pairOpts.join(", ")})`);
  p0 = await past();
  await page.select('select[aria-label="Hand-off pair"]', "key");
  await waitForFrame(page);
  h.eq((await authored()).beats[3].tracks.find((t) => t.id === bk.id)?.to?.become?.pair, "key", "choosing by key writes pair: key");
  h.eq(await past(), p0 + 1, "…one undo step");
  // The planner itself pairs by the series' NAMES (their ids are "trace-<name>"): the plot's outlines carry the name
  // only for this pairing; asked plainly they are the outlines they always were.
  const planned = await F(async (trackId) => {
    const f = window.__flux, { compileSlide } = await import("/src/lib/slide/compile.ts"), { planHandoff } = await import("/src/lib/slide/handoffPlan.ts"), { targetOutlines } = await import("/src/lib/slide/targetGeometry.ts"), { fluximgPartsLookup } = await import("/src/lib/fluximg/parts.ts");
    const d = f.slide.currentDeck(), sl = d.slides.find((x) => x.id === f.get(f.fig.activeFigureId));
    const manifest = (id) => f.get(f.plot.plotManifests)[id], { appFluximgParts } = await import("/src/lib/fluximg/partStore.ts");
    // the window's own lookup when this copy of the module has it, else the image store's (a hot-reloaded dev server
    // can hand a plain import a second copy of a module the app already holds under a versioned URL)
    const fluximgParts = fluximgPartsLookup() ?? ((assetId) => appFluximgParts(assetId));
    const frame = compileSlide(sl, d.stage, { plotManifest: manifest, fluximgParts }).sample(3);
    const ctx = { manifest, plotRoot: (id) => f.plot.plotDom.get(id), groups: sl.groups, fluximgParts };
    const track = sl.beats[3].tracks.find((t) => t.id === trackId);
    const plan = planHandoff(track, frame, ctx);
    const plain = targetOutlines({ element: "traces" }, frame, ctx);
    return { policy: plan.policy, both: plan.pairs.filter((x) => x.a && x.b).length, named: plain.filter((o) => "seriesName" in o.owner).length, series: plain.filter((o) => o.owner.series).length };
  }, bk.id);
  h.ok(planned.policy === "key" && planned.both === 3, `the planner pairs three footprints with their traces by the series' names (policy ${planned.policy}, ${planned.both} pairs)`);
  h.ok(planned.named === 0 && planned.series > 0, `asked plainly, the plot's outlines carry no series name (${planned.named} of ${planned.series} series parts)`);
  // the preview plays it (a screenshot mid-flight for the eye)
  await F(() => { for (const b of document.querySelectorAll(".step-controls button")) if (b.title === "Replay this step") b.click(); });
  await waitFor(page, () => !!document.querySelector(".preview-overlay"), null, { label: "the preview", timeout: 4000 });
  await sleep(550);
  await page.screenshot({ path: `${SHOTS}/become-by-key-midflight.png` });
  const flying = await F(() => document.querySelectorAll(".preview-overlay svg path").length);
  h.ok(flying > 0, `the step preview plays the flight (${flying} paths in the preview)`);
  await sleep(1500);

  h.section("console");
  h.eq(errs.filter((e) => !/favicon/.test(e)), [], "no console errors");
} catch (error) {
  h.fail(`gate threw: ${error?.stack ?? error}`);
} finally {
  await browser.close();
}
await h.done();
