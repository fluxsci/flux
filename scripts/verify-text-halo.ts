#!/usr/bin/env -S npx tsx
// WP 4.2 (manim study, W6): the text halo (manim's set_backstroke): a ring in the background colour behind the glyphs, so a label stays
// legible over data. One field pair on the shared TextElement, one attribute law (export.ts haloAttrs: stroke = haloColor ?? the
// background, width 2·min(haloWidth, 0.3 em), round joins, paint-order stroke) used by the serializer (Figure/Paper export, resvg), the
// slide player and the editor canvas. A text without a halo serializes byte-identically.
// Run: npx tsx scripts/verify-text-halo.ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { harness } from "./lib/harness.mjs";
import { elementToSvg, figureToSvg, haloAttrs, haloBackgroundOf, textSvgLayout } from "../src/lib/export";
import { lerpElement } from "../src/lib/slide/tween";
import { createDeck, addSlide, addElement } from "../src/lib/slide/ops";
import { exportDeckHtml } from "../src/lib/slide/export/exportDeck";
import { validateDeckFile } from "../src/lib/project/validate";
import { launch } from "./lib/driver.mjs";

const h = harness("verify-text-halo");
const T = (extra: Record<string, unknown> = {}): any => ({ id: "t", type: "text", x: 20, y: 20, width: 260, height: 60, rotation: 0, text: "HALO", fontFamily: "DejaVu Sans", fontSize: 48, fontWeight: 700, fontStyle: "normal", align: "left", color: "#100f0f", sizing: "fixed", ...extra });
const none = () => undefined;
let browser: Awaited<ReturnType<typeof launch>>["browser"] | undefined;
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-halo-"));
try {
  h.section("one attribute law");
  const plain = elementToSvg(T(), none);
  h.ok(!/stroke|paint-order/.test(plain), "a text without a halo carries no stroke / paint-order at all");
  h.eq(elementToSvg(T({ haloWidth: 0 }), none), plain, "haloWidth 0 is off: byte-identical to no halo");
  h.eq(haloAttrs(T({ haloWidth: 3 }), "#202020"), { stroke: "#202020", "stroke-width": "6", "stroke-linejoin": "round", "paint-order": "stroke" }, "halo 3 on a #202020 background: stroke the background, 6 wide (3 per side), round joins, behind the fill");
  h.eq(haloAttrs(T({ haloWidth: 40 }), "#fff")["stroke-width"], String(2 * 0.3 * 48), "the width is capped at 0.3 em (bold text never turns into a blob)");
  h.eq(haloAttrs(T({ haloWidth: 3, haloColor: "#d14d41" }), "#202020").stroke, "#d14d41", "an explicit halo colour wins over the background");
  h.eq([haloBackgroundOf("transparent"), haloBackgroundOf(undefined), haloBackgroundOf("#123456")], ["#ffffff", "#ffffff", "#123456"], "the default colour is the background, white where that is transparent");
  const withHalo = elementToSvg(T({ haloWidth: 3 }), none, undefined, undefined, undefined, "#202020");
  h.eq(withHalo.replace(' stroke="#202020" stroke-width="6" stroke-linejoin="round" paint-order="stroke"', ""), plain, "a halo adds exactly its four attributes and nothing else");
  h.eq(textSvgLayout(T({ haloWidth: 2 }), "#000").attrs.stroke, "#000", "the slide player's text binding (textSvgLayout) shares the law");

  h.section("Figure export: the figure's background, rasterised by resvg");
  const fig = (bg: string, halo?: number): any => ({ id: "f", name: "F", canvasId: "c", x: 0, y: 0, width: 300, height: 100, background: bg, elements: [
    { id: "r", type: "rect", x: 0, y: 0, width: 300, height: 100, rotation: 0, fill: "#100f0f", stroke: "none", strokeWidth: 0, cornerRadius: 0 },
    T(halo ? { haloWidth: halo } : {})] });
  const svgOf = (f: any) => figureToSvg(f, none);
  h.ok(svgOf(fig("#fffcf0", 4)).includes('stroke="#fffcf0" stroke-width="8"'), "figureToSvg gives a colourless halo the figure's background");
  const count = (svg: string) => {
    const img = new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: "DejaVu Sans" } }).render(), px = img.pixels;
    let light = 0, dark = 0;
    for (let i = 0; i < px.length; i += 4) { const v = (px[i] + px[i + 1] + px[i + 2]) / 3; if (v > 200) light++; else if (v < 40) dark++; }
    return { light, dark };
  };
  const off = count(svgOf(fig("#fffcf0"))), on = count(svgOf(fig("#fffcf0", 4)));
  h.ok(off.light < 50 && on.light > 1500, `resvg paints the halo: ${on.light} light pixels around dark glyphs on a dark panel (${off.light} without)`);
  h.ok(on.dark > 0.5 * off.dark, "...and the glyphs themselves stay dark on top (paint-order: the fill paints over the ring)");

  h.section("motion and files");
  const mid = lerpElement(T(), T({ haloWidth: 3 }), 0.5) as any;
  h.ok(Math.abs(mid.haloWidth - 1.5) < 1e-12, "a Change that turns a halo on grows it (haloWidth 0 -> 3 is 1.5 halfway)");
  const deck = createDeck({ id: "h", title: "h", withTitleSlide: false } as never); const s = addSlide(deck, { id: "s", layout: "blank" } as never);
  addElement(deck, s.id, T({ haloWidth: 3, haloColor: "#fffcf0" }) as never);
  const errs = (d: unknown) => validateDeckFile(d) as unknown as unknown[];
  h.eq(errs(JSON.parse(JSON.stringify(deck))).length, 0, "a deck with a halo validates");
  const bad = JSON.parse(JSON.stringify(deck)); bad.slides[0].elements[0].haloWidth = -2;
  h.ok(errs(bad).length > 0, "a negative halo width is refused");
  const badColour = JSON.parse(JSON.stringify(deck)); badColour.slides[0].elements[0].haloColor = 7;
  h.ok(errs(badColour).length > 0, "a non-string halo colour is refused");

  h.section("the slide player (exported deck): the slide's background, painted behind the glyphs");
  const d2 = createDeck({ id: "p", title: "p", withTitleSlide: false } as never); d2.defaults.transition = "none";
  const s2 = addSlide(d2, { id: "s", layout: "blank" } as never); (d2.slides[0] as any).background = "#fffcf0";
  addElement(d2, s2.id, { id: "panel", type: "rect", x: 100, y: 100, width: 440, height: 160, rotation: 0, fill: "#100f0f", stroke: "none", strokeWidth: 0, cornerRadius: 0 } as never);
  addElement(d2, s2.id, T({ id: "label", x: 140, y: 140, haloWidth: 4, color: "#100f0f" }) as never);
  const file = path.join(tmp, "halo.html"); await fs.writeFile(file, (await exportDeckHtml({ deck: d2 } as never)).html);
  const launched = await launch({ width: 960, height: 540 }); browser = launched.browser; const page = launched.page;
  const errors: string[] = []; page.on("pageerror", (err: Error) => errors.push(String(err)));
  await page.goto(pathToFileURL(file).href); await page.waitForFunction("!!window.fluxDeck?.seek");
  const attrs = await page.evaluate(`(() => { const t = document.querySelector('[data-el-id="label"] text'); return t ? { stroke: t.getAttribute("stroke"), width: t.getAttribute("stroke-width"), order: t.getAttribute("paint-order") } : null; })()`);
  h.eq(attrs, { stroke: "#fffcf0", width: "8", order: "stroke" }, "the player's label carries the slide background as its halo");
  const shot = (await page.screenshot({ encoding: "base64", type: "png" })) as string;
  const light = await page.evaluate(`(async () => { const img = new Image(); img.src = "data:image/png;base64,${shot}"; await img.decode(); const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const k = c.getContext("2d"); k.drawImage(img, 0, 0);
    const d = k.getImageData(150, 150, 660, 240).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 200) n++; return n; })()`) as number;
  h.ok(light > 1500, `on the dark panel, the halo paints ${light} light pixels around the label`);
  h.eq(errors, [], "no page errors");
} catch (err) { h.fail(String((err as Error).stack ?? err)); }
finally { await browser?.close(); await fs.rm(tmp, { recursive: true, force: true }); }
await h.done();
