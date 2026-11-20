// fluximg Inspector gate (ui tier): the Inspector's sections for a selected image, "the live view's settings as
// numbers", driven with real input against the dev server (FLUX_URL, default :1420).
//
//   · with a synthetic z-stack placed and selected: the Image, Channels, Position, Annotations and View sections
//     appear (Layers does not: the stack has none) and show the RESOLVED view (the manifest's windows, the
//     manifest's default plane, the pixel size)
//   · typing a white point writes element.view.channels[i].range and makes exactly ONE undo entry; a wheel run over
//     a field is one undo entry too
//   · typing the default back removes the key, and an all-default view removes `view` from the element
//   · toggling a channel, the scale bar, a layer and an object layer's names; changing the plane; choosing a
//     projection and its run; Blend / Single
//   · a locked selection shows the same values with every control disabled, and nothing writes
//   · "Live view" opens the live view on the element
//   · no console errors
//
// Synthetic data only: the bundles come from scripts/lib/fluximgFixtures.ts, written by a tsx child into a scratch
// directory that is removed at the end, then seeded into the in-memory demo project.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch, gotoApp, clickMode, sleep, realErrors, waitFor, APP_URL } from "./lib/driver.mjs";
import { harness } from "./lib/harness.mjs";
import { tsxRun } from "./lib/tsxRun.mjs";

const h = harness("verify-fluximg-inspector");
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(path.join(tmpdir(), "fx-inspector-gate-"));
const NAMES = ["stack_u16", "mean_f64_layers"];

// --- synthetic bundles ------------------------------------------------------------------------------
const writer = path.join(scratch, "write.mts");
writeFileSync(writer, `import { fixtures, writeFixture } from ${JSON.stringify(path.join(repo, "scripts/lib/fluximgFixtures.ts"))};
const out = process.argv[2], want = process.argv.slice(3);
for (const f of fixtures()) if (want.includes(f.name)) await writeFixture(out, f);
`);
const [node, args] = tsxRun(writer, [path.join(scratch, "bundles"), ...NAMES]);
execFileSync(node, args, { cwd: repo, stdio: "inherit" });
function bundleFiles(root) {
  const out = {};
  const walk = (d) => { for (const n of readdirSync(d)) { const p = path.join(d, n); if (statSync(p).isDirectory()) walk(p); else out[path.relative(root, p).split(path.sep).join("/")] = readFileSync(p).toString("base64"); } };
  walk(root);
  return out;
}
const bundles = Object.fromEntries(NAMES.map((n) => [n, bundleFiles(path.join(scratch, "bundles", `${n}.fluximg`))]));

const { browser, page } = await launch({ width: 1500, height: 1300 });

// --- page helpers -----------------------------------------------------------------------------------
const el = (id) => page.evaluate((id) => structuredClone(window.__flux.figures().flatMap((f) => f.elements).find((e) => e.id === id)), id);
const past = () => page.evaluate(() => window.__flux.fig.historyStats().past);
const select = (id) => page.evaluate((id) => window.__flux.fig.selectOnly(id), id);
const sel = (s) => `.inspector ${s}`;
/** Type into a NumberField (select its text, type, Enter): a discrete typed edit. */
async function typeField(selector, text) {
  const input = await page.$(sel(selector));
  if (!input) throw new Error(`no field ${selector}`);
  await input.click({ clickCount: 3 });
  await page.keyboard.down("Control"); await page.keyboard.press("KeyA"); await page.keyboard.up("Control");
  if (text) await page.keyboard.type(text);
  else await page.keyboard.press("Delete");
  await page.keyboard.press("Enter");
  await sleep(150);
}
async function click(selector) {
  const node = await page.$(sel(selector));
  if (!node) throw new Error(`no control ${selector}`);
  await node.click();
  await sleep(150);
}
/** One discrete edit: run it, return the element after and how many undo entries it made. */
async function edit(id, act) {
  const before = await past();
  await act();
  await sleep(120);
  return { e: await el(id), undo: (await past()) - before };
}
const fieldValue = (selector) => page.$eval(sel(selector), (n) => n.value);
const WHITE1 = '[data-fluximg-channel="1"] .three label:nth-child(2) input';
const BLACK0 = '[data-fluximg-channel="0"] .three label:nth-child(1) input';

let ok = false;
try {
  await gotoApp(page, { url: `${APP_URL}?fixture=demo`, settle: 1500 });
  await clickMode(page, "Figure");
  await waitFor(page, () => !!window.__flux?.fluximg && !!document.querySelector(".canvas-host"), null, { timeout: 20000, label: "Figure mounted" });

  // Seed and place both bundles through the real import + ops.
  const placed = await page.evaluate(async (bundles) => {
    const F = window.__flux, root = F.get(F.fig.embeddedProjectRoot) ?? F.get(F.fig.projectDir);
    const figureId = F.get(F.fig.activeFigureId) ?? F.get(F.fig.project).figures[0].id;
    const out = {};
    let x = 30;
    for (const [name, files] of Object.entries(bundles)) {
      window.__fluxSeedFluximg(`plots/${name}.fluximg`, files);
      const assetId = F.fluximg.place.fluximgAssetId(name, `gate${x}`);
      const result = await window.fig.importFluximg({ root, sourcePath: `plots/${name}.fluximg`, assetId });
      const asset = F.fluximg.place.fluximgAsset(assetId, result, `plots/${name}.fluximg`);
      let id;
      F.fig.commit((p) => { id = F.ops.addFluximg(p, { figureId, asset, x, y: 30, width: 220, source: { bundlePath: `/synthetic/data/${name}.fluximg` } }); });
      out[name] = { id, assetId };
      x += 260;
    }
    F.fig.viewport.set({ panX: 120, panY: 120, zoom: 1 });
    F.fig.resetHistory();
    return out;
  }, bundles);
  const stack = placed.stack_u16.id, layered = placed.mean_f64_layers.id;

  // --- 1. sections and resolved values ---------------------------------------------------------------
  h.section("sections show the resolved view");
  await select(stack);
  await waitFor(page, () => !!document.querySelector('.inspector [data-fluximg-inspector="channels"]'), null, { timeout: 15000, label: "manifest read, channels shown" });
  const sections = await page.$$eval(".inspector [data-fluximg-inspector]", (n) => n.map((s) => s.getAttribute("data-fluximg-inspector")));
  h.eq(sections, ["image", "channels", "position", "annotations", "view"], "the stack shows Image, Channels, Position, Annotations, View (no Layers: it has none)");
  h.eq(await page.$eval(sel("[data-fluximg-describe]"), (n) => n.textContent.trim()), "2 channels · 7 z · 64 × 48 · uint16", "Image says what it is");
  h.ok(await page.$(sel("[data-fluximg-inspector-state]")) === null, "no loading line once the manifest is in");
  h.ok((await page.$eval(sel("[data-fluximg-source]"), (n) => n.getAttribute("title"))) === "/synthetic/data/stack_u16.fluximg", "the source bundle's full path is the title");
  const manifest = await page.evaluate((assetId) => { const F = window.__flux; return structuredClone(F.get(F.fluximg.store.fluximgManifests)[assetId]); }, placed.stack_u16.assetId);
  const defaultWhite1 = manifest.channels[1].range[1], defaultBlack0 = manifest.channels[0].range[0];
  const shownWhite = Number(await fieldValue(WHITE1));
  h.ok(Math.abs(shownWhite - defaultWhite1) <= 0.5, `the white point shows the manifest's window (${shownWhite} ~ ${defaultWhite1})`);
  h.eq(Number(await fieldValue(BLACK0)), Math.round(defaultBlack0), "the black point shows the manifest's window (integer data, whole numbers)");
  h.eq(await fieldValue('[data-fluximg-dim="z"] input'), "4", "the plane is the manifest's default (z index 3, shown 1-based)");
  h.ok((await page.$eval(sel('[data-fluximg-where="z"]'), (n) => n.textContent)).startsWith("z 4/7"), "the physical position is printed beside the plane");
  h.eq(await page.$$eval(sel("[data-fluximg-channel]"), (n) => n.length), 2, "one block per channel");

  // --- 2. a white point: one undo, then back to default clears ----------------------------------------
  h.section("white point");
  let r = await edit(stack, () => typeField(WHITE1, "2000"));
  h.eq(r.e.view?.channels?.[1]?.range, [manifest.channels[1].range[0], 2000], "typing a white point writes view.channels[1].range");
  h.eq(r.e.view?.channels?.[0], null, "the other channel is left alone (a hole)");
  h.eq(r.undo, 1, "exactly one undo entry");
  r = await edit(stack, () => typeField(WHITE1, String(defaultWhite1)));
  h.eq(r.e.view, undefined, "typing the default back removes the key, and the all-default view removes `view`");
  h.eq(r.undo, 1, "…one undo entry");
  // A wheel run over the field: live, and one undo entry for the whole run.
  {
    const input = await page.$(sel(WHITE1));
    await input.evaluate((n) => n.scrollIntoView({ block: "center" }));
    const b = await input.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    const before = await past();
    for (let i = 0; i < 4; i++) { await page.mouse.wheel({ deltaY: -100 }); await sleep(40); }
    const mid = await el(stack);
    await sleep(400);
    const after = await el(stack);
    h.ok(!!mid.view?.channels?.[1]?.range && mid.view.channels[1].range[1] !== defaultWhite1, "the wheel previews live (the element changes during the run)");
    h.ok(Number.isInteger(after.view?.channels?.[1]?.range?.[1]), "integer data scrubs in whole values");
    h.eq((await past()) - before, 1, "a wheel run is one undo entry");
    await page.mouse.move(10, 10);
    await page.evaluate(() => window.__flux.fig.undo());
    await sleep(150);
    h.eq((await el(stack)).view, undefined, "undo returns the whole run");
  }

  // --- 3. toggles -------------------------------------------------------------------------------------
  h.section("toggles");
  r = await edit(stack, () => click('[data-fluximg-channel="0"] [data-fluximg-channel-show]'));
  h.eq(r.e.view?.channels?.[0], { visible: false }, "unticking a channel hides it");
  h.eq(r.undo, 1, "…one undo entry");
  r = await edit(stack, () => click('[data-fluximg-channel="0"] [data-fluximg-channel-show]'));
  h.eq(r.e.view, undefined, "ticking it again clears the key (shown is the default)");
  r = await edit(stack, () => click("[data-fluximg-scalebar]"));
  h.eq(r.e.view?.furniture, { scalebar: {} }, "the scale bar switches on with defaults ({})");
  h.eq(r.undo, 1, "…one undo entry");
  h.ok(!!(await page.$(sel('[data-fluximg-furniture="scalebar"] .three'))), "its length, thickness and size fields appear");
  const LENGTH = '[data-fluximg-furniture="scalebar"] .three label:nth-child(1) input';
  r = await edit(stack, () => typeField(LENGTH, "10"));
  h.eq(r.e.view?.furniture?.scalebar, { length: 10 }, "a typed length is stored in the image's unit");
  h.eq(r.undo, 1, "…one undo entry");
  r = await edit(stack, () => typeField(LENGTH, ""));
  h.eq(r.e.view?.furniture?.scalebar, {}, "emptying the length returns to auto (the key goes, the bar stays on)");
  h.eq(await fieldValue(LENGTH), "", "…and the field shows its auto placeholder");
  r = await edit(stack, () => click("[data-fluximg-scalebar]"));
  h.eq(r.e.view, undefined, "and off again leaves no view");
  r = await edit(stack, () => click('[data-fluximg-composite="single"]'));
  h.eq(r.e.view, { composite: "single" }, "Single shows one channel");
  r = await edit(stack, () => page.select(sel('select[aria-label="Channel shown"]'), "1"));
  h.eq(r.e.view, { composite: "single", solo: 1 }, "…and which one");
  h.eq(r.undo, 1, "…one undo entry");
  r = await edit(stack, () => click('[data-fluximg-composite="blend"]'));
  h.eq(r.e.view, undefined, "Blend is the default: the view empties");

  // --- 4. plane and projection ------------------------------------------------------------------------
  h.section("position");
  r = await edit(stack, () => typeField('[data-fluximg-dim="z"] input', "6"));
  h.eq(r.e.view, { index: { z: 5 } }, "typing plane 6 stores index 5 (1-based on screen)");
  h.eq(r.undo, 1, "…one undo entry");
  r = await edit(stack, () => typeField('[data-fluximg-dim="z"] input', "99"));
  h.eq(r.e.view, { index: { z: 6 } }, "a plane past the end is clamped to the last");
  r = await edit(stack, () => typeField('[data-fluximg-dim="z"] input', "4"));
  h.eq(r.e.view, undefined, "the default plane clears the key");
  r = await edit(stack, () => page.select(sel("[data-fluximg-projection]"), "max"));
  h.eq(r.e.view, { projection: { dim: "z", mode: "max", from: 0, to: 7 } }, "a projection starts over the whole dimension");
  h.eq(r.undo, 1, "…one undo entry");
  h.ok(await page.$(sel('[data-fluximg-dim="z"]')) === null, "the projected dimension's plane field gives way to the run");
  r = await edit(stack, () => typeField(".two label:nth-child(1) input", "2"));
  h.eq(r.e.view?.projection, { dim: "z", mode: "max", from: 1, to: 7 }, "From 2 (1-based, inclusive) stores from 1");
  h.ok((await page.$eval(sel("[data-fluximg-run]"), (n) => n.textContent)).startsWith("max z 2–7"), "the run is described in words");
  r = await edit(stack, () => page.select(sel("[data-fluximg-projection]"), ""));
  h.eq(r.e.view, undefined, "One plane returns to the run's middle (here the default plane): no view");

  h.section("crop");
  const CROP_W = '[data-fluximg-crop="size"] label:nth-child(1) input';
  r = await edit(stack, () => typeField(CROP_W, "32"));
  h.eq(r.e.crop, { x: 0, y: 0, width: 32, height: 48 }, "W 32 crops to the left half, in image pixels");
  h.eq(r.undo, 1, "…one undo entry");
  r = await edit(stack, async () => {
    const target = await page.evaluateHandle(() => [...document.querySelectorAll(".inspector button.true-size")].find((b) => b.textContent.includes("Reset crop")) ?? null);
    if (!target.asElement()) throw new Error("no Reset crop button");
    await target.asElement().click();
    await sleep(150);
  });
  h.eq(r.e.crop, undefined, "the Inspector's own Reset crop shows the whole image again (reused, not duplicated)");
  h.eq(await page.$$eval(sel("[data-fluximg-inspector] button"), (n) => n.filter((b) => /whole image|reset crop/i.test(b.textContent)).length), 0, "the image sections add no second reset");

  // --- 5. layers and object names (the layered fixture) ------------------------------------------------
  h.section("layers");
  await select(layered);
  await waitFor(page, () => !!document.querySelector('.inspector [data-fluximg-inspector="layers"]'), null, { timeout: 15000, label: "layers section" });
  h.eq(await page.$$eval(sel("[data-fluximg-layer]"), (n) => n.map((x) => x.getAttribute("data-fluximg-layer"))).then((a) => a.length), 5, "one block per layer");
  r = await edit(layered, () => click('[data-fluximg-layer="footprints"] [data-fluximg-layer-show]'));
  h.eq(r.e.view, { layers: { footprints: { visible: false } } }, "unticking a layer that shows by default hides it");
  h.eq(r.undo, 1, "…one undo entry");
  r = await edit(layered, () => typeField('[data-fluximg-layer="footprints"] .three label:nth-child(1) input', "40"));
  h.eq(r.e.view?.layers?.footprints, { visible: false, opacity: 0.4 }, "opacity 40 % stores 0.4");
  r = await edit(layered, () => typeField('[data-fluximg-layer="footprints"] .three label:nth-child(1) input', "100"));
  r = await edit(layered, () => click('[data-fluximg-layer="footprints"] [data-fluximg-layer-show]'));
  h.eq(r.e.view, undefined, "opacity 100 % and shown again are defaults: no view");
  r = await edit(layered, () => click('[data-fluximg-names="discs"]'));
  h.eq(r.e.view, { furniture: { names: { layers: ["discs"] } } }, "names on for one object layer");
  r = await edit(layered, () => click('[data-fluximg-names="discs"]'));
  h.eq(r.e.view, undefined, "off again: names off, no view");
  r = await edit(layered, () => click('[data-fluximg-channel="1"] [data-fluximg-use-colour]'));
  h.ok(typeof r.e.view?.channels?.[1]?.color === "string" && !("lut" in r.e.view.channels[1]), "a colour-mapped channel takes a single colour on request");
  h.ok(!!(await page.$(sel('[data-fluximg-channel="1"] .swatch'))), "…and then shows a colour field");
  await page.evaluate(() => window.__flux.fig.undo());
  await sleep(150);

  // --- 6. read-only -------------------------------------------------------------------------------------
  h.section("read-only");
  await select(stack);
  await page.evaluate((id) => window.__flux.fig.commit((p) => { for (const f of p.figures) for (const e of f.elements) if (e.id === id) e.locked = true; }), stack);
  await sleep(250);
  const ro = await page.evaluate(() => {
    const root = document.querySelector('.inspector [data-fluximg-inspector="channels"]');
    const controls = [...document.querySelectorAll('.inspector [data-fluximg-inspector] :is(input, select, button)')];
    return {
      shown: !!root,
      value: document.querySelector('.inspector [data-fluximg-channel="1"] .three label:nth-child(2) input')?.value,
      enabled: controls.filter((n) => !n.matches(":disabled")).map((n) => n.outerHTML.slice(0, 80)),
      count: controls.length,
    };
  });
  h.ok(ro.shown, "a locked image still shows its sections");
  h.ok(Math.abs(Number(ro.value) - defaultWhite1) <= 0.5, "…with the same values");
  h.eq(ro.enabled, [], `…and all ${ro.count} controls disabled (Live view included)`);
  const beforeRo = await past();
  await page.$eval(sel('[data-fluximg-channel="0"] [data-fluximg-channel-show]'), (n) => n.click());
  await sleep(150);
  h.eq((await el(stack)).view, undefined, "a click on a disabled control writes nothing");
  h.eq((await past()) - beforeRo, 0, "…and makes no undo entry");
  await page.evaluate((id) => window.__flux.fig.commit((p) => { for (const f of p.figures) for (const e of f.elements) if (e.id === id) delete e.locked; }), stack);
  await sleep(250);

  // --- 7. the live view -----------------------------------------------------------------------------------
  h.section("live view");
  h.ok(!(await page.$eval(sel("[data-fluximg-open-live]"), (n) => n.disabled)), "Live view is enabled on an unlocked image");
  await click("[data-fluximg-open-live]");
  await waitFor(page, (id) => { const F = window.__flux; return F.get(F.fluximg.live.fluximgLive)?.elementId === id; }, stack, { timeout: 5000, label: "live view open" });
  h.ok(true, "Live view opens the live view on the element");
  await page.evaluate(() => window.__flux.fluximg.live.closeFluximgLive());
  await sleep(200);

  const errs = realErrors(page);
  h.eq(errs, [], "no console errors");
  ok = true;
} catch (error) {
  h.fail(`gate aborted: ${error?.stack ?? error}`);
} finally {
  if (!ok) await page.screenshot({ path: path.join(repo, "test-results", "verify-fluximg-inspector-fail.png") }).catch(() => {});
  await browser.close().catch(() => {});
  rmSync(scratch, { recursive: true, force: true });
}
await h.done();
