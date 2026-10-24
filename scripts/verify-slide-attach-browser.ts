#!/usr/bin/env -S npx tsx
// WP 3.2 (manim study, T9): attached connectors and labels in the REAL portable player (headless Chrome, the exported deck). The attach
// driver (player/attach.ts) must paint exactly what compile.sample solves, every frame of a Change that moves the drivers with an arc and a
// spring overshoot: a connector's endpoints (its <line> attributes) and a label's box (its wrapper, composited while it glides), within
// 0.05 stage px over 150 frames, and seek-pure (forward, backward and shuffled seeks paint byte-identical DOM). Without the driver the player
// would show the Design geometry the whole time (the gap this gate exists for).
// Run: npx tsx scripts/verify-slide-attach-browser.ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createDeck, addSlide, addElement, addBeat, setTransform, setAttach, setAnimation } from "../src/lib/slide/ops";
import { compileSlide } from "../src/lib/slide/compile";
import { exportDeckHtml } from "../src/lib/slide/export/exportDeck";
import { harness } from "./lib/harness.mjs";
import { launch } from "./lib/driver.mjs";

const h = harness("verify-slide-attach-browser");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-attach-browser-"));
let browser: Awaited<ReturnType<typeof launch>>["browser"] | undefined;
try {
  const deck = createDeck({ id: "att", title: "attach", withTitleSlide: false } as never); deck.defaults.transition = "none";
  const s = addSlide(deck, { id: "s", layout: "blank" });
  addElement(deck, s.id, { id: "A", type: "rect", x: 120, y: 300, width: 220, height: 130, rotation: 0, fill: "#4385be", stroke: "none", strokeWidth: 0, cornerRadius: 0 } as never);
  addElement(deck, s.id, { id: "B", type: "ellipse", x: 1300, y: 280, width: 200, height: 200, rotation: 0, fill: "#d14d41", stroke: "none", strokeWidth: 0 } as never);
  addElement(deck, s.id, { id: "L", type: "line", x: 0, y: 0, width: 0, height: 0, rotation: 0, x1: 0, y1: 0, x2: 10, y2: 0, stroke: "#100f0f", strokeWidth: 6 } as never);
  addElement(deck, s.id, { id: "T", type: "text", x: 0, y: 0, width: 220, height: 50, rotation: 0, text: "follows A", fontFamily: "Arial", fontSize: 36, fontWeight: 400, fontStyle: "normal", align: "center", fill: "#100f0f", sizing: "fixed" } as never);
  h.ok(setAttach(deck, s.id, "L", { start: { to: "A", gap: 6 }, end: { to: "B", gap: 6 } }).ok && setAttach(deck, s.id, "T", { to: "A", side: "n", gap: 12 }).ok, "a connector between A and B, a label above A");
  const beat = addBeat(deck, s.id, { id: "b1" })!;
  setTransform(deck, s.id, beat.id, "A", { state: { x: 700, y: 700 }, duration: 1000, easing: "smooth", arc: 0.8 });
  setTransform(deck, s.id, beat.id, "B", { state: { x: 1500, y: 120 }, duration: 1000, curve: { kind: "spring", bounce: 0.5 } });
  // slide 2 (R3 review): an arrow that DRAWS while its end's driver stretches it 3x: the head must grow from where the shaft arrives
  const s2 = addSlide(deck, { id: "s2", layout: "blank" });
  addElement(deck, s2.id, { id: "P", type: "rect", x: 100, y: 200, width: 160, height: 100, rotation: 0, fill: "#4385be", stroke: "none", strokeWidth: 0, cornerRadius: 0 } as never);
  addElement(deck, s2.id, { id: "Q", type: "rect", x: 500, y: 200, width: 160, height: 100, rotation: 0, fill: "#d14d41", stroke: "none", strokeWidth: 0, cornerRadius: 0 } as never);
  addElement(deck, s2.id, { id: "PQ", type: "line", x: 0, y: 0, width: 0, height: 0, rotation: 0, x1: 0, y1: 0, x2: 10, y2: 0, stroke: "#100f0f", strokeWidth: 8, arrowEnd: true } as never);
  setAttach(deck, s2.id, "PQ", { start: { to: "P", gap: 6 }, end: { to: "Q", gap: 6 } });
  const g2 = addBeat(deck, s2.id, { id: "g2" })!;
  setTransform(deck, s2.id, g2.id, "Q", { state: { x: 1600, y: 700 }, duration: 1000, easing: "smooth" });
  setAnimation(deck, s2.id, g2.id, { target: "PQ", preset: "drawOn", start: 0, duration: 1000, easing: "smooth" } as never);
  const slide = deck.slides[0], c = compileSlide(slide, deck.stage, deck);
  const file = path.join(tmp, "attach.html"); await fs.writeFile(file, (await exportDeckHtml({ deck } as never)).html);
  const launched = await launch(); browser = launched.browser; const page = launched.page;
  const errors: string[] = []; page.on("pageerror", (err: Error) => errors.push(String(err)));
  await page.goto(pathToFileURL(file).href); await page.waitForFunction("!!window.fluxDeck?.seek");
  // (string expressions: a function declared inside an evaluated callback gets tsx's `__name` helper)
  const read = (time: number) => page.evaluate(`(() => { window.fluxDeck.seek(0, 1, ${time});
    const cam = document.querySelector(".sl-camera").getBoundingClientRect(), k = cam.width / ${deck.stage.width};
    const ln = document.querySelector('[data-el-id="L"] line'), t = document.querySelector('[data-el-id="T"]').getBoundingClientRect();
    return { line: ["x1", "y1", "x2", "y2"].map(a => +ln.getAttribute(a)), label: [(t.left - cam.left) / k, (t.top - cam.top) / k, t.width / k, t.height / k], sig: document.querySelector('[data-el-id="L"]').outerHTML + document.querySelector('[data-el-id="T"]').outerHTML }; })()`) as Promise<{ line: number[]; label: number[]; sig: string }>;
  const times = Array.from({ length: 150 }, (_, i) => Math.round(i * 1000 / 149 * 100) / 100);
  let worstLine = 0, worstLabel = 0, moved = 0;
  const sigs = new Map<number, string>();
  for (const ms of times) {
    const dom = await read(ms), frame = c.sample(1, ms).elements, L = frame.find(e => e.id === "L") as never as { x: number; y: number; x1: number; y1: number; x2: number; y2: number }, T = frame.find(e => e.id === "T")!;
    const want = [L.x + L.x1, L.y + L.y1, L.x + L.x2, L.y + L.y2];
    worstLine = Math.max(worstLine, ...want.map((v, i) => Math.abs(v - dom.line[i])));
    worstLabel = Math.max(worstLabel, Math.abs(dom.label[0] - T.x), Math.abs(dom.label[1] - T.y));
    if (Math.abs(want[0] - (slide.elements.find(e => e.id === "L") as never as { x: number }).x) > 1) moved++;
    sigs.set(ms, dom.sig);
  }
  h.ok(moved > 100, `the drivers really move the connector (${moved} of 150 frames off its Design start)`);
  h.ok(worstLine <= 0.05, `connector endpoints == compile.sample's solve on 150 frames (arc + spring overshoot): max ${worstLine.toExponential(2)} stage px (<= 0.05)`);
  h.ok(worstLabel <= 0.05, `the label's painted box == compile.sample's solve on 150 frames (composited while it glides): max ${worstLabel.toExponential(2)} stage px (<= 0.05)`);
  const shuffled = [...times].sort((a, b) => Math.sin(a * 12.9898) - Math.sin(b * 12.9898));
  let diffs = 0;
  for (const ms of [...[...times].reverse(), ...shuffled]) if ((await read(ms)).sig !== sigs.get(ms)) diffs++;
  h.eq(diffs, 0, "seek purity: backward and shuffled seeks paint the same DOM as the forward pass (300 seeks)");
  const rest = await read(5000), last = c.sample(1, Infinity).elements.find(e => e.id === "L") as never as { x: number; y: number; x1: number; y1: number; x2: number; y2: number };
  h.ok([last.x + last.x1, last.y + last.y1, last.x + last.x2, last.y + last.y2].every((v, i) => Math.abs(v - rest.line[i]) <= 0.05), "at rest the connector sits on the end state's solve");
  // the arrow drawing while it stretches: the head's scale origin is its CURRENT base (the shaft's arrival), every frame
  let worstHead = 0, framesWithHead = 0;
  for (let i = 1; i < 40; i++) {
    const r = await page.evaluate(`(() => { window.fluxDeck.seek(1, 1, ${i * 25});
      const poly = document.querySelector('[data-el-id="PQ"] polygon'); if (!poly) return null;
      const n = (poly.getAttribute("points") || "").split(/[\\s,]+/).filter(Boolean).map(Number); if (n.length < 6) return null;
      const q = [[n[0], n[1]], [n[2], n[3]], [n[4], n[5]]];
      const o = (poly.style.transformOrigin || "").split(/px|\\s+/).filter(Boolean).map(Number);
      return { base: [(q[1][0] + q[2][0]) / 2, (q[1][1] + q[2][1]) / 2], origin: o };
    })()`) as { base: number[]; origin?: number[] } | null;
    if (!r?.origin) continue;
    framesWithHead++; worstHead = Math.max(worstHead, Math.hypot(r.origin[0] - r.base[0], r.origin[1] - r.base[1]));
  }
  h.ok(framesWithHead >= 10 && worstHead < 0.01, `a drawing arrow that stretches 3x grows its head from the shaft's arrival every frame (${framesWithHead} frames, worst ${worstHead.toExponential(2)} px)`);
  h.eq(errors, [], "no page errors");
} catch (err) { h.fail(String((err as Error).stack ?? err)); }
finally { await browser?.close(); await fs.rm(tmp, { recursive: true, force: true }); }
await h.done();
