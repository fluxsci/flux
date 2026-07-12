// Shape-completeness gate — the Colors panel's "None" swatch (fill/stroke →
// the literal "none") and the Inspector's "Closed path" toggle. Drives the
// REAL panel DOM (swatch clicks, seg toggle, checkbox), asserts on the model
// AND the rendered SVG, and checks the applyColor("none") guards: text colour
// is never blanked, and an empty-selection stroke-None must not poison
// drawStyle.textColor.
//   Run (dev server on :1420): node scripts/verify-shape-nofill.mjs
import { launch, gotoApp, clickMode, realErrors, waitFor } from "./lib/driver.mjs";

let fails = 0;
const ok = (cond, msg) => (cond ? console.log("  ✓ " + msg) : (fails++, console.log("  ✗ " + msg)));

const { browser, page } = await launch({ width: 1440, height: 900 });
try {
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
  await clickMode(page, "Figure");
  await waitFor(page, () => !!(window.__flux?.fig && window.__flux.figures().length && document.querySelector(".canvas-host")), null, {
    timeout: 15000,
    label: "figure mode ready (dev handle + demo figures + canvas)",
  });

  // Seed: a filled rect, a LEGACY d-only open path (triangle missing its base
  // edge — the "drew it with the pen, ended with Enter" artifact), and a text.
  const ids = await page.evaluate(() => {
    const F = window.__flux.fig;
    const out = {};
    F.commit((p) => {
      const g = p.figures[0];
      g.elements = [];
      out.rect = F.newId("rect");
      g.elements.push({ type: "rect", id: out.rect, x: 60, y: 60, width: 160, height: 110, rotation: 0, fill: "#d62728", stroke: "#222222", strokeWidth: 3, cornerRadius: 0 });
      out.path = F.newId("path");
      g.elements.push({ type: "path", id: out.path, x: 300, y: 60, width: 120, height: 90, rotation: 0, d: "M 0 90 L 60 0 L 120 90", fill: "none", stroke: "#222222", strokeWidth: 3, closed: false });
      out.text = F.newId("text");
      g.elements.push({ type: "text", id: out.text, x: 60, y: 220, width: 120, height: 24, rotation: 0, text: "label", fontFamily: "sans-serif", fontSize: 14, fontWeight: 400, fontStyle: "normal", align: "left", color: "#111111", sizing: "auto" });
    });
    return out;
  });

  const el = (id) =>
    page.evaluate((id) => {
      const X = window.__flux;
      for (const f of X.get(X.fig.project).figures) for (const e of f.elements) if (e.id === id) return JSON.parse(JSON.stringify(e));
      return null;
    }, id);
  const select = (...list) => page.evaluate((list) => window.__flux.fig.selection.set(new Set(list)), list);
  const clickNone = (target) =>
    page.evaluate((target) => {
      const b = document.querySelector(`button[aria-label="No ${target}"]`);
      if (!b) return false;
      b.click();
      return true;
    }, target);
  const setTarget = (label) =>
    page.evaluate((label) => {
      const sec = [...document.querySelectorAll("section")].find((s) => s.querySelector("h4")?.textContent === "Colors");
      const b = sec && [...sec.querySelectorAll(".seg button")].find((x) => x.textContent.trim() === label);
      if (!b) return false;
      b.click();
      return true;
    }, label);

  // --- A. None swatch: fill → "none" on the rect (model + rendered SVG)
  await select(ids.rect);
  await waitFor(page, () => !!document.querySelector('button[aria-label="No fill"]'), null, { label: "None swatch present (fill target default)" });
  ok(await clickNone("fill"), "None swatch clicked (fill)");
  let r = await el(ids.rect);
  ok(r.fill === "none", `rect fill is "none" (got ${r.fill})`);
  ok(r.stroke === "#222222", "rect stroke untouched");
  const domFill = await page.evaluate(() => !!document.querySelector('.scene-svg rect[fill="none"][stroke="#222222"]'));
  ok(domFill, 'rendered SVG rect carries fill="none" (outline only)');

  // Stroke target → "none" too (borderless): the swatch relabels with the target.
  ok(await setTarget("Stroke"), "seg toggled to Stroke");
  await waitFor(page, () => !!document.querySelector('button[aria-label="No stroke"]'), null, { label: "None swatch relabelled for stroke" });
  ok(await clickNone("stroke"), "None swatch clicked (stroke)");
  r = await el(ids.rect);
  ok(r.stroke === "none", `rect stroke is "none" (got ${r.stroke})`);

  // --- B. guards: None never blanks text colour; fill-None skips lines/text
  await select(ids.text);
  ok(await setTarget("Fill"), "seg back to Fill");
  await clickNone("fill");
  const t = await el(ids.text);
  ok(t.color === "#111111", "text colour NOT set to none (guard)");

  // empty-selection stroke-None seeds drawStyle.stroke but must not poison textColor
  await select();
  await setTarget("Stroke");
  await clickNone("stroke");
  const ds = await page.evaluate(() => window.__flux.get(window.__flux.fig.drawStyle));
  ok(ds.stroke === "none", "empty-selection None sets drawStyle.stroke");
  ok(ds.textColor !== "none", `drawStyle.textColor stays visible (got ${ds.textColor})`);

  // --- C. Closed toggle: close the open triangle from the Inspector
  await select(ids.path);
  const closedChk = () => {
    const l = [...document.querySelectorAll("label.chk")].find((x) => /Closed path/.test(x.textContent));
    return l ? l.querySelector("input") : null;
  };
  await waitFor(page, () => { const l = [...document.querySelectorAll("label.chk")].find((x) => /Closed path/.test(x.textContent)); return !!l; }, null, { label: "Closed-path checkbox visible for a path selection" });
  await page.evaluate(() => { [...document.querySelectorAll("label.chk")].find((x) => /Closed path/.test(x.textContent)).querySelector("input").click(); });
  let pth = await el(ids.path);
  ok(pth.closed === true && /Z$/.test(pth.d.trim()), `Closed toggle closes the path (d: …${pth.d.slice(-14)})`);
  ok(Array.isArray(pth.nodes) && pth.nodes.length === 3, "legacy d-only path adopted into 3 nodes");
  const domClosed = await page.evaluate(() => [...document.querySelectorAll(".scene-svg path")].some((p) => /Z$/.test((p.getAttribute("d") || "").trim()) && p.getAttribute("stroke") === "#222222"));
  ok(domClosed, "rendered path gains the closing segment");

  // now the triangle can take a fill (the original ask): Fill target + None-swatch's inverse — any colour
  await setTarget("Fill");
  await page.evaluate(() => {
    const sec = [...document.querySelectorAll("section")].find((s) => s.querySelector("h4")?.textContent === "Colors");
    const add = sec.querySelector('.add input[type="color"]');
    add.value = "#2ca02c";
    add.dispatchEvent(new Event("change", { bubbles: true }));
  });
  pth = await el(ids.path);
  ok(pth.fill === "#2ca02c", "closed triangle takes a fill");

  // reopen: fill survives in the model, renderer suppresses it (open paths draw fill=none)
  await page.evaluate(() => { [...document.querySelectorAll("label.chk")].find((x) => /Closed path/.test(x.textContent)).querySelector("input").click(); });
  pth = await el(ids.path);
  ok(pth.closed === false && !/Z/.test(pth.d), "Closed toggle reopens (Z removed)");
  const domOpenFill = await page.evaluate(() => [...document.querySelectorAll(".scene-svg path")].some((p) => p.getAttribute("stroke") === "#222222" && p.getAttribute("fill") === "none"));
  ok(domOpenFill, "reopened path renders unfilled (no chord-fill masquerade)");

  const errs = realErrors(page);
  ok(errs.length === 0, errs.length ? `console errors: ${errs.join(" | ").slice(0, 200)}` : "zero console errors");
} finally {
  await browser.close();
}
console.log(fails ? `\nSHAPE-NOFILL VERIFY: FAIL — ${fails}` : "\nSHAPE-NOFILL VERIFY: PASS");
process.exit(fails ? 1 : 0);
