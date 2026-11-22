// verify-tiff-app-gui (ui tier; your dev server; FLUX_URL for a worktree): TIFF import in the headless app, through the
// in-memory bridge, whose conversions are REAL (the dev server's route runs the same converter child as the desktop app).
//   * a file whose metadata says everything (ImageJ) converts and places at once; the toast says what was understood,
//     with Change and Cancel; one Ctrl+Z removes it;
//   * a metadata-free two-channel stack opens the ASKING SURFACE where it was dropped: pictures per channel, proposals,
//     the pages as keys (reorder by drag), transpose, pixel size and rate written in place, Convert off with its reason
//     while the answer does not fit; converting places the image with the right dims, axes and channels; the answer is
//     remembered for the project;
//   * the next file of the family converts without asking; Change during a conversion reopens the surface; Esc leaves
//     nothing; Cancel during a conversion leaves nothing; a refused file says why;
//   * the same on a slide; the Plots rail lists a TIFF under plots/ with a picture and places it;
//   * a keyboard-only path; the surface's chrome rules (no native form controls, nothing animating at rest, presses
//     swallowed, the hint line never cut); a clean console.
//   Run: FLUX_URL=http://127.0.0.1:<port>/ env -u WAYLAND_DISPLAY -u DISPLAY node --import tsx scripts/verify-tiff-app-gui.mjs
import { launch, gotoApp, clickMode, realErrors, APP_URL } from "./lib/driver.mjs";
import { waitFor } from "./lib/wait.mjs";
import { harness } from "./lib/harness.mjs";
import { writeTiff, rng } from "./lib/tiffFixtures.ts";

const h = harness("verify-tiff-app-gui");
const r = rng(11);
const b64 = (u8) => Buffer.from(u8).toString("base64");
/** No metadata: `t` frames x 2 interleaved channels of different brightness and shape, W x H (W ≠ H so a transpose shows). */
function family(t, W = 72, H = 48, ch = 2) {
  return b64(writeTiff({ pages: Array.from({ length: t * ch }, (_, p) => {
    const c = p % ch, d = new Uint16Array(W * H);
    for (let i = 0; i < d.length; i++) { const x = i % W, y = (i / W) | 0; d[i] = (c ? 2500 : 300) + ((r() * 60) | 0) + (c ? (900 * Math.exp(-((x - 20) ** 2 + (y - 12) ** 2) / 120)) | 0 : (x + y) % 12 < 2 ? 700 : 0); }
    return { width: W, height: H, dtype: "uint16", data: d };
  }) }));
}
const imagej = b64(writeTiff({ pages: Array.from({ length: 12 }, (_, p) => ({ width: 40, height: 30, dtype: "uint8", data: Uint8Array.from({ length: 1200 }, (_, i) => (p * 9 + i) % 251), descriptions: p === 0 ? ["ImageJ=1.54f\nimages=12\nchannels=2\nslices=3\nframes=2\nhyperstack=true\nunit=micron\nspacing=0.5\nfinterval=0.1\n"] : [], resolution: { x: 4, y: 4, unit: 1 } })) }));
// An ImageJ float stack whose unscanned pixels hold -1: its pages are settled, the -1 is the one question.
const holes = b64(writeTiff({ pages: Array.from({ length: 4 }, (_, p) => ({ width: 40, height: 30, dtype: "float32", data: Float32Array.from({ length: 1200 }, (_, i) => (i % 40 < 10 ? -1 : 5 + p + (i % 9))), descriptions: p === 0 ? ["ImageJ=1.54f\nimages=4\nslices=4\nhyperstack=true\nunit=micron\nspacing=1\n"] : [], resolution: { x: 2, y: 2, unit: 1 } })) }));
const jpeg = b64(writeTiff({ pages: [{ width: 8, height: 8, dtype: "uint8", data: new Uint8Array(64), compressionCode: 7 }] }));
const famA = family(40), famB = family(25), famKeys = family(30, 50, 40, 3);

const { browser, page } = await launch({ width: 1500, height: 960 });
const errs = realErrors(page);
const S = (fn, arg) => page.evaluate(fn, arg);
const ask = () => S(() => { const F = window.__flux; const s = F.get(F.fluximg.tiff.tiffAsk); return s ? { answer: s.answer, problem: s.problem, chosen: s.chosen, hover: !!s.hover, remember: s.remember, pictures: (s.hover ?? s.preview)?.channels.length ?? 0, png0: (s.hover ?? s.preview)?.channels[0]?.png.slice(-40) ?? "" } : null; });
const images = () => S(() => window.__flux.figures().flatMap((f) => f.elements.filter((e) => e.type === "fluximg").map((e) => ({ id: e.id, fig: f.id, assetId: e.assetId, source: e.source }))));
const assetFiles = () => S(() => [...window.fig._files.keys()].filter((k) => /\/fig\/assets\/[^/]+\.fluximg/.test(k) || /\/fig\/assets\/\./.test(k)).map((k) => k.split("/fig/assets/")[1].split("/")[0]).filter((v, i, a) => a.indexOf(v) === i));
const manifestOf = (assetId) => S((id) => { const F = window.__flux; return F.get(F.fluximg.store.fluximgManifests)[id] ?? null; }, assetId);
/** A big stack of the same family (72 x 48 uint16, two channels), written IN the page: tens of MB must not cross CDP. */
const BIG = { frames: 2400 };
async function dropBig(name) {
  await S(({ name, frames }) => {
    const W = 72, H = 48, N = frames * 2, plane = W * H * 2, tags = 11, ifd = 2 + tags * 12 + 4, dataEnd = 8 + N * plane;
    const buf = new ArrayBuffer(dataEnd + N * ifd), dv = new DataView(buf), u16 = new Uint16Array(buf, 8, N * W * H);
    dv.setUint8(0, 0x49); dv.setUint8(1, 0x49); dv.setUint16(2, 42, true); dv.setUint32(4, dataEnd, true);
    for (let i = 0; i < u16.length; i++) { const p = Math.floor(i / (W * H)); u16[i] = (p % 2 ? 2500 : 300) + ((i * 2654435761) >>> 26); }
    for (let p = 0; p < N; p++) {
      const at = dataEnd + p * ifd;
      dv.setUint16(at, tags, true);
      [[256, 3, W], [257, 3, H], [258, 3, 16], [259, 3, 1], [262, 3, 1], [273, 4, 8 + p * plane], [277, 3, 1], [278, 3, H], [279, 4, plane], [284, 3, 1], [339, 3, 1]].forEach(([tag, type, v], k) => {
        const e = at + 2 + k * 12;
        dv.setUint16(e, tag, true); dv.setUint16(e + 2, type, true); dv.setUint32(e + 4, 1, true);
        if (type === 3) dv.setUint16(e + 8, v, true); else dv.setUint32(e + 8, v, true);
      });
      dv.setUint32(at + 2 + tags * 12, p + 1 < N ? at + ifd : 0, true);
    }
    const file = new File([buf], name, { type: "image/tiff" });
    const dt = new DataTransfer(); dt.items.add(file);
    const F = window.__flux, fig = F.figures().find((f) => f.id === F.get(F.fig.activeFigureId)) ?? F.figures()[0], host = document.querySelector(".canvas-host"), r = host.getBoundingClientRect(), vp = F.get(F.fig.viewport);
    const p = { x: r.left + vp.panX + (fig.x + fig.width / 2) * vp.zoom, y: r.top + vp.panY + (fig.y + fig.height / 2) * vp.zoom };
    host.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, clientX: p.x, clientY: p.y, bubbles: true, cancelable: true }));
    host.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, clientX: p.x, clientY: p.y, bubbles: true, cancelable: true }));
  }, { name, frames: BIG.frames });
}
/** Drop a TIFF (base64) on the canvas at the active figure's centre, or `at` (client px). */
async function drop(data, name, at) {
  const p = at ?? await S(() => { const F = window.__flux; const fig = F.figures().find((f) => f.id === F.get(F.fig.activeFigureId)) ?? F.figures()[0]; const host = document.querySelector(".canvas-host").getBoundingClientRect(); const vp = F.get(F.fig.viewport); return { x: host.left + vp.panX + (fig.x + fig.width / 2) * vp.zoom, y: host.top + vp.panY + (fig.y + fig.height / 2) * vp.zoom }; });
  await S(({ data, name, p }) => {
    const file = new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], name, { type: "image/tiff" });
    const dt = new DataTransfer(); dt.items.add(file);
    const host = document.querySelector(".canvas-host");
    host.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, clientX: p.x, clientY: p.y, bubbles: true, cancelable: true }));
    host.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, clientX: p.x, clientY: p.y, bubbles: true, cancelable: true }));
  }, { data, name, p });
  return p;
}
const surface = (timeout = 15000) => waitFor(page, () => !!document.querySelector("[data-tiff-ask] [data-ask-picture]"), null, { label: "the asking surface", timeout });
const noSurface = () => S(() => !document.querySelector("[data-tiff-ask]"));
const settle = (ms = 250) => new Promise((res) => setTimeout(res, ms));
const centre = (sel) => S((s) => { const b = document.querySelector(s)?.getBoundingClientRect(); return b ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null; }, sel);
// Every toast that ever shows, with its buttons (a fast conversion's toast lives for milliseconds).
const watchToasts = () => S(() => {
  window.__tiffToasts = [];
  new MutationObserver(() => { for (const t of document.querySelectorAll('[data-toast-tag="tiff-import"], .toast')) { const rec = { msg: t.querySelector(".t-msg")?.textContent ?? "", detail: t.querySelector(".t-detail")?.textContent ?? "", buttons: [...t.querySelectorAll(".t-act")].map((b) => b.textContent), tagged: t.dataset.toastTag === "tiff-import" }; if (!window.__tiffToasts.some((x) => x.msg === rec.msg && x.detail === rec.detail && x.buttons.join() === rec.buttons.join())) window.__tiffToasts.push(rec); } })
    .observe(document.body, { subtree: true, childList: true, characterData: true });
});
const seenToasts = () => S(() => window.__tiffToasts ?? []);
const clickToast = (label) => S((label) => { const b = [...document.querySelectorAll('[data-toast-tag="tiff-import"] .t-act')].find((x) => x.textContent === label); b?.click(); return !!b; }, label);

try {
  await gotoApp(page, { url: `${APP_URL}?fixture=demo`, settle: 2500 });
  await clickMode(page, "Figure");
  await waitFor(page, () => !!document.querySelector(".canvas-host") && !!window.__flux?.fluximg?.tiff, null, { label: "canvas and handles" });
  const root = await S(() => { const F = window.__flux; return F.get(F.fig.embeddedProjectRoot) ?? F.get(F.fig.projectDir); });
  await watchToasts();

  h.section("a file that says everything converts at once");
  await drop(imagej, "hyper.tif");
  const ij = await waitFor(page, () => window.__flux.figures().flatMap((f) => f.elements).find((e) => e.type === "fluximg") ?? null, null, { label: "the placed image", timeout: 15000 });
  h.ok(await noSurface(), "no question was asked");
  const ijm = await manifestOf(ij.assetId);
  h.eq({ dims: ijm?.pixels.dims, shape: ijm?.pixels.shape }, { dims: ["t", "c", "z", "y", "x"], shape: [2, 2, 3, 30, 40] }, "ImageJ's order and sizes are understood");
  h.ok(ijm?.axes?.x?.scale === 0.25 && ijm.axes.z.scale === 0.5, `…its pixel size and z step too (${ijm?.axes?.x?.scale} ${ijm?.axes?.x?.unit}, z ${ijm?.axes?.z?.scale})`);
  const ijToast = (await seenToasts()).find((t) => t.tagged && /^hyper\.tif: t 2 × z 3 × c 2/.test(t.msg));
  h.ok(!!ijToast && ijToast.buttons.includes("Change") && ijToast.buttons.includes("Cancel"), `the toast's first line says what was understood, with Change and Cancel: "${ijToast?.msg}"`);
  h.ok((await seenToasts()).some((t) => /^hyper placed/.test(t.msg)), "…and then that it was placed");
  h.ok(ij.source?.frozen === true && ij.source.bundlePath === "hyper.tif", "the element records the TIFF as its source, frozen");
  await page.mouse.click(1100, 800);
  await page.keyboard.down("Control"); await page.keyboard.press("KeyZ"); await page.keyboard.up("Control");
  h.ok(await waitFor(page, () => !window.__flux.figures().flatMap((f) => f.elements).some((e) => e.type === "fluximg"), null, { label: "undo" }).then(() => true, () => false), "one Ctrl+Z removes it");

  h.section("a settled file with a -1 fill: one question");
  await drop(holes, "holes.tif");
  await surface();
  const reason = await S(() => document.querySelector("[data-ask-reason]")?.textContent ?? "");
  h.ok(/does -1 .* mean "no data"/.test(reason), `a float file whose pages are settled is asked one question when -1 fills its plane: "${reason}"`);
  await page.keyboard.press("d");
  h.eq((await ask()).answer.nodata, -1, "D answers it");
  await page.keyboard.press("Enter");
  const hp = await waitFor(page, () => window.__flux.figures().flatMap((f) => f.elements).find((e) => e.type === "fluximg") ?? null, null, { label: "the -1 stack placed", timeout: 15000 });
  const hm = await manifestOf(hp.assetId);
  h.ok(hm && hm.channels[0].stats.min >= 5, `…and -1 is no data in the bundle: the stored minimum is ${hm?.channels[0].stats.min}, not -1`);
  await page.mouse.click(1100, 800);
  await page.keyboard.down("Control"); await page.keyboard.press("KeyZ"); await page.keyboard.up("Control");
  await waitFor(page, () => !window.__flux.figures().flatMap((f) => f.elements).some((e) => e.type === "fluximg"), null, { label: "undo" });

  h.section("a stack without metadata: the asking surface");
  const dropAt = await drop(famA, "rec_001.tif");
  await surface();
  await settle(400);
  const box = await S(() => { const b = document.querySelector("[data-tiff-ask]").getBoundingClientRect(); const host = document.querySelector(".canvas-host").getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, inHost: b.left >= host.left && b.right <= host.right && b.top >= host.top && b.bottom <= host.bottom }; });
  const land = await centre("[data-ask-landing]");
  h.ok(box.inHost && !!land && Math.abs(land.x - dropAt.x) < 2 && Math.abs(land.y - dropAt.y) < 2 && (box.x > dropAt.x || box.x + box.w < dropAt.x), `it stands beside the drop point (marked where the image will land), inside the canvas (${Math.round(box.w)} x ${Math.round(box.h)})`);
  let st = await ask();
  h.ok(st.pictures === 2 && st.answer.dims.map((d) => d.name).join() === "t,c", `the best guess is two interleaved channels: ${st.answer.dims.map((d) => `${d.name} ${d.size}`).join(" × ")}; ${st.pictures} pictures`);
  await page.screenshot({ path: "test-results/scratch/shots/ask-open.png" });
  h.eq(await S(() => document.querySelectorAll("[data-tiff-ask] input, [data-tiff-ask] select, [data-tiff-ask] textarea, [data-tiff-ask] [contenteditable]").length), 0, "no native form controls");
  h.eq(await S(() => document.getAnimations().map((a) => a.animationName ?? a.constructor.name)), [], "nothing animates at rest");
  const proposals = await S(() => [...document.querySelectorAll("[data-ask-proposal]")].map((b) => b.textContent.trim()));
  h.ok(proposals.length >= 2, `the proposals are keys at the top: ${proposals.join(" | ")}`);
  await page.keyboard.press("2");
  await waitFor(page, () => { const F = window.__flux, s = F.get(F.fluximg.tiff.tiffAsk); return s && s.chosen === 1 && (s.preview?.channels.length ?? 0) === 1; }, null, { label: "proposal 2" });
  h.ok(true, "choosing proposal 2 by its number fills the surface (one dimension, one picture)");
  await page.keyboard.press("1");
  await waitFor(page, () => { const F = window.__flux, s = F.get(F.fluximg.tiff.tiffAsk); return s && s.chosen === 0 && (s.preview?.channels.length ?? 0) === 2; }, null, { label: "proposal 1" });
  st = await ask();
  const before = st.png0;
  // Drag the first page key behind the second: the pages are read in another order, so the pictures change.
  const k0 = await centre('[data-ask-page="0"] .nm'), k1 = await centre('[data-ask-page="1"]');
  await page.mouse.move(k0.x, k0.y); await page.mouse.down(); await page.mouse.move(k0.x + 15, k0.y, { steps: 2 }); await page.mouse.move(k1.x + 30, k1.y, { steps: 4 }); await page.mouse.up();
  await waitFor(page, () => { const F = window.__flux, s = F.get(F.fluximg.tiff.tiffAsk); return s && s.answer.dims[0].name === "c"; }, null, { label: "reordered" });
  await waitFor(page, (b) => { const F = window.__flux, s = F.get(F.fluximg.tiff.tiffAsk); return s?.preview && s.preview.channels[0].png.slice(-40) !== b; }, before, { label: "new pictures" });
  st = await ask();
  h.ok(st.answer.dims.map((d) => d.name).join() === "c,t", `dragging a page key reorders the pages (${st.answer.dims.map((d) => d.name).join(" × ")}) and the pictures change`);
  const k1b = await centre('[data-ask-page="1"] .nm'), k0b = await centre('[data-ask-page="0"]');
  await page.mouse.move(k1b.x, k1b.y); await page.mouse.down(); await page.mouse.move(k1b.x - 15, k1b.y, { steps: 2 }); await page.mouse.move(k0b.x - 40, k0b.y, { steps: 4 }); await page.mouse.up();
  await waitFor(page, () => { const F = window.__flux, s = F.get(F.fluximg.tiff.tiffAsk); return s && s.answer.dims.map((d) => d.name).join() === "t,c"; }, null, { label: "back" });
  // Hover previews before acting.
  const fx = await centre('[data-tiff-ask] [data-fxb-key="flipX"]');
  await page.mouse.move(fx.x, fx.y);
  await waitFor(page, () => { const F = window.__flux, s = F.get(F.fluximg.tiff.tiffAsk); return !!s?.hover; }, null, { label: "hover preview" });
  st = await ask();
  h.ok(st.hover && !st.answer.flipX, "resting on Flip shows its pictures before anything is written");
  const hintText = await S(() => document.querySelector("[data-ask-hint]")?.textContent ?? "");
  h.ok(/Flip left/.test(hintText), `the one hint line says what the pointer is on: "${hintText}"`);
  await page.mouse.move(1450, 900);
  await waitFor(page, () => { const F = window.__flux, s = F.get(F.fluximg.tiff.tiffAsk); return s && !s.hover; }, null, { label: "hover gone" });
  // Transpose by its key: the pictures turn.
  const w0 = await S(() => document.querySelector("[data-ask-picture='0']").naturalWidth);
  await page.keyboard.press("t");
  await waitFor(page, (w) => { const i = document.querySelector("[data-ask-picture='0']"); const F = window.__flux, s = F.get(F.fluximg.tiff.tiffAsk); return s?.answer.transpose && i && i.naturalWidth !== w; }, w0, { label: "transposed pictures" });
  h.ok(true, "T transposes, and the pictures turn");
  // Pixel size and rate written in place.
  await page.click('[data-ask-edit="pixel"]');
  await page.keyboard.type("0.5"); await page.keyboard.press("Enter");
  await page.click('[data-ask-edit="time"]');
  await page.keyboard.type("40"); await page.keyboard.press("Enter");
  st = await ask();
  h.eq({ px: st.answer.pixelSize, rate: st.answer.time?.rate }, { px: { x: 0.5, unit: "µm" }, rate: 40 }, "pixel size and rate are written in place (no boxes)");
  // A size that does not fit: Convert is off and says why.
  await page.click('[data-ask-edit="size:1"]');
  await page.keyboard.type("3"); await page.keyboard.press("Enter");
  await waitFor(page, () => document.querySelector("[data-ask-convert]")?.disabled === true, null, { label: "Convert off" });
  const why = await S(() => document.querySelector("[data-ask-why]")?.textContent ?? "");
  h.ok(/^Convert is off: .*80 pages cannot be split/.test(why), `Convert is off with its reason inline: "${why}"`);
  h.ok(await S(() => { const n = document.querySelector("[data-ask-hint]"); return n.scrollWidth <= n.clientWidth + 1 && n.scrollHeight <= n.clientHeight + 1; }), "the hint line is never cut");
  await page.screenshot({ path: "test-results/scratch/shots/ask-invalid.png" });
  await page.click('[data-ask-edit="size:1"]');
  await page.keyboard.type("2"); await page.keyboard.press("Enter");
  await waitFor(page, () => document.querySelector("[data-ask-convert]")?.disabled === false, null, { label: "Convert on" });
  h.ok(true, "…and comes back on once the answer fits");
  // Presses on the plate are its own: the canvas behind neither selects, deselects nor pans.
  const pre = await S(() => { const F = window.__flux; return { vp: JSON.stringify(F.get(F.fig.viewport)), sel: [...F.get(F.fig.selection)].join() }; });
  const plate = await centre("[data-ask-pages]");
  await page.mouse.click(plate.x + 150, plate.y + 30);
  await page.mouse.move(plate.x, plate.y); await page.mouse.down(); await page.mouse.move(plate.x + 60, plate.y + 40, { steps: 3 }); await page.mouse.up();
  const post = await S(() => { const F = window.__flux; return { vp: JSON.stringify(F.get(F.fig.viewport)), sel: [...F.get(F.fig.selection)].join(), open: !!document.querySelector("[data-tiff-ask]") }; });
  h.ok(post.open && post.vp === pre.vp && post.sel === pre.sel, "presses on the surface are swallowed: nothing behind it moves");
  await page.keyboard.press("m");
  h.eq((await ask()).remember, "project", "M remembers the answer for this project");
  await page.screenshot({ path: "test-results/scratch/shots/ask-valid.png" });
  await page.keyboard.press("Enter");
  const placedA = await waitFor(page, () => window.__flux.figures().flatMap((f) => f.elements).find((e) => e.type === "fluximg") ?? null, null, { label: "placed", timeout: 20000 });
  const ma = await manifestOf(placedA.assetId);
  h.eq({ dims: ma?.pixels.dims, shape: ma?.pixels.shape, ch: ma?.channels.length }, { dims: ["t", "c", "y", "x"], shape: [40, 2, 72, 48], ch: 2 }, "converting places the image with the answered dims, the transposed plane and two channels");
  h.ok(ma?.axes?.x?.scale === 0.5 && Math.abs((ma?.axes?.t?.scale ?? 0) - 0.025) < 1e-12, `…with its pixel size and frame interval (${ma?.axes?.x?.scale} ${ma?.axes?.x?.unit}, ${ma?.axes?.t?.scale} s)`);
  const pj = await S((root) => window.fig.readText(`${root}/project.json`).then((t) => JSON.parse(t).tiffRules ?? []), root);
  h.ok(pj.length === 1 && pj[0].answer.transpose === true && pj[0].answer.dims[0].size === "rest", "the answer is remembered in project.json as a rule (the slowest size left open)");

  h.section("the family: no question; Change; Esc; Cancel; a refusal");
  const countBefore = (await images()).length;
  await drop(famB, "rec_002.tif");
  await waitFor(page, (n) => window.__flux.figures().flatMap((f) => f.elements).filter((e) => e.type === "fluximg").length > n, countBefore, { label: "the second file placed", timeout: 20000 });
  h.ok(await noSurface(), "the second file of the family converts without asking");
  h.ok((await seenToasts()).some((t) => /^rec_002\.tif: t 25 × c 2 .*\(remembered\)/.test(t.msg)), "…and its toast says it was remembered");
  // Change during a conversion: cancels it and reopens the surface with that answer.
  const assetsBefore = await assetFiles();
  await dropBig("rec_003.tif");
  await waitFor(page, () => [...document.querySelectorAll('[data-toast-tag="tiff-import"] .t-act')].some((b) => b.textContent === "Change"), null, { label: "the Change button", timeout: 20000 });
  await clickToast("Change");
  await surface(20000);
  st = await ask();
  h.ok(st.answer.transpose === true && st.answer.dims.length === 2, "Change cancels the conversion and opens the surface with the answer it was using");
  await page.screenshot({ path: "test-results/scratch/shots/ask-change.png" });
  await page.keyboard.press("Escape");
  await settle(600);
  h.ok(await noSurface(), "Esc closes it");
  h.eq(await assetFiles(), assetsBefore, "…and leaves nothing in fig/assets");
  // Cancel during a conversion.
  await dropBig("rec_004.tif");
  await waitFor(page, () => window.__flux.get(window.__flux.fluximg.tiff.tiffJobs).some((j) => j.label === "rec_004.tif" && j.state === "converting" && j.progress?.phase), null, { label: "converting", timeout: 20000 });
  await page.screenshot({ path: "test-results/scratch/shots/converting.png" });
  const prog = (await seenToasts()).filter((t) => /^rec_004/.test(t.msg)).map((t) => t.detail);
  h.ok(prog.some((d) => /(reading|storing) [\d,]+ of [\d,]+ planes · .* read/.test(d)), `the toast shows the phase, planes and bytes: "${prog.find((d) => /planes/.test(d)) ?? prog.at(-1)}"`);
  await clickToast("Cancel");
  await waitFor(page, () => window.__flux.get(window.__flux.fluximg.tiff.tiffJobs).some((j) => j.label === "rec_004.tif" && j.state === "cancelled"), null, { label: "cancelled", timeout: 10000 });
  await settle(500);
  h.eq(await assetFiles(), assetsBefore, "Cancel during a conversion leaves nothing in fig/assets");
  h.eq((await images()).length, countBefore + 1, "…and places nothing");
  await drop(jpeg, "photo.tif");
  const refusal = await waitFor(page, () => [...document.querySelectorAll(".toast.err")].map((t) => t.textContent).find((t) => /photo\.tif/.test(t)) ?? null, null, { label: "the refusal", timeout: 10000 });
  h.ok(/JPEG/.test(refusal) && /Re-save/.test(refusal), `a refused file says why and what to do: "${refusal.replace(/\s+/g, " ").trim().slice(0, 140)}"`);
  await S(() => { for (const b of document.querySelectorAll(".toast .t-x")) b.click(); });

  h.section("files dropped while a question is open join its batch: none vanishes");
  {
    const kindX = (t) => family(t, 60, 40), kindY = (t) => family(t, 44, 36);
    const n0 = (await images()).length;
    await drop(kindX(10), "qx_001.tif");
    await surface();
    await drop(kindX(7), "qx_002.tif");
    const kind2 = await waitFor(page, () => document.querySelector("[data-ask-kind]")?.getAttribute("data-ask-kind") === "2" ? document.querySelector("[data-tiff-ask] .l1")?.textContent ?? "" : null, null, { label: "the question counts the second file", timeout: 10000 }).catch(() => null);
    h.ok(!!kind2 && /qx_001\.tif/.test(kind2), `a second file of the same kind joins the open question, which counts it ("${kind2?.replace(/\s+/g, " ").trim()}")`);
    await drop(kindY(6), "qy_001.tif");
    const waits = await waitFor(page, () => document.querySelector("[data-ask-waiting]")?.textContent ?? null, null, { label: "the question says another waits", timeout: 10000 }).catch(() => null);
    h.eq(waits, "1 more waits", "a file of another kind waits its turn, and the question says so");
    h.ok(/qx_001/.test(await S(() => document.querySelector("[data-tiff-ask] .ttl")?.textContent ?? "")), "…while the first file's question stays open");
    await page.keyboard.press("Enter");
    await waitFor(page, () => /qy_001/.test(document.querySelector("[data-tiff-ask] .ttl")?.textContent ?? ""), null, { label: "the waiting file's question", timeout: 30000 });
    h.eq(await S(() => window.__flux.get(window.__flux.fluximg.tiff.tiffJobs).filter((j) => /^qx_/.test(j.label) && j.state === "placed").map((j) => j.label).sort()), ["qx_001.tif", "qx_002.tif"], "the first answer converts both files of its kind, then the waiting file is asked about");
    await drop(kindY(4), "qy_002.tif");
    await waitFor(page, () => document.querySelector("[data-ask-kind]")?.getAttribute("data-ask-kind") === "2", null, { label: "the second question counts its newcomer", timeout: 10000 });
    await page.keyboard.press("Escape");
    const leftNotice = await waitFor(page, () => [...document.querySelectorAll(".toast")].map((t) => t.textContent.replace(/\s+/g, " ")).find((t) => /Not imported: .*qy_/.test(t)) ?? null, null, { label: "the left-out notice", timeout: 10000 }).catch(() => "");
    h.ok(/qy_001\.tif/.test(leftNotice) && /qy_002\.tif/.test(leftNotice), `Esc leaves out exactly that question's files and names them: "${leftNotice.trim().slice(0, 120)}"`);
    const placedX = await waitFor(page, (n) => { const els = window.__flux.figures().flatMap((f) => f.elements).filter((e) => e.type === "fluximg"); return els.length >= n + 2 ? els.slice(-2).map((e) => e.source?.bundlePath).sort() : null; }, n0, { label: "the batch placed", timeout: 20000 }).catch(() => null);
    h.eq(placedX, ["qx_001.tif", "qx_002.tif"], "every dropped file is placed or named: both of the first kind are on the figure");
    h.ok(await noSurface(), "…and no question is left open");
  }

  h.section("keyboard only");
  await drop(famKeys, "keys_01.tif");
  await surface();
  await page.keyboard.press("1");
  await page.keyboard.press("t");
  let tabs = 0;
  for (; tabs < 40; tabs++) { await page.keyboard.press("Tab"); if (await S(() => document.activeElement?.getAttribute("data-ask-edit") === "pixel")) break; }
  h.ok(tabs < 40, `Tab reaches the pixel size (${tabs + 1} presses)`);
  await page.keyboard.type("0.5"); await page.keyboard.press("Enter");
  st = await ask();
  h.ok(st.answer.pixelSize?.x === 0.5 && st.answer.transpose === true, "…typed in place without the mouse");
  const n0 = (await images()).length;
  await page.keyboard.press("Enter");
  const kp = await waitFor(page, (n) => { const els = window.__flux.figures().flatMap((f) => f.elements).filter((e) => e.type === "fluximg"); return els.length > n ? els.at(-1) : null; }, n0, { label: "placed by keyboard", timeout: 20000 });
  const km = await manifestOf(kp.assetId);
  h.ok(km?.axes?.x?.scale === 0.5 && km.pixels.shape.at(-1) === 40, "Enter converts: the keyboard path places it with its answer");

  h.section("the Plots rail lists a TIFF and places it");
  await S(({ root, data }) => { window.fig._files.set(`${root}/plots/rec_009.tif`, Uint8Array.from(atob(data), (c) => c.charCodeAt(0))); }, { root, data: famB });
  await page.mouse.click(900, 500);
  await page.keyboard.down("Alt"); await page.keyboard.press("KeyG"); await page.keyboard.up("Alt");
  const tile = '[data-plots-gallery] [data-tile$="/rec_009.tif"]';
  await waitFor(page, (s) => !!document.querySelector(s), tile, { label: "the TIFF's tile", timeout: 15000 });
  const tpic = await waitFor(page, (s) => { const img = document.querySelector(`${s} .page img`); return img && img.naturalWidth > 0 ? { w: img.naturalWidth, h: img.naturalHeight } : null; }, tile, { label: "the tile's picture", timeout: 15000 }).catch(() => null);
  h.ok(!!tpic, `a TIFF under plots/ is a tile with a picture of its middle plane (${tpic?.w} x ${tpic?.h})`);
  const mark = await S((s) => document.querySelector(`${s} .chip.kind`)?.textContent ?? "", tile);
  h.ok(mark.includes("▦→"), `…marked "converts on placing" (${mark})`);
  const n1 = (await images()).length;
  const tc = await centre(`${tile} .page`);
  await page.mouse.click(tc.x, tc.y, { count: 2 });
  await waitFor(page, (n) => window.__flux.figures().flatMap((f) => f.elements).filter((e) => e.type === "fluximg").length > n, n1, { label: "placed from the rail", timeout: 20000 });
  const railEl = (await images()).at(-1);
  h.ok(railEl.source?.bundlePath === "plots/rec_009.tif" && railEl.source.frozen, "placing it from the rail converts it (the family's rule applies) and records plots/rec_009.tif (its project path)");

  h.section("on a slide");
  await clickMode(page, "Slide");
  await waitFor(page, () => !!document.querySelector(".canvas-host") && window.__flux.get(window.__flux.fig.activeFigureId), null, { label: "slide canvas", timeout: 10000 });
  await settle(800);
  const slideId = await S(() => window.__flux.get(window.__flux.fig.activeFigureId));
  await drop(imagej, "hyper_slide.tif");
  const onSlide = await waitFor(page, (id) => window.__flux.figures().find((f) => f.id === id)?.elements.find((e) => e.type === "fluximg") ?? null, slideId, { label: "placed on the slide", timeout: 20000 });
  h.ok(!!onSlide, "a ready TIFF dropped on a slide is placed on it");
  await drop(family(10, 30, 20), "slide_001.tif");
  await surface();
  h.ok(true, "a stack without metadata asks on the slide too");
  const toolBefore = await S(() => window.__flux.get(window.__flux.fig.activeTool));
  await page.keyboard.press("t");
  const afterT = await S(() => ({ tool: window.__flux.get(window.__flux.fig.activeTool), transpose: window.__flux.get(window.__flux.fluximg.tiff.tiffAsk)?.answer.transpose === true }));
  h.ok(afterT.transpose && afterT.tool === toolBefore, `its keys are its own on a slide too: T transposes, the slide's tool stays "${toolBefore}"`);
  await page.keyboard.press("Enter");
  await waitFor(page, (id) => window.__flux.figures().find((f) => f.id === id)?.elements.filter((e) => e.type === "fluximg").length === 2, slideId, { label: "second on the slide", timeout: 20000 });
  h.ok(true, "…and converts and places there");

  h.eq(errs, [], "no console errors");
} catch (error) {
  h.fail(`unexpected: ${error?.stack ?? error}`);
  await page.screenshot({ path: "test-results/scratch/shots/gui-failure.png" }).catch(() => {});
} finally {
  await browser.close();
}
await h.done();
