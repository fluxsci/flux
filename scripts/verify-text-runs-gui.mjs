// Per-RANGE text formatting in the real app (2026-09-22) — the GUI half of
// verify-text-runs:
//   • selecting a word in the inline editor and pressing Ctrl+I formats THAT
//     word, leaving the element's own font alone;
//   • the painted SVG carries the run as a nested tspan inside its line tspan;
//   • typing inside a formatted word keeps it formatted (runs remap live);
//   • one undo takes the whole range toggle back;
//   • with NOTHING selected the same chord still toggles the whole box, which
//     is the behaviour every earlier gate pins;
//   • (2026-09-24) the Inspector's B/I/U buttons and Text colour act on the
//     selected letters, keep the editor focused for a second button, and go
//     back to the whole box after a canvas click.
// Screenshot: a label with one italic word (render evidence).
import { launch, gotoApp, clickMode, shot, realErrors, sleep } from "./lib/driver.mjs";

let fails = 0;
function assert(cond, msg) {
  if (cond) console.log("  ok:", msg);
  else {
    fails++;
    console.error("  FAIL:", msg);
  }
}

const { browser, page } = await launch({ width: 1440, height: 900 });
try {
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
  await clickMode(page, "Figure");
  await sleep(700);

  await page.evaluate(() => {
    const F = window.__flux.fig;
    F.commit((p) => {
      const g = p.figures.find((f) => f.id === "growth") || p.figures[0];
      g.x = 0; g.y = 0; g.width = 1000; g.height = 700;
      g.elements = [{
        type: "text", id: "runs-t1", x: 60, y: 40, width: 260, height: 26, rotation: 0,
        text: "Homo sapiens here", fontFamily: "Arial", fontSize: 18, fontWeight: 400,
        fontStyle: "normal", align: "left", color: "#111111", sizing: "auto",
      }];
    });
    F.viewport.set({ panX: 120, panY: 120, zoom: 1 });
    F.selectOnly("runs-t1");
  });
  await sleep(200);

  const el = () => page.evaluate(() => window.__flux.figures().flatMap((f) => f.elements).find((e) => e.id === "runs-t1"));
  const mod = async (k) => {
    await page.keyboard.down("Control");
    await page.keyboard.press(k);
    await page.keyboard.up("Control");
    await sleep(200);
  };
  const openEditor = async () => {
    const c = await page.evaluate(() => {
      const vp = window.__flux.get(window.__flux.fig.viewport);
      const host = document.querySelector(".canvas-host").getBoundingClientRect();
      return { x: host.left + vp.panX + 80 * vp.zoom, y: host.top + vp.panY + 52 * vp.zoom };
    });
    await page.mouse.click(c.x, c.y, { count: 2 });
    await sleep(400);
    return page.evaluate(() => !!document.querySelector("textarea.text-edit"));
  };
  // Blur COMMITS the edit session; Escape discards it (editSession.cancel),
  // so a gate that ends an edit with Escape is testing the undo path.
  const commitEdit = async () => { await page.evaluate(() => document.querySelector("textarea.text-edit")?.blur()); await sleep(350); };
  const select = (from, to) => page.evaluate(([a, b]) => {
    const t = document.querySelector("textarea.text-edit");
    t.focus();
    t.setSelectionRange(a, b);
  }, [from, to]);

  // ---- one word, not the whole box ---------------------------------------------
  assert(await openEditor(), "the inline editor opens on the label");
  await select(5, 12); // "sapiens"
  await mod("i");
  let e = await el();
  assert(JSON.stringify(e.runs) === JSON.stringify([{ from: 5, to: 12, italic: true }]),
    `Ctrl+I on a selected word stores exactly that run (${JSON.stringify(e.runs)})`);
  assert(e.fontStyle === "normal", "the element's own font style is untouched by a range toggle");

  // ---- the formatting is visible WHILE editing ----------------------------------
  {
    const live = await page.evaluate(() => {
      const ta = document.querySelector("textarea.text-edit");
      const g = document.querySelector('[data-editor-element-id="runs-t1"]');
      const nested = [...(g?.querySelectorAll("text tspan tspan") ?? [])].map((s) => [s.textContent, s.getAttribute("font-style")]);
      return { ghost: ta?.classList.contains("ghost-text"), hidden: g?.classList.contains("editing-hidden"), nested };
    });
    assert(live.ghost && !live.hidden, "the painted text stays visible while editing a metric-neutral run");
    assert(live.nested.some(([text, style]) => text === "sapiens" && style === "italic"),
      `...so the italic shows before the edit is committed (${JSON.stringify(live.nested)})`);
  }

  // ---- the painted SVG ----------------------------------------------------------
  await commitEdit();
  const painted = await page.evaluate(() => {
    const t = document.querySelector('[data-editor-element-id="runs-t1"] text');
    if (!t) return null;
    const nested = [...t.querySelectorAll("tspan tspan")].map((s) => [s.textContent, s.getAttribute("font-style"), s.getAttribute("x")]);
    return { outer: t.getAttribute("font-style"), nested, all: t.textContent };
  });
  assert(painted && painted.all === "Homo sapiens here", `the label still paints its whole text (${painted && painted.all})`);
  assert(painted && painted.nested.some(([text, style]) => text === "sapiens" && style === "italic"),
    `the italic word is a nested tspan (${JSON.stringify(painted && painted.nested)})`);
  assert(painted && painted.nested.every(([, , x]) => x === null),
    "a segment tspan sets no x — that would restart the line");
  assert(!painted || painted.outer === null || painted.outer === "normal",
    "the outer <text> keeps the element's own upright style");
  await shot(page, "text-runs-01-italic-word");

  // ---- typing inside a run keeps it ---------------------------------------------
  assert(await openEditor(), "the editor reopens");
  await select(8, 8); // inside "sapiens"
  await page.keyboard.type("X");
  await sleep(300);
  e = await el();
  assert(e.text === "Homo sapXiens here", `typing inside the word edits the text (${e.text})`);
  assert(JSON.stringify(e.runs) === JSON.stringify([{ from: 5, to: 13, italic: true }]),
    `the run grew with the character typed inside it (${JSON.stringify(e.runs)})`);

  // ---- undo ---------------------------------------------------------------------
  await commitEdit();
  await page.evaluate(() => window.__flux.fig.undo());
  await sleep(250);
  e = await el();
  assert(e.text === "Homo sapiens here", "one undo takes the typed character back");
  await page.evaluate(() => window.__flux.fig.undo());
  await sleep(250);
  e = await el();
  assert(!e.runs || e.runs.length === 0, `one more undo takes the range toggle back (${JSON.stringify(e.runs)})`);

  // ---- selecting ALL of it means the whole box, not a run ------------------------
  await page.evaluate(() => window.__flux.fig.selectOnly("runs-t1"));
  await sleep(150);
  assert(await openEditor(), "the editor opens on the whole-selection case");
  await select(0, 17);
  await mod("i");
  e = await el();
  assert(e.fontStyle === "italic" && (!e.runs || !e.runs.length),
    `selecting every character italicises the ELEMENT, not a run (${e.fontStyle}, ${JSON.stringify(e.runs)})`);
  await mod("i");
  await commitEdit();

  // ---- no selection still means the whole box ------------------------------------
  await page.evaluate(() => window.__flux.fig.selectOnly("runs-t1"));
  await sleep(150);
  assert(await openEditor(), "the editor opens again");
  await select(0, 0);
  await mod("b");
  e = await el();
  assert(e.fontWeight === 700 && (!e.runs || !e.runs.length),
    `with nothing selected the chord still bolds the whole element (${e.fontWeight}, ${JSON.stringify(e.runs)})`);
  await commitEdit();

  // ---- the Inspector acts on the selected letters, not the box (2026-09-24) -----
  // Owner report: "the style would just apply to the whole box instead of to the
  // selected letters". Real mouse clicks, so the focus move a panel click causes
  // is part of what is tested.
  await page.evaluate(() => {
    window.__flux.fig.commit((p) => {
      const t = p.figures.flatMap((f) => f.elements).find((x) => x.id === "runs-t1");
      t.fontWeight = 400; t.fontStyle = "normal"; t.color = "#111111"; delete t.runs;
    });
    window.__flux.fig.selectOnly("runs-t1");
  });
  await sleep(200);
  const clickSel = async (selector) => {
    const c = await page.evaluate((s) => {
      const n = document.querySelector(s);
      if (!n) return null;
      const b = n.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }, selector);
    if (!c) throw new Error(`missing ${selector}`);
    await page.mouse.click(c.x, c.y);
    await sleep(250);
  };
  assert(await openEditor(), "the editor opens for the Inspector checks");
  await select(5, 12); // "sapiens"
  await sleep(150);
  assert(await page.evaluate(() => !!document.querySelector("[data-text-range]")),
    "the Inspector says it is styling the selected characters");
  await clickSel('button.biu[title^="Bold"]');
  e = await el();
  assert(JSON.stringify(e.runs) === JSON.stringify([{ from: 5, to: 12, bold: true }]) && e.fontWeight === 400,
    `the Inspector's Bold button bolds only the selected word (${e.fontWeight}, ${JSON.stringify(e.runs)})`);
  assert(await page.evaluate(() => document.activeElement?.matches("textarea.text-edit") ?? false),
    "...and the editor keeps focus, so the letters stay selected");
  await clickSel('button.biu[title^="Italicise"]');
  e = await el();
  assert(JSON.stringify(e.runs) === JSON.stringify([{ from: 5, to: 12, bold: true, italic: true }]) && e.fontStyle === "normal",
    `a second Inspector button acts on the same letters (${JSON.stringify(e.runs)})`);
  assert(await page.evaluate(() => document.querySelector('button.biu[title^="Italicise"]')?.getAttribute("aria-pressed") === "true"),
    "the Italic button reads pressed for the selected letters");
  // Colour: opening the picker takes focus, which closes the editor; the letters
  // are kept, so the pick still lands on them.
  await clickSel('button.swrow[title^="Colour of the selected letters"]');
  const swatch = await page.evaluate(() => {
    // A DARK swatch, so the screenshot shows the recoloured word on white.
    const dark = (hex) => { const v = parseInt(hex.slice(1), 16); return ((v >> 16) & 255) * 0.3 + ((v >> 8) & 255) * 0.59 + (v & 255) * 0.11 < 110; };
    const n = [...document.querySelectorAll(".pop .sw[data-r]")].find((s) => { const hex = (s.getAttribute("title") ?? "").split("· ").pop(); return !s.classList.contains("none") && /^#[0-9a-f]{6}$/i.test(hex) && dark(hex) && hex.toLowerCase() !== "#111111"; });
    if (!n) return null;
    n.dataset.pick = "1";
    n.scrollIntoView({ block: "nearest" });
    return (n.getAttribute("title") ?? "").split("· ").pop();
  });
  assert(!!swatch, `the colour picker offers a palette swatch (${swatch})`);
  if (swatch) {
    await clickSel('.pop .sw[data-pick="1"]');
    e = await el();
    const colored = (e.runs ?? []).filter((r) => r.color);
    assert(colored.length === 1 && colored[0].from === 5 && colored[0].to === 12 && colored[0].color.toLowerCase() === swatch.toLowerCase(),
      `a palette colour paints only the selected word (${JSON.stringify(e.runs)})`);
    assert(e.color === "#111111", `the box keeps its own colour (${e.color})`);
    const fill = await page.evaluate(() => [...document.querySelectorAll('[data-editor-element-id="runs-t1"] text tspan tspan')].map((s) => [s.textContent, s.getAttribute("fill")]));
    assert(fill.some(([t, f]) => t === "sapiens" && (f ?? "").toLowerCase() === swatch.toLowerCase()),
      `the canvas paints the word in that colour (${JSON.stringify(fill)})`);
    await shot(page, "text-runs-02-inspector-range");
  }
  // Clicking the canvas retires the kept letters: the box is the target again.
  await page.keyboard.press("Escape");
  await sleep(150);
  await page.evaluate(() => window.__flux.fig.selectOnly("runs-t1"));
  await sleep(150);
  const host = await page.evaluate(() => { const b = document.querySelector(".canvas-host").getBoundingClientRect(); return { x: b.right - 30, y: b.bottom - 30 }; });
  await page.mouse.click(host.x, host.y);
  await sleep(200);
  await page.evaluate(() => window.__flux.fig.selectOnly("runs-t1"));
  await sleep(200);
  assert(await page.evaluate(() => !document.querySelector("[data-text-range]")),
    "after a canvas click the Inspector targets the whole box again");
  await clickSel('button.biu[title^="Bold"]');
  e = await el();
  assert(e.fontWeight === 700, `...and its Bold button bolds the element (${e.fontWeight})`);

  // ---- the live preview really is the painted text (2026-09-24) -----------------
  // Owner report: while a word was selected its glyphs looked wrong, and boxes
  // with a bold word showed no formatting at all until clicking away. Two
  // causes: the textarea's inline color outranked the ghost class, so upright
  // glyphs were drawn over the italic ones; and any bold run disabled the
  // preview. A bold run now keeps it while the plain editor breaks lines where
  // the renderer does, and only a bold word that moves a wrap point falls back.
  const preview = async () => page.evaluate(() => {
    const ta = document.querySelector("textarea.text-edit");
    const g = document.querySelector('[data-editor-element-id="runs-t1"]');
    return { ghost: ta?.classList.contains("ghost-text"), color: ta ? getComputedStyle(ta).color : null,
      hidden: g?.classList.contains("editing-hidden"),
      bold: [...(g?.querySelectorAll('text tspan tspan[font-weight="700"]') ?? [])].map((s) => s.textContent) };
  });
  const setRuns = (patch) => page.evaluate((patch) => {
    window.__flux.fig.commit((p) => { const t = p.figures.flatMap((f) => f.elements).find((x) => x.id === "runs-t1"); Object.assign(t, patch); });
    window.__flux.fig.selectOnly("runs-t1");
  }, patch);
  await setRuns({ text: "Homo sapiens here", fontWeight: 400, fontStyle: "normal", sizing: "auto", runs: [{ from: 0, to: 4, italic: true }] });
  await sleep(200);
  assert(await openEditor(), "the editor opens for the preview checks");
  let pv = await preview();
  assert(pv.ghost && pv.color === "rgba(0, 0, 0, 0)" && !pv.hidden,
    `in preview mode the textarea's own glyphs are transparent over the painted text (${JSON.stringify(pv)})`);
  await commitEdit();
  await setRuns({ runs: [{ from: 5, to: 12, bold: true }] });
  await sleep(200);
  assert(await openEditor(), "the editor opens on a box with a bold word");
  pv = await preview();
  assert(pv.ghost && !pv.hidden && pv.bold.includes("sapiens"),
    `a bold word is visible while editing when it moves no line break (${JSON.stringify(pv)})`);
  await commitEdit();
  // A width where the bold word pushes a word onto the next line: found with
  // the app's own wrap and measure, so the case is exact rather than guessed.
  const width = await page.evaluate(() => {
    const T = window.__flux.text;
    const base = { type: "text", id: "w", text: "Homo sapiens here", x: 0, y: 0, width: 100, height: 30, rotation: 0, fontFamily: "Arial", fontSize: 18, fontWeight: 400, fontStyle: "normal", align: "left", color: "#111111", sizing: "auto-h" };
    const bold = { ...base, runs: [{ from: 5, to: 12, bold: true }] };
    for (let w = 60; w < 260; w += 0.5) {
      const a = T.wrapText(base.text, w, T.elementMeasure(base)), b = T.wrapText(bold.text, w, T.elementMeasure(bold));
      if (a.join("\n") !== b.join("\n")) return w;
    }
    return null;
  });
  assert(width !== null, `a width exists where the bold word moves a wrap point (${width})`);
  if (width !== null) {
    await setRuns({ sizing: "auto-h", width, runs: [{ from: 5, to: 12, bold: true }] });
    await page.evaluate(() => window.__flux.fig.commit((p) => { const t = p.figures.flatMap((f) => f.elements).find((x) => x.id === "runs-t1"); window.__flux.text.applyTextLayout(t); }));
    await sleep(200);
    assert(await openEditor(), "the editor opens on the wrap-moving case");
    pv = await preview();
    assert(!pv.ghost && pv.hidden, `...where it falls back to the plain editor so the caret stays on the right line (${JSON.stringify(pv)})`);
    await commitEdit();
  }

  const errs = realErrors(page);
  assert(errs.length === 0, `no renderer errors (${errs.slice(0, 2).join(" | ")})`);
} finally {
  await browser.close();
}

console.log(fails === 0 ? "\nTEXT RUNS GUI: ALL PASS" : `\nTEXT RUNS GUI: ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
