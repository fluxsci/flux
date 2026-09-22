// Per-RANGE text formatting in the real app (2026-09-22) — the GUI half of
// verify-text-runs:
//   • selecting a word in the inline editor and pressing Ctrl+I formats THAT
//     word, leaving the element's own font alone;
//   • the painted SVG carries the run as a nested tspan inside its line tspan;
//   • typing inside a formatted word keeps it formatted (runs remap live);
//   • one undo takes the whole range toggle back;
//   • with NOTHING selected the same chord still toggles the whole box, which
//     is the behaviour every earlier gate pins.
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

  const errs = realErrors(page);
  assert(errs.length === 0, `no renderer errors (${errs.slice(0, 2).join(" | ")})`);
} finally {
  await browser.close();
}

console.log(fails === 0 ? "\nTEXT RUNS GUI: ALL PASS" : `\nTEXT RUNS GUI: ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
