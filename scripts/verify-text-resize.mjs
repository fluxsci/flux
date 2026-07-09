// figure-v1 Phase 3 (ui) — text resize semantics: resizing a text box NEVER
// changes its font size (Figma contract — reflow instead):
//   • drag the E (width) handle in on a wide one-liner → fontSize UNCHANGED,
//     text wraps (≥2 tspans in the live DOM), sizing flips auto → "auto-h",
//     the box height GREW to hug the wrapped lines
//   • drag a corner (height involved) → sizing pins "fixed"
//   • the K/Scale tool remains the intentional font scaler (fontSize halves)
//   • the inline textarea editor wraps at the box width (pre-wrap, exact width)
// Screenshots: the same text wrapped at two widths (evidence for the notes).
import { launch, gotoApp, clickMode, shot, realErrors, sleep } from "./lib/driver.mjs";

let fails = 0;
function assert(cond, msg) {
  if (cond) console.log("  ok:", msg);
  else {
    fails++;
    console.error("  FAIL:", msg);
  }
}
const near = (a, b, t = 2) => Math.abs(a - b) <= t;

const { browser, page } = await launch({ width: 1440, height: 900 });
try {
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
  await clickMode(page, "Figure");
  await sleep(700);

  const TEXT = "The quick brown fox jumps over the lazy dog near the riverbank";
  const seed = (id, over = {}) =>
    page.evaluate(
      (id, over, TEXT) => {
        const F = window.__flux.fig;
        F.commit((p) => {
          const g = p.figures.find((f) => f.id === "growth") || p.figures[0];
          g.x = 0;
          g.y = 0;
          g.width = 900;
          g.height = 600;
          g.elements = g.elements.filter((e) => !e.id.startsWith("tr-"));
          g.elements.push({
            type: "text", id, x: 80, y: 120, width: 520, height: 20, rotation: 0,
            text: TEXT, fontFamily: "Arial", fontSize: 16, fontWeight: 400,
            fontStyle: "normal", align: "left", color: "#111111", sizing: "auto",
            ...over,
          });
        });
        F.selectOnly(id);
        F.activeTool.set("select");
        F.viewport.set({ panX: 120, panY: 120, zoom: 1 });
      },
      id,
      over,
      TEXT,
    );
  const el = (id) => page.evaluate((id) => window.__flux.figures().flatMap((f) => f.elements).find((e) => e.id === id), id);
  // screen position of a figure-local point (growth at 0,0; zoom 1)
  const pt = (lx, ly) =>
    page.evaluate(
      ([lx, ly]) => {
        const vp = window.__flux.get(window.__flux.fig.viewport);
        const host = document.querySelector(".canvas-host").getBoundingClientRect();
        return { x: host.left + vp.panX + lx * vp.zoom, y: host.top + vp.panY + ly * vp.zoom };
      },
      [lx, ly],
    );
  const drag = async (from, to, steps = 10) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps });
    await page.mouse.up();
    await sleep(200);
  };
  // count the live tspans of OUR text node
  const tspans = (id) =>
    page.evaluate((needle) => {
      const texts = [...document.querySelectorAll(".scene-svg text")];
      const t = texts.find((n) => (n.textContent ?? "").includes("quick brown"));
      return t ? t.querySelectorAll("tspan").length : 0;
    }, id);

  // ---- 1) E-handle width drag: wrap, no font change --------------------------
  await seed("tr-wrap");
  await sleep(250);
  let e0 = await el("tr-wrap");
  // sizing auto hugged the box to its content on seed? (commit didn't reflow —
  // the model width stays 520; that's fine, the handle math uses the model box)
  const w0 = e0.width;
  const h0 = e0.height;
  assert((await tspans()) === 1, "seeded one-liner renders a single tspan");
  const eHandle = await pt(80 + w0, 120 + h0 / 2);
  const eTarget = await pt(80 + 260, 120 + h0 / 2); // pull width in to 260
  await drag(eHandle, eTarget);
  let e1 = await el("tr-wrap");
  assert(near(e1.fontSize, 16, 0.01), `W-drag leaves fontSize at 16 (got ${e1.fontSize})`);
  assert(e1.sizing === "auto-h", `W-drag flips sizing auto → auto-h (got ${e1.sizing})`);
  assert(near(e1.width, 260, 6), `width followed the drag (${Math.round(e1.width)} ≈ 260)`);
  assert(e1.height > h0 + 10, `height GREW to hug the wrapped lines (${h0} → ${Math.round(e1.height)})`);
  assert(Array.isArray(e1.lines) && e1.lines.length >= 2, `wrap cache has ≥2 lines (${e1.lines?.length})`);
  const nT = await tspans();
  assert(nT >= 2, `live DOM renders ≥2 tspans (${nT})`);
  await shot(page, "text-resize-01-wrapped-260");

  // narrower still → more lines (second width for the evidence shots)
  const e2Handle = await pt(80 + e1.width, 120 + e1.height / 2);
  const e2Target = await pt(80 + 150, 120 + e1.height / 2);
  await drag(e2Handle, e2Target);
  let e2 = await el("tr-wrap");
  assert(near(e2.fontSize, 16, 0.01), "second W-drag: fontSize still 16");
  assert(e2.lines.length > e1.lines.length, `narrower box wraps into more lines (${e1.lines.length} → ${e2.lines.length})`);
  await shot(page, "text-resize-02-wrapped-150");

  // ---- 2) corner drag (height involved) → fixed ------------------------------
  await seed("tr-fix");
  await sleep(250);
  const f0 = await el("tr-fix");
  const seH = await pt(80 + f0.width, 120 + f0.height);
  const seT = await pt(80 + f0.width - 140, 120 + f0.height + 60);
  await drag(seH, seT);
  const f1 = await el("tr-fix");
  assert(f1.sizing === "fixed", `corner drag pins sizing "fixed" (got ${f1.sizing})`);
  assert(near(f1.fontSize, 16, 0.01), `corner drag leaves fontSize at 16 (got ${f1.fontSize})`);

  // ---- 3) K/Scale tool still scales the font ---------------------------------
  await seed("tr-k", { sizing: "fixed", width: 400, height: 40 });
  await sleep(250);
  await page.evaluate(() => window.__flux.fig.activeTool.set("scale"));
  await sleep(150);
  const kH = await pt(80 + 400, 120 + 40);
  const kT = await pt(80 + 200, 120 + 20); // uniform 0.5
  await drag(kH, kT);
  const k1 = await el("tr-k");
  assert(near(k1.fontSize, 8, 0.8), `K tool halves fontSize 16 → ${k1.fontSize?.toFixed(1)}`);
  await page.evaluate(() => window.__flux.fig.activeTool.set("select"));

  // ---- 4) textarea editor parity: wraps at the box ---------------------------
  await seed("tr-edit", { sizing: "auto-h", width: 240 });
  await page.evaluate(() => {
    // reflow through the real seam so lines exist before we open the editor
    const F = window.__flux.fig;
    F.commit((p) => {
      const g = p.figures.find((f) => f.id === "growth") || p.figures[0];
      const t = g.elements.find((e) => e.id === "tr-edit");
      // width fixed at 240; applyTextLayout runs inside Inspector/menu paths —
      // here poke it via a no-op style commit (sizing already auto-h)
      t.width = 240;
    });
  });
  await sleep(200);
  const ed = await el("tr-edit");
  const c = await pt(80 + 60, 120 + Math.max(10, ed.height / 2));
  await page.mouse.click(c.x, c.y, { count: 2 });
  await sleep(400);
  const ta = await page.evaluate(() => {
    const t = document.querySelector("textarea.text-edit");
    if (!t) return null;
    const cs = getComputedStyle(t);
    return { ws: cs.whiteSpace, ow: cs.overflowWrap, w: parseFloat(cs.width), lh: cs.lineHeight, clientH: t.clientHeight, scrollW: t.scrollWidth };
  });
  assert(ta, "dblclick opened the inline textarea editor");
  assert(ta && ta.ws === "pre-wrap", `editor white-space is pre-wrap (${ta?.ws})`);
  assert(ta && ta.ow === "break-word", `editor overflow-wrap is break-word (${ta?.ow})`);
  assert(ta && near(ta.w, 240, 1.5), `editor content width == model width (${ta?.w} ≈ 240)`);
  await shot(page, "text-resize-03-editor-wrap");
  await page.keyboard.press("Escape");
  await sleep(150);

  const errs = realErrors(page);
  assert(errs.length === 0, `no console errors (${errs.length})`);
  if (errs.length) console.error(errs.slice(0, 5));
  console.log(fails === 0 ? "\nTEXT RESIZE ALL PASS" : `\nTEXT RESIZE ${fails} FAILURE(S)`);
} finally {
  await browser.close();
}
process.exit(fails === 0 ? 0 : 1);
