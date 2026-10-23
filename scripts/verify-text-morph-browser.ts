// The glyph-matched text morph through the actual portable HTML player (pure
// tier, Chrome — the verify-slide-handoff-browser pattern): a Change, the owner's
// two Deck-3 examples, a font-size change, a text→text hand-off, the unmappable
// fallback, and (P2) a shape → text Become flying glyph outlines plus the
// glyph-box fallback.
// WP 2.5 (R4_T9 §3.1-3.4): glide lanes (crossing words take separate lanes, stage-bounded), the roll fade and the letter
// bag, all resolved from the track's AUTHORED params (new text transforms carry roll + travel; an old track plays
// exactly as made: its glides are the straight line + crossArc to 1e-3 px, asserted below through the real DOM).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createDeck, addSlide, addElement, addBeat, setTransform } from "../src/lib/slide/ops";
import { exportDeckHtml } from "../src/lib/slide/export/exportDeck";
import { gatherPayload } from "../src/lib/slide/payload";
import { lookupFont } from "../src/lib/text/fontFiles.mjs";
import type { Slide } from "../src/lib/slide/types";
import type { TextElement } from "../src/lib/types";
import { crossArc as crossArcOf } from "../src/lib/slide/textMatch";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { harness } from "./lib/harness.mjs";
import { launch } from "./lib/driver.mjs";
import { perceptualDiff } from "./lib/slideSettleSweep";

const h = harness("verify-text-morph-browser");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-text-morph-"));
let browser: Awaited<ReturnType<typeof launch>>["browser"] | undefined;
const text = (id: string, x: number, y: number, value: string, extra: Partial<TextElement> = {}): TextElement => ({
  id, type: "text", x, y, width: 300, height: 40, rotation: 0, text: value, fontFamily: "Arial", fontSize: 32,
  fontWeight: 400, fontStyle: "normal", align: "left", color: "#222222", sizing: "auto", ...extra,
});
try {
  const deck = createDeck({ withTitleSlide: false, theme: "flux-light" } as never); deck.stage = { width: 960, height: 540 }; deck.defaults.transition = "none";
  const add = (id: string) => addSlide(deck, { id, layout: "blank" });
  const change = (slide: Slide, target: string, state: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const beat = addBeat(deck, slide.id, { id: `${slide.id}-b${slide.beats.length}` })!;
    setTransform(deck, slide.id, beat.id, target, { state, duration: 1000, easing: "linear", ...extra });
    return beat.tracks.find((t) => t.target === target)!;
  };
  // 0 — a reorder Change that also moves down.
  const s0 = add("reorder"); addElement(deck, s0.id, text("t", 100, 100, "Alpha beta gamma"));
  change(s0, "t", { text: "Gamma beta alpha", y: 200 });
  // 1 — the owner's Become (consume) and Change, verbatim from Deck 3 slide 4.
  const s1 = add("owner");
  addElement(deck, s1.id, text("become", 49.49675612080992, 102.95607247405933, "Microscopy", { width: 70, height: 16, fontSize: 13.333333333333334 }));
  addElement(deck, s1.id, text("change", 40.49675612080991, 293.6422256849605, "Some text to change", { width: 88, height: 12, fontSize: 9.333333333333334 }));
  change(s1, "become", { x: 34.99675612080992, y: 145.63205783219064, width: 99, text: "Optics and Light" }, { duration: 1750, easing: "smooth" });
  s1.beats[1].tracks[0].to!.become = { ref: { element: "gone" }, mode: "consume" };
  change(s1, "change", { width: 81, text: "Subtextual Context" }, { duration: 1750, easing: "smooth" });
  // 2 — a size change: glides scale (soft mid-flight), demoted at rest.
  const s2 = add("size"); addElement(deck, s2.id, text("t", 100, 100, "Grow this word"));
  change(s2, "t", { text: "Grow that word", fontSize: 48, width: 400, height: 60 });
  // 3 — text → text hand-off: two objects, one stage-level span layer.
  const s3 = add("handoff"); addElement(deck, s3.id, text("a", 40, 60, "The quick brown fox", { fontSize: 18 }));
  addElement(deck, s3.id, text("b", 360, 260, "The brown fox quickly", { fontSize: 26, color: "#c03030", fontWeight: 700 }));
  change(s3, "a", {}).to!.become = { mode: "handoff", ref: { element: "b" } };
  // 4 — unmappable (legacy whole-line justification): the natural-size crossfade.
  const s4 = add("legacy"); addElement(deck, s4.id, text("t", 100, 100, "one two three four five six", { align: "justify", sizing: "fixed", width: 200, height: 80, lines: ["one two three", "four five six"] }));
  change(s4, "t", { text: "seven eight nine ten", width: 260 });

  // 5 — P2: a filled rect hands off to the word (letters as outlines).
  const rect = (id: string, x: number, y: number) => ({ id, type: "rect" as const, x, y, width: 220, height: 90, rotation: 0, fill: "#d95f0e", stroke: "#222222", strokeWidth: 2, cornerRadius: 6 });
  const s5 = add("pour"); addElement(deck, s5.id, rect("r", 60, 200));
  addElement(deck, s5.id, text("w", 420, 230, "Microscopy", { fontSize: 48, fontWeight: 700, color: "#1f3a93" }));
  change(s5, "r", {}).to!.become = { mode: "handoff", ref: { element: "w" } };
  // 6 — P2: a Consume retype rect → text inside ONE element.
  const s6 = add("consume"); addElement(deck, s6.id, rect("r", 60, 200));
  change(s6, "r", { type: "text", x: 420, y: 230, width: 300, height: 56, text: "Optics", fontFamily: "Arial", fontSize: 48, fontWeight: 400, fontStyle: "normal", align: "left", color: "#1f3a93", sizing: "auto" });

  // WP 2.5 — lanes, roll, letters. `old(track)` strips the authored look: what a deck made before WP 2.5 stores.
  const old = (t: { params?: unknown }) => { delete t.params; };
  // 7 — a 4-word reversal that overprints under today's arcs (new track: roll + travel + lanes).
  const s7 = add("rev4"); addElement(deck, s7.id, text("t", 100, 200, "alpha beta gamma delta", { fontSize: 44, width: 700, height: 60 }));
  change(s7, "t", { text: "delta gamma beta alpha" });
  // 8 — the same reversal on the stage's top edge: no lane may lift ink off the stage.
  const s8 = add("rev4top"); addElement(deck, s8.id, text("t", 100, 8, "alpha beta gamma delta", { fontSize: 44, width: 700, height: 60 }));
  change(s8, "t", { text: "delta gamma beta alpha" });
  // 9 — identity for OLD tracks (params stripped): a pure insert (every word shifts right, a visible crossArc lift) and the owner's Deck-3 Change.
  const s9 = add("insert"); addElement(deck, s9.id, text("t", 100, 200, "red blue green", { fontSize: 56, width: 700, height: 70 }));
  old(change(s9, "t", { text: "the red blue green" }));
  const s10 = add("deck3"); addElement(deck, s10.id, text("t", 100, 200, "Some text to change", { fontSize: 40, width: 700, height: 56 }));
  old(change(s10, "t", { text: "Subtextual Context" }));
  // 11 / 12 — an anagram: new track (travel) vs old track (fade).
  const s11 = add("anagram"); addElement(deck, s11.id, text("t", 100, 200, "the morse code", { fontSize: 56, width: 700, height: 70 }));
  change(s11, "t", { text: "here come dots" });
  const s12 = add("anagram-old"); addElement(deck, s12.id, text("t", 100, 200, "the morse code", { fontSize: 56, width: 700, height: 70 }));
  old(change(s12, "t", { text: "here come dots" }));
  // 13 / 14 — an in-place word swap: new track (roll) vs old track (drift).
  const s13 = add("roll"); addElement(deck, s13.id, text("t", 100, 200, "The signal is noisy", { fontSize: 44, width: 700, height: 60 }));
  change(s13, "t", { text: "The signal is bursty" });
  const s14 = add("roll-old"); addElement(deck, s14.id, text("t", 100, 200, "The signal is noisy", { fontSize: 44, width: 700, height: 60 }));
  old(change(s14, "t", { text: "The signal is bursty" }));
  // 15 — a text -> text hand-off whose destination is a reversal (the hand-off driver plans lanes too).
  const s15 = add("handoff-rev"); addElement(deck, s15.id, text("a", 100, 150, "alpha beta gamma delta", { fontSize: 44, width: 700, height: 60 }));
  addElement(deck, s15.id, text("b", 100, 150, "delta gamma beta alpha", { fontSize: 44, width: 700, height: 60 }));
  change(s15, "a", {}).to!.become = { mode: "handoff", ref: { element: "b" } };
  // 16 / 17 — a stem edit (the changed letters ride the word's glide): new track (roll) vs old track (drift).
  const s16 = add("stem"); addElement(deck, s16.id, text("t", 100, 200, "Microscope images", { fontSize: 44, width: 700, height: 60 }));
  change(s16, "t", { text: "Microscopy images" });
  const s17 = add("stem-old"); addElement(deck, s17.id, text("t", 100, 200, "Microscope images", { fontSize: 44, width: 700, height: 60 }));
  old(change(s17, "t", { text: "Microscopy images" }));
  // 18 — a text -> text hand-off whose source is unmappable (legacy whole-line justification): the box crossfade draws it, and the flight's own
  // copies of A and B (the text layer, R2 F2) stay hidden: two renders of one text must never show at once.
  const s18 = add("handoff-legacy"); addElement(deck, s18.id, text("a", 100, 100, "one two three four five six", { align: "justify", sizing: "fixed", width: 200, height: 80, lines: ["one two three", "four five six"] }));
  addElement(deck, s18.id, text("b", 400, 300, "seven eight nine ten", { sizing: "fixed", width: 260, height: 40 }));
  change(s18, "a", {}).to!.become = { mode: "handoff", ref: { element: "b" } };
  // The real bake (payload.ts) through the shared resolver, as export-deck does.
  const io = { readText: (p: string) => fs.readFile(p, "utf8"), readFile: (p: string) => fs.readFile(p) };
  const baked = (await gatherPayload(tmp, deck, { ...io, glyphFont: async (style) => (await lookupFont(style)).bytes })).payload;
  h.ok(Object.keys(baked.glyphs ?? {}).sort().join() === "Arial|400|normal,Arial|700|normal", `the export bakes the two morphing texts' fonts (${Object.keys(baked.glyphs ?? {}).join(", ")})`);
  const exported = await exportDeckHtml(baked);
  h.ok(!/opentype/i.test(exported.html), "the offline runtime carries baked records, never the font parser");
  const file = path.join(tmp, "text-morph.html");
  await fs.writeFile(file, exported.html);
  const boxesFile = path.join(tmp, "text-morph-boxes.html");
  await fs.writeFile(boxesFile, (await exportDeckHtml({ deck, plots: {} })).html);
  const launched = await launch(); browser = launched.browser; const page = launched.page;
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  const errors: string[] = []; page.on("pageerror", (err: Error) => errors.push(String(err))); page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
  // tsx names the arrow functions it compiles; the page needs its helper.
  await page.evaluateOnNewDocument("window.__name = (f) => f");
  await page.goto(pathToFileURL(file).href); await page.waitForFunction("!!window.fluxDeck?.seek");
  const seek = (slide: number, time: number, beat = 1) => page.evaluate(({ slide, time, beat }) => (window as any).fluxDeck.seek(slide, beat, time), { slide, time, beat });
  const state = () => page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll<HTMLElement>(".sl-tm-span"));
    const matrix = (el: HTMLElement) => { const m = new DOMMatrix(getComputedStyle(el).transform === "none" ? undefined : getComputedStyle(el).transform); return { x: m.e, y: m.f, sx: m.a, sy: m.d }; };
    const morph = document.querySelector<HTMLElement>(".sl-text-morph");
    const layers = morph ? Array.from(morph.parentElement!.children).map((n) => getComputedStyle(n).visibility) : [];
    return {
      spans: spans.map((s) => ({ text: s.textContent, kind: s.dataset.kind, role: s.dataset.role, visible: getComputedStyle(s).visibility === "visible", opacity: Number(getComputedStyle(s).opacity), promoted: s.style.willChange === "transform", m: matrix(s),
        rect: (() => { const r = s.querySelector("text")!.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })() })),
      layers, morphVisible: morph ? getComputedStyle(morph).visibility : null,
      flightText: Array.from(document.querySelectorAll<HTMLElement>(".sl-flight-text")).map((l) => ({ visible: getComputedStyle(l).visibility, beforeFlight: l.nextElementSibling?.classList.contains("sl-flight") ?? false })),
      wrappers: Object.fromEntries(Array.from(document.querySelectorAll<HTMLElement>("[data-el-id]")).map((w) => [w.dataset.elId, getComputedStyle(w).visibility])),
    };
  });
  /** Screen boxes of a substring of the live text inside `[data-el-id=id]`'s visible layer. */
  const liveBox = (id: string, needle: string) => page.evaluate(({ id, needle }) => {
    const wrap = document.querySelector(`[data-el-id="${id}"]`)!;
    const texts = Array.from(wrap.querySelectorAll("text")).filter((t) => getComputedStyle(t).visibility !== "hidden" && !t.closest(".sl-text-morph"));
    for (const t of texts) {
      const all = t.textContent ?? "", at = all.indexOf(needle);
      if (at < 0) continue;
      const svg = t.ownerSVGElement!, ctm = t.getScreenCTM()!;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let i = at; i < at + needle.length; i++) {
        const e = t.getExtentOfChar(i);
        for (const [x, y] of [[e.x, e.y], [e.x + e.width, e.y + e.height]]) {
          const p = new DOMPoint(x, y).matrixTransform(ctm);
          x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
        }
      }
      void svg;
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    return null;
  }, { id, needle });
  /** The same for a span clone's glyphs (getExtentOfChar through the clone's CTM). */
  const spanBox = (needle: string, role = "main") => page.evaluate(({ needle, role }) => {
    const s = Array.from(document.querySelectorAll<HTMLElement>(".sl-tm-span")).find((n) => n.textContent === needle && n.dataset.role === role)!;
    const t = s.querySelector("text")!, ctm = t.getScreenCTM()!;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < needle.length; i++) {
      const e = t.getExtentOfChar(i);
      for (const [x, y] of [[e.x, e.y], [e.x + e.width, e.y + e.height]]) { const p = new DOMPoint(x, y).matrixTransform(ctm); x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }, { needle, role });
  const scale = await page.evaluate(() => { const c = document.querySelector<HTMLElement>(".sl-camera")!; return c.getBoundingClientRect().width / c.offsetWidth; });

  // --- 0: the reorder Change ---------------------------------------------------
  await seek(0, 0); let st = await state();
  h.ok(st.spans.every((s) => !s.visible) && st.layers[0] === "visible" && st.layers[2] === "hidden" && st.morphVisible === "hidden", "raw 0: only A's own text shows; the span layer is hidden");
  const xs: Record<string, number[]> = {};
  for (const t of [100, 250, 400, 550, 700, 850]) {
    await seek(0, t); st = await state();
    for (const s of st.spans.filter((s) => s.kind === "glide" && s.role === "main")) (xs[s.text!] ??= []).push(s.m.x);
  }
  await seek(0, 500); st = await state();
  const glides = st.spans.filter((s) => s.kind === "glide");
  h.eq(new Set(glides.map((s) => s.text!.toLowerCase())).size, 3, "mid-flight: all three words glide (a reorder by content)");
  // F2: spans paint IN PLACE. A layer bakes the sub-pixel phase of its first raster, so its picture is not the in-place picture the two endpoints
  // are (a step on the first and the last moving frame, measured 10 to 90 stage px² on a line of text in both headless and the GPU compositor).
  h.ok(glides.filter((s) => !s.promoted && s.role === "main").length === 3 && st.spans.every((s) => !s.promoted), "mid-flight: the three gliding spans paint in place (no compositor layer)");
  h.ok(st.layers[0] === "hidden" && st.layers[2] === "hidden" && st.morphVisible === "visible", "mid-flight: A and B are hidden, the span layer shows");
  const mono = (v: number[]) => v.every((x, i) => !i || x > v[i - 1]) || v.every((x, i) => !i || x < v[i - 1]);
  h.ok(Object.keys(xs).length === 3 && Object.values(xs).every(mono), `glide translates move monotonically (${Object.entries(xs).map(([k, v]) => `${k}:${v.map((x) => x.toFixed(1)).join(">")}`).join(" ")})`);
  h.ok(xs.Alpha[0] < xs.Alpha[5] && xs.gamma[0] > xs.gamma[5], "Alpha travels right, gamma travels left");
  await seek(0, 999.9); const flying = await spanBox("beta");
  await seek(0, 1000); const landed = await liveBox("t", "beta");
  const d = landed ? Math.max(Math.abs(flying.x - landed.x), Math.abs(flying.y - landed.y), Math.abs(flying.w - landed.w)) / scale : Infinity;
  h.ok(d <= 0.5, `'beta' lands on B's own glyphs (Δ ${d.toFixed(3)} stage px ≤ 0.5)`);
  st = await state();
  h.ok(st.spans.every((s) => !s.visible && !s.promoted) && st.layers[2] === "visible" && st.layers[0] === "hidden" && st.morphVisible === "hidden", "raw 1: only B's text, the span layer is empty of visible spans and nothing is promoted");
  await seek(0, 500); await seek(0, 0); st = await state();
  h.ok(st.spans.every((s) => !s.visible && !s.promoted) && st.layers[0] === "visible" && st.layers[2] === "hidden", "reverse seek to 0 restores A exactly");
  await seek(0, 300); const a1 = (await state()).spans.map((s) => s.m); await seek(0, 800); await seek(0, 300); const a2 = (await state()).spans.map((s) => s.m);
  h.eq(JSON.stringify(a2), JSON.stringify(a1), "random seeks are deterministic (no accumulated state)");

  // --- 1: the owner's examples -------------------------------------------------
  await seek(1, 875); st = await state();
  const owner = st.spans;
  h.ok(owner.some((s) => s.kind === "exit" && s.visible) && owner.some((s) => s.kind === "enter" && s.visible), "owner Become mid-flight: letters of both words are on screen (the wave overlaps)");
  h.ok(owner.filter((s) => s.kind === "exit").length === 10 && owner.filter((s) => s.kind === "enter").length === 14, `owner Become: a letter wave (10 out, 14 in; got ${owner.filter((s) => s.kind === "exit").length} out, ${owner.filter((s) => s.kind === "enter").length} in, texts ${JSON.stringify(owner.map((s) => s.text).join(""))})`);
  await seek(1, 450); const wave = (await state()).spans.filter((s) => s.kind === "exit").map((s) => s.opacity);
  h.ok(wave.every((o, i) => !i || o >= wave[i - 1] - 1e-6) && wave[0] < wave[wave.length - 1], `owner Become: the exit wave runs in reading order (${wave.map((o) => o.toFixed(2)).join(" ")})`);
  await seek(1, 875, 2); st = await state();
  const textGlide = st.spans.find((s) => s.kind === "glide" && s.text === "text");
  h.ok(!!textGlide && textGlide.visible, "owner Change: 'text' glides into Con|text");
  await seek(1, 1750, 2); st = await state();
  h.ok(st.spans.every((s) => !s.visible), "owner Change lands with no span left showing");

  // --- 2: a font-size change ---------------------------------------------------------
  await seek(2, 500); st = await state();
  const grow = st.spans.find((s) => s.kind === "glide" && s.text === "Grow");
  h.ok(!!grow && grow.m.sx > 1.2 && grow.m.sx < 1.3 && !grow.promoted, `size change: the glide scales mid-flight (×${grow?.m.sx.toFixed(3)}), painted in place`);
  await seek(2, 1000); st = await state();
  h.ok(st.spans.every((s) => !s.promoted && !s.visible), "size change: demoted and hidden at rest");

  // --- 3: text → text hand-off ---------------------------------------------------
  await seek(3, 0); st = await state();
  h.ok(st.wrappers.a === "visible" && st.wrappers.b === "hidden" && st.flightText.every((l) => l.visible === "hidden"), "hand-off raw 0: the source shows, the destination and the text flight layer are hidden");
  h.ok(st.flightText.length === 1 && st.flightText[0].beforeFlight, "hand-off: one stage-level text layer, placed just before svg.sl-flight (the flight stays the camera's last child)");
  await seek(3, 500); st = await state();
  h.ok(st.wrappers.a === "hidden" && st.wrappers.b === "hidden" && st.flightText[0].visible === "visible", "hand-off mid-flight: both objects hidden, the text layer flies");
  h.ok(st.spans.filter((s) => s.kind === "glide" && s.visible).length >= 3, "hand-off mid-flight: The / brown fox / quick glide");
  const ly = st.spans.find((s) => s.text === "l" && s.kind === "enter"), quick = st.spans.find((s) => s.text === "quick" && s.role === "twin");
  // 'ly' rides its stem: it sits just past the moving 'quick' (one word), not at
  // its final place 300 px away.
  h.ok(!!ly && !!quick && ly.rect.x > quick.rect.x && ly.rect.x - (quick.rect.x + quick.rect.w) < 0.25 * quick.rect.w, `hand-off: the entering 'ly' rides beside its moving 'quick' (gap ${ly && quick ? (ly.rect.x - quick.rect.x - quick.rect.w).toFixed(1) : "?"} px)`);
  await seek(3, 999.9); const fq = await spanBox("quick", "twin");
  await seek(3, 1000); const lq = await liveBox("b", "quick");
  const dq = lq ? Math.max(Math.abs(fq.x - lq.x), Math.abs(fq.y - lq.y), Math.abs(fq.w - lq.w)) / scale : Infinity;
  h.ok(dq <= 0.5, `hand-off: a restyled word (bold, red, larger) lands on the destination's glyphs (Δ ${dq.toFixed(3)} stage px)`);
  st = await state();
  h.ok(st.wrappers.a === "hidden" && st.wrappers.b === "visible" && st.spans.every((s) => !s.visible), "hand-off raw 1: only the destination shows");

  // --- 4: unmappable → natural-size crossfade ----------------------------------------
  await seek(4, 500); st = await state();
  h.ok(st.morphVisible === "hidden" && st.layers[0] === "visible" && st.layers[2] === "visible", "legacy justification: the fallback crossfades A and B");
  const legacy = await page.evaluate(() => {
    const morph = document.querySelector<HTMLElement>('[data-el-id="t"] .sl-text-morph') ?? Array.from(document.querySelectorAll<HTMLElement>(".sl-text-morph")).pop()!;
    const [A, , B] = Array.from(morph.parentElement!.children) as HTMLElement[];
    const glyphW = (layer: HTMLElement) => { const t = layer.querySelector("text")!; const r = t.getBoundingClientRect(); return r.height; };
    return { a: A.style.transform, b: B.style.transform, ha: glyphW(A), hb: glyphW(B) };
  });
  h.ok(/scale\(/.test(legacy.a) && /scale\(/.test(legacy.b) && Math.abs(legacy.ha - legacy.hb) < 2, "fallback: both endpoint renders keep their natural glyph size (no stretch with the box)");
  // --- 5: rect → word hand-off, letters as outlines ------------------------------------
  const flight = () => page.evaluate(() => {
    const paths = Array.from(document.querySelectorAll<SVGPathElement>(".sl-flight .sl-handoff-path"));
    const shown = paths.filter((p) => Number(p.getAttribute("opacity") ?? 1) > 0.01 && getComputedStyle(p).visibility !== "hidden");
    const ctm = (document.querySelector(".sl-flight") as SVGSVGElement).getScreenCTM()!;
    const box = (p: SVGPathElement) => { const b = p.getBBox(); const a = new DOMPoint(b.x, b.y).matrixTransform(ctm), c = new DOMPoint(b.x + b.width, b.y + b.height).matrixTransform(ctm); return { x: a.x, y: a.y, r: c.x, b: c.y }; };
    const holds = Array.from(document.querySelectorAll<SVGGElement>(".sl-flight .sl-handoff-shape, .sl-flight .sl-handoff-text")).map((g) => ({ cls: g.getAttribute("class"), opacity: Number(g.getAttribute("opacity") ?? 0) }));
    return { count: shown.length, boxes: shown.map(box), fills: shown.map((p) => p.getAttribute("fill")), driver: document.querySelector(".sl-flight .sl-handoff")?.getAttribute("data-driver"), holds,
      source: getComputedStyle(document.querySelector('[data-el-id="r"]')!).visibility, dest: getComputedStyle(document.querySelector('[data-el-id="w"]')!).visibility };
  });
  /** The destination word's per-letter extent boxes (screen px). */
  const letterBoxes = (id: string) => page.evaluate((id) => {
    const t = document.querySelector(`[data-el-id="${id}"] text`) as SVGTextElement, ctm = t.getScreenCTM()!;
    return Array.from({ length: t.getNumberOfChars() }, (_, i) => { const e = t.getExtentOfChar(i); const a = new DOMPoint(e.x, e.y).matrixTransform(ctm), c = new DOMPoint(e.x + e.width, e.y + e.height).matrixTransform(ctm); return { x: a.x, y: a.y, r: c.x, b: c.y }; });
  }, id);
  // The very first seek finds the baked font still loading (a promise): boxes.
  // Parked there, the player repaints once the font lands — outlines, no seek.
  await seek(5, 500);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 60)));
  let fl = await flight();
  h.eq(fl.count, 11, "a scrub parked while the font loads repaints from boxes to the 11 letter outlines without another seek");
  h.ok(fl.count >= 10 && fl.source === "hidden" && fl.dest === "hidden", `mid-flight: ${fl.count} letter rings fly (≥ 10) while both objects hide`);
  await seek(5, 30); fl = await flight();
  h.ok(fl.holds.some((x) => x.cls === "sl-handoff-shape" && x.opacity > 0.5), "leaving: the rect itself covers its slice seams for the first 15 %");
  await seek(5, 999); fl = await flight();
  const lb = await letterBoxes("w");
  const inside = fl.boxes.every((b) => lb.some((l) => b.x >= l.x - 0.5 * scale && b.r <= l.r + 0.5 * scale && b.y >= l.y - 0.5 * scale && b.b <= l.b + 0.5 * scale));
  h.ok(fl.count === 11 && inside, `landing: each of the ${fl.count} rings (M-i-c-r-o-s-c-o-p-y, i in two parts) sits inside its letter's own box (≤ 0.5 px)`);
  h.ok(fl.fills.every((f) => /rgb\(31, 58, 147\)|#1f3a93/i.test(f ?? "")), "landing: the rings carry the text colour (OKLab-lerped, clamped)");
  await seek(5, 1000); fl = await flight();
  h.ok(fl.count === 0 && fl.dest === "visible" && fl.source === "hidden", "raw 1: the flight empties and the live word flips in");
  await seek(5, 0); fl = await flight();
  h.ok(fl.count === 0 && fl.source === "visible" && fl.dest === "hidden", "reverse seek: the rect is back, the word hidden");

  // --- 6: Consume rect → text in one element ---------------------------------------------
  const consume = () => page.evaluate(() => {
    const w = document.querySelector<HTMLElement>('[data-el-id="r"]')!, m = w.querySelector<HTMLElement>(".sl-glyph-morph");
    const layers = m ? Array.from(m.parentElement!.children).map((n) => ({ vis: getComputedStyle(n).visibility, opacity: Number(getComputedStyle(n).opacity) })) : [];
    return { paths: m ? Array.from(m.querySelectorAll("path")).filter((p) => Number(p.getAttribute("opacity")) > 0.01).length : -1, layers, width: w.style.width, visible: getComputedStyle(m ?? w).visibility };
  });
  await seek(6, 500); let cs = await consume();
  h.ok(cs.paths >= 6 && cs.layers[1]?.vis === "visible", `consume mid-flight: the element's own morph layer pours the rect into ${cs.paths} letter rings`);
  await seek(6, 1000); cs = await consume();
  h.ok(cs.layers[1]?.vis === "hidden" && cs.layers[2]?.vis === "visible" && cs.width === "300px", `consume at rest: the end text shows in the AUTHORED box (width ${cs.width}, never re-hugged)`);

  // --- 7-15: WP 2.5 — lanes, roll, letters (all from authored params) ----------------------------------------------------------
  /** Worst frame of summed pairwise ink overlap (stage px^2): visible spans above 35 % opacity, central 60 % of their height; the
   *  two clones of one crossfading word are not a collision (probes/dom_overlap.mts, the number R4_T9 quotes: 9 015 -> 607). */
  const worstOverlap = async (slide: number, frames = 54) => {
    let worst = 0;
    for (let f = 0; f <= frames; f++) {
      await seek(slide, (f / frames) * 1000);
      const rects = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>(".sl-tm-span")).filter((d) => d.style.visibility !== "hidden" && Number(d.style.opacity) > 0.35).map((d) => { const r = d.querySelector("text")!.getBoundingClientRect(); return { s: d.textContent, x: r.x, y: r.y + r.height * 0.2, w: r.width, h: r.height * 0.6 }; }));
      let area = 0;
      for (let a = 0; a < rects.length; a++) for (let b = a + 1; b < rects.length; b++) {
        if (rects[a].s === rects[b].s) continue;
        const ox = Math.min(rects[a].x + rects[a].w, rects[b].x + rects[b].w) - Math.max(rects[a].x, rects[b].x), oy = Math.min(rects[a].y + rects[a].h, rects[b].y + rects[b].h) - Math.max(rects[a].y, rects[b].y);
        if (ox > 0 && oy > 0) area += ox * oy;
      }
      worst = Math.max(worst, area / (scale * scale));
    }
    return Math.round(worst);
  };
  // lanes: the reversal no longer overprints (base: crossArc alone, worst frame 6 698 px^2 on this deck)
  const ov = await worstOverlap(7);
  h.ok(ov <= 400, `lanes: a 4-word reversal's worst frame overprints ${ov} px^2 (<= 400, measured ~293; today's arcs alone: 6 698 on this deck)`);
  await seek(7, 500); st = await state();
  const reversed = st.spans.filter((s) => s.kind === "glide" && s.role === "main");
  h.eq(reversed.length, 4, "lanes: all four words glide");
  // seek purity with lanes: forward == reverse == shuffled
  // a hidden span keeps its last (invisible) style, so only visible spans are compared
  const frameAt = async (t: number) => { await seek(7, t); return JSON.stringify((await state()).spans.map((s) => s.visible ? [s.m, s.opacity] : null)); };
  const times = [0, 130, 260, 390, 520, 650, 780, 910, 1000], fwd = [] as string[], rev = [] as string[];
  for (const t of times) fwd.push(await frameAt(t));
  for (const t of [...times].reverse()) rev.unshift(await frameAt(t));
  const order = [4, 1, 8, 0, 6, 3, 7, 2, 5], shuf = [] as string[]; for (const i of order) shuf[i] = await frameAt(times[i]);
  h.ok(fwd.every((v, i) => v === rev[i] && v === shuf[i]), "lanes: forward == reverse == shuffled seeks, frame for frame (9 times)");
  // landing: the flying glyphs land exactly on B's own text with lanes + roll + travel authored
  await seek(7, 999.9); const lf = await spanBox("beta");
  await seek(7, 1000); const ll = await liveBox("t", "beta");
  const dl = ll ? Math.max(Math.abs(lf.x - ll.x), Math.abs(lf.y - ll.y), Math.abs(lf.w - ll.w)) / scale : Infinity;
  h.ok(dl <= 0.5, `lanes: 'beta' lands on B's own glyphs (Δ ${dl.toFixed(3)} stage px ≤ 0.5)`);
  // stage bounds: a title on the top edge keeps every glyph's ink on the stage (the lane planner refuses classic arcs that leave it too)
  let topMin = Infinity;
  for (let f = 0; f <= 54; f++) { await seek(8, (f / 54) * 1000); for (const sp of (await state()).spans.filter((s) => s.kind === "glide" && s.visible)) topMin = Math.min(topMin, sp.m.y - 44); }
  h.ok(topMin >= -0.5, `bounds: no glide's ink rises above the stage top on a top-edge title (min ink top ${topMin.toFixed(2)} stage px >= 0)`);
  // identity: an OLD track (no params) over paths that never collide plays today's look EXACTLY. Portable form of the base-player
  // hash pin (no absolute font geometry): every glide is its straight line plus crossArc, to the rounding the frame writes (1e-6 px),
  // so no lane, bow or roll leaked in. (Measured once: at the base commit and on the branch the per-frame span-style sha1 of these two old-track decks is identical.)
  const classicOnly = async (slide: number, size: number) => {
    const at = async (u: number) => { await seek(slide, u * 1000); return (await state()).spans.filter((sp) => sp.kind === "glide" && sp.role === "main" && sp.visible).map((sp) => sp.m); };
    const f25 = await at(0.25), f75 = await at(0.75), f50 = await at(0.5);
    let worst = 0, lifted = 0, n = 0;
    for (const u of [0.1, 0.4, 0.6, 0.9]) {
      const fu = await at(u);
      fu.forEach((m, k) => {
        const dx = (f75[k].x - f25[k].x) / 0.5;
        worst = Math.max(worst, Math.abs((m.x - f50[k].x) - dx * (u - 0.5)));                                           // x is the straight line
        const arc = (t: number) => crossArcOf(dx, 0, size, t);
        worst = Math.max(worst, Math.abs((m.y - f50[k].y) - (arc(u) - arc(0.5))));                                      // y is the classic arc
        lifted = Math.max(lifted, Math.abs(arc(0.5))); n++;
      });
    }
    return { worst, lifted, n };
  };
  const c9 = await classicOnly(9, 56), c10 = await classicOnly(10, 40);
  h.ok(c9.n >= 4 && c9.worst < 2e-3 && c9.lifted > 2, `old track, pure insert: glides are straight line + crossArc only (worst Δ ${c9.worst.toExponential(1)} px; arc lift ${c9.lifted.toFixed(1)} px)`);
  h.ok(c10.n >= 4 && c10.worst < 2e-3, `old track, owner Deck-3 Change: glides are straight line + crossArc only (worst Δ ${c10.worst.toExponential(1)} px)`);
  // letters travel: authored -> the letters of the anagram fly (no leftover fades); absent -> today's plan (two shared blocks, the rest fades)
  await seek(11, 500); st = await state();
  const flyers = st.spans.filter((s) => s.kind === "glide" && s.role === "main" && s.visible);
  h.ok(flyers.length === 10 && st.spans.every((s) => s.kind === "glide"), `letters travel (authored): all ${st.spans.length} spans of "the morse code" -> "here come dots" are glides (letters fly), none fades`);
  h.ok(flyers.filter((s) => s.text!.length === 1).length >= 8, "letters travel (authored): single letters fly");
  await seek(12, 500); st = await state();
  h.eq([st.spans.filter((s) => s.kind === "glide").map((s) => s.text), st.spans.filter((s) => s.kind === "exit").length, st.spans.filter((s) => s.kind === "enter").length], [["he", "co"], 8, 8], "letters travel (absent): the old track plays today's plan (he / co glide, 8 letters out, 8 in)");
  await seek(11, 1000); st = await state();
  h.ok(st.spans.every((s) => !s.visible && !s.promoted) && st.layers[2] === "visible", "letters travel: raw 1 shows B only, nothing promoted");
  // roll: authored -> leftovers lift 0.35 em without a scale change; absent -> today's drift (scale < 1)
  await seek(13, 330); st = await state();
  const exits = st.spans.filter((s) => s.kind === "exit" && s.visible), enters = st.spans.filter((s) => s.kind === "enter" && s.visible);
  h.ok(exits.length > 0 && exits.every((s) => s.m.sx === 1 && s.m.sy === 1) && enters.every((s) => s.m.sx === 1 && s.m.sy === 1), "roll (authored): leftover letters never change scale");
  await seek(14, 330); st = await state();
  h.ok(st.spans.filter((s) => (s.kind === "exit" || s.kind === "enter") && s.visible).some((s) => s.m.sx !== 1), "roll (absent): the old track still shrinks / grows its leftovers (fadeLook)");
  await seek(13, 1000); st = await state();
  h.ok(st.spans.every((s) => !s.visible && !s.promoted), "roll: raw 1 leaves no span showing");
  // roll reaches the riders: the `e` / `y` glued to the Microscop glide roll in place (no scale change); the old track still shrinks them
  const ridersAt = async (slide: number) => { const seen: { kind: string; sx: number; sy: number }[] = []; for (const t of [200, 330, 500, 670, 800]) { await seek(slide, t); seen.push(...(await state()).spans.filter((s) => (s.kind === "exit" || s.kind === "enter") && s.visible).map((s) => ({ kind: s.kind, sx: s.m.sx, sy: s.m.sy }))); } return seen; };
  const rd = await ridersAt(16);
  h.ok(rd.some((r) => r.kind === "exit") && rd.some((r) => r.kind === "enter") && rd.every((r) => r.sx === 1 && r.sy === 1), `roll (authored) reaches riders: the leaving e and the entering y of Microscope -> Microscopy keep their scale (${rd.length} samples)`);
  h.ok((await ridersAt(17)).some((r) => r.sx !== 1), "roll (absent): the old track's riders still shrink / grow (fadeLook)");
  await seek(16, 1000); st = await state();
  h.ok(st.spans.every((s) => !s.visible && !s.promoted), "riders: raw 1 leaves no span showing");
  // the hand-off driver plans lanes and reads the look too
  const ovh = await worstOverlap(15);
  h.ok(ovh <= 400, `hand-off: the same reversal as a text -> text Become overprints ${ovh} px^2 (<= 400)`);

  // --- R2 F2: the first moving frame is the rest render, the last is the static render ---------------------------------------------------------
  // A span run is shaped and rasterised a few hundredths of a device pixel differently from the whole line it was cut from (a quarter-pixel
  // glyph bucket flips for a glyph or two), which read 15 to 130 stage px^2 on the first moving frame and the landing frame of every rewrite
  // (R2 settle sweep: START POP / END SNAP on the text decks, change#3). Measured in the pixels the page paints (the perceptual comparison of the
  // settle sweep, stage px^2 per stage px^2), through the real player: spans are drawn by their endpoint's own svg mapping, paint in place, and
  // hand over to the static renders over the first and the last 0.75 stage px of change.
  {
    const box = await page.evaluate(() => { const r = document.querySelector<HTMLElement>(".sl-camera")!.parentElement!.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
    const grab = async (slide: number, time: number, beat = 1) => {
      await seek(slide, time, beat); await page.evaluate("new Promise(r => requestAnimationFrame(r))");
      const img = await loadImage(await page.screenshot({ clip: box, type: "png" }) as Buffer);
      const c = createCanvas(img.width, img.height).getContext("2d"); c.drawImage(img, 0, 0);
      return c.getImageData(0, 0, img.width, img.height).data;
    };
    const diff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => perceptualDiff(a, b, Math.round(box.width), scale);
    for (const [slide, label] of [[0, "reorder + move"], [7, "4-word reversal"], [16, "stem edit"], [3, "text -> text Become"], [15, "Become reversal"]] as const) {
      const rest = await grab(slide, 0), first = await grab(slide, 0.05), near = await grab(slide, 999.95), end = await grab(slide, 1000);
      const d0 = diff(rest, first), d1 = diff(near, end);
      h.ok(d0 < 2, `${label}: the first moving frame (0.05 ms of a linear move) is the rest render (Δ ${d0.toFixed(2)} stage px² < 2; base 15 to 130)`);
      h.ok(d1 < 2, `${label}: the last frame (0.05 ms before the end) is the static render (Δ ${d1.toFixed(2)} stage px² < 2; base 10 to 90)`);
    }
    await seek(0, 500); st = await state();
    h.ok(st.layers[0] === "hidden" && st.layers[2] === "hidden", "mid-flight the span layer alone shows (A and B hold no weight)");
    await seek(0, 0.2); st = await state();
    h.ok(st.layers[0] === "visible" && st.morphVisible === "visible" && st.spans.every((s) => !s.promoted), "a fraction of a ms in, A still shows and the span layer is added over it with its own weight (no span is promoted)");
  }

  {
    await seek(18, 500);
    const fb = await page.evaluate(() => { const l = document.querySelector<HTMLElement>(".sl-flight-text"); return { copies: l ? Array.from(l.children).filter((c) => !c.classList.contains("sl-text-morph") && c.querySelector("text")).map((c) => getComputedStyle(c).visibility) : [], spans: Array.from(document.querySelectorAll<HTMLElement>(".sl-tm-span")).filter((s) => getComputedStyle(s).visibility === "visible").length }; });
    h.ok(fb.copies.length === 2 && fb.copies.every((v) => v === "hidden") && fb.spans === 0, `hand-off, unmappable source: the box crossfade draws the texts and the flight's copies of A and B stay hidden (${fb.copies.join("/")}, ${fb.spans} spans showing)`);
  }

  // --- the glyph-box fallback (an export without baked fonts) -----------------------------
  await page.goto(pathToFileURL(boxesFile).href); await page.waitForFunction("!!window.fluxDeck?.seek");
  await seek(5, 500); fl = await flight();
  h.ok(fl.count === 10, `no font: the rect still splits into one box per letter (${fl.count})`);
  await seek(5, 930); fl = await flight();
  const textHold = fl.holds.find((x) => x.cls === "sl-handoff-text");
  h.ok(!!textHold && textHold.opacity > 0.3 && textHold.opacity < 0.7, `no font: boxes land, then crossfade into the live word over the final 15 % (text at ${textHold?.opacity.toFixed(2)})`);
  await seek(5, 1000); fl = await flight();
  h.ok(fl.count === 0 && fl.dest === "visible", "no font: raw 1 shows only the live word");

  h.eq(errors, [], "no console errors");
} finally {
  await browser?.close();
  await fs.rm(tmp, { recursive: true, force: true });
}
await h.done();
