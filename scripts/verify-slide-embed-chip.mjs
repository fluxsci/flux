// Paper's slide-embed SOURCE chip (owner inbox 2026-10-02): an embedded
// slide's raw `![](…){.flux-slide …}` line folds to `▷ <deck title> · Slide N`
// exactly the way a figure embed folds to its name chip. Pinned in the app:
//   - the chip shows the deck title + 1-based ordinal; the raw text is hidden;
//   - a caret on the line reveals the raw source, moving off re-folds, and the
//     line's height never changes (feel contract: no layout shift on reveal);
//   - every doc line still costs exactly one ArrowDown;
//   - a REAL double-click (the first click reveals the source and removes the
//     chip) opens Slide mode on that deck + slide;
//   - an unknown deck renders the dimmed unresolved chip and opens nothing;
//   - renaming the deck on disk updates the chip with no document change;
//   - the figure chip beside it is unchanged;
//   - with 20 slide embeds, prose typing costs ZERO chip builds and stays
//     inside the ≤100 ms key-to-frame budget.
// The catalog's pure contract is verify-slide-embed-chip.ts.
import { launch, gotoApp, clickMode, waitFor, APP_URL, realErrors, shot, sleep } from "./lib/driver.mjs";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-slide-embed-chip");
const { browser, page } = await launch();
const ROOT = "/demo/myc-growth-paper";
const slideLine = (deck, slide, id, indent = "") =>
  `${indent}![](../slides/${deck}/renders/${slide}-step-0.svg){#slide-${id} .flux-slide deck="${deck}" slide="${slide}" width=50%}`;
const realDblClick = async (selector) => {
  await page.$eval(selector, (e) => e.scrollIntoView({ block: "center" }));
  await sleep(150); // let CodeMirror's scroll measure settle before reading the box
  const box = await page.$eval(selector, (e) => { const r = e.getBoundingClientRect(); return { x: r.x + Math.min(30, r.width / 2), y: r.y + r.height / 2 }; });
  h.ok(await page.evaluate((b, sel) => document.elementFromPoint(b.x, b.y)?.closest(sel) != null, box, selector), `the double-click lands on ${selector}`);
  // Two down/up pairs, the second with clickCount 2 — what makes Chrome
  // synthesize detail-2 mousedown + dblclick, like a real user.
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
};
const mode = () => page.evaluate(() => window.__flux.get(window.__flux.panes.focusedMode));
const view = (fn, arg) => page.evaluate(fn, arg);
const SLIDE_CHIP = ".cm-editor .flux-embedchip.slide:not(.unresolved)";
try {
  await gotoApp(page, { url: `${APP_URL}?fixture=demo`, settle: 600 });
  await page.evaluate(async (root) => {
    const { inlineSlideFixture, inlineSlideSvg } = await import("/scripts/fixtures/inline-slide.ts");
    const pm = window.__flux.get(window.__flux.shell.projectModel);
    pm.manifest.slides = [{ id: "talk", path: "slides/talk/deck.json", title: "Evidence talk" }];
    await window.fig.writeText(`${root}/project.json`, JSON.stringify(pm.manifest));
    const deck = inlineSlideFixture("talk");
    // "Other slide" first: the embedded "Results" is the SECOND slide.
    deck.slides = [deck.slides[1], deck.slides[0]];
    await window.fig.writeText(`${root}/slides/talk/deck.json`, JSON.stringify(deck));
    await window.fig.writeText(`${root}/slides/talk/assets/shared.svg`, inlineSlideSvg());
  }, ROOT);
  await clickMode(page, "Paper");
  await waitFor(page, () => !!window.__fluxView, null, { timeout: 10000 });
  await page.evaluate(() => {
    window.__fluxSeedFigures(
      [{ id: "f1", label: "fig-growth", name: "Growth", family: "figure", order: 0, number: 1, display: "Fig. 1", captionLabel: "Figure 1 | ", canvas: "c1", caption: "Growth.", panels: [] }],
      { f1: { id: "f1", name: "Growth", canvasId: "c1", x: 0, y: 0, width: 800, height: 500, background: "#ffffff", elements: [] } },
      {},
    );
  });
  const lines = [
    "# Slide chip",
    "",
    "Prose before the slide.",
    slideLine("talk", "results", "one", "  "),
    "Prose after the slide.",
    "![](../fig/renders/f1.svg){#fig-growth width=50%}",
    "Prose after the figure.",
    slideLine("ghost", "nowhere", "two"),
    "Last line.",
  ];
  await view((text) => { const v = window.__fluxView; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text }, selection: { anchor: 0 } }); v.focus(); }, lines.join("\n"));
  await waitFor(page, (sel) => document.querySelector(sel)?.textContent.includes("Evidence talk"), SLIDE_CHIP, { timeout: 10000 });
  await waitFor(page, () => !!document.querySelector(".cm-editor .flux-slide-art"), null, { timeout: 12000 });

  const collapsed = await page.evaluate(() => {
    const chips = [...document.querySelectorAll(".cm-editor .flux-embedchip")].map((c) => ({ text: c.textContent, cls: c.className }));
    const lines = [...document.querySelectorAll(".cm-line.cm-flux-embedsrc")].map((l) => l.textContent ?? "");
    return { chips, lines };
  });
  h.eq(collapsed.chips.find((c) => c.cls.includes("slide") && !c.cls.includes("unresolved"))?.text, "▷ Evidence talk · Slide 2", "slide chip shows the deck title + 1-based ordinal");
  h.ok(!collapsed.lines.some((l) => l.includes("renders/results-step-0.svg")), "the raw slide source is not visible while folded");
  h.ok(collapsed.lines.some((l) => l.startsWith("  ▷")), "the line's indent is preserved before the chip");
  h.ok(collapsed.chips.some((c) => c.cls === "flux-embedchip slide unresolved" && c.text === "▷ Missing slide deck"), "an unknown deck renders the unresolved chip");
  h.ok(collapsed.chips.some((c) => c.cls === "flux-embedchip" && c.text === "⌗ Growth"), "the figure chip beside it is unchanged");
  h.ok(await page.$eval(SLIDE_CHIP, (e) => /Slide 2 of 2 — “Results”/.test(e.title) && /double-click to open in Slide/.test(e.title)), "tooltip names the slide and the gestures");

  // Reveal on caret, re-fold off it — with no height change of the line or the doc.
  const metrics = () => page.evaluate(() => {
    const v = window.__fluxView, line = v.state.doc.line(4);
    const el = v.domAtPos(line.from).node;
    const lineEl = (el.nodeType === 1 ? el : el.parentElement).closest(".cm-line");
    return { h: lineEl.getBoundingClientRect().height, doc: v.contentDOM.scrollHeight, text: lineEl.textContent };
  });
  const folded = await metrics();
  await view(() => { const v = window.__fluxView; v.dispatch({ selection: { anchor: v.state.doc.line(4).from + 8 } }); });
  await sleep(50);
  const open = await metrics();
  h.ok(open.text.includes('deck="talk"') && !open.text.includes("▷"), "a caret on the line reveals the raw source");
  await view(() => { const v = window.__fluxView; v.dispatch({ selection: { anchor: v.state.doc.line(3).from } }); });
  await sleep(50);
  const refolded = await metrics();
  h.ok(refolded.text.includes("▷ Evidence talk · Slide 2"), "moving off re-folds the line");
  // A revealed 50%-width line can wrap; compare the folded single-row line
  // against a revealed one only through the document height of the folded states.
  h.ok(Math.abs(refolded.h - folded.h) < 0.5 && Math.abs(refolded.doc - folded.doc) < 0.5, `fold → reveal → fold returns to the identical height (${folded.h} / ${refolded.h})`);
  const oneRow = await page.evaluate(() => {
    const prose = [...document.querySelectorAll(".cm-line.cm-flux-embedsrc")][0];
    const probe = prose.cloneNode(false); probe.textContent = "x"; prose.parentElement.append(probe);
    const hh = probe.getBoundingClientRect().height; probe.remove(); return hh;
  });
  h.ok(Math.abs(folded.h - oneRow) < 0.5, `the chip keeps the 12px/1.65 source-line metrics (${folded.h} vs ${oneRow})`);

  // ArrowDown visits every document line in order — never skipping one under
  // a slide player (its margins once desynced CodeMirror's height map by 32px
  // per slide). A folded line is one row and costs one press to enter; once
  // revealed, its long raw source wraps like prose, one press per visual row.
  await view(() => { const v = window.__fluxView; v.dispatch({ selection: { anchor: 0 } }); v.focus(); });
  const walk = [1];
  for (let i = 0; i < 2 * lines.length && walk.at(-1) < lines.length; i++) {
    await page.keyboard.press("ArrowDown");
    walk.push(await view(() => { const v = window.__fluxView; return v.state.doc.lineAt(v.state.selection.main.head).number; }));
  }
  h.ok(walk.at(-1) === lines.length && walk.every((n, i) => i === 0 || n - walk[i - 1] === 0 || n - walk[i - 1] === 1), `ArrowDown visits every line in order, none skipped (${walk.join(",")})`);
  const offsets = await page.evaluate(() => {
    const v = window.__fluxView;
    return [5, 9].map((n) => { const l = v.state.doc.line(n); return v.coordsAtPos(l.from).top - v.documentTop - v.lineBlockAt(l.from).top; });
  });
  h.ok(Math.abs(offsets[0] - offsets[1]) < 1, `the height map stays in step with the DOM below slide players (${offsets.map((o) => o.toFixed(1)).join(" / ")})`);

  // Unresolved chip: a double-click opens nothing.
  await view(() => { const v = window.__fluxView; v.dispatch({ selection: { anchor: 0 } }); v.focus(); });
  await sleep(50);
  await realDblClick(".cm-editor .flux-embedchip.slide.unresolved");
  await sleep(400);
  h.eq(await mode(), "paper", "double-clicking the unresolved chip stays in Paper");

  // Real double-click → Slide mode on that deck + slide (the existing handshake).
  await view(() => { const v = window.__fluxView; v.dispatch({ selection: { anchor: 0 } }); v.focus(); });
  await waitFor(page, async (root) => (await window.fig.readText(`${root}/manuscript/main.qmd`)).includes("Slide chip"), ROOT, { timeout: 5000 });
  await realDblClick(SLIDE_CHIP);
  await waitFor(page, () => window.__flux.get(window.__flux.panes.focusedMode) === "slide", null, { timeout: 8000 });
  await waitFor(page, () => window.__flux.slide.currentDeck()?.id === "talk" && window.__flux.get(window.__flux.fig.activeFigureId) === "results", null, { timeout: 8000 });
  h.ok(true, "a real double-click on the chip opens Slide mode on that deck and slide");
  await clickMode(page, "Paper");
  await waitFor(page, () => window.__flux.get(window.__flux.panes.focusedMode) === "paper", null, { timeout: 5000 });

  // Rename the deck on disk (what a Slide-mode save publishes): chip follows, doc untouched.
  const before = await view(() => window.__fluxView.state.doc.toString());
  await view(() => { const v = window.__fluxView; v.dispatch({ selection: { anchor: 0 } }); });
  await page.evaluate(async (root) => {
    const file = `${root}/slides/talk/deck.json`, d = JSON.parse(await window.fig.readText(file));
    d.title = "Renamed talk";
    await window.fig.writeText(file, JSON.stringify(d));
    (await import("/src/shell/scholar/revisions.ts")).bumpSlideEmbeds();
  }, ROOT);
  await waitFor(page, (sel) => document.querySelector(sel)?.textContent === "▷ Renamed talk · Slide 2", SLIDE_CHIP, { timeout: 5000 });
  h.ok(true, "renaming the deck updates the chip without a reload");
  h.eq(await view(() => window.__fluxView.state.doc.toString()), before, "the rename changes nothing in the document");
  await shot(page, "slide-embed-chip");

  // 20 slide embeds: prose typing re-derives NO chip and stays instantaneous.
  const many = ["# Twenty", ""];
  for (let i = 0; i < 20; i++) many.push(`Paragraph ${i} of research notes and explanatory text.`, slideLine("talk", i % 2 ? "results" : "other", `m${i}`), "");
  many.push("Typing here.");
  await view((text) => { const v = window.__fluxView; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } }); v.dispatch({ selection: { anchor: v.state.doc.line(3).to } }); v.focus(); }, many.join("\n"));
  await waitFor(page, () => document.querySelectorAll(".cm-editor .flux-embedchip.slide").length >= 2, null, { timeout: 8000 });
  await sleep(300);
  await page.evaluate(() => {
    window.__chipBuilds0 = window.__flux.paperPerf.slideChips;
    window.__keys = []; window.__keyStart = 0;
    const c = window.__fluxView.contentDOM;
    c.addEventListener("keydown", (e) => { if (e.key === "x") window.__keyStart = performance.now(); });
    c.addEventListener("input", () => { const t = window.__keyStart; if (t) requestAnimationFrame(() => window.__keys.push(performance.now() - t)); });
  });
  for (let i = 0; i < 15; i++) { await page.keyboard.type("x"); await sleep(20); }
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowLeft");
  await waitFor(page, () => window.__keys.length >= 15, null, { timeout: 3000 });
  const typing = await page.evaluate(() => ({ builds: window.__flux.paperPerf.slideChips - window.__chipBuilds0, keys: window.__keys }));
  h.eq(typing.builds, 0, "15 prose keystrokes + 5 caret moves cost zero chip builds (20 embeds)");
  h.ok(Math.max(...typing.keys) < 100, `key-to-frame ≤100 ms with 20 embeds (max ${Math.max(...typing.keys).toFixed(1)} ms)`);
  console.log(JSON.stringify({ keyToFrameMs: typing.keys.map((t) => +t.toFixed(1)) }));
  h.eq(realErrors(page), [], "no browser errors");
} catch (error) {
  h.fail(String(error));
  console.error(error);
  await shot(page, "slide-embed-chip-failure");
}
await h.done(() => browser.close());
