// verify-slide-morph-geometry-browser — the DOM half of the morph bug floor (WP 1.5; headless Chrome via exportDeckHtml, no Electron):
//  - the 1↔1 morph layer's gradient `<defs>` never share an id with the hidden A layer's (a duplicate `fxg-<id>-fill`
//    made `url(#…)` resolve to A's stops, so a gradient→flat Become sat frozen until the swap to B: a 68,541 px pop);
//  - pieces of a split gradient shape paint ONE ramp (userSpaceOnUse over the shape's box), not one ramp per piece;
//  - per-channel alpha survives a Become (a translucent source never snaps opaque on its first frame).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createDeck, addSlide, addElement, addBeat, becomeTransform, setTransform } from "../src/lib/slide/ops";
import { exportDeckHtml } from "../src/lib/slide/export/exportDeck";
import { harness } from "./lib/harness.mjs";
import { launch } from "./lib/driver.mjs";
const h = harness("verify-slide-morph-geometry-browser");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-morphgeo-"));
let browser: Awaited<ReturnType<typeof launch>>["browser"] | undefined;
try {
  const V = ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"];
  const deck = createDeck({ withTitleSlide: false }); deck.stage = { width: 640, height: 360 }; deck.defaults.transition = "none";
  const R = (o: object = {}) => ({ type: "rect" as const, id: "a", x: 220, y: 80, width: 200, height: 200, rotation: 0, fill: "#4385be", stroke: "#205ea6", strokeWidth: 6, cornerRadius: 0, ...o });
  const E = (id: string, o: object = {}) => ({ type: "ellipse" as const, id, x: 220, y: 80, width: 200, height: 200, rotation: 0, fill: "#d14d41", stroke: "#942822", strokeWidth: 6, ...o });
  const slide = (name: string) => addSlide(deck, { id: name, layout: "blank" });
  const g = slide("g2flat"); addElement(deck, g.id, R({ fillMap: { map: "viridis", axis: "x", stops: V } })); addElement(deck, g.id, E("b"));
  const gb = addBeat(deck, g.id, { id: "b1" })!; becomeTransform(deck, g.id, gb.id, "a", "b");
  const s = slide("set"); addElement(deck, s.id, R({ id: "source", x: 161, y: 111, width: 135, height: 45, strokeWidth: 0, fillMap: { map: "viridis", axis: "x", stops: V } }));
  for (const [id, y] of [["e1", 71], ["e2", 124], ["e3", 176]] as const) addElement(deck, s.id, E(id, { x: 458, y, width: 21, height: 21, strokeWidth: 0 }));
  const sb = addBeat(deck, s.id, { id: "b1" })!; setTransform(deck, s.id, sb.id, "source", { state: {}, duration: 1000, easing: "linear" });
  sb.tracks[0].to!.become = { mode: "handoff", ref: { element: "e1", members: [{ element: "e1" }, { element: "e2" }, { element: "e3" }] }, method: "shatter" } as any;
  const al = slide("alpha"); addElement(deck, al.id, R({ fillOpacity: 0.35 })); addElement(deck, al.id, E("b"));
  const alb = addBeat(deck, al.id, { id: "b1" })!; becomeTransform(deck, al.id, alb.id, "a", "b");
  for (const sl of deck.slides) for (const b of sl.beats) for (const t of b.tracks) if (sl.id !== "set") { delete (t as any).duration; delete (t as any).easing; }

  const file = path.join(tmp, "morph.html"); await fs.writeFile(file, (await exportDeckHtml({ deck })).html);
  const launched = await launch(); browser = launched.browser; const page = launched.page;
  await page.goto(pathToFileURL(file).href); await page.waitForFunction("!!window.fluxDeck?.seek");
  const seek = async (slideIx: number, time: number, beat = 1) => page.evaluate(({ slideIx, time, beat }) => (window as any).fluxDeck.seek(slideIx, beat, time), { slideIx, time, beat });

  h.section("1↔1 morph layer: gradient ids are unique and the stops follow t");
  const stops = () => page.evaluate(() => {
    const ids = Array.from(document.querySelectorAll("[id]")).map((n) => n.id);
    const live = Array.from(document.querySelectorAll("svg path")).find((p) => /^url\(#/.test(p.getAttribute("fill") ?? "") && getComputedStyle(p).visibility !== "hidden" && !!p.closest("div")?.querySelector("path"));
    const ref = /#([^)]+)/.exec(live?.getAttribute("fill") ?? "")?.[1];
    const grad = ref ? document.getElementById(ref) : null;
    return { dup: ids.length - new Set(ids).size, ref, colors: Array.from(grad?.querySelectorAll("stop") ?? []).map((n) => n.getAttribute("stop-color")) };
  });
  await seek(0, 0); await seek(0, 300);
  let st = await stops();
  const hex = (c: string | null) => { const m = /^#([0-9a-f]{6})$/i.exec(c ?? ""); return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : null; };
  h.eq(st.dup, 0, "no duplicate element ids anywhere in the document mid-morph");
  const mid = st.colors.map(hex);
  h.ok(mid.length === 5 && mid.every(Boolean) && mid[0]!.join() !== hex(V[0])!.join(), `mid-morph the live path's own stops have already left viridis (${st.colors.join(" ")})`);
  await seek(0, 593); st = await stops();
  const red = hex("#d14d41")!;
  h.ok(st.colors.length === 5 && st.colors.every((c) => { const v = hex(c); return v && Math.max(...v.map((x, i) => Math.abs(x - red[i]))) <= 14; }), `just before the swap to B every stop is within 14/255 of the destination red (${st.colors.join(" ")}); a frozen A gradient was the old pop`);

  h.section("set flight of a gradient shape: one ramp, in user space");
  await seek(1, 500);
  const ramps = await page.evaluate(() => {
    const flight = document.querySelector(".sl-flight")!;
    const paths = Array.from(flight.querySelectorAll<SVGPathElement>(".sl-handoff-path")).filter((p) => /^url\(#/.test(p.getAttribute("fill") ?? "") || /^url\(#/.test(p.getAttribute("stroke") ?? ""));
    return paths.map((p) => { const ref = /#([^)]+)/.exec((/^url/.test(p.getAttribute("fill") ?? "") ? p.getAttribute("fill") : p.getAttribute("stroke"))!)![1]; const g = flight.querySelector(`[id="${ref}"]`) ?? document.getElementById(ref); return g ? { units: g.getAttribute("gradientUnits"), x1: Number(g.getAttribute("x1")), x2: Number(g.getAttribute("x2")) } : null; });
  });
  h.ok(ramps.length >= 3 && ramps.every((r) => r && r.units === "userSpaceOnUse") && ramps.every((r) => Math.abs(r!.x1 - ramps[0]!.x1) < 1e-6 && Math.abs(r!.x2 - ramps[0]!.x2) < 1e-6) && ramps[0]!.x2 - ramps[0]!.x1 > 20, `${ramps.length} gradient pieces share one userSpaceOnUse ramp x ${ramps[0]?.x1.toFixed(1)}→${ramps[0]?.x2.toFixed(1)} (objectBoundingBox restarted the ramp inside every piece)`);
  h.section("1↔1 per-channel alpha: the live path keeps fill-opacity between the two ends");
  const fo = async () => page.evaluate(() => { const p = Array.from(document.querySelectorAll("svg path")).find((q) => q.getAttribute("fill-opacity") !== null && getComputedStyle(q).visibility !== "hidden" && !!q.closest("div")?.querySelector("path")); return p ? Number(p.getAttribute("fill-opacity")) : null; });
  await seek(2, 0); await seek(2, 150); const f1 = await fo();
  await seek(2, 450); const f2 = await fo();
  h.ok(f1 !== null && f2 !== null && f1 > 0.35 && f1 < 1 && f2 > f1 && f2 < 1, `fill-opacity rises 0.35 → 1 through the morph (${f1?.toFixed(2)} → ${f2?.toFixed(2)}); the old driver dropped the channel and painted opaque from frame 1`);
} finally { await browser?.close(); await fs.rm(tmp, { recursive: true, force: true }); }
await h.done();
