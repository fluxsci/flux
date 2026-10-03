// Hand-offs through the actual portable HTML player, plus its static host.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createDeck, addSlide, addElement, addBeat, setTransform } from "../src/lib/slide/ops";
import { compileSlide } from "../src/lib/slide/compile";
import { exportDeckHtml } from "../src/lib/slide/export/exportDeck";
import type { Track, TargetRef, BecomeSpec, Slide } from "../src/lib/slide/types";
import type { SemanticPlotElement } from "../src/lib/types";
import { harness } from "./lib/harness.mjs";
import { launch } from "./lib/driver.mjs";

const h = harness("verify-slide-handoff-browser");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-handoff-"));
let browser: Awaited<ReturnType<typeof launch>>["browser"] | undefined;
const near = (a: number, b: number, eps = 1) => Math.abs(a - b) <= eps;
try {
  const plots: Record<string, any> = {};
  for (const [id, name] of [["box", "mpl_boxplot"], ["scatter", "mpl_scatter"], ["sine", "mpl_sine_waves"]]) plots[id] = {
    svg: await fs.readFile(new URL(`./fixtures/plots/${name}_FLUXPLOT.svg`, import.meta.url), "utf8"),
    manifest: JSON.parse(await fs.readFile(new URL(`./fixtures/plots/${name}_FLUXPLOT.fluxplot.json`, import.meta.url), "utf8")),
  };
  // A deterministic large marker fixture exercises the production threshold
  // (64), rather than changing planner policy through a test-only code path.
  const points = Array.from({ length: 100 }, (_, i) => ({ index: i, svgId: `samples.point.${i}`, x: i / 20, y: 20 + 12 * Math.sin(i) }));
  plots.large = {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><g id="samples.points" fill="#4169e1">${points.map(p => `<g id="${p.svgId}" data-flux-glyph="1" transform="translate(${p.x * 36} ${p.y})"><circle r="2" opacity=".8"/></g>`).join("")}</g></svg>`,
    manifest: { spec: "fluxplot", schemaVersion: "0.2.0", size: { width: 200, height: 100, unit: "px" }, axes: [{ x: { scale: "linear", domain: [0, 5], anchors: [{ data: 0, svg: 0 }, { data: 5, svg: 180 }] }, y: { scale: "linear", domain: [0, 100], anchors: [{ data: 0, svg: 0 }, { data: 100, svg: 100 }] } }], series: [{ id: "samples", roles: ["point"], svg: { points: "samples.points" }, points }] },
  };
  const deck = createDeck({ withTitleSlide: false }); deck.stage = { width: 960, height: 540 }; deck.defaults.transition = "none";
  const plot = (id: string, assetId: string, x = 480, extra: Partial<SemanticPlotElement> = {}): SemanticPlotElement => ({ id, type: "plot", assetId, x, y: 100, width: 360, height: 216, rotation: 0, ...extra });
  const pathEl = (id: string) => ({ id, type: "path" as const, x: 40, y: 60, width: 180, height: 120, rotation: 0, d: "M0 120 L90 0 L180 120", closed: false, fill: "none", stroke: "#4169e1", strokeWidth: 4, nodes: [{ x: 0, y: 120, type: "corner" as const }, { x: 90, y: 0, type: "corner" as const }, { x: 180, y: 120, type: "corner" as const }] });
  const add = (name: string) => addSlide(deck, { id: name, layout: "blank" });
  function handoff(slide: Slide, source: string, ref: TargetRef, spec: Partial<BecomeSpec> = {}, parts?: string[]) {
    const beat = addBeat(deck, slide.id, { id: `${slide.id}-flight-${slide.beats.length}` })!;
    setTransform(deck, slide.id, beat.id, source, { state: {}, duration: 1000, easing: "linear", ...(parts ? { ref: { element: source, parts } } : {}) });
    const track = beat.tracks.find(t => t.target === source)!;
    track.to!.become = { mode: "handoff", ref, ...spec };
    return track;
  }
  const spines = ["axis.x.spine", "axis.y.spine"];
  const a = add("axes"); addElement(deck, a.id, pathEl("source")); addElement(deck, a.id, plot("dest", "box"));
  handoff(a, "source", { element: "dest", parts: spines });
  a.beats[1].tracks.push({ id: "camera", target: "@camera", preset: "camera", duration: 1000, easing: "linear", to: { x: 460, y: 250, zoom: 1.15 } });
  const b = add("points"); addElement(deck, b.id, plot("source", "scatter", 30)); addElement(deck, b.id, plot("dest", "sine", 520, { height: 108 }));
  handoff(b, "source", { element: "dest", parts: ["2hz.line"] }, { pair: "data", reveal: "draw" }, Array.from({ length: 40 }, (_, i) => `samples.point.${i}`));
  const c = add("text"); addElement(deck, c.id, { id: "source", type: "text", x: 30, y: 40, width: 180, height: 30, rotation: 0, text: "Result", fontFamily: "Arial", fontSize: 24, fontWeight: 400, fontStyle: "normal", align: "left", color: "#4169e1", sizing: "fixed" }); addElement(deck, c.id, plot("dest", "box"));
  handoff(c, "source", { element: "dest", parts: ["axis.x.ticklabel.0"] });
  // The fixture's exact tick-label spelling is source data, not a convention.
  const tick = plots.box.svg.match(/id="(axis\.x\.(?:ticklabel|tick-label)\.[^"]+)"/)?.[1];
  if (tick) c.beats[1].tracks[0].to!.become!.ref.parts = [tick];
  const d = add("glyphs"); addElement(deck, d.id, plot("source", "large", 30, { width: 200, height: 100 })); addElement(deck, d.id, plot("dest", "sine", 520, { height: 108 }));
  handoff(d, "source", { element: "dest", parts: ["2hz.line"] }, { pair: "data" }, ["samples.points"]);
  const e = add("whole"); addElement(deck, e.id, pathEl("source")); addElement(deck, e.id, plot("dest", "box")); handoff(e, "source", { element: "dest" });
  const f = add("colour"); addElement(deck, f.id, plot("source", "sine", 30, { height: 108, overrides: { "2hz.line": { stroke: "#4169e1" } } })); addElement(deck, f.id, plot("dest", "sine", 520, { height: 108, overrides: { "2hz.line": { stroke: "#e13958" } } }));
  handoff(f, "source", { element: "dest", parts: ["2hz.line"] }, {}, ["2hz.line"]);

  const arrow = add("arrow-ring"); addElement(deck, arrow.id, { ...pathEl("source"), arrowStart: true, arrowEnd: true });
  addElement(deck, arrow.id, { id: "dest", type: "ellipse", x: 600, y: 200, width: 120, height: 80, rotation: 0, fill: "#e13958", stroke: "#e13958", strokeWidth: 4 });
  handoff(arrow, "source", { element: "dest" });
  const chain = add("chain"); addElement(deck, chain.id, pathEl("source")); addElement(deck, chain.id, { ...pathEl("dest"), x: 500 });
  handoff(chain, "source", { element: "dest" }); handoff(chain, "dest", { element: "source" });
  const cropped = add("crop"); addElement(deck, cropped.id, pathEl("source"));
  addElement(deck, cropped.id, plot("dest", "sine", 520, { height: 108, crop: { x: 20, y: 10, width: 160, height: 60 }, view: { x: { domain: [2,4] } } }));
  handoff(cropped, "source", { element: "dest", parts: ["2hz.line"] });

  const refused = add("refused-overlap");
  addElement(deck, refused.id, pathEl("source")); addElement(deck, refused.id, plot("dest", "box"));
  addElement(deck, refused.id, { ...pathEl("refused-source"), y: 300 });
  const accepted = handoff(refused, "source", { element: "dest", parts: spines });
  // An identical destination ref now MERGES (Oct-2); a partial overlap — one of
  // the two landed spines — is still refused.
  const refusedTrack = { ...structuredClone(accepted), id: "refused-flight", target: "refused-source", start: 1500 };
  refusedTrack.to!.become!.ref = { element: "dest", parts: ["axis.x.spine"] };
  refused.beats[1].tracks.push(refusedTrack);
  const refusedPlan = compileSlide(refused, deck.stage, { plotManifest: id => plots[id]?.manifest });
  h.ok(refusedPlan.issues.some(issue => issue.trackId === "refused-flight" && /already lands/.test(issue.reason)) && refusedPlan.handoffs.length === 1, "the compiler excludes a second overlapping landing even with a later start");
  const playerSource = await fs.readFile(new URL("../src/lib/slide/player/player.ts", import.meta.url), "utf8");
  h.ok(!/function handoffsFor\b|interface HandoffRecord\b/.test(playerSource) && /type HandoffRecord = CompiledSlide\["handoffs"\]\[number\]/.test(playerSource), "the player consumes the compiler's hand-off record type without a second detection path");

  // Oct-2 destination SETS: the owner's Deck 3 slide 2 (rect → three loose
  // ellipses), and a set mixing parts of TWO plots with a loose ellipse.
  const dot = (id: string, y: number) => ({ id, type: "ellipse" as const, x: 458, y, width: 21, height: 21, rotation: 0, fill: "#d95f02", stroke: "none", strokeWidth: 0 });
  const setSlide = add("set-ellipses");
  addElement(deck, setSlide.id, { id: "source", type: "rect", x: 161, y: 111, width: 135, height: 45, rotation: 0, fill: "#d95f02", stroke: "none", strokeWidth: 0, cornerRadius: 0 });
  for (const [id, y] of [["e1", 71], ["e2", 124], ["e3", 176]] as const) addElement(deck, setSlide.id, dot(id, y));
  handoff(setSlide, "source", { element: "e1", members: [{ element: "e1" }, { element: "e2" }, { element: "e3" }] });
  // A later Change on ONE member must bind to that member's own content.
  const after = addBeat(deck, setSlide.id, { id: "set-after" })!;
  setTransform(deck, setSlide.id, after.id, "e2", { state: { x: 560, fill: "#4169e1" }, duration: 400, easing: "linear" });
  const mixedSlide = add("set-mixed");
  addElement(deck, mixedSlide.id, pathEl("source"));
  addElement(deck, mixedSlide.id, plot("dest", "box", 300, { width: 300, height: 180 }));
  addElement(deck, mixedSlide.id, plot("dest2", "sine", 620, { y: 300, width: 300, height: 90 }));
  addElement(deck, mixedSlide.id, dot("e1", 420));
  handoff(mixedSlide, "source", { element: "dest", members: [{ element: "dest", parts: ["peaches.box"] }, { element: "dest2", parts: ["2hz.line"] }, { element: "e1" }] });
  // MERGE: three ellipses → one rect, staggered starts 0 / 150 / 300 ms.
  const mergeSlide = add("merge");
  addElement(deck, mergeSlide.id, { id: "dest", type: "rect", x: 161, y: 111, width: 135, height: 45, rotation: 0, fill: "#d95f02", stroke: "none", strokeWidth: 0, cornerRadius: 0 });
  for (const [id, y] of [["e1", 71], ["e2", 124], ["e3", 176]] as const) addElement(deck, mergeSlide.id, dot(id, y));
  const mergeBeat = addBeat(deck, mergeSlide.id, { id: "merge-flight" })!;
  ["e1", "e2", "e3"].forEach((id, i) => mergeBeat.tracks.push({ id: `m-${id}`, target: id, preset: "transform", start: 150 * i, duration: 600, easing: "linear", to: { become: { mode: "handoff", ref: { element: "dest" } }, state: {} } }));
  const mergePlan = compileSlide(mergeSlide, deck.stage);
  h.ok(mergePlan.handoffs.length === 3 && mergePlan.handoffs.every(x => x.merge?.landAt === 900 && x.merge.trackIds.length === 3) && !mergePlan.issues.length, "three hand-offs into one rect compile as one merge landing at 900 ms");
  const setPlan = compileSlide(mixedSlide, deck.stage, { plotManifest: id => plots[id]?.manifest });
  h.ok(setPlan.handoffs.length === 1 && setPlan.handoffs[0].destination.map(d => `${d.elementId}:${d.partIds?.join(",") ?? "*"}`).join(" ") === "dest:peaches.box dest2:2hz.line e1:*" && !setPlan.issues.length, "the compiler resolves each set member against its own plot's manifest");

  // In-memory curves until M3 enables their persisted schema.
  const springPaths = structuredClone(b), springGlyphs = structuredClone(d);
  springPaths.id = "spring-pairs"; springGlyphs.id = "spring-glyphs";
  for (const slide of [springPaths, springGlyphs]) slide.beats[1].tracks[0].curve = { kind: "spring", bounce: .8 };
  deck.slides.push(springPaths, springGlyphs);
  const file = path.join(tmp, "handoff.html"); await fs.writeFile(file, (await exportDeckHtml({ deck, plots })).html);
  const launched = await launch(); browser = launched.browser; const page = launched.page;
  const errors: string[] = []; page.on("pageerror", (err: Error) => errors.push(String(err))); page.on("console", msg => { if (msg.type() === "error") errors.push(msg.text()); });
  await page.goto(pathToFileURL(file).href); await page.waitForFunction("!!window.fluxDeck?.seek");
  const seek = async (slide: number, time: number, beat = 1) => page.evaluate(({ slide, time, beat }) => (window as any).fluxDeck.seek(slide, beat, time), { slide, time, beat });
  const inspect = async () => page.evaluate(() => {
    const flight = document.querySelector(".sl-flight") as SVGSVGElement;
    const paths = Array.from(flight.querySelectorAll<SVGPathElement>(".sl-handoff-path"));
    return { count: paths.filter(el => getComputedStyle(el).visibility !== "hidden" && Number(getComputedStyle(el).opacity) > 0).length, boxes: paths.map(node => { const b = node.getBBox(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }),
      finite: paths.every(p => !/NaN|Infinity/.test(p.getAttribute("d") ?? "")),
      source: getComputedStyle(document.querySelector('[data-el-id="source"]')!).visibility,
      destination: getComputedStyle(document.querySelector('[data-el-id="dest"]')!).visibility,
      sourceParts: Array.from(document.querySelectorAll('[id^="source__samples.point."]')).slice(0, 40).map(n => getComputedStyle(n).visibility),
      spines: ["axis.x.spine", "axis.y.spine"].map(id => document.querySelector(`[id="dest__${id}"]`)).filter(Boolean).map(n => getComputedStyle(n!).visibility),
      curve: document.querySelector('[id="dest__2hz.line"]') ? getComputedStyle(document.querySelector('[id="dest__2hz.line"]')!).visibility : null,
      glyphs: Array.from(flight.querySelectorAll<SVGGElement>(".sl-handoff-glyph")).map(g => { const m = g.transform.baseVal.consolidate()?.matrix; return { x: m?.e, y: m?.f, opacity: Number(g.getAttribute("opacity")) }; }),
      driver: flight.querySelector(".sl-handoff")?.getAttribute("data-driver"),
      last: flight.parentElement?.lastElementChild === flight,
      visibleFlight: Array.from(flight.querySelectorAll("path,circle,text,image")).filter(el => getComputedStyle(el).visibility !== "hidden" && Number(getComputedStyle(el).opacity) > 0).length,
      camera: (flight.parentElement as HTMLElement).style.transform,
    };
  });
  await seek(0, 0); let state = await inspect();
  h.ok(state.spines.every(v => v === "hidden") && state.visibleFlight === 0, "at zero the destination spines and every flight child are hidden");
  h.eq(state.source, "visible", "at zero the source stays visible");
  await seek(0, 500); state = await inspect();
  h.eq(state.count, 1, "mid-flight there is exactly one merged L-chain path");
  h.ok(state.boxes[0]?.x > 40 && state.boxes[0]?.x < 600 && state.boxes[0]?.y >= 50 && state.finite, "L-chain bbox lies between the source and destination in stage coordinates");
  h.ok(state.source === "hidden" && state.spines.every(v => v === "hidden"), "mid-flight hides BOTH live source and destination");
  h.ok(state.last && state.camera.includes("scale("), "the flight is the camera's last child during a camera beat");
  await seek(0, 1000); state = await inspect();
  h.ok(state.visibleFlight === 0 && state.source === "hidden" && state.spines.every(v => v === "visible"), "landing hides the flight and source, revealing the original spines");
  await seek(0, 0); state = await inspect(); h.ok(state.source === "visible" && state.spines.every(v => v === "hidden") && state.visibleFlight === 0, "reverse seek restores the source and hides the destination again");

  await seek(1, 500); state = await inspect();
  h.eq(state.count, 40, "40 source points produce exactly 40 paths");
  h.ok(state.sourceParts.every(v => v === "hidden") && state.curve === "hidden", "the original points and curve are hidden during the data flight");
  await seek(1, 999); state = await inspect();
  const bounds = { x: Math.min(...state.boxes.map(b => b.x)), y: Math.min(...state.boxes.map(b => b.y)), right: Math.max(...state.boxes.map(b => b.x + b.w)), bottom: Math.max(...state.boxes.map(b => b.y + b.h)) };
  const curveBox = await page.evaluate(() => { const p = document.querySelector('[id="dest__2hz.line"] path') as SVGGraphicsElement, flight = document.querySelector(".sl-flight") as SVGSVGElement, b = p.getBBox(), m = flight.getScreenCTM()!.inverse().multiply(p.getScreenCTM()!); return { x: m.a*b.x+m.e, y:m.d*b.y+m.f, right:m.a*(b.x+b.width)+m.e, bottom:m.d*(b.y+b.height)+m.f }; });
  h.ok(Object.keys(bounds).every(k => near(bounds[k as keyof typeof bounds], curveBox[k as keyof typeof curveBox], 1)), `at .999 the tiled pieces cover the curve within 1px: ${JSON.stringify({ bounds, curveBox })}`);
  await seek(1, 1000);
  const dash0 = await page.$eval('[id="dest__2hz.line"] path', el => Number((el as SVGElement).style.strokeDashoffset));
  await seek(1, 1100);
  const dash1 = await page.$eval('[id="dest__2hz.line"] path', el => Number((el as SVGElement).style.strokeDashoffset));
  h.ok(dash0 > dash1 && dash1 > 0, `reveal draw advances the destination's dash after the flight (${dash0} → ${dash1})`);
  await seek(1, 2000); h.eq(await page.$eval('[id="dest__2hz.line"] path', el => (el as SVGElement).style.strokeDashoffset), "", "draw completion removes temporary dash styling");

  await seek(2, 500);
  const text = await page.evaluate(() => { const f = document.querySelector(".sl-flight")!; return { texts: f.querySelectorAll("text").length, paths: f.querySelectorAll(".sl-handoff-path").length, boxes: Array.from(f.querySelectorAll(".sl-handoff > g")).map(g => { const b=(g as SVGGraphicsElement).getBBox(); return [b.width,b.height]; }) }; });
  h.ok(text.texts >= 2 && text.paths === 0 && text.boxes.every(b => b[0] > 0 && b[1] > 0), `text uses two measured, non-zero crossfade clones (${JSON.stringify(text)})`);
  // A text element ↔ a plot's text part has no drawn side, so it stays a box
  // crossfade — but its clones scale uniformly: glyphs never stretch (oct2 W3).
  const scales = await page.evaluate(() => Array.from(document.querySelectorAll(".sl-flight .sl-handoff > g")).map(g => { const m = (g as SVGGraphicsElement).transform.baseVal.consolidate()?.matrix; return m ? [m.a, m.d] : [1, 1]; }));
  h.ok(scales.length >= 2 && scales.every(([sx, sy]) => Math.abs(sx - sy) < 1e-6), `text crossfade clones scale uniformly (${JSON.stringify(scales)})`);
  await seek(3, 250); const early = await inspect(); await seek(3, 750); const late = await inspect();
  h.ok(early.driver === "glyph" && early.glyphs.length === 100 && early.count === 0, "100 actual marker groups use the glyph driver with no pair paths");
  h.ok(late.glyphs.every((g, i) => g.x! > early.glyphs[i].x! && g.opacity === 1), "every marker moves toward its landing and stays opaque before raw .85");
  h.ok(await page.$eval(".sl-handoff-glyph circle", el => getComputedStyle(el).opacity === "0.8") && late.glyphs.every(g => g.opacity === 1), "cloning preserves marker alpha exactly once");

  await seek(3, 925); h.ok((await inspect()).glyphs.every(g => near(g.opacity, .5, .0001)), "glyph opacity fades only during the final 15 percent");
  await seek(3, 1000); state = await inspect(); h.ok(state.visibleFlight === 0 && state.curve === "visible", "glyph landing reveals the curve and hides every clone");
  const { resolveCurve } = await import("../src/lib/slide/curves");
  const spring = resolveCurve(springPaths.beats[1].tracks[0]);
  const samples = Array.from({ length: 60 }, (_, i) => ({ raw: i / 59, t: spring.clamped(i / 59) }));
  const springFlights = await page.evaluate(({ samples, first }) => {
    const rows: { raw: number; glyph: boolean; error: number; hidden: boolean; opacity: boolean }[] = [];
    for (const glyph of [false, true]) for (const { raw, t } of samples) {
      (window as any).fluxDeck.seek(first + Number(glyph), 1, raw * 1000);
      const flight = document.querySelector(".sl-handoff")!;
      const nodes = Array.from(flight.querySelectorAll(glyph ? ".sl-handoff-glyph" : ".sl-handoff-path"));
      const geometry = nodes.map(n => (n.getAttribute(glyph ? "transform" : "d") ?? "").match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi)?.map(Number) ?? []);
      const hidden = getComputedStyle(document.querySelector('[id="dest__2hz.line"]')!).visibility === (raw < 1 ? "hidden" : "visible") && flight.getAttribute("visibility") === (raw > 0 && raw < 1 ? "visible" : "hidden");
      const opacity = !glyph || raw <= 0 || raw >= 1 || nodes.every(n => Math.abs(Number(n.getAttribute("opacity")) - (raw < .85 ? 1 : (1 - raw) / .15)) < 1e-9);
      let error = 0;
      if (raw > 0 && raw < 1) {
        (window as any).fluxDeck.seek(glyph ? 3 : 1, 1, Math.max(1e-9, Math.min(1 - 1e-9, t)) * 1000);
        const oracle = Array.from(document.querySelectorAll(glyph ? ".sl-handoff-glyph" : ".sl-handoff-path"));
        if (oracle.length !== geometry.length) error = Infinity;
        oracle.forEach((n, i) => {
          const values = (n.getAttribute(glyph ? "transform" : "d") ?? "").match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi)?.map(Number) ?? [];
          if (values.length !== geometry[i]?.length) error = Infinity;
          values.forEach((v, j) => { error = Math.max(error, Math.abs(v - (geometry[i]?.[j] ?? Infinity))); });
        });
      }
      rows.push({ raw, glyph, error, hidden, opacity });
    }
    return rows;
  }, { samples, first: deck.slides.length - 2 });
  h.ok(springFlights.filter(f => !f.glyph).every(f => f.error < .00001), "60 spring(.8) real-player pairing samples match only clamped correspondence progress");
  h.ok(springFlights.filter(f => f.glyph).every(f => f.error < .00001 && f.opacity), "60 spring(.8) glyph landings stay clamped and fade only over the final raw 15 percent");
  h.ok(springFlights.every(f => f.hidden), "spring hand-off reveals only at raw=1, never at an earlier eased crossing");
  await seek(4, 500); const wholeMid = await inspect(); await seek(4, 900); const wholeLate = await inspect();
  h.ok(wholeMid.count === 1 && wholeMid.destination === "hidden" && wholeLate.count > 1, "whole plot pairs only the spine chain; other parts fade late as leftovers");
  for (const t of [1, 100, 250, 500, 750, 999]) {
    await seek(5, t);
    const stroke = await page.$eval(".sl-handoff-path", p => ({ raw: p.getAttribute("stroke") ?? "", computed: getComputedStyle(p).stroke, valid: CSS.supports("color", p.getAttribute("stroke") ?? "") }));
    h.ok(stroke.valid && /^rgba?\(/.test(stroke.computed) && !/NaN|Infinity/.test(stroke.raw), `differing plot colours stay valid RGB at ${t}ms (${stroke.raw} → ${stroke.computed})`);
  }
  await seek(6, 200);
  h.ok(await page.$$eval(".sl-handoff polygon", heads => heads.length === 2 && heads.every(p => p.getAttribute("points") && Number(p.getAttribute("opacity")) > 0)), "both authored arrowheads survive an open-to-closed flight");
  await seek(6, 500);
  h.ok(await page.$$eval(".sl-handoff polygon", heads => heads.every(p => Number(p.getAttribute("opacity")) === 0)), "open-to-closed arrowheads fade without leaving stroke gaps");
  await seek(7, 0); state = await inspect();
  h.ok(state.source === "visible" && state.destination === "hidden", "a future reverse hand-off does not hide the initial source");
  await seek(7, 1000); state = await inspect();
  h.ok(state.source === "hidden" && state.destination === "visible", "a future reverse hand-off preserves the preceding landing");
  await seek(7, 1000, 2); state = await inspect();
  h.ok(state.source === "visible" && state.destination === "hidden", "a second hand-off can land back on the original source");
  await seek(7, 0); state = await inspect();
  h.ok(state.source === "visible" && state.destination === "hidden", "reverse-seeking the chain restores its exact initial visibility");
  await seek(8, 500);
  h.ok(await page.$eval(".sl-flight", flight => {
    const clip = flight.querySelector("clipPath"), rect = clip?.querySelector("rect"), path = flight.querySelector(".sl-handoff-path");
    return rect?.getAttribute("x") === "520" && rect?.getAttribute("width") === "360" && path?.parentElement?.getAttribute("clip-path") === `url(#${clip?.id})`;
  }), "a projected cropped destination retains its stage-space clip throughout the flight");
  await seek(9, 2000);
  state = await inspect();
  h.ok(state.count === 0 && state.visibleFlight === 0 && await page.$eval('[data-el-id="refused-source"]', el => getComputedStyle(el).visibility === "visible"), "the exported player creates NO visible flight paths for a compiler-refused overlapping landing");
  h.eq(await page.$$eval(".sl-handoff", nodes => nodes.length), 1, "only the compiler-accepted flight owns a controller layer");
  // --- destination sets in the exported player ------------------------------
  {
    // tsx keeps function names via an injected __name helper the page lacks.
    await page.evaluate("globalThis.__name = (fn) => fn");
    const ellipses = ["e1", "e2", "e3"];
    const setState = () => page.evaluate((ids: string[]) => {
      const flight = document.querySelector(".sl-flight") as SVGSVGElement;
      const paths = Array.from(flight.querySelectorAll<SVGPathElement>(".sl-handoff-path")).filter(el => getComputedStyle(el).visibility !== "hidden" && Number(getComputedStyle(el).opacity) > 0 && flight.getAttribute("visibility") !== "hidden" && el.closest(".sl-handoff")?.getAttribute("visibility") !== "hidden");
      const toFlight = (node: SVGGraphicsElement) => flight.getScreenCTM()!.inverse().multiply(node.getScreenCTM()!);
      const box = (node: SVGGraphicsElement) => { const b = node.getBBox(), m = toFlight(node); return { x: m.a * b.x + m.e, y: m.d * b.y + m.f, w: m.a * b.width, h: m.d * b.height }; };
      const vis = (id: string) => getComputedStyle(document.querySelector(`[data-el-id="${id}"]`)!).visibility;
      const shapes = ids.map(id => { const el = document.querySelector(`[data-el-id="${id}"]`)!.querySelector("ellipse,path,circle") as SVGGraphicsElement; return box(el); });
      // Each visible flight piece sampled along its length, in flight (stage) px.
      const pieces = paths.map(p => { const m = toFlight(p), len = p.getTotalLength(); return Array.from({ length: 24 }, (_, i) => { const q = p.getPointAtLength(len * i / 23); return { x: m.a * q.x + m.c * q.y + m.e, y: m.b * q.x + m.d * q.y + m.f }; }); });
      return { count: paths.length, source: vis("source"), dest: ids.map(vis), shapes, pieces, union: paths.length ? (() => { const bs = paths.map(p => box(p)); const x = Math.min(...bs.map(b => b.x)), y = Math.min(...bs.map(b => b.y)); return { x, y, cx: (x + Math.max(...bs.map(b => b.x + b.w))) / 2, cy: (y + Math.max(...bs.map(b => b.y + b.h))) / 2 }; })() : null };
    }, ellipses);
    const S = 10;
    await seek(S, 0); let st = await setState();
    h.ok(st.source === "visible" && st.dest.every(v => v === "hidden") && st.count === 0, "set: at raw 0 the rect shows, the three ellipses are hidden and the flight layer is empty");
    await seek(S, 250); const q1 = await setState();
    await seek(S, 500); const q2 = await setState();
    await seek(S, 750); const q3 = await setState();
    h.ok([q1, q2, q3].every(q => q.source === "hidden" && q.dest.every(v => v === "hidden") && q.count >= 3), `set: mid-flight both sides hide and the flight draws ≥ 3 pieces (${[q1, q2, q3].map(q => q.count).join("/")})`);
    const target = { cx: 468.5, cy: (71 + 197) / 2 };
    const dist = (u: { cx: number; cy: number } | null) => u ? Math.hypot(u.cx - target.cx, u.cy - target.cy) : Infinity;
    h.ok(dist(q1.union) > dist(q2.union) && dist(q2.union) > dist(q3.union), `set: the pieces' union converges on the ellipses (${[q1, q2, q3].map(q => dist(q.union).toFixed(1)).join(" → ")} px)`);
    await seek(S, 999.999); st = await setState();
    // The last flight frame is each destination's own outline (§4: a pixel-invisible flip).
    const fits = st.pieces.map(points => {
      const shape = st.shapes.reduce((best, b) => Math.hypot(b.x + b.w / 2 - points[0].x, b.y + b.h / 2 - points[0].y) < Math.hypot(best.x + best.w / 2 - points[0].x, best.y + best.h / 2 - points[0].y) ? b : best);
      const rx = shape.w / 2, ry = shape.h / 2, cx = shape.x + rx, cy = shape.y + ry;
      return { shape: st.shapes.indexOf(shape), error: Math.max(...points.map(p => Math.abs(Math.hypot((p.x - cx) / rx, (p.y - cy) / ry) - 1) * Math.min(rx, ry))) };
    });
    // 3 arcs + 3 fill triangles (Oct-3: a filled ring's interior rides as fill-only
    // pieces paired with fill-only copies of the partners), all on the ellipses.
    h.ok(st.count === 6 && new Set(fits.map(f => f.shape)).size === 3 && fits.every(f => f.error < 0.5), `set: at raw .999999 every piece — three arcs and three fill pieces — lies on its own ellipse's outline within 0.5 px (${fits.map(f => f.error.toFixed(3)).join(", ")})`);
    await seek(S, 1000); st = await setState();
    h.ok(st.source === "hidden" && st.dest.every(v => v === "visible") && st.count === 0, "set: at raw 1 the three ellipses show, the rect is hidden and the flight layer is empty");
    await seek(S, 500); await seek(S, 0); st = await setState();
    h.ok(st.source === "visible" && st.dest.every(v => v === "hidden") && st.count === 0, "set: reverse seek restores the rect and hides the ellipses again");
    // Step 2: a Change on one landed member moves and recolours only that member.
    const member = () => page.evaluate(() => ["e1", "e2", "e3"].map(id => { const w = document.querySelector(`[data-el-id="${id}"]`) as HTMLElement, shape = w.querySelector("ellipse,path,circle") as SVGGraphicsElement, r = shape.getBoundingClientRect(); return { x: r.x + r.width / 2, fill: getComputedStyle(shape).fill, vis: getComputedStyle(w).visibility }; }));
    await seek(S, 1000); const landedMembers = await member();
    await seek(S, 400, 2); const moved = await member();
    h.ok(moved.every(m => m.vis === "visible") && moved[1].x > landedMembers[1].x + 20 && /65, 105, 225|4169e1/i.test(moved[1].fill) && Math.abs(moved[0].x - landedMembers[0].x) < 0.5 && Math.abs(moved[2].x - landedMembers[2].x) < 0.5 && moved[0].fill === landedMembers[0].fill,
      `set: a later Change on one landed member moves and recolours only that member (${JSON.stringify(moved.map(m => Math.round(m.x)))})`);
    await seek(S, 0, 2); await seek(S, 0, 1); const back = await member();
    h.ok(back.every(m => m.vis === "hidden") && Math.abs(back[1].x - landedMembers[1].x) < 0.5, "set: seeking back before the landing hides every member again at its pre-Change place");
    await seek(S, 500);
    await page.screenshot({ path: path.join(process.cwd(), "test-results", "slide-handoff-set.png") });
    // Parts of two plots + an ellipse.
    const M = 11;
    const mixed = () => page.evaluate(() => {
      const flight = document.querySelector(".sl-flight")!;
      const v = (sel: string) => { const n = document.querySelector(sel); return n ? getComputedStyle(n).visibility : "missing"; };
      return { source: v('[data-el-id="source"]'), box: v('[id="dest__peaches.box"]'), line: v('[id="dest2__2hz.line"]'), dot: v('[data-el-id="e1"]'), other: v('[id="dest__oranges.box"]'),
        count: flight.getAttribute("visibility") === "hidden" ? 0 : Array.from(flight.querySelectorAll(".sl-handoff-path")).filter(el => getComputedStyle(el).visibility !== "hidden" && Number(getComputedStyle(el).opacity) > 0).length };
    });
    await seek(M, 0); let m = await mixed();
    h.ok(m.source === "visible" && m.box === "hidden" && m.line === "hidden" && m.dot === "hidden" && m.other === "visible", "mixed set: before the flight only the members hide (a box of one plot, a curve of another, an ellipse)");
    await seek(M, 500); m = await mixed();
    h.ok(m.source === "hidden" && m.count >= 3 && m.box === "hidden" && m.line === "hidden" && m.dot === "hidden", `mixed set: one source flies into all three members at once (${m.count} pieces)`);
    await seek(M, 1000); m = await mixed();
    h.ok(m.source === "hidden" && m.box === "visible" && m.line === "visible" && m.dot === "visible" && m.count === 0, "mixed set: landing reveals every member in its own plot and hides the source");
    await seek(M, 0); m = await mixed();
    h.ok(m.source === "visible" && m.box === "hidden" && m.line === "hidden" && m.dot === "hidden", "mixed set: reverse seek restores the source");
  }
  // --- merge in the exported player ------------------------------------------
  {
    const G = 12;
    const merge = () => page.evaluate(() => {
      const flight = document.querySelector(".sl-flight") as SVGSVGElement;
      const layers = Array.from(flight.querySelectorAll(".sl-handoff")).filter(l => l.getAttribute("visibility") !== "hidden");
      const paths = layers.flatMap(l => Array.from(l.querySelectorAll<SVGPathElement>(".sl-handoff-path"))).filter(p => Number(p.getAttribute("opacity") ?? 1) > 0);
      const toFlight = (node: SVGGraphicsElement) => flight.getScreenCTM()!.inverse().multiply(node.getScreenCTM()!);
      const pts = paths.map(p => { const m = toFlight(p), len = p.getTotalLength(); return Array.from({ length: 16 }, (_, i) => { const q = p.getPointAtLength(len * i / 15); return { x: m.a * q.x + m.e, y: m.d * q.y + m.f }; }); });
      const vis = (id: string) => getComputedStyle(document.querySelector(`[data-el-id="${id}"]`)!).visibility;
      return { layers: layers.length, paths: paths.length, pts, slice: paths.map(p => p.getAttribute("data-piece") === "slice"), dest: vis("dest"), dots: ["e1", "e2", "e3"].map(vis) };
    });
    await seek(G, 0); let m = await merge();
    h.ok(m.dest === "hidden" && m.dots.every(v => v === "visible") && m.paths === 0, "merge: at zero the three ellipses show, the rect is hidden and nothing flies");
    await seek(G, 400); m = await merge();
    h.ok(m.layers === 3 && m.paths >= 3 && m.dots.every(v => v === "hidden") && m.dest === "hidden", `merge: mid-flight all three converge at once (${m.paths} pieces in ${m.layers} flights)`);
    await seek(G, 750); m = await merge();
    h.ok(m.layers === 3 && m.paths >= 3 && m.dest === "hidden", "merge: after the first two land (600, 750 ms) their pieces HOLD on the rect while the last still flies; the rect stays hidden");
    h.ok(await page.evaluate(() => {
      const layers = Array.from(document.querySelectorAll(".sl-flight > .sl-handoff")).filter(l => l.getAttribute("visibility") !== "hidden");
      const ids = layers.map(l => Number((l.getAttribute("data-handoff") ?? "").replace(/\D/g, "")));
      // every lander carries its own arc + its own fill triangle of the rect's interior; the
      // last lander (created last, the highest id) is inserted BENEATH the others
      return layers.length === 3 && layers.every(l => l.querySelectorAll(".sl-handoff-path").length === 2) && ids[0] === Math.max(...ids);
    }), "merge: each lander's layer holds its arc and its fill triangle, and the last lander's layer lies BENEATH the other landers'");
    await seek(G, 899.999); m = await merge();
    const onRect = (p: { x: number; y: number }) => Math.min(Math.abs(p.x - 161), Math.abs(p.x - 296), Math.abs(p.y - 111), Math.abs(p.y - 156));
    const inRect = (p: { x: number; y: number }) => p.x > 161 - 0.6 && p.x < 296 + 0.6 && p.y > 111 - 0.6 && p.y < 156 + 0.6;
    const arcPts = m.pts.filter((_, i) => !m.slice[i]), fillPts = m.pts.filter((_, i) => m.slice[i]);
    h.ok(arcPts.length === 3 && arcPts.every(points => points.every(p => onRect(p) < 0.5)), `merge: just before the reveal every arc piece lies on the rect's outline within 0.5 px (max ${Math.max(...arcPts.flat().map(onRect)).toFixed(3)})`);
    h.ok(fillPts.length === 3 && fillPts.every(points => points.every(inRect)), "merge: just before the reveal the three fill triangles lie inside the rect (its interior arrives with the pieces, never pops)");
    await seek(G, 900); m = await merge();
    h.ok(m.dest === "visible" && m.dots.every(v => v === "hidden") && m.paths === 0, "merge: the rect reveals at the LAST landing and the flight layer empties");
    await seek(G, 400); await seek(G, 0); m = await merge();
    h.ok(m.dest === "hidden" && m.dots.every(v => v === "visible") && m.paths === 0, "merge: reverse seek restores the ellipses and hides the rect");
    await seek(G, 450);
    await page.screenshot({ path: path.join(process.cwd(), "test-results", "slide-handoff-merge.png") });
  }
  await seek(5, 500);

  await page.screenshot({ path: path.join(process.cwd(), "test-results", "slide-handoff-colour.png") });

  // A separate CSP-safe bundle exercises the real static host and controller
  // raw-progress seam; no substitute player or sampling shortcut.
  const bundle = await build({ stdin: { resolveDir: process.cwd(), loader: "ts", contents: `
    import { createPlayer, renderStaticAt, computeSlideAnims, applyAt, disposeSlideAnims } from './src/lib/slide/player/player';
    import { renderSlide } from './src/lib/slide/player/render';
    import { preparePlot } from './src/lib/plot/parse';
    globalThis.probe = (deck, plots) => {
      const cache = Object.fromEntries(Object.entries(plots).map(([id,p]) => [id, preparePlot(p.svg,p.manifest)]));
      const opts = { theme: deck.theme, plotRoot: id => cache[id]?.root, plotManifest: id => cache[id]?.manifest };
      const host = document.getElementById('stage'), slide = deck.slides[0], results = [];
      for (const beat of [0,1,0]) {
        const r=renderStaticAt(host,slide,deck.stage,beat,opts);
        results.push({ beat, dest:getComputedStyle(host.querySelector('[id="dest__axis.x.spine"]')).visibility, source:getComputedStyle(r.elements.get('source')).visibility, children:r.flight.childElementCount });
      }
      const r=renderSlide(host,slide,deck.stage,opts), specs=computeSlideAnims(slide,r,host,deck.stage,opts);
      const controller=specs.find(s=>s.handoff).morph;
      const raw=[];
      for (const [u,p] of [[1.2,.4],[-.2,.6],[1,1],[0,0]]) {
        controller.seek(u,p);raw.push({p,flight:r.flight.querySelector('.sl-handoff').getAttribute('visibility'),dest:getComputedStyle(host.querySelector('[id="dest__axis.x.spine"]')).visibility});
      }
      applyAt(specs,1,500);disposeSlideAnims(specs);
      const disposed={children:r.flight.childElementCount,source:r.elements.get('source').style.visibility,dest:host.querySelector('[id="dest__axis.x.spine"]').style.visibility};
      globalThis.channelInputs = { pairs: [], glyphs: [] };
      const player = createPlayer(host, deck, { ...opts, reducedMotion: true });
      for (const index of [deck.slides.length-2, deck.slides.length-1]) for(let i=0;i<60;i++) player.seek(index,1,1000*i/59);
      player.destroy();
      return {results,raw,disposed,channels:globalThis.channelInputs};
    };` }, bundle: true, platform: "browser", format: "iife", write: false, plugins: [{ name: "observe-handoff-inputs", setup(build) {
      build.onLoad({ filter: /player[\\/]handoff\.ts$/ }, async ({ path: file }) => {
        let source = await fs.readFile(file, "utf8");
        // Match the call's head only: its trailing options (raw progress, duration) are free to grow.
        for (const [marker, channel] of [["sampleCorrespondence(sampled!, t, out", "pairs"], ["for (const glyph of glyphs) {", "glyphs"]]) {
          if (!source.includes(marker)) throw new Error(`Missing hand-off observation boundary: ${marker}`);
          source = source.replace(marker, `(globalThis as any).channelInputs?.${channel}.push(t); ${marker}`);
        }
        return { contents: source, loader: "ts", resolveDir: path.dirname(file) };
      });
    } }] });
  await fs.writeFile(path.join(tmp, "probe.js"), bundle.outputFiles[0].contents);
  await fs.writeFile(path.join(tmp, "static.html"), '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'unsafe-inline\'"><div id="stage"></div><script src="probe.js"></script>');
  await page.goto(pathToFileURL(path.join(tmp, "static.html")).href);
  const statics = await page.evaluate(({deck,plots}) => (globalThis as any).probe(deck,plots), {deck,plots});
  h.eq(statics.results.map((r: any) => r.dest), ["hidden","visible","hidden"], "renderStaticAt retains hidden-before/visible-after destination parts after disposal");
  h.eq(statics.results.map((r: any) => r.source), ["visible","hidden","visible"], "renderStaticAt retains source visibility in both directions");
  h.ok(statics.results.every((r: any) => r.children === 0), "static hosts release all flight children");
  h.eq(statics.raw.map((r: any) => r.flight), ["visible","visible","hidden","hidden"], "overshooting eased values never trigger a discrete layer swap");
  h.eq(statics.disposed, { children:0,source:"",dest:"" }, "dispose restores all prior inline visibility and releases flight children");
  h.ok(statics.channels.pairs.length >= 58 && statics.channels.pairs.every((t: number) => t >= 0 && t <= 1), "real-player correspondence receives only [0,1] under spring(.8)");
  h.ok(statics.channels.glyphs.length >= 116 && statics.channels.glyphs.every((t: number) => t >= 0 && t <= 1), "real-player glyph driver receives only [0,1] under spring(.8)");
  h.eq(errors, [], "exported and static hosts have no browser errors or CSP violations");
} catch (err) { h.fail(String((err as Error).stack ?? err)); }
finally { await browser?.close(); await fs.rm(tmp, { recursive:true,force:true }); }
await h.done();
