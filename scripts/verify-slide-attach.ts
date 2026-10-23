#!/usr/bin/env -S npx tsx
// WP 3.2 (manim study, T9): ATTACHED CONNECTORS and labels — the pure gate (slide/attach.ts): solver exactness, order / cycles, the sampler
// (compile.sample) over a spring + arc deck at 60 fps, seek purity, identity seams, hardening, the editor hook and the slide editor's
// capture; then what Release 3 added to the T9 prototype: the authoring op and its one check, the verbs' argument grammar, the hand-move
// rule (a dependent moved by hand frees itself), the write points (stored == solved on disk) and the content-derived schema stamps
// (deck 0.7.0 / canvas 0.3.0 while anything is attached), and the headless verbs. No DOM.
import { harness } from "./lib/harness.mjs";
import { get } from "svelte/store";
import * as att from "../src/lib/slide/attach";
import { compileSlide } from "../src/lib/slide/compile";
import { createDeck, addSlide, addElement, addBeat, setTransform, becomeTransform } from "../src/lib/slide/ops";
import { diffState, applyState } from "../src/lib/slide/tween";
import { validateDeckFile } from "../src/lib/project/validate";
import * as store from "../src/lib/store";
import * as figOps from "../src/lib/ops";
import { cloneContentWithFreshIds } from "../src/lib/slide/deckProject";
import * as ss from "../src/lib/slide/store";
import * as slideOps from "../src/lib/slide/ops";
import { planFigSave } from "../src/lib/project/figfiles";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scaffold } from "../flux-core/index";
import { saveDeck, loadDeck, slideAttachVerb } from "../flux-core/slides";
import { figureAttachVerb } from "../flux-core/figures";
import { loadFigModel, mutateFigModel } from "../flux-core/model";

const h = harness("verify-slide-attach");
const R = (id: string, x: number, y: number, w = 100, hgt = 60, extra: object = {}): any => ({ type: "rect", id, x, y, width: w, height: hgt, rotation: 0, fill: "#4385be", stroke: "#205ea6", strokeWidth: 2, cornerRadius: 0, ...extra });
const E = (id: string, x: number, y: number, w = 96, hgt = 96): any => ({ type: "ellipse", id, x, y, width: w, height: hgt, rotation: 0, fill: "#d14d41", stroke: "#942822", strokeWidth: 2 });
const L = (id: string, attach: any): any => ({ type: "line", id, x: 0, y: 0, width: 0, height: 0, rotation: 0, x1: 0, y1: 0, x2: 10, y2: 0, stroke: "#100f0f", strokeWidth: 2, arrowEnd: true, attach });
const T = (id: string, attach: any): any => ({ type: "text", id, x: 0, y: 0, width: 70, height: 24, rotation: 0, text: "x", fontFamily: "Gelasio", fontSize: 18, fontWeight: 400, fontStyle: "normal", align: "center", color: "#000", sizing: "fixed", attach });
const AUTO = { start: { to: "A", anchor: "auto", gap: 3 }, end: { to: "B", anchor: "auto", gap: 3 } };
const near = (a: number, b: number, e = 1e-9) => Math.abs(a - b) <= e;

h.section("solver exactness");
{
  const a = R("A", 0, 0), pt = att.boundaryToward(a, { x: 400, y: 30 }, 0);
  h.ok(near(pt.x, 100) && near(pt.y, 30), "rect: axis ray from the centre hits the east edge");
  const pg = att.boundaryToward(a, { x: 400, y: 30 }, 4);
  h.ok(near(pg.x, 104) && near(pg.y, 30), "rect: gap pushes outward along the ray");
  const rot = R("A", 100, 100, 100, 60, { rotation: 30 }), s = att.shapeOf(rot), p = att.boundaryToward(rot, { x: 400, y: 130 }, 0);
  const c = Math.cos(-30 * Math.PI / 180), sn = Math.sin(-30 * Math.PI / 180), lx = (p.x - s.c.x) * c - (p.y - s.c.y) * sn, ly = (p.x - s.c.x) * sn + (p.y - s.c.y) * c;
  h.ok(near(Math.max(Math.abs(lx) / s.hw, Math.abs(ly) / s.hh), 1), "rotated rect: hit lies exactly on the rotated outline");
  const el = E("B", 200, 50, 120, 80), se = att.shapeOf(el), q = att.boundaryToward(el, { x: 10, y: 200 }, 0);
  h.ok(near(((q.x - se.c.x) / se.hw) ** 2 + ((q.y - se.c.y) / se.hh) ** 2, 1), "ellipse: hit lies exactly on the ellipse");
  const els = [R("A", 0, 0), E("B", 400, 200), L("L", AUTO)]; att.resolveAttachments(els as any);
  const l = els[2], p1 = { x: l.x + l.x1, y: l.y + l.y1 }, p2 = { x: l.x + l.x2, y: l.y + l.y2 }, cA = { x: 50, y: 30 }, cB = { x: 448, y: 248 };
  const cross = (p2.x - p1.x) * (cA.y - p1.y) - (p2.y - p1.y) * (cA.x - p1.x), cross2 = (p2.x - p1.x) * (cB.y - p1.y) - (p2.y - p1.y) * (cB.x - p1.x);
  h.ok(Math.abs(cross) < 1e-6 && Math.abs(cross2) < 1e-6, "both ends auto: the connector is collinear with both centres");
  h.ok(l.rotation === 0 && l.x1 === 0 && l.y1 === 0, "a solved line is written Figure-style (x,y = start, x1=y1=0, rotation 0)");
  const sp = att.sidePoint(R("A", 0, 0), "e", 5); h.ok(near(sp.x, 105) && near(sp.y, 30), "side anchor: east midpoint + gap");
  const lab = T("T", { to: "A", side: "n", gap: 8 }), lst = [R("A", 100, 100), lab]; att.resolveAttachments(lst as any);
  h.ok(near(lab.x, 115) && near(lab.y, 100 - 8 - 24), "label: centred above the driver with gap 8 (x=115, y=68)");
}

h.section("order, cycles, malformed input");
{
  const els: any[] = [L("L2", { start: { to: "T", anchor: "auto" }, end: { to: "B" } }), T("T", { to: "A", side: "e" }), R("A", 0, 0), E("B", 300, 0)];
  const { order, cycles } = att.attachOrder(els); h.ok(order.indexOf("T") < order.indexOf("L2") && cycles.length === 0, "driver-before-dependent order across a chain (label drives a connector)");
  const cyc: any[] = [T("P", { to: "Q", side: "e" }), T("Q", { to: "P", side: "e" })];
  h.ok(att.attachOrder(cyc).cycles.length === 1 && att.attachIssues(cyc).some((i) => i.code === "cycle"), "a 2-cycle is cut once and reported, never thrown");
  const bad: any[] = [R("A", 20, 20), L("L", { start: { to: "A", anchor: "zzz", gap: "x" }, end: { to: 5 } }), T("T", { to: "A", side: "up", gap: NaN }), L("L2", { start: { to: "L2" } })];
  att.resolveAttachments(bad); h.ok(bad.every((e) => Number.isFinite(e.x) && Number.isFinite(e.y)), "garbage attach leaves finite geometry (no NaN reaches JSON)");
  h.ok(att.attachIssues(bad).length >= 4, "attachIssues names every malformed / self end");
  const both = [R("A", 0, 0), { ...L("L", AUTO), attach: { to: "A", side: "n" } }]; h.ok(att.attachIssues(both as any).some((i) => i.code === "wrong-shape"), "a box-attach on a line is refused (wrong shape)");
}

h.section("validators");
{
  const deck: any = createDeck({ id: "v", title: "v", withTitleSlide: false }), s = addSlide(deck, { id: "s", layout: "blank" });
  addElement(deck, s.id, R("A", 0, 0)); addElement(deck, s.id, L("L", undefined));
  const el = deck.slides[0].elements.find((e: any) => e.id === "L");
  h.eq(validateDeckFile(deck), [], "deck without attach validates");
  el.attach = { start: { to: "A", anchor: "auto", gap: 2 } }; h.eq(validateDeckFile(deck), [], "well-formed attach validates");
  el.attach = { start: { to: "A", anchor: "zzz", gap: "x" } }; h.ok(validateDeckFile(deck).length === 2, "garbage anchor + gap are refused with 2 messages");
  el.attach = 5; h.ok(validateDeckFile(deck).length > 0, "non-object attach is refused");
}

h.section("the sampler: spring + arc deck, 60 fps");
const STAGE = { width: 640, height: 360 };
const mkDeck = () => {
  const deck: any = createDeck({ id: "t", title: "t", withTitleSlide: false }); deck.stage = STAGE; deck.defaults.transition = "none";
  const s = addSlide(deck, { id: "s", layout: "blank" });
  addElement(deck, s.id, R("A", 60, 150, 110, 64)); addElement(deck, s.id, E("B", 470, 140));
  const probe: any[] = [R("A", 60, 150, 110, 64), E("B", 470, 140), L("L", AUTO)]; att.resolveAttachments(probe);
  addElement(deck, s.id, { ...probe[2] });
  const lab: any[] = [R("A", 60, 150, 110, 64), T("T", { to: "A", side: "n", gap: 8 })]; att.resolveAttachments(lab); addElement(deck, s.id, { ...lab[1] });
  const b = addBeat(deck, s.id, { id: "b1" });
  setTransform(deck, s.id, b.id, "A", { state: { x: 150, y: 36 }, duration: 900, easing: "smooth", arc: 0.8 });
  setTransform(deck, s.id, b.id, "B", { state: { x: 400, y: 236 }, duration: 900, curve: { kind: "spring", bounce: 0.5 } });
  return { deck, slide: deck.slides[0] };
};
{
  const { deck, slide } = mkDeck(), c = compileSlide(slide, deck.stage);
  const f0 = c.sample(0).elements, stored = slide.elements.find((e: any) => e.id === "L");
  h.ok(["x", "y", "x2", "y2"].every((k) => near((f0.find((e: any) => e.id === "L") as any)[k], stored[k])), "Design state: stored geometry == the solve of the stored drivers (invariant)");
  let worstGap = 0, worstLabel = 0, frames = 0, maxOver = 0;
  for (let ms = 0; ms <= 900; ms += 1000 / 60) {
    const els = c.sample(1, ms).elements, by: any = Object.fromEntries(els.map((e: any) => [e.id, e]));
    const A = by.A, B = by.B, l = by.L, t = by.T;
    const exp = [R("A", 0, 0), E("B", 0, 0), L("L", AUTO)].map((e) => e); Object.assign(exp[0], { x: A.x, y: A.y, width: A.width, height: A.height, rotation: A.rotation }); Object.assign(exp[1], { x: B.x, y: B.y, width: B.width, height: B.height, rotation: B.rotation });
    att.resolveAttachments(exp as any); const e = exp[2] as any;
    worstGap = Math.max(worstGap, Math.hypot(l.x + l.x1 - (e.x + e.x1), l.y + l.y1 - (e.y + e.y1)), Math.hypot(l.x + l.x2 - (e.x + e.x2), l.y + l.y2 - (e.y + e.y2)));
    // the start point is OUTSIDE A's rect and within `gap` (3) of it, on the ray toward B's centre (gap is applied along the ray)
    const px = l.x + l.x1, py = l.y + l.y1, dx = Math.max(A.x - px, 0, px - (A.x + A.width)), dy = Math.max(A.y - py, 0, py - (A.y + A.height)), dist = Math.hypot(dx, dy);
    if (!(dist > 0 && dist <= 3 + 1e-9)) maxOver = Math.max(maxOver, 1);
    worstLabel = Math.max(worstLabel, Math.abs(t.x - (A.x + (A.width - 70) / 2)), Math.abs(t.y - (A.y - 8 - 24))); frames++;
  }
  h.ok(frames >= 54, `sampled ${frames} frames across the 900 ms spring + arc Change`);
  h.ok(worstGap < 1e-9, `every connector endpoint == the solve of that frame's FINAL driver boxes (max ${worstGap.toExponential(1)} px)`);
  h.eq(maxOver, 0, "the connector start stays within `gap` outside driver A's rect on all frames");
  h.ok(worstLabel < 1e-9, `the label rides the driver's final box through arc + overshoot (max ${worstLabel.toExponential(1)} px)`);
  // seek purity
  const t = [0, 137, 300, 301, 643, 900]; const fwd = t.map((ms) => JSON.stringify(c.sample(1, ms).elements)), rev = [...t].reverse().map((ms) => JSON.stringify(c.sample(1, ms).elements)).reverse();
  h.ok(fwd.every((s, i) => s === rev[i]), "seek purity: forward and reverse sampling are byte-equal");
  h.ok(JSON.stringify(c.sample(1, 300).elements) === fwd[2], "seek purity: the same (beat, t) twice is byte-equal");
  // companion workaround baseline (what attach replaces) — recorded, not asserted
  // dangling driver falls back to the stored endpoint
  const d2 = structuredClone(deck); d2.slides[0].elements = d2.slides[0].elements.filter((e: any) => e.id !== "B"); d2.slides[0].beats[0].tracks = d2.slides[0].beats[0].tracks.filter((t: any) => t.target !== "B");
  const c2 = compileSlide(d2.slides[0], d2.stage), l2: any = c2.sample(1, 450).elements.find((e: any) => e.id === "L"), a2: any = c2.sample(1, 450).elements.find((e: any) => e.id === "A");
  h.ok(Number.isFinite(l2.x2) && near(l2.x + l2.x2, stored.x + stored.x2), "deleted driver: the end falls back to its stored point; the other end keeps following");
  h.ok(near(l2.x + l2.x1, att.boundaryToward(a2, { x: stored.x + stored.x2, y: stored.y + stored.y2 }, 3).x), "…and aims at that fixed point");
}

h.section("compile issues");
{
  const { deck, slide } = mkDeck(); const b = slide.beats[0];
  setTransform(deck, slide.id, b.id, "L", { state: { x2: 5 }, duration: 300, easing: "smooth" });
  const c = compileSlide(deck.slides[0], deck.stage);
  h.ok(c.issues.some((i: any) => /follows its attachment/.test(i.reason) && i.target === "L"), "a Change that writes an attached object's geometry is surfaced (and ignored)");
  {
    const hd: any = createDeck({ id: "h", title: "h", withTitleSlide: false }); hd.stage = STAGE; const hs = addSlide(hd, { id: "s", layout: "blank" });
    addElement(hd, hs.id, R("A", 60, 140, 100, 60)); addElement(hd, hs.id, E("D", 400, 120, 100, 100)); addElement(hd, hs.id, R("B", 260, 20, 80, 40));
    const hl: any[] = [R("A", 60, 140, 100, 60), R("B", 260, 20, 80, 40), L("L", { start: { to: "A", anchor: "auto" }, end: { to: "B", anchor: "auto" } })]; att.resolveAttachments(hl); addElement(hd, hs.id, hl[2]);
    becomeTransform(hd, hs.id, addBeat(hd, hs.id, { id: "b1" }).id, "A", "D", { mode: "handoff" });
    h.ok(compileSlide(hd.slides[0], hd.stage).issues.some((i: any) => /hand-off/.test(i.reason) && i.target === "A"), "an object attached to a hand-off Become SOURCE is flagged (it keeps the resting box: documented limit)");
  }
  const bad = structuredClone(deck); bad.slides[0].elements.find((e: any) => e.id === "L").attach.end.to = "ZZ";
  h.ok(compileSlide(bad.slides[0], bad.stage).issues.some((i: any) => /dangling/.test(i.reason)), "a dangling driver is an AnimationIssue, not a throw");
}

h.section("never captured, retype");
{
  const pre: any = T("T", { to: "A", side: "n", gap: 8 }), cur = { ...pre, x: 50, text: "y" };
  h.eq(diffState(pre, cur), { x: 50, text: "y" }, "diffState never emits attach (the capture of a dependent's DISPLAY geometry is skipped upstream)");
  const gone = { ...pre, attach: undefined }; h.ok(!("attach" in (diffState(pre, gone) ?? {})), "…even when attach was removed");
  const re = applyState(pre, { type: "ellipse", fill: "#000", stroke: "#000", strokeWidth: 1 }); h.ok(!!(re as any).attach, "a retyped dependent keeps its attachment (BASE_PROPS)");
}

h.section("identity seams (clone cores, figure ops, scale)");
{
  const els = [R("A", 20, 100), R("B", 300, 100), L("L", AUTO), T("T", { to: "A", side: "n", gap: 8 })];
  const c = cloneContentWithFreshIds(structuredClone(els) as any, undefined), [A, B, Lc, Tc] = c.elements as any[];
  h.ok(Lc.attach.start.to === A.id && Lc.attach.end.to === B.id && Tc.attach.to === A.id, "cloneContentWithFreshIds (slide duplicate / snapshot insert / figure import) remaps attachments");
  h.ok(!(cloneContentWithFreshIds([structuredClone(els[2])] as any, undefined).elements[0] as any).attach, "a connector cloned WITHOUT its drivers becomes free geometry");
  const mk = (): any => ({ version: 2, name: "t", canvases: [{ id: "c1", name: "C" }], figures: [{ id: "f1", name: "F", canvasId: "c1", x: 0, y: 0, width: 640, height: 360, background: "#fff", elements: structuredClone(els) }, { id: "f2", name: "G", canvasId: "c1", x: 700, y: 0, width: 640, height: 360, background: "#fff", elements: [] }], assets: [], palette: [] });
  const p = mk(), ids = figOps.duplicateElements(p, "f1", ["A", "B", "L", "T"], { dx: 0, dy: 120 }); const cp = ids.map((id: string) => p.figures[0].elements.find((e: any) => e.id === id)) as any[];
  h.ok(cp[2].attach.start.to === cp[0].id && cp[2].attach.end.to === cp[1].id && cp[3].attach.to === cp[0].id, "duplicateElements remaps inside the copied set");
  const nid = figOps.duplicateFigure(mk(), "f1"); h.ok(!!nid, "duplicateFigure runs");
  const q = mk(), n2 = figOps.duplicateFigure(q, "f1")!, g = q.figures.find((x: any) => x.id === n2)!, gids = new Set(g.elements.map((e: any) => e.id)), L2: any = g.elements.find((e: any) => e.type === "line");
  h.ok(gids.has(L2.attach.start.to) && !["A", "B"].includes(L2.attach.start.to), "duplicateFigure: connectors point at the NEW figure's boxes");
  const m = mk(); figOps.moveElementsToFigure(m, ["A"], "f2"); const Lm: any = m.figures[0].elements.find((e: any) => e.id === "L");
  h.ok(Lm.attach.start === undefined && Lm.attach.end?.to === "B", "moveElementsToFigure: moving a driver out detaches only that end");
  const m2 = mk(); figOps.moveElementsToFigure(m2, ["A", "B", "L"], "f2"); h.ok(m2.figures[1].elements.find((e: any) => e.id === "L").attach.start.to === "A", "moving driver + connector together keeps the attachment");
  const sc: any = structuredClone(els); sc.forEach((e: any) => att.scaleAttach(e, 0.5)); h.ok(sc[2].attach.start.gap === 1.5 && sc[3].attach.gap === 4, "scaleAttach: gaps are stage px and scale with the content");
}

h.section("the editor hook (store.applyEditorMutation → settleAttachments)");
{
  const fig = { id: "f1", name: "F", canvasId: "c1", x: 0, y: 0, width: 640, height: 360, background: "#fff", elements: [R("A", 20, 100), R("B", 300, 100), L("L", AUTO), T("T", { to: "A", side: "n", gap: 8 })] };
  store.project.set({ version: 2, name: "t", canvases: [{ id: "c1", name: "C" }], figures: [fig], assets: [], palette: [] } as any);
  let worst = 0;
  for (let k = 1; k <= 100; k++) {
    store.mutateFigure("f1", (p) => { const A: any = p.figures[0].elements.find((e) => e.id === "A"); A.x = 20 + k * 2; A.y = 100 + Math.sin(k / 10) * 60; });
    const f = get(store.project)!.figures[0], ex: any[] = structuredClone(f.elements); att.resolveAttachments(ex);
    for (const id of ["L", "T"]) { const a: any = f.elements.find((e) => e.id === id), b = ex.find((e) => e.id === id); for (const key of ["x", "y", "x2", "y2"]) if (a[key] !== undefined) worst = Math.max(worst, Math.abs(a[key] - b[key])); }
  }
  h.eq(worst, 0, "100 drag steps through mutateFigure: dependents equal resolveAttachments after EVERY step");
  const lone = Array.from({ length: 5000 }, (_, i) => R("r" + i, i, 0)); const t0 = performance.now(); for (let i = 0; i < 2000; i++) att.settleAttachments(lone as any);
  const per = (performance.now() - t0) / 2000; h.ok(per < 0.2, `settleAttachments over 5000 unattached elements: ${(per * 1000).toFixed(0)} us/call (< 200 us)`);
}

h.section("slide editor flow (capture adapter never records a dependent's solved geometry)");
{
  const deck: any = createDeck({ id: "e", title: "e", withTitleSlide: false }); deck.stage = { width: 640, height: 360 };
  const s = addSlide(deck, { id: "s", layout: "blank" });
  const els: any[] = [R("A", 40, 100), R("B", 400, 100), L("L", AUTO), T("T", { to: "A", side: "n", gap: 8 })]; att.resolveAttachments(els); for (const e of els) addElement(deck, s.id, e);
  const b = addBeat(deck, s.id, { id: "b1" }); setTransform(deck, s.id, b.id, "B", { state: { x: 420, y: 160 }, duration: 600, easing: "smooth" });
  ss.loadDeckModel(deck); ss.selectSlide("s"); ss.setEditDestination({ kind: "after", beatId: "b1" }); ss.refreshBeatDisplay();
  const unreg = ss.registerSlideEditAdapter();
  for (let k = 1; k <= 20; k++) store.mutateFigure("s", (p) => { const A: any = p.figures.find((f) => f.id === "s")!.elements.find((e) => e.id === "A"); A.x = 40 + k * 4; A.y = 100 - k * 2; });
  const tracks = get(ss.deckOverlay)!.slides[0].beats[1].tracks.map((t: any) => t.target).sort();
  h.eq(tracks, ["A", "B"], "dragging driver A at step 1 writes a Change for A only (no junk x1..y2 / x,y tracks for L or T)");
  const fig = get(store.project).figures.find((f) => f.id === "s")!, ex: any[] = structuredClone(fig.elements); att.resolveAttachments(ex);
  const Ld: any = fig.elements.find((e) => e.id === "L"), Le = ex.find((e) => e.id === "L");
  h.ok(["x", "y", "x2", "y2"].every((k) => near(Ld[k], Le[k])), "…and the displayed connector followed the drag live (== resolveAttachments)");
  h.eq(att.userDiff({ x: 1, text: "a" }, T("T", { to: "A", side: "n" })), { text: "a" }, "userDiff strips x/y/width/height/rotation/x1..y2 for dependents");
  h.eq(att.userDiff({ x: 1 }, T("T", { to: "A", side: "n" })), null, "…and returns null when nothing else changed");
  h.eq(att.userDiff({ x: 1 }, R("A", 0, 0)), { x: 1 }, "…and is the identity for ordinary elements");
  unreg();
}

h.section("editor snap target");
{
  const els: any[] = [R("card", 0, 0, 300, 200), R("chip", 100, 80, 60, 30), { ...L("ln", undefined), attach: undefined }, R("far", 500, 0)];
  h.eq(att.attachTargetAt(els, { x: 130, y: 95 }), "chip", "release over a chip inside a card -> the smaller shape wins");
  h.eq(att.attachTargetAt(els, { x: 20, y: 20 }), "card", "release over the card body -> the card");
  h.eq(att.attachTargetAt(els, { x: 305, y: 100 }), "card", "within the 6 px tolerance of an edge counts");
  h.eq(att.attachTargetAt(els, { x: 400, y: 300 }), null, "empty space leaves the end free");
  h.eq(att.attachTargetAt(els, { x: 130, y: 95 }, { exclude: "chip" }), "card", "the dragged element itself is excluded");
}


h.section("authoring: one check, one op, the verbs' grammar");
{
  const deck: any = createDeck({ id: "o", title: "o", withTitleSlide: false }), s = addSlide(deck, { id: "s", layout: "blank" });
  for (const e of [R("A", 20, 100), E("B", 400, 100), L("L", undefined), T("T", undefined)]) addElement(deck, s.id, e);
  const els = () => deck.slides[0].elements as any[];
  h.ok(slideOps.setAttach(deck, "s", "L", { start: { to: "A" }, end: { to: "B", gap: 4 } }).ok, "setAttach: a connector between two shapes");
  const l = els().find((e) => e.id === "L"), probe = structuredClone(els()); att.resolveAttachments(probe);
  h.ok(["x", "y", "x2", "y2"].every((k) => near(l[k], probe.find((e: any) => e.id === "L")[k])), "...and the stored geometry IS the Design solve at once");
  const refusals = [
    slideOps.setAttach(deck, "s", "L", { start: { to: "ZZ" } }), slideOps.setAttach(deck, "s", "L", { start: { to: "L" } }),
    slideOps.setAttach(deck, "s", "L", { to: "A", side: "n" } as any), slideOps.setAttach(deck, "s", "T", { start: { to: "A" } } as any),
    slideOps.setAttach(deck, "s", "T", { to: "A", side: "up" } as any), slideOps.setAttach(deck, "s", "L", {} as any),
  ];
  h.ok(refusals.every((r) => !r.ok && !!r.reason), `missing driver, self, wrong shape (both ways), a bad side, an empty attachment: each refused with a reason (${refusals.map((r) => r.reason).join(" | ")})`);
  h.ok(JSON.stringify(els().find((e) => e.id === "L").attach) === JSON.stringify({ start: { to: "A" }, end: { to: "B", gap: 4 } }), "...and a refused call leaves the element as it was");
  h.ok(slideOps.setAttach(deck, "s", "T", { to: "L", side: "n" }).ok && !slideOps.setAttach(deck, "s", "L", { start: { to: "T" }, end: { to: "B" } }).ok, "a cycle (a label on the connector, the connector on the label) is refused");
  h.ok(slideOps.setAttach(deck, "s", "T", null).ok && !els().find((e) => e.id === "T").attach, "null detaches");
  h.eq([att.parseAttachEnd("box"), att.parseAttachEnd("box:e:4"), att.parseAttachEnd("box:0.25,1:2"), att.parseAttachEnd("box:north"), att.parseAttachEnd("box:auto:x"), att.parseAttachEnd("")],
    [{ to: "box" }, { to: "box", anchor: "e", gap: 4 }, { to: "box", anchor: { fx: 0.25, fy: 1 }, gap: 2 }, null, null, null], "an end on the command line: <id>[:anchor[:gap]]");
  const err = (f: () => unknown) => { try { f(); return ""; } catch (e) { return (e as Error).message; } };
  h.eq(att.attachFromArgs({ type: "line" }, { start: "A", end: "B:w:2" }), { start: { to: "A" }, end: { to: "B", anchor: "w", gap: 2 } }, "a line's verb arguments become its ends");
  h.eq(att.attachFromArgs({ type: "text" }, { to: "A", side: "s", gap: 6, align: "start" }), { to: "A", side: "s", gap: 6, align: "start" }, "anything else's become its place beside an element");
  h.ok([err(() => att.attachFromArgs({ type: "line" }, { to: "A", side: "n" })), err(() => att.attachFromArgs({ type: "text" }, { start: "A" })), err(() => att.attachFromArgs({ type: "line" }, {})), err(() => att.attachFromArgs({ type: "line" }, { start: "A:north" }))].every(Boolean), "the wrong arguments for the element are usage errors");
  h.eq(att.attachFromArgs({ type: "line" }, { detach: true }), null, "--detach");
}

h.section("the hand-move rule (store: an attached element moved by hand frees itself)");
{
  const fig = { id: "f1", name: "F", canvasId: "c1", x: 0, y: 0, width: 640, height: 360, background: "#fff", elements: [R("A", 20, 100), R("B", 300, 100), L("L", structuredClone(AUTO)), T("T", { to: "A", side: "n", gap: 8 })] };
  att.resolveAttachments(fig.elements as any);
  store.project.set({ version: 2, name: "t", canvases: [{ id: "c1", name: "C" }], figures: [fig], assets: [], palette: [] } as any);
  const el = (id: string): any => get(store.project).figures[0].elements.find((e) => e.id === id);
  const x0 = el("T").x;
  store.mutateFigure("f1", (p) => { const t: any = p.figures[0].elements.find((e) => e.id === "T"); t.x += 30; });
  h.ok(!el("T").attach && near(el("T").x, x0 + 30), "a label moved by hand (its box stayed) is freed and keeps the new place");
  store.mutateFigure("f1", (p) => { for (const e of p.figures[0].elements) if (e.id === "A" || e.id === "L") { e.x += 25; e.y += 10; } });
  h.ok(!!el("L").attach?.start && !el("L").attach?.end, "a connector moved WITH its start shape keeps that end and frees the other (its shape stayed)");
  const before = JSON.stringify(el("L"));
  store.mutateFigure("f1", (p) => { const b: any = p.figures[0].elements.find((e) => e.id === "B"); b.x += 40; });
  h.eq(JSON.stringify(el("L")), before, "moving a shape the connector is no longer attached to changes nothing");
  store.mutateFigure("f1", (p) => { const a: any = p.figures[0].elements.find((e) => e.id === "A"); a.y += 50; });
  const ex: any[] = structuredClone(get(store.project).figures[0].elements); att.resolveAttachments(ex);
  h.ok(!!el("L").attach?.start && near(el("L").y, ex.find((e) => e.id === "L").y), "...while its attached end keeps following its shape");
  store.mutateFigure("f1", (p) => { const l: any = p.figures[0].elements.find((e) => e.id === "L"); l.attach = { start: { to: "A" }, end: { to: "B" } }; l.x2 += 99; });
  h.ok(el("L").attach?.end?.to === "B", "an edit that sets the attachment itself is left to it (a line end released on a shape)");
  h.eq(att.detachHandMoved([R("A", 0, 0)] as any, null), undefined, "nothing attached: no snapshot, nothing to do");
}

h.section("the write points keep stored == solved, and the format says what the file holds");
{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-attach-"));
  try {
    await scaffold(root, { title: "attach" });
    const deck: any = createDeck({ id: "w", title: "w", withTitleSlide: false }), s = addSlide(deck, { id: "s", layout: "blank" });
    for (const e of [R("A", 20, 100), E("B", 400, 100), L("L", undefined)]) addElement(deck, s.id, e);
    await saveDeck(root, deck);
    const file = path.join(root, "slides", "w", "deck.json"), read = async () => JSON.parse(await fs.readFile(file, "utf8"));
    h.eq((await read()).schemaVersion, "0.6.0", "a deck without attachments is written as 0.6.0");
    await slideAttachVerb(root, "w", "s", "L", { start: "A", end: "B:auto:4" });
    const on = await read(), L1 = on.slides[0].elements.find((e: any) => e.id === "L");
    h.ok(on.schemaVersion === "0.7.0" && L1.attach?.end?.gap === 4, "slide-attach writes the attachment and the deck becomes 0.7.0 (an older build would leave the connector behind)");
    const d2 = await loadDeck(root, "w"); d2.slides[0].elements.find((e: any) => e.id === "A")!.x = 200;  // a raw edit that never solved
    await saveDeck(root, d2);
    const solved = (await read()).slides[0].elements, probe = structuredClone(solved); att.resolveAttachments(probe as any);
    h.ok(["x", "y", "x2", "y2"].every((k) => near(solved.find((e: any) => e.id === "L")[k], (probe.find((e: any) => e.id === "L") as any)[k])), "the deck write point re-solves: what is on disk is the Design solve, whoever moved the shape");
    await slideAttachVerb(root, "w", "s", "L", { detach: true });
    h.eq((await read()).schemaVersion, "0.6.0", "detaching the last attachment lowers the deck to 0.6.0 again");
    let refused = ""; try { await slideAttachVerb(root, "w", "s", "L", { start: "nope" }); } catch (e) { refused = (e as Error).message; }
    h.ok(/nothing to attach to/.test(refused), "slide-attach refuses a missing driver with its reason");
    // the Figure twin and the canvas stamp
    await mutateFigModel(root, "seed", ({ project }) => { const f = project.figures[0]; f.elements.push(R("FA", 20, 20), E("FB", 300, 60), L("FL", undefined)); });
    const figId = (await loadFigModel(root)).project.figures[0].id;
    await figureAttachVerb(root, figId, "FL", { start: "FA", end: "FB" });
    const canvasFile = path.join(root, "fig", "canvases", `${(await loadFigModel(root)).project.figures[0].canvasId}.json`);
    const canvas = JSON.parse(await fs.readFile(canvasFile, "utf8")), FL = canvas.figures[0].elements.find((e: any) => e.id === "FL");
    h.ok(canvas.schemaVersion === "0.3.0" && FL.attach?.end?.to === "FB", "figure-attach writes it; the canvas becomes 0.3.0");
    await figureAttachVerb(root, figId, "FL", { detach: true });
    h.eq(JSON.parse(await fs.readFile(canvasFile, "utf8")).schemaVersion, "0.1.0", "...and back to the legacy stamp when nothing is attached");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
  const model: any = { version: 2, name: "m", canvases: [{ id: "c1", name: "C" }], figures: [{ id: "f1", name: "F", canvasId: "c1", x: 0, y: 0, width: 640, height: 360, background: "#fff", elements: [R("A", 20, 100), R("B", 300, 100), L("L", structuredClone(AUTO))] }], assets: [], palette: [] };
  const raw = JSON.stringify(model.figures[0].elements);
  planFigSave(model, null);
  h.eq(JSON.stringify(model.figures[0].elements), raw, "planFigSave solves on copies: the model it is handed is not mutated");
}

await h.done();
