// OS-clipboard image paste (Figma-style screenshot paste) + arbitration.
// Drives the real GUI paste entry (window "paste" event → keyboard.ts
// handleEditorPaste): an image File on the clipboard imports through the
// standard pipeline as an image element + pasted-* asset; the in-app marker
// text wins over a stale image (no double paste); focused inputs are never
// hijacked; the no-marker/no-image case falls back to the internal clipboard.
import { launch, gotoApp, clickMode, shot, realErrors, sleep } from "./lib/driver.mjs";
import { waitFor } from "./lib/wait.mjs";

let fails = 0;
function assert(cond, msg) {
  if (cond) console.log("  ok:", msg);
  else {
    fails++;
    console.error("  FAIL:", msg);
  }
}

const { browser, page } = await launch();
try {
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3000 });
  await clickMode(page, "Figure");
  await sleep(700);

  const counts = () =>
    page.evaluate(() => {
      const F = window.__flux;
      const p = F.get(F.fig.project);
      const els = p.figures.flatMap((f) => f.elements);
      return {
        image: els.filter((e) => e.type === "image").length,
        rect: els.filter((e) => e.type === "rect").length,
        assets: (p.assets ?? []).length,
      };
    });

  await page.evaluate(() => {
    const F = window.__flux.fig;
    const p = window.__flux.get(F.project);
    F.activeFigureId.set(p.figures[0].id);
  });

  // In-page helper: dispatch a synthetic paste with an optional image file +
  // optional text, on window or on a given element.
  await page.evaluate(() => {
    window.__dispatchPaste = async ({ withImage, text, onInput }) => {
      const dt = new DataTransfer();
      if (text) dt.setData("text/plain", text);
      if (withImage) {
        const c = document.createElement("canvas");
        c.width = 8;
        c.height = 8;
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#d62728";
        ctx.fillRect(0, 0, 8, 8);
        const blob = await new Promise((r) => c.toBlob(r, "image/png"));
        dt.items.add(new File([blob], "image.png", { type: "image/png" }));
      }
      let evt = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
      if (!evt.clipboardData) Object.defineProperty(evt, "clipboardData", { value: dt });
      if (onInput) {
        const inp = document.createElement("input");
        document.body.appendChild(inp);
        inp.focus();
        inp.dispatchEvent(evt);
        inp.remove();
      } else {
        window.dispatchEvent(evt);
      }
    };
  });

  // --- 1. screenshot paste: image File → image element + pasted-* asset ---
  const c0 = await counts();
  await page.evaluate(() => window.__dispatchPaste({ withImage: true }));
  await waitFor(
    page,
    (n) => {
      const F = window.__flux;
      const p = F.get(F.fig.project);
      return p.figures.flatMap((f) => f.elements).filter((e) => e.type === "image").length === n;
    },
    c0.image + 1,
    { label: "pasted image element appears" },
  );
  const pasted = await page.evaluate(() => {
    const F = window.__flux;
    const p = F.get(F.fig.project);
    const els = p.figures.flatMap((f) => f.elements).filter((e) => e.type === "image");
    const el = els[els.length - 1];
    const asset = (p.assets ?? []).find((a) => a.id === el.assetId);
    const sel = [...F.get(F.fig.selection)];
    return { w: el.width, h: el.height, assetName: asset?.name ?? "", kind: asset?.kind, selected: sel.includes(el.id) };
  });
  assert(pasted.w === 8 && pasted.h === 8, `pasted at natural size 8x8 (got ${pasted.w}x${pasted.h})`);
  assert(/^pasted-\d{4}-\d{2}-\d{2}-\d{6}\.png$/.test(pasted.assetName), `dated display name (got "${pasted.assetName}")`);
  assert(pasted.kind === "png", "asset kind png");
  assert(pasted.selected, "pasted element is selected");
  await shot(page, "paste-01-image");

  // --- 2. arbitration: marker + internal elements beat a stale image ---
  // Seed + select a rect, copy it (Ctrl+C keeps the internal clipboard; the
  // navigator.clipboard marker write may be permission-denied headless — the
  // synthetic paste below supplies the marker text explicitly).
  await page.evaluate(() => {
    const F = window.__flux.fig;
    let id;
    F.commit((p) => {
      const g = p.figures[0];
      id = F.newId("rect");
      g.elements.push({ type: "rect", id, x: 20, y: 20, width: 60, height: 40, rotation: 0, fill: "#2ca02c", stroke: "#222222", strokeWidth: 2, cornerRadius: 0 });
    });
    F.selectOnly(id);
  });
  await sleep(150);
  await page.keyboard.down("Control");
  await page.keyboard.press("c");
  await page.keyboard.up("Control");
  await sleep(150);
  const c1 = await counts();
  await page.evaluate(() => window.__dispatchPaste({ withImage: true, text: "flux:elements:v1" }));
  await waitFor(
    page,
    (n) => {
      const F = window.__flux;
      const p = F.get(F.fig.project);
      return p.figures.flatMap((f) => f.elements).filter((e) => e.type === "rect").length === n;
    },
    c1.rect + 1,
    { label: "marker paste clones the internal rect" },
  );
  const c2 = await counts();
  assert(c2.image === c1.image, `marker beats stale image: image count unchanged (${c1.image} -> ${c2.image})`);
  assert(c2.rect === c1.rect + 1, "internal elements pasted exactly once");

  // --- 3. focused input is never hijacked ---
  await page.evaluate(() => window.__dispatchPaste({ withImage: true, onInput: true }));
  await sleep(600); // debounce: give a wrong-path import time to land before counting
  const c3 = await counts();
  assert(c3.image === c2.image && c3.rect === c2.rect, "paste into a focused input imports nothing");

  // --- 4. fallback: no marker, no image → internal clipboard still pastes ---
  await page.evaluate(() => window.__dispatchPaste({}));
  await waitFor(
    page,
    (n) => {
      const F = window.__flux;
      const p = F.get(F.fig.project);
      return p.figures.flatMap((f) => f.elements).filter((e) => e.type === "rect").length === n;
    },
    c3.rect + 1,
    { label: "bare paste falls back to internal clipboard" },
  );

  const errs = realErrors(page);
  assert(errs.length === 0, `no console errors (${errs.length})`);
  if (errs.length) console.error(errs.slice(0, 5));
  console.log(fails === 0 ? "\nPASTE ALL PASS" : `\nPASTE ${fails} FAILURE(S)`);
} finally {
  await browser.close();
}
process.exit(fails === 0 ? 0 : 1);
