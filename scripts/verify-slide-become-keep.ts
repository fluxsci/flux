// A Become whose SOURCE STAYS (`BecomeSpec.keepSource`, "a ghost Become", manim's TransformFromCopy, 2026-11-16).
//
// The owner's case: each fitted curve of one plot does a ghost-become into its bar in another plot. The curves stay, crisp, the whole
// time; a copy of each leaves it and becomes its bar exactly as an ordinary hand-off would (pairing, timing, the pose law), and every copy
// obeys the Ghost law (ghost.ts): its ink emerges as it separates, so the first frames never double the source's ink.
//
// Pinned here: (A) the record: the op, its defaults and refusals (Consume), Swap keeps it, the schema, the stamp (not raised), an absent
// field writes no key; the REAL CLI `become --keep-source` and `appear-from --keep-source` write the op's bytes. (B) The static model:
// compile.sample keeps the source visible before, during and after its step (an ordinary twin hides it), the destination lands the same;
// the PDF / PowerPoint still (evaluateSlide, pptxPages) shows the source after the step. (C) The exported player, in Chrome, for part
// sources (two curves → two bars, in unison and with piece lag), a whole shape and a whole text: the first flight frame is the rest (no
// doubled ink), the source's own nodes are never hidden and its region rests unchanged at the landing, the landing equals an ordinary
// hand-off's landing, copies emerge with their separation, and a seek back or an animated Back lands on the rest pixel for pixel.
// Run through the runner: node scripts/run-verifies.mjs --tier pure --only slide-become-keep
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import * as ops from "../src/lib/slide/ops";
import { compileSlide } from "../src/lib/slide/compile";
import { exportDeckHtml } from "../src/lib/slide/export/exportDeck";
import { evaluateSlide } from "../src/lib/slide/embedRender";
import { pptxPages } from "../src/lib/slide/export/pptxBuilds";
import { ghostEmergence, ghostInk, ghostSpanOf, ghostEmergeSpan, ghostSeparation } from "../src/lib/slide/ghost";
import { validateDeckFile } from "../src/lib/project/validate";
import { deckSchemaFor } from "../src/lib/slide/schemaStamp";
import { buildScaffoldTree } from "../src/lib/project/scaffoldTree";
import { loadDeck, saveDeck } from "../flux-core/slides";
import type { Deck, Slide, TargetRef, BecomeSpec } from "../src/lib/slide/types";
import type { Element, SemanticPlotElement, RectElement, EllipseElement, TextElement } from "../src/lib/types";
import { harness } from "./lib/harness.mjs";
import { launch } from "./lib/driver.mjs";

const h = harness("verify-slide-become-keep");
const repo = path.resolve(import.meta.dirname, "..");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-become-keep-"));
let browser: Awaited<ReturnType<typeof launch>>["browser"] | undefined;
try {
  const plots: Record<string, { svg: string; manifest: unknown }> = {};
  for (const [id, name] of [["sine", "mpl_sine_waves"], ["bars", "mpl_bars"]]) plots[id] = {
    svg: await fs.readFile(new URL(`./fixtures/plots/${name}_FLUXPLOT.svg`, import.meta.url), "utf8"),
    manifest: JSON.parse(await fs.readFile(new URL(`./fixtures/plots/${name}_FLUXPLOT.fluxplot.json`, import.meta.url), "utf8")),
  };
  const plotManifest = (id: string) => plots[id]?.manifest as never;
  const LINES = ["2hz.line", "1hz.line"], BARS = ["viability.bar.0", "viability.bar.1"];
  const plot = (id: string, assetId: string, x: number, extra: Partial<SemanticPlotElement> = {}): SemanticPlotElement => ({ id, type: "plot", assetId, x, y: 120, width: 360, height: 216, rotation: 0, ...extra });
  const rect = (id: string, x = 60): RectElement => ({ id, type: "rect", x, y: 160, width: 180, height: 110, rotation: 0, fill: "#d0e4f7", stroke: "#205ea6", strokeWidth: 4, cornerRadius: 0 } as RectElement);
  const ellipse = (id: string): EllipseElement => ({ id, type: "ellipse", x: 640, y: 150, width: 200, height: 200, rotation: 0, fill: "#f2c9c3", stroke: "#af3029", strokeWidth: 4 } as EllipseElement);
  const text = (id: string, x: number, t: string): TextElement => ({ id, type: "text", x, y: 200, width: 220, height: 44, rotation: 0, text: t, fontFamily: "Arial", fontSize: 32, fontWeight: 700, fontStyle: "normal", align: "left", color: "#205ea6", sizing: "fixed" } as unknown as TextElement);
  const DUR = 1000;

  // ── (A) the record ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  h.section("the record");
  const deckOf = (elements: Element[]) => {
    const deck = ops.createDeck({ id: "keep", withTitleSlide: false });
    const slide = ops.addSlide(deck, { id: "s1", layout: "blank" });
    for (const el of elements) ops.addElement(deck, slide.id, structuredClone(el));
    const b1 = ops.addBeat(deck, slide.id, { id: "b1" })!;
    return { deck, slide, beat: b1.id };
  };
  {
    // whole drawn shapes default to CONSUME; asking the source to stay makes it a hand-off and keeps both objects
    const { deck, slide, beat } = deckOf([rect("src"), ellipse("dst")]);
    const r = ops.becomeTransform(deck, slide.id, beat, "src", "dst", { keepSource: true })!;
    const t = slide.beats[1].tracks.find(x => x.id === r.trackId)!;
    h.ok(t.to?.become?.mode === "handoff" && t.to.become.keepSource === true && slide.elements.some(e => e.id === "dst"), "keepSource on whole drawn shapes writes a hand-off (not Consume) with keepSource: true, both objects kept");
    h.eq(Object.keys(t.to!.become!), ["ref", "mode", "pair", "reveal", "keepSource"], "the spec's key order: keepSource last, after the existing fields");
    let refused = "";
    try { ops.becomeTransform(deck, slide.id, beat, "src", "dst", { keepSource: true, mode: "consume" }); } catch (e) { refused = String(e); }
    h.ok(/cannot also stay/.test(refused), `Consume with keepSource is refused and says why (${refused.slice(0, 80)})`);
    // a re-Become without it (Source: leaves) drops the key; with it, writes it back: the inspector switch's two writes
    ops.becomeTransform(deck, slide.id, beat, "src", "dst", { ...t.to!.become!, keepSource: false });
    const off = slide.beats[1].tracks.find(x => x.id === r.trackId)!;
    h.ok(off.to?.become?.mode === "handoff" && !("keepSource" in off.to.become), "switching to Source: leaves keeps the hand-off and writes NO keepSource key");
    // swap keeps the source staying (the old destination stays and sends copies back)
    ops.becomeTransform(deck, slide.id, beat, "src", "dst", { mode: "handoff", keepSource: true });
    const swapped = ops.swapBecome(deck, slide.id, r.trackId, { plotManifest });
    const back = slide.beats[1].tracks.find(x => x.id === swapped)!;
    h.ok(back.target === "dst" && back.to?.become?.ref.element === "src" && back.to.become.keepSource === true, "Swap direction reverses a source-stays Become and keeps it source-stays");
  }
  {
    // an ordinary hand-off's bytes are unchanged (absent field), so older decks load and save byte-identically
    const a = deckOf([plot("src", "sine", 30), plot("dst", "bars", 520)]), b = deckOf([plot("src", "sine", 30), plot("dst", "bars", 520)]);
    const withPlots = (d: typeof a) => ({ compiled: compileSlide(d.slide, d.deck.stage, { plotManifest }) });
    ops.becomeTransform(a.deck, a.slide.id, a.beat, { element: "src", parts: LINES }, { element: "dst", parts: BARS }, withPlots(a));
    ops.becomeTransform(b.deck, b.slide.id, b.beat, { element: "src", parts: LINES }, { element: "dst", parts: BARS }, { keepSource: false, ...withPlots(b) });
    const trackOf = (d: typeof a) => JSON.stringify({ ...d.slide.beats[1].tracks[0], id: "" });
    h.ok(trackOf(a) === trackOf(b) && !trackOf(a).includes("keepSource"), "keepSource absent or false writes exactly an ordinary hand-off's track bytes (no key)");
    const k = deckOf([plot("src", "sine", 30), plot("dst", "bars", 520)]);
    ops.becomeTransform(k.deck, k.slide.id, k.beat, { element: "src", parts: LINES }, { element: "dst", parts: BARS }, { keepSource: true, ...withPlots(k) });
    h.ok(validateDeckFile(k.deck).length === 0, "a deck holding keepSource validates against the bundled schema");
    const bad = structuredClone(k.deck); (bad.slides[0].beats[1].tracks[0].to!.become as unknown as Record<string, unknown>).keepSource = "yes";
    h.ok(validateDeckFile(bad).length > 0, "a non-boolean keepSource is refused by the schema");
    h.eq(deckSchemaFor(k.deck), "0.6.0", "keepSource does not raise the deck stamp (an older build plays it as an ordinary hand-off: recorded decision)");
  }
  {
    // the Ghost law is one formula: ghostEmergence (Ghost births) reads ghostInk bit for bit as before
    const pre = rect("a"), far = { ...rect("a"), x: 400 }, near = { ...rect("a"), fill: "#000" };
    const old = (p: Element, e: Element) => { const span = Math.max(3, Math.min(12, 0.1 * Math.min(p.width, p.height))), travels = ghostSeparation(p, e) >= span; const ramp = (x: number) => { const q = Math.max(0, Math.min(1, x)); return q * q * (3 - 2 * q); }; return travels ? (el: Element) => ramp(ghostSeparation(p, el) / span) : (_: Element, u: number) => ramp(u / 0.25); };
    let same = true;
    for (const end of [far, near]) for (let i = 0; i <= 40; i++) { const u = i / 40, el = { ...pre, x: pre.x + (end.x - pre.x) * u * 0.05 }; if (ghostEmergence(pre, end)(el, u) !== old(pre, end)(el, u)) same = false; }
    h.ok(same && ghostEmergeSpan(pre) === ghostSpanOf(pre.width, pre.height) && ghostInk(0, 5, true, 0.9) === 0 && ghostInk(5, 5, true, 0) === 1 && ghostInk(0, 5, false, 0.25) === 1, "ghostEmergence reads the shared ghostInk / ghostSpanOf bit for bit (Ghost births unchanged)");
  }
  {
    // the REAL CLI: become --keep-source and appear-from --keep-source write the op's bytes
    const root = path.join(tmp, "project");
    const tree = buildScaffoldTree({ title: "Become keep verification" }, ops.createDeck());
    for (const dir of tree.dirs) await fs.mkdir(path.join(root, dir), { recursive: true });
    for (const [rel, contents] of tree.files) { await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await fs.writeFile(path.join(root, rel), contents); }
    const { deck, slide, beat } = deckOf([rect("src"), ellipse("dst"), rect("other", 300)]);
    await saveDeck(root, deck);
    const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "flux-cli.ts", ...args, "--root", root], { cwd: repo, encoding: "utf8", env: { ...process.env, FLUX_NO_MIGRATE: "1", HOME: tmp, XDG_CONFIG_HOME: path.join(tmp, "xdg") }, timeout: 60000 });
    const cli = run("become", deck.id, slide.id, beat, "src", "--target", "dst", "--keep-source", "--duration", "800");
    h.ok(cli.status === 0 && /sends copies to dst \(the source stays\)/.test(cli.stderr), `CLI become --keep-source succeeds and says what it does (${cli.stderr.trim().slice(0, 100)})`);
    const saved = await loadDeck(root, deck.id), twin = structuredClone(deck);
    ops.becomeTransform(twin, slide.id, beat, "src", "dst", { keepSource: true, duration: 800 });
    const cliTrack = saved.slides[0].beats[1].tracks[0], opTrack = twin.slides[0].beats[1].tracks[0];
    h.ok(JSON.stringify({ ...cliTrack, id: "" }) === JSON.stringify({ ...opTrack, id: "" }), "the CLI's track is the op's track, byte for byte");
    const af = run("appear-from", deck.id, slide.id, beat, "--dest", "dst", "--from", "other", "--keep-source");
    const afTrack = (await loadDeck(root, deck.id)).slides[0].beats[1].tracks.find(t => t.target === "other");
    h.ok(af.status === 0 && afTrack?.to?.become?.keepSource === true && afTrack.to.become.mode === "handoff", `CLI appear-from --keep-source writes the same record from the destination side (${af.stderr.trim().slice(0, 90)})`);
    const bytes = await fs.readFile(path.join(root, "slides", deck.id, "deck.json"), "utf8");
    const no = run("become", deck.id, slide.id, beat, "src", "--target", "dst", "--keep-source", "--mode", "consume");
    h.ok(no.status !== 0 && /cannot also stay/.test(no.stderr) && await fs.readFile(path.join(root, "slides", deck.id, "deck.json"), "utf8") === bytes, "CLI Consume + --keep-source is refused before any write");
  }

  // ── (B) the static model ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  h.section("compile.sample, PDF and PowerPoint stills");
  const deck = ops.createDeck({ withTitleSlide: false }); deck.stage = { width: 960, height: 540 }; deck.defaults.transition = "none"; deck.background = "#ffffff";
  const add = (name: string) => ops.addSlide(deck, { id: name, layout: "blank" });
  function become(slide: Slide, source: TargetRef, ref: TargetRef, spec: Partial<BecomeSpec> & { pairLag?: number } = {}) {
    const beat = ops.addBeat(deck, slide.id, { id: `${slide.id}-flight` })!;
    const r = ops.becomeTransform(deck, slide.id, beat.id, source, ref, { mode: "handoff", duration: DUR, easing: "smooth", compiled: compileSlide(slide, deck.stage, { plotManifest }), ...spec });
    return slide.beats[1].tracks.find(t => t.id === r!.trackId)!;
  }
  // the owner's shape: curves of one plot → bars of another, the source staying; and its ordinary twin (the source leaves)
  const cases: { id: string; keep: boolean; source: TargetRef; dest: TargetRef; els: Element[]; lag?: number }[] = [
    { id: "parts", keep: true, source: { element: "src", parts: LINES }, dest: { element: "dst", parts: BARS }, els: [plot("src", "sine", 30), plot("dst", "bars", 560, { width: 180 })] },
    { id: "parts-plain", keep: false, source: { element: "src", parts: LINES }, dest: { element: "dst", parts: BARS }, els: [plot("src", "sine", 30), plot("dst", "bars", 560, { width: 180 })] },
    { id: "parts-lag", keep: true, source: { element: "src", parts: LINES }, dest: { element: "dst", parts: BARS }, els: [plot("src", "sine", 30), plot("dst", "bars", 560, { width: 180 })], lag: 0.6 },
    { id: "shape", keep: true, source: { element: "src" }, dest: { element: "dst" }, els: [rect("src"), ellipse("dst")] },
    { id: "shape-plain", keep: false, source: { element: "src" }, dest: { element: "dst" }, els: [rect("src"), ellipse("dst")] },
    { id: "text", keep: true, source: { element: "src" }, dest: { element: "dst" }, els: [text("src", 60, "Result"), text("dst", 600, "Results")] },
    { id: "text-plain", keep: false, source: { element: "src" }, dest: { element: "dst" }, els: [text("src", 60, "Result"), text("dst", 600, "Results")] },
  ];
  for (const c of cases) { const s = add(c.id); for (const el of c.els) ops.addElement(deck, s.id, el); become(s, c.source, c.dest, { keepSource: c.keep, ...(c.lag ? { pairLag: c.lag } : {}) }); }
  const slideOf = (id: string) => deck.slides.find(s => s.id === id)!;
  for (const c of cases) {
    const compiled = compileSlide(slideOf(c.id), deck.stage, { plotManifest });
    h.ok(!compiled.issues.length && compiled.handoffs.length === 1, `${c.id}: compiles to one hand-off without issues${compiled.issues.length ? ` (${compiled.issues.map(i => i.reason).join("; ")})` : ""}`);
    const shown = (beat: number, t: number) => {
      const f = compiled.sample(beat, t);
      const src = c.source.parts ? c.source.parts.every(p => f.presentation.partStates.src?.[p]?.visible !== false) : !f.presentation.hiddenElementIds.includes("src");
      const dst = c.dest.parts ? c.dest.parts.every(p => f.presentation.partStates.dst?.[p]?.visible === true) : !f.presentation.hiddenElementIds.includes("dst");
      return { src, dst };
    };
    const at = [shown(0, Infinity), shown(1, 1), shown(1, DUR / 2), shown(1, Infinity)];
    if (c.keep) h.ok(at.every(s => s.src) && !at[0].dst && !at[2].dst && at[3].dst, `${c.id}: the source is shown before, during and after its step; the destination only once landed`);
    else h.ok(at[0].src && !at[2].src && !at[3].src && at[3].dst, `${c.id}: (ordinary twin) the source leaves`);
  }
  {
    const payload = (id: string) => ({ deck: { ...deck, slides: [slideOf(id)] }, plots, assets: {}, assetSizes: {} } as never);
    const still = evaluateSlide(payload("parts"), 1), plain = evaluateSlide(payload("parts-plain"), 1);
    h.ok(LINES.every(p => still.partStates.src?.[p]?.visible !== false) && LINES.every(p => plain.partStates.src?.[p]?.visible === false), "the PDF / static still after the step keeps the curves (the ordinary twin's are gone)");
    const pages = pptxPages(payload("shape"), "animated"), last = pages[pages.length - 1].ev;
    const src = last.elements.find(e => e.id === "src");
    h.ok(pages.length === 2 && !!src && !src.hidden && (src.opacity ?? 1) > 0, "the PowerPoint step page keeps the whole source shape after its step");
  }

  // ── (C) the exported player ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  h.section("the exported player (Chrome)");
  const file = path.join(tmp, "keep.html"); await fs.writeFile(file, (await exportDeckHtml({ deck, plots } as never)).html);
  const launched = await launch({ width: 1280, height: 720 }); browser = launched.browser; const page = launched.page;
  const errors: string[] = []; page.on("pageerror", e => errors.push(String(e)));
  await page.goto(pathToFileURL(file).href); await page.waitForFunction("!!window.fluxDeck?.seek");
  const frame = `new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`;
  const stage = await page.evaluate(`(() => { const r = document.querySelector(".sl-camera").parentElement.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`) as { x: number; y: number; width: number; height: number };
  const k = stage.width / deck.stage.width;
  type Img = { data: Uint8ClampedArray; width: number; height: number };
  const shot = async (slide: number, beat: number, time: number): Promise<Img> => {
    await page.evaluate(`window.fluxDeck.seek(${slide}, ${beat}, ${time})`); await page.evaluate(frame);
    const img = await loadImage(await page.screenshot({ clip: stage, type: "png" }) as Buffer);
    const c = createCanvas(img.width, img.height).getContext("2d"); c.drawImage(img, 0, 0);
    return c.getImageData(0, 0, img.width, img.height) as unknown as Img;
  };
  const crop = (a: Img, x0: number, x1: number): Img => {
    const X0 = Math.round(x0 * k), X1 = Math.min(a.width, Math.round(x1 * k)), w = X1 - X0, out = new Uint8ClampedArray(w * a.height * 4);
    for (let y = 0; y < a.height; y++) out.set(a.data.subarray((y * a.width + X0) * 4, (y * a.width + X1) * 4), y * w * 4);
    return { data: out, width: w, height: a.height };
  };
  /** Pixels that differ visibly (a channel by 24 levels or more), and ink (darkening against white paper). */
  const changed = (a: Img, b: Img) => { let n = 0; for (let i = 0; i < a.data.length; i += 4) if (Math.abs(a.data[i] - b.data[i]) >= 24 || Math.abs(a.data[i + 1] - b.data[i + 1]) >= 24 || Math.abs(a.data[i + 2] - b.data[i + 2]) >= 24) n++; return n; };
  const ink = (a: Img) => { let s = 0; for (let i = 0; i < a.data.length; i += 4) s += 765 - a.data[i] - a.data[i + 1] - a.data[i + 2]; return s / 765; };
  const index = (id: string) => deck.slides.findIndex(s => s.id === id);
  const FLOOR = 40;   // anti-aliasing at a hand-over (measured 0 to 6 in the pose gate); a doubled source or a blink is hundreds
  /** The source's own live nodes (never a flight copy): none is hidden, none transparent. */
  const sourceShown = (slide: number, beat: number, time: number, parts?: string[]) => page.evaluate(`(() => {
    window.fluxDeck.seek(${slide}, ${beat}, ${time});
    const wrap = document.querySelector('.sl-camera [data-el-id="src"]');
    const nodes = ${JSON.stringify(parts ?? null)} ? ${JSON.stringify(parts ?? [])}.map(p => wrap?.querySelector('[id$="' + p + '"]')) : [wrap];
    return nodes.length > 0 && nodes.every(n => { if (!n) return false; for (let e = n; e && e !== document.body; e = e.parentElement) { const s = getComputedStyle(e); if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) < 0.999) return false; } return true; });
  })()`) as Promise<boolean>;
  for (const c of cases.filter(c => c.keep)) {
    const slide = index(c.id), twin = cases.find(o => !o.keep && o.source.parts?.length === c.source.parts?.length && o.els[0].type === c.els[0].type && o.id.startsWith(c.id.split("-")[0]));
    // rest at step 0 with the plan built there (the idle warm), as the audience sees it
    await page.evaluate(`window.fluxDeck.seek(${slide}, 0, 0)`);
    await page.evaluate(`new Promise(r => requestIdleCallback(() => r(), { timeout: 3000 }))`); await page.evaluate(frame);
    const rest = await shot(slide, 0, 0), first = await shot(slide, 1, 1), mid = await shot(slide, 1, DUR * 0.4), late = await shot(slide, 1, DUR * 0.9), last = await shot(slide, 1, DUR - 1), landed = await shot(slide, 1, DUR);
    if (process.env.DUMP) for (const [name, img] of [["rest", rest], ["first", first], ["mid", mid], ["late", late], ["last", last], ["landed", landed]] as const) { const cv = createCanvas(img.width, img.height); cv.getContext("2d").putImageData(img as never, 0, 0); await fs.mkdir(process.env.DUMP, { recursive: true }); await fs.writeFile(path.join(process.env.DUMP, `${c.id}-${name}.png`), cv.toBuffer("image/png")); }
    h.ok(changed(rest, first) <= FLOOR && Math.abs(ink(first) - ink(rest)) <= Math.max(30, ink(rest) * 0.01), `${c.id}: the first flight frame is the rest: no doubled ink while the copies coincide (${changed(rest, first)} px, ink ${Math.round(ink(rest))} → ${Math.round(ink(first))})`);
    // (a text morph's words wait in their windows: "Result" → "Results" moves late, so look at 40 and 90 %)
    h.ok(Math.max(changed(rest, mid), changed(rest, late)) > 400, `${c.id}: something flies (${changed(rest, mid)} px changed at 40 %, ${changed(rest, late)} at 90 %)`);
    const shownAt = await Promise.all([0, 1, DUR * 0.15, DUR * 0.4, DUR * 0.7, DUR, DUR * 3].map(t => sourceShown(slide, 1, t, c.source.parts)));
    h.ok(shownAt.every(Boolean), `${c.id}: the source's own nodes are drawn, opaque, at 0, 15, 40, 70 and 100 % and after (${shownAt.join(",")})`);
    const srcRegion = (img: Img) => crop(img, 0, c.els[0].x + c.els[0].width + 8);
    h.ok(changed(srcRegion(rest), srcRegion(landed)) <= FLOOR, `${c.id}: the source's region rests unchanged once the copies have landed (${changed(srcRegion(rest), srcRegion(landed))} px)`);
    // (against the ordinary twin's own landing: a source that stays changes nothing about how the copies land)
    const twinStep = twin ? changed(await shot(index(twin.id), 1, DUR - 1), await shot(index(twin.id), 1, DUR)) : 0;
    h.ok(changed(last, landed) <= Math.max(FLOOR, twinStep), `${c.id}: the last flight frame lands as an ordinary hand-off's does (${changed(last, landed)} px; the ordinary twin ${twinStep})`);
    if (twin) {
      const ts = index(twin.id), tl = await shot(ts, 1, DUR), tr = await shot(ts, 0, 0);
      const dstRegion = (img: Img) => crop(img, c.els[1].x - 8, deck.stage.width);
      h.ok(changed(dstRegion(landed), dstRegion(tl)) <= FLOOR, `${c.id}: the destination lands exactly as after an ordinary hand-off (${changed(dstRegion(landed), dstRegion(tl))} px against ${twin.id})`);
      h.ok(changed(srcRegion(tl), srcRegion(tr)) > 400, `${c.id}: (control) the ordinary twin's source region does change: its source left (${changed(srcRegion(tl), srcRegion(tr))} px)`);
    }
    // a seek back to the rest, and an animated Back, land on the rest pixel for pixel
    const again = await shot(slide, 0, 0);
    h.ok(changed(again, rest) <= FLOOR, `${c.id}: seeking back to step 0 restores the rest (${changed(again, rest)} px)`);
    await page.evaluate(`window.fluxDeck.goTo(${slide}, 1)`); await page.evaluate(frame);
    await page.evaluate(`window.fluxDeck.prev()`);
    await page.waitForFunction(`!window.fluxDeck.state().reversing && window.fluxDeck.state().beat === 0`, { timeout: 5000 });
    await page.evaluate(frame);
    const rewound = await loadImage(await page.screenshot({ clip: stage, type: "png" }) as Buffer), cv = createCanvas(rewound.width, rewound.height).getContext("2d"); cv.drawImage(rewound, 0, 0);
    const rw = cv.getImageData(0, 0, rewound.width, rewound.height) as unknown as Img;
    h.ok(changed(rw, rest) <= FLOOR, `${c.id}: an animated Back lands on the rest (${changed(rw, rest)} px)`);
  }
  // The Ghost law in the DOM: a copy that has barely left its source is (nearly) undrawn, a copy that has left by its span is whole; the
  // hand-over's copy of the source's start render is never shown (the real source is it)
  const pieces = (slide: number, t: number) => page.evaluate(`(() => { window.fluxDeck.seek(${slide}, 1, ${t}); const L = document.querySelector(".sl-handoff[data-driver]"); return { driver: L?.getAttribute("data-driver"), a: [...document.querySelectorAll(".sl-handover-a")].map(g => g.getAttribute("display")), aCopies: document.querySelectorAll(".sl-handover-a .sl-handover-copy").length, ops: L ? [...L.querySelectorAll("path.sl-handoff-path")].map(p => p.getAttribute("display") === "none" ? 0 : Number(p.getAttribute("opacity") ?? 1)) : [] }; })()`) as Promise<{ driver: string; a: (string | null)[]; aCopies: number; ops: number[] }>;
  {
    const slide = index("parts"), early = await pieces(slide, 4), later = await pieces(slide, DUR * 0.4);
    h.ok(early.driver === "path" && early.ops.length >= 2 && early.ops.every(o => o < 0.5), `parts: 4 ms in, the copies are still emerging (opacity ${early.ops.map(o => o.toFixed(3)).join(", ")})`);
    h.ok(later.ops.every(o => o > 0.999), `parts: at 40 % every copy is whole (opacity ${later.ops.map(o => o.toFixed(3)).join(", ")})`);
    h.ok(early.aCopies === 0 && early.a.every(d => d === "none" || d === null), "parts: no copy of the source's start render is cut or shown");
    // piece lag: a piece that has not left yet stays undrawn while its neighbour flies
    const lag = await pieces(index("parts-lag"), DUR * 0.3);
    h.ok(lag.ops.length >= 2 && Math.max(...lag.ops) > 0.99 && Math.min(...lag.ops) < 0.01, `parts-lag: with piece lag, a copy still on its source is undrawn while the other flies (opacity ${lag.ops.map(o => o.toFixed(3)).join(", ")})`);
  }
  h.ok(!errors.length, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
} finally { await browser?.close(); await fs.rm(tmp, { recursive: true, force: true }); }
h.done();
