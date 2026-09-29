// Slide builds -> a sequence of PowerPoint pages joined by Morph (2026-09-27,
// owner request: "slides with animations are exported to pptx with the same
// transitions and animations; maybe the best way is with the morph").
//
// PowerPoint's own effects cannot carry most of Flux's motion (the camera, a
// Change that tweens geometry, colour or text, Become), but Morph can: it
// tweens every object that appears, under the same name, on two consecutive
// slides. So a Flux slide becomes its resting state plus one page per click
// (a with-previous chain lands on the same click), each entered by Morph and
// named "!!<object>" so PowerPoint pairs the objects exactly:
//   • sequential effects within a click (a gap or no overlap in time) become
//     auto-advancing Morph pages, so "this, then that" survives; effects that
//     overlap in time play together over their shared span;
//   • an automatic step advances by itself after its delay;
//   • appearing / disappearing objects fade (Morph's own behaviour); a rising
//     or popping entrance (fadeRise / popIn) and a popping exit (popOut) get
//     an invisible twin at the offset or scaled pose, so Morph shows the lift
//     or the pop, not a bare fade;
//   • the slide-to-slide transition (fade / slide / push) enters each slide.
// Morph has one ease of its own, so a track's easing is not carried; a plot's
// staggered parts cross-fade as one picture.
import { beatDelayMs } from "../timing";
import type { CompiledSlide } from "../compile";
import { compileSlideFor, evaluateSlide, type EvaluatedSlide } from "../embedRender";
import type { ExportPayload } from "../payload";
import { familyOf } from "../family";
import { cueEnd } from "../video";
import { scaleRemap } from "../../editing";
import type { Element } from "../../types";
import { DUR } from "../../motion/tokens";

export type PptxPages = "animated" | "final";
export interface PptxTransition { kind: "none" | "fade" | "cover" | "push" | "morph"; ms: number }
export interface PptxPage {
  ev: EvaluatedSlide;
  /** How the page is entered. */
  enter: PptxTransition;
  /** Leave by itself this long after the page settles (else on a click). */
  advanceAfterMs?: number;
  /** Shape names by element id ("!!…" on Morph chains), unique on the page. */
  names: Map<string, string>;
  label: string;
  /** A picture drawn from another state than its frame: an invisible pop twin
   *  of a 3D model shows, scaled into its frame, the still Morph lands on. */
  stills?: Map<string, Element>;
}

const RISE = new Set(["fadeRise"]), POP_IN = new Set(["popIn"]), POP_OUT = new Set(["popOut"]);

function slideTransition(payload: ExportPayload): PptxTransition {
  const kind = payload.deck.slides[0].transition ?? payload.deck.defaults?.transition ?? "none";
  // The player's "slide" moves the new slide in over the old: PowerPoint's Cover.
  return { kind: kind === "slide" ? "cover" : kind, ms: kind === "none" ? 0 : DUR.gentle };
}

function uniqueNames(elements: Element[], morph: boolean): Map<string, string> {
  const base = (el: Element) => (el.name || `${el.type} ${el.id}`).trim();
  const seen = new Map<string, number>();
  for (const el of elements) seen.set(base(el), (seen.get(base(el)) ?? 0) + 1);
  return new Map(elements.map((el) => {
    const name = (seen.get(base(el)) ?? 0) > 1 ? `${base(el)} ${el.id}` : base(el);
    return [el.id, morph ? `!!${name}` : name];
  }));
}

/** An element scaled about its centre by `f` (a pop's start or end pose). */
function scaledAboutCentre(el: Element, f: number): Element {
  const out = structuredClone(el);
  const ob = { x: el.x, y: el.y, w: el.width, h: el.height };
  const nb = { x: el.x + el.width * (1 - f) / 2, y: el.y + el.height * (1 - f) / 2, w: el.width * f, h: el.height * f };
  scaleRemap(out, el, ob, nb);
  return out;
}

/** One click (or automatic step): beats `from..to` play together. */
interface Run { from: number; to: number; auto: boolean; autoDelayMs: number }
function runsOf(payload: ExportPayload): Run[] {
  const slide = payload.deck.slides[0], runs: Run[] = [];
  for (let from = 1; from < slide.beats.length;) {
    const to = cueEnd(slide, from), beat = slide.beats[from];
    runs.push({ from, to, auto: beat.advance === "auto", autoDelayMs: beatDelayMs(beat) });
    from = to + 1;
  }
  return runs;
}

/** Merge the run's track spans into phases: spans that overlap or touch play
 *  together; a later, disjoint span is a phase of its own. */
function phasesOf(compiled: CompiledSlide, run: Run) {
  const spans = compiled.cues.slice(run.from, run.to + 1).flatMap((c) => c.tracks)
    .filter((ct) => familyOf(ct.track) !== "media")
    .map((ct) => ({ start: ct.start, end: ct.end, ct }))
    .sort((a, b) => a.start - b.start);
  const phases: { start: number; end: number; tracks: typeof spans }[] = [];
  for (const span of spans) {
    const last = phases[phases.length - 1];
    if (last && span.start <= last.end) { last.end = Math.max(last.end, span.end); last.tracks.push(span); }
    else phases.push({ start: span.start, end: span.end, tracks: [span] });
  }
  return phases.length ? phases : [{ start: 0, end: 0, tracks: [] }];
}

/** The pages one Flux slide exports as. `final` = its last build state only. */
export function pptxPages(payload: ExportPayload, mode: PptxPages = "animated", slideNumber = 1): PptxPage[] {
  const slide = payload.deck.slides[0];
  const compiled = compileSlideFor(payload);
  const cache = new Map<string, EvaluatedSlide>();
  const at = (beat: number, time = Infinity) => {
    const key = `${beat}@${time}`;
    let ev = cache.get(key);
    if (!ev) {
      // Model elements keep their sampled box and visibility here: deckPptx
      // pictures them through staticModelElement (Design mesh and furniture
      // at the page's placement), the same still the PDF pages use.
      ev = evaluateSlide(payload, beat, time, compiled);
      cache.set(key, ev);
    }
    return ev;
  };
  const last = Math.max(0, slide.beats.length - 1);
  const runs = mode === "animated" ? runsOf(payload) : [];
  const title = slide.name ?? `Slide ${slideNumber}`;
  if (!runs.length) {
    const ev = at(last);
    return [{ ev, enter: slideTransition(payload), names: uniqueNames(ev.elements, false), label: title }];
  }

  const names = uniqueNames(at(last).elements, true);
  const pages: PptxPage[] = [{ ev: at(0), enter: slideTransition(payload), names, label: title }];
  let step = 0;
  for (const run of runs) {
    const phases = phasesOf(compiled, run);
    // Which beat of the run moves each target: its state at a phase's end is
    // that beat sampled at that time (earlier beats of the chain count as
    // done — exact for the usual one-beat click).
    const owner = new Map<string, number>();
    for (const ct of compiled.cues.slice(run.from, run.to + 1).flatMap((c) => c.tracks))
      if (familyOf(ct.track) !== "media") owner.set(ct.track.target, Math.max(owner.get(ct.track.target) ?? 0, ct.beat));
    for (const handoff of compiled.handoffs) if (handoff.beat >= run.from && handoff.beat <= run.to)
      for (const dest of handoff.destination) owner.set(dest.elementId, Math.max(owner.get(dest.elementId) ?? 0, handoff.beat));
    const done = at(run.to);
    step++;
    for (const [i, phase] of phases.entries()) {
      const final = i === phases.length - 1;
      const source = (id: string) => {
        const beat = owner.get(id);
        return beat == null ? done : at(beat, final ? Infinity : phase.end);
      };
      const ev: EvaluatedSlide = {
        ...done,
        elements: done.elements.map((el) => source(el.id).elements.find((e) => e.id === el.id) ?? el),
        plotMarkup: (el) => source(el.id).plotMarkup(el),
        camera: owner.has("@camera") ? source("@camera").camera : done.camera,
      };
      const previous = pages[pages.length - 1];
      if (i === 0) { if (run.auto) previous.advanceAfterMs = run.autoDelayMs + phase.start; }
      else previous.advanceAfterMs = Math.max(0, phase.start - phases[i - 1].end);
      const page: PptxPage = {
        ev, names, label: `${title} · step ${step}${phases.length > 1 ? `.${i + 1}` : ""}`,
        enter: phase.end > phase.start ? { kind: "morph", ms: phase.end - phase.start } : { kind: "none", ms: 0 },
      };
      twins(previous, page, phase.tracks.map((t) => t.ct));
      pages.push(page);
    }
  }
  return pages;
}

/** Invisible twins for the entrances and exits Morph would otherwise only
 *  fade: the rising/popping object starts, on the page before, at its offset
 *  or scaled pose at zero opacity (and a popping exit ends so on its page). */
function twins(before: PptxPage, after: PptxPage, tracks: CompiledSlide["cues"][number]["tracks"]): void {
  // A twin (opacity 0) placed by an earlier step is not "shown".
  const shown = (ev: EvaluatedSlide, id: string) => ev.elements.find((e) => e.id === id && !e.hidden && (e.opacity ?? 1) > 0);
  const place = (page: PptxPage, twin: Element, still?: Element) => {
    page.ev = { ...page.ev, elements: page.ev.elements.map((e) => e.id === twin.id ? twin : e) };
    // A model's still depends on its box; a scaled twin pictures the full-size
    // still (its own size has no rendered poster) so Morph pops one image.
    if (still?.type === "model3d") (page.stills ??= new Map()).set(twin.id, still);
    else page.stills?.delete(twin.id);
  };
  for (const ct of tracks) {
    const preset = ct.track.preset ?? "fade", id = ct.track.target;
    if (ct.track.part || ct.track.selector) continue; // parts live inside one picture
    const entering = !shown(before.ev, id) && shown(after.ev, id);
    const leaving = shown(before.ev, id) && !shown(after.ev, id);
    if (entering && (RISE.has(preset) || POP_IN.has(preset))) {
      const end = shown(after.ev, id)!;
      const twin = RISE.has(preset)
        ? { ...structuredClone(end), y: end.y + Number(ct.track.params?.y ?? 14) }
        : scaledAboutCentre(end, Number(ct.track.params?.from ?? 0.9));
      place(before, { ...twin, hidden: false, opacity: 0 } as Element, POP_IN.has(preset) ? end : undefined);
    } else if (leaving && POP_OUT.has(preset)) {
      const start = shown(before.ev, id)!;
      place(after, { ...scaledAboutCentre(start, Number(ct.track.params?.to ?? 0.92)), hidden: false, opacity: 0 } as Element, start);
    }
  }
}
