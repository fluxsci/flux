// fluximg stage 2, W7: the EXPORTED deck plays images in a real headless Chrome (no dev server, no decoder).
//
// The standard deck of scripts/lib/fluximgSlideExportFixture.ts is exported by flux-core's export-deck path into one
// offline .html (stills + baked MP4 clips + the conditional image runtime) and opened from file://. Pins:
//   - a Change through time: the visible frame at sampled times is the right plane within the decoder bound (read
//     from the <video> the image host places where the live canvas would be), contrast and crop Changes likewise;
//   - a layer fade animates the overlay's opacity (no clip: overlays are never baked);
//   - a styled label layer draws per-object colours in the exported overlay;
//   - Play: native playback in step with the clock, the end still swapped in at the end (law 4), never a blank;
//   - animated Back (reverse) and a scrub seek the decoder to the clock; leaving the step shows the step's still;
//   - the CAPTURE document (MP4 of a slide) seeks the same clip once per captured frame to exactly the clip frame;
//   - no console errors, no CSP violation, zero animation callbacks at rest.
// Without the pinned encoder the clip checks report BLOCKED (native-encoder) and the still-only checks still run.
//
// Run: npx tsx scripts/verify-fluximg-slide-export-browser.ts
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { harness } from "./lib/harness.mjs";
import { makeProject, standardDeck } from "./lib/fluximgSlideExportFixture";

const h = harness("verify-fluximg-slide-export-browser");
const P = await makeProject();
const { launch, errors } = await import("./lib/driver.mjs");
const { imageClipEncoder } = await import("../flux-core/fluximgClip");
const { fluximgReader, fluximgRenderSession, resolveFluximgLut } = await import("../flux-core/fluximgRender");
const { renderStill } = await import("../src/lib/fluximg/still");
const { planViewTween } = await import("../src/lib/fluximg/viewTween");
const CP = await import("../src/lib/fluximg/clipPlan");
const { fluximgResolvedAsset } = await import("../src/lib/fluximg/place");
const { fluximgStillRequest } = await import("../src/lib/fluximg/exportStatic");
const { compileSlide } = await import("../src/lib/slide/compile");
const { slideImageChanges, imageStillRef } = await import("../src/lib/slide/imageExport");
const { exportSlideVideoHtml } = await import("../src/lib/slide/export/exportDeck");
const { planSlideVideo, videoFrame, videoOptions } = await import("../src/lib/slide/video");
const { ensureColormapLuts } = await import("../src/lib/color/colormapLuts");
const { decodePng } = await import("../flux-core/fluximgPng");
await ensureColormapLuts();

const encoder = await imageClipEncoder();
const blocked = (what: string) => console.log(`BLOCKED (native-encoder: pinned encoder not installed; npm run fetch:video-encoder): ${what}`);
const assetId: string = P.placed.assetId;
const manifest = JSON.parse(await fs.readFile(path.join(P.root, "fig/assets", `${assetId}.fluximg`, "fluximg.json"), "utf8"));
const asset = fluximgResolvedAsset(assetId, manifest);
const reader = await fluximgReader(P.root, asset, fluximgRenderSession());
const BOUND = { mean: 2.5, max: 192 };   // the pure gate's measured bound with Chrome's own chroma upsampling (the max is one-pixel colour edges)

async function reference(f: any, w: number, hh: number): Promise<Uint8ClampedArray> {
  const L = CP.frameLayers(f);
  const draw = async (p: any) => (await renderStill(reader, { view: CP.tweenPictureView(p.view), crop: p.crop, outWidth: w, outHeight: hh }, { resolveLut: resolveFluximgLut })).rgba;
  const one = async (a: any, b: any) => (b ? CP.mixRgba(await draw(a), await draw(b), L.mix) : await draw(a));
  let rgba = await one(L.a, L.b);
  if (L.there) rgba = CP.mixRgba(rgba, await one(L.there.a, L.there.b), L.weight);
  return CP.matteRgba(rgba.slice(), "#000000");
}
const diff = (a: Uint8Array, b: Uint8ClampedArray) => { let max = 0, sum = 0, n = 0; for (let i = 0; i < a.length; i += 4) for (let k = 0; k < 3; k++) { const e = Math.abs(a[i + k] - b[i + k]); if (e > max) max = e; sum += e; n++; } return { max, mean: sum / n }; };

let browser: any;
try {
  const deck = await standardDeck(P);
  const slide = deck.slides[0];
  const el = slide.elements.find((e: any) => e.type === "fluximg") as any;
  const compiled = compileSlide(slide, deck.stage, {});
  const changes = slideImageChanges(compiled);
  const planOf = (beat: number) => { const c = changes.find((x) => x.beat === beat)!; const pl = planViewTween(manifest, { view: c.pre.view, crop: c.pre.crop }, { view: c.end.view, crop: c.end.crop }, { blend: c.blend }); return { c, pl, clip: CP.planImageClip(manifest, pl, c.ease.fn, c.durationMs, 640, 480) }; };
  const out = await P.slidesCore.exportDeck(P.root, "talk", { refreshSources: false, out: path.join(P.scratch, "talk.html") });
  const html = await fs.readFile(out.path, "utf8");
  h.ok(/media-src data: blob:/.test(html) && !/unsafe-inline'[^;]*script|script-src[^;]*unsafe/.test(html), "the exported file keeps its CSP (hashed scripts; data:/blob: media only)");
  const stillOf = (step: number) => { const e = compiled.sample(step).elements.find((x: any) => x.id === el.id) as any; const r = fluximgStillRequest(e, asset, manifest, 2); return imageStillRef(assetId, r.key); };

  const launched = await launch({ width: 1280, height: 720 }); browser = launched.browser; const page = launched.page;
  await page.evaluateOnNewDocument(() => {
    const w = window as any;
    w.__csp = []; document.addEventListener("securitypolicyviolation", (e: any) => w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
    w.__rafs = 0; const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = (cb: FrameRequestCallback) => { w.__rafs++; return raf(cb); };
  });
  await page.goto(pathToFileURL(out.path).href); await page.waitForFunction("!!window.fluxDeck?.readyMedia");
  await page.evaluate("window.fluxDeck.readyMedia()");
  const state = () => page.evaluate(`(() => { const v = document.querySelector('video[data-slide-fluximg-clip]'); const still = document.querySelector('[data-fluximg-still]'); const img = still?.querySelector('image');
    return { video: v ? { t: v.currentTime, paused: v.paused, shown: v.style.display === 'block', ready: v.readyState, seeking: v.seeking, w: v.videoWidth, h: v.videoHeight } : null,
      still: still?.style.display !== 'none', stillKey: img?.getAttribute('data-fluximg-still-key') ?? '', href: img?.getAttribute('href')?.length ?? 0, deck: window.fluxDeck.state(), stats: window.fluxDeck.imageClips?.() }; })()`);
  const pixels = async (): Promise<Uint8Array> => Buffer.from(await page.evaluate(`(() => { const v = document.querySelector('video[data-slide-fluximg-clip]'); const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
    const g = c.getContext('2d'); g.drawImage(v, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data; let s = ''; for (let i = 0; i < d.length; i += 32768) s += String.fromCharCode(...d.subarray(i, i + 32768)); return btoa(s); })()`), "base64");
  const settledClip = () => page.waitForFunction(`(() => { const v = document.querySelector('video[data-slide-fluximg-clip]'); return v && v.readyState >= 2 && !v.seeking && v.style.display === 'block'; })()`, { timeout: 15000 });
  const exported = JSON.parse(html.slice(html.indexOf('id="flux-payload">') + 18, html.indexOf("</script>", html.indexOf('id="flux-payload">'))).replace(/\\u003c/g, "<"));
  /** The still layer is shown and holds exactly the payload's still of `step`. */
  const stillShown = async (step: number) => { const href = await page.evaluate("(() => { const s = document.querySelector('[data-fluximg-still]'); return s && s.style.display !== 'none' ? s.querySelector('image')?.getAttribute('href') ?? '' : ''; })()"); return !!href && href === exported.assets[stillOf(step)]; };

  // ---------------------------------------------------------------------------------------------------------------
  h.section("at rest: the still, no video, no animation callbacks");
  {
    const s = await state();
    h.ok(s.still && (!s.video || !s.video.shown) && await stillShown(0), "Design rests on step 0's still");
    await page.evaluate("window.__rafs = 0"); await new Promise((r) => setTimeout(r, 800));
    h.eq(await page.evaluate("window.__rafs"), 0, "zero animation callbacks at rest");
  }

  if (!encoder || !Object.keys(exported.imageClips ?? {}).length) {
    blocked("every clip check (seek, play, reverse, scrub, capture)");
  } else {
    // -------------------------------------------------------------------------------------------------------------
    h.section("a Change through time: the right plane at sampled times (seek)");
    const walk = planOf(1);
    for (const ms of [100, 333, 500, 760, 950]) {
      await page.evaluate(`window.fluxDeck.seek(0, 1, ${ms})`); await settledClip();
      const s = await state();
      const k = Math.floor((ms / 1000) * walk.clip.fps + 1e-6), f = walk.clip.frames[k];
      const d = diff(await pixels(), await reference(f.frame, 640, 480));
      const t = f.frame.a.view.index.t as number;
      const wrong = diff(await pixels(), await reference({ ...f.frame, a: { ...f.frame.a, view: { ...f.frame.a.view, index: { ...f.frame.a.view.index, t: t + 1 } } } }, 640, 480));
      h.ok(s.video!.paused && Math.floor(s.video!.t * walk.clip.fps) === k && d.max <= BOUND.max && d.mean <= BOUND.mean && wrong.mean > 3 * d.mean, `walk at ${ms} ms: plane ${t} (clip frame ${k}), max ${d.max} mean ${d.mean.toFixed(2)} (next plane: mean ${wrong.mean.toFixed(2)})`);
    }
    for (const [beat, name] of [[2, "contrast"], [3, "crop"], [5, "blended walk back"]] as const) {
      const p = planOf(beat);
      await page.evaluate(`window.fluxDeck.seek(0, ${beat}, 500)`); await settledClip();
      const k = Math.floor(0.5 * p.clip.fps + 1e-6);
      const d = diff(await pixels(), await reference(p.clip.frames[k].frame, 640, 480));
      h.ok(d.max <= BOUND.max && d.mean <= BOUND.mean, `${name} at 500 ms: the clip frame matches the reference (max ${d.max}, mean ${d.mean.toFixed(2)})`);
    }

    // -------------------------------------------------------------------------------------------------------------
    h.section("overlays are not baked: a layer fade and a styled layer in the exported overlay");
    {
      await page.evaluate("window.fluxDeck.seek(0, 4, 500)"); await page.evaluate("window.fluxDeck.readyMedia()");
      const o = await page.evaluate(`(() => { const g = (id) => document.querySelector('[data-slide-fluximg-root] g[data-layer="' + id + '"]'); const v = document.querySelector('video[data-slide-fluximg-clip]');
        const cells = g('cells'), marks = g('marks'); const colours = new Set([...(cells?.querySelectorAll('[stroke],[fill]') ?? [])].map((n) => n.getAttribute('stroke') + '|' + n.getAttribute('fill')));
        return { cells: cells?.getAttribute('opacity'), marks: marks?.getAttribute('opacity'), marksShown: marks ? marks.getAttribute('display') !== 'none' : false, video: v ? v.style.display : 'none', colours: colours.size }; })()`);
      h.ok(Math.abs(Number(o.cells) - 0.625) < 0.02 && Math.abs(Number(o.marks) - 0.5) < 0.02 && o.video !== "block", `mid-fade: the label layer at ${o.cells}, the vector layer at ${o.marks} (opacity lerped), no clip (pixels unchanged)`);
      h.ok(o.colours >= 3, `the styled label layer draws per-object colours by its column (${o.colours} distinct paints)`);
    }

    // -------------------------------------------------------------------------------------------------------------
    h.section("Play: native playback in step with the clock, the end still at the end, never a blank");
    {
      await page.evaluate("window.fluxDeck.goTo(0, 0)");
      await page.evaluate(`window.__blank = 0; window.__samples = []; window.__watch = setInterval(() => { const v = document.querySelector('video[data-slide-fluximg-clip]'); const still = document.querySelector('[data-fluximg-still]'); const st = window.fluxDeck.state();
        const showing = (v && v.style.display === 'block') || (still && still.style.display !== 'none' && still.querySelector('image')); if (!showing) window.__blank++;
        if (v && st.beat === 1 && st.playing) window.__samples.push({ clock: st.time, t: v.currentTime * 1000, paused: v.paused, shown: v.style.display === 'block' }); }, 16)`);
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction("window.fluxDeck.state().beat === 1 && !window.fluxDeck.state().playing", { timeout: 10000 });
      await new Promise((r) => setTimeout(r, 100));
      const samples: Array<{ clock: number; t: number; paused: boolean; shown: boolean }> = await page.evaluate("(clearInterval(window.__watch), window.__samples)");
      const playing = samples.filter((s) => s.shown && !s.paused && s.clock > 150 && s.clock < 900);
      const drift = Math.max(...playing.map((s) => Math.abs(s.t - s.clock)));
      h.ok(playing.length >= 10 && drift <= 60, `the clip plays natively (${playing.length} samples while playing, worst |clip - clock| ${drift.toFixed(0)} ms; re-sync above 25 ms)`);
      const s = await state();
      h.ok(s.still && (!s.video!.shown) && await stillShown(1), "at the end the clip hands over to step 1's still (law 4)");
      h.eq(await page.evaluate("window.__blank"), 0, "never a blank between still, clip and still");
      await page.evaluate("window.__rafs = 0"); await new Promise((r) => setTimeout(r, 600));
      h.eq(await page.evaluate("window.__rafs"), 0, "zero animation callbacks once it rests");
    }

    // -------------------------------------------------------------------------------------------------------------
    h.section("animated Back and a scrub seek the decoder to the clock");
    {
      await page.evaluate("window.__rev = []; window.__watch = setInterval(() => { const v = document.querySelector('video[data-slide-fluximg-clip]'); const st = window.fluxDeck.state(); if (v && st.reversing) window.__rev.push({ t: v.currentTime, paused: v.paused, shown: v.style.display === 'block' }); }, 16)");
      await page.keyboard.press("ArrowLeft");
      await page.waitForFunction("window.fluxDeck.state().beat === 0 && !window.fluxDeck.state().reversing && !window.fluxDeck.state().playing", { timeout: 10000 });
      const rev: Array<{ t: number; paused: boolean; shown: boolean }> = await page.evaluate("(clearInterval(window.__watch), window.__rev)");
      const shown = rev.filter((r) => r.shown);
      h.ok(rev.length >= 3 && shown.length >= 1 && shown.every((r) => r.paused) && shown.at(-1)!.t <= shown[0].t, `Back plays the walk in reverse on the paused decoder (${rev.length} samples, ${shown.length} with the clip shown, time ${shown[0]?.t.toFixed(2)} -> ${shown.at(-1)?.t.toFixed(2)} s)`);
      h.ok(await stillShown(0), "and lands on step 0's still");
      const walk = planOf(1);
      for (const ms of [800, 200, 600]) {
        await page.evaluate(`window.fluxDeck.seek(0, 1, ${ms})`); await settledClip();
        const s = await state(), k = Math.floor((ms / 1000) * walk.clip.fps + 1e-6);
        h.ok(s.video!.paused && Math.floor(s.video!.t * walk.clip.fps) === k, `scrub to ${ms} ms: the decoder shows clip frame ${k}`);
      }
      const stats = (await state()).stats;
      h.ok(stats && stats.videos === 1, `one video element for the image across every Change (${JSON.stringify(stats)})`);
    }

    // -------------------------------------------------------------------------------------------------------------
    h.section("the capture document (MP4 of a slide): one decoder seek per captured frame");
    {
      const mediaDir = path.join(P.scratch, "capture"); await fs.mkdir(mediaDir, { recursive: true });
      const { payload } = await P.slidesCore.gatherDeckPayload(P.root, "talk", slide.id, { refreshSources: false, imageClipUrl: async (file: string, clip: { key: string }) => { const to = path.join(mediaDir, `${clip.key}.mp4`); await fs.copyFile(file, to); return pathToFileURL(to).href; } });
      h.ok(Object.values(payload.imageClips ?? {}).every((c: any) => c.url.startsWith("file:")), "capture clips are scratch files named by URL (the worker allowlists exactly these)");
      const options = videoOptions({ height: 720, fps: 60, startHoldMs: 0, stepDelayMs: 0, endHoldMs: 0 });
      const doc = path.join(mediaDir, "capture.html");
      await fs.writeFile(doc, await exportSlideVideoHtml(payload, options));
      await page.goto(pathToFileURL(doc).href);
      const info = await page.evaluate("window.fluxVideoReady");
      // The vectors over the image are not part of the clip: hidden here, so the screenshot shows only what the clip draws.
      await page.addStyleTag({ content: "[data-slide-fluximg-root] > svg:last-child { visibility: hidden }" });
      await page.setViewport({ width: info.width, height: info.height, deviceScaleFactor: 1 });
      const box = await page.evaluate("(() => { const r = document.querySelector('[data-slide-fluximg-root]').getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: r.width, h: r.height }; })()");
      const plan = planSlideVideo(payload.deck.slides[0], info ? compiled.cues.map((c: any) => c.duration) : [], options, { resolvedTracks: compiled.cues.map((c: any) => c.tracks.map((t: any) => t.track)) });
      let checked = 0, ok = 0; const notes: string[] = [];
      for (let i = 0; i < info.frames && checked < 8; i += 9) {
        const at = videoFrame(plan, i);
        const ch = changes.find((c) => c.beat === at.beat);
        if (!ch || at.time <= 30 || at.time >= ch.durationMs - 30) continue;
        const p = planOf(at.beat); if (!p.pl.pixels) continue;
        await page.evaluate(`window.fluxVideo.frame(${i})`);
        const t = await page.evaluate("document.querySelector('video[data-slide-fluximg-clip]')?.currentTime ?? -1");
        const k = Math.floor((at.time / 1000) * p.clip.fps + 1e-6);
        // What the capture worker records: a screenshot of the composited page (a file: video taints a canvas). The image's
        // box is 320 x 240 stage px at (40, 20), scaled 2x into the 720p frame: exactly the clip's 640 x 480 pixels.
        const shot = await page.screenshot({ clip: { x: box.x, y: box.y, width: 640, height: 480 }, type: "png", fromSurface: true, optimizeForSpeed: false });
        const png = decodePng(new Uint8Array(shot));
        const d = diff(png.rgba, await reference(p.clip.frames[k].frame, 640, 480));
        checked++;
        if (Math.floor(t * p.clip.fps) === k && d.mean <= BOUND.mean && d.max <= BOUND.max) ok++; else notes.push(`frame ${i}: beat ${at.beat} t ${at.time.toFixed(0)} want ${k} got ${(t * p.clip.fps).toFixed(2)} mean ${d.mean.toFixed(2)}`);
      }
      h.ok(checked >= 5 && ok === checked, `${ok}/${checked} captured frames show exactly the clip frame for their time, within the bound${notes.length ? `: ${notes.join("; ")}` : ""}`);
    }
  }

  h.section("console and CSP");
  h.eq(await page.evaluate("window.__csp ?? []").catch(() => []), [], "no CSP violation (no blocked resource)");
  h.eq(errors(page), [], "no console errors");
} catch (error) {
  h.fail(`unexpected: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  await browser?.close().catch(() => {});
}
await h.done(async () => { await fs.rm(P.scratch, { recursive: true, force: true }); });
