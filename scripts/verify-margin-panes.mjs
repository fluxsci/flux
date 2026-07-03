// Dynamic-margin pane gate — the summonable frosted-glass pane stack
// (src/shell/modes/paper/margin/marginPanes.ts + MarginPaneFrame.svelte).
// Verifies the owner's contract: at rest the margin shows NOTHING but the
// outline + dynamic background; Alt+R/T/A/F summon panes (open-or-FOCUS if
// already open); panes stack in one column splitting the height equally;
// Alt+P closes the active pane and Ctrl+Alt+P clears all (focus → editor);
// past the max (default 4) the oldest pane is evicted; Escape in a pane input
// closes it back to the editor; Alt+D hides/shows the margin with open panes
// retained.
//   Run (dev server on :1420 must be up): node scripts/verify-margin-panes.mjs
import { launch, gotoApp, clickMode, sleep, realErrors, shot } from "./lib/driver.mjs";

const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
await clickMode(page, "Paper").catch(() => {});
await sleep(600);
await page.evaluate(() => window.__fluxView.focus());

const alt = async (key) => {
  await page.keyboard.down("Alt");
  await page.keyboard.press(key);
  await page.keyboard.up("Alt");
  await sleep(320);
};
const panesState = () =>
  page.evaluate(() => {
    const els = [...document.querySelectorAll(".dynmargin [data-pane-id]")];
    return {
      ids: els.map((e) => e.getAttribute("data-pane-id")),
      heights: els.map((e) => Math.round(e.getBoundingClientRect().height)),
      focusPane: document.activeElement?.closest("[data-pane-id]")?.getAttribute("data-pane-id") ?? null,
      editorFocused: !!document.activeElement?.closest(".cm-content"),
    };
  });

// --- at rest: outline + background only ------------------------------------------
const rest = await panesState();
const restOk = rest.ids.length === 0;
const editorRect = () =>
  page.evaluate(() => {
    const r = document.querySelector(".editor-col").getBoundingClientRect();
    return `${r.x},${r.y},${r.width},${r.height}`;
  });
const edRect0 = await editorRect();
await shot(page, "margin-panes-rest");

// --- Alt+R summons reference search, input focused --------------------------------
await alt("KeyR");
const s1 = await panesState();
const summonOk = s1.ids.join() === "reference-search" && s1.focusPane === "reference-search";

// --- Alt+T splits with the terminal, equal heights ---------------------------------
await alt("KeyT");
const s2 = await panesState();
const splitOk = s2.ids.length === 2 && s2.ids.includes("terminal") && Math.abs(s2.heights[0] - s2.heights[1]) <= 2;

// --- Alt+A + Alt+F → four equal panes ----------------------------------------------
await alt("KeyA");
await alt("KeyF");
const s4 = await panesState();
const fourOk =
  s4.ids.length === 4 && Math.max(...s4.heights) - Math.min(...s4.heights) <= 2 && s4.focusPane === "figure";
// Pane opens live in absolute layers — the editor column must not move a pixel.
const editorStableOk = (await editorRect()) === edRect0;
await shot(page, "margin-panes-four");

// --- summon-if-open FOCUSES (no duplicate pane) ------------------------------------
await alt("KeyR");
const s5 = await panesState();
const refocusOk = s5.ids.length === 4 && s5.focusPane === "reference-search";

// --- Alt+P closes the ACTIVE pane, editor refocused --------------------------------
await alt("KeyP");
const s6 = await panesState();
const closeActiveOk = s6.ids.length === 3 && !s6.ids.includes("reference-search") && s6.editorFocused;

// --- legend notch: no pane may draw its top border through its title ---------------
// Three stacked panes sit at FRACTIONAL y offsets (the equal flex split) — the
// case where native fieldset legends mispainted. Hide the legend text, then
// count border-colored pixel columns in each label band at the pane's top
// edge: a proper notch leaves the band empty; a strike-through fills it.
const notch = await (async () => {
  const panes = await page.evaluate(() => {
    document.getElementById("notch-probe")?.remove();
    const st = document.createElement("style");
    st.id = "notch-probe";
    st.textContent = ".dynmargin [data-pane-id] .legend { visibility: hidden; }";
    document.head.appendChild(st);
    return [...document.querySelectorAll(".dynmargin [data-pane-id]")].map((el) => {
      const r = el.getBoundingClientRect();
      const lg = el.querySelector(".legend").getBoundingClientRect();
      return { id: el.getAttribute("data-pane-id"), top: r.y, x0: lg.x + 3, x1: lg.x + lg.width - 3 };
    });
  });
  await sleep(80);
  const b64 = await page.screenshot({ encoding: "base64" });
  const rows = await page.evaluate(
    async (png, ps) => {
      const img = new Image();
      img.src = "data:image/png;base64," + png;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      return ps.map((p) => {
        const w = Math.max(1, Math.round(p.x1 - p.x0));
        const d = g.getImageData(Math.round(p.x0), Math.round(p.top) - 2, w, 5).data;
        let cols = 0;
        for (let x = 0; x < w; x++) {
          for (let y = 0; y < 5; y++) {
            const i = (y * w + x) * 4;
            if (Math.abs(d[i] - 255) + Math.abs(d[i + 1] - 252) + Math.abs(d[i + 2] - 240) > 140) {
              cols++;
              break;
            }
          }
        }
        return { id: p.id, coverage: +(cols / w).toFixed(2) };
      });
    },
    b64,
    panes
  );
  await page.evaluate(() => document.getElementById("notch-probe")?.remove());
  return rows;
})();
const notchOk = notch.length === 3 && notch.every((r) => r.coverage < 0.6);

// --- eviction past the max (default 4): oldest goes --------------------------------
// Stack is [terminal, comments, figure]; + stats = 4; + bibliography evicts terminal.
await page.evaluate(() => window.__fluxMargin.summon("stats"));
await sleep(250);
await page.evaluate(() => window.__fluxMargin.summon("bibliography"));
await sleep(250);
const s7 = await panesState();
const evictOk = s7.ids.length === 4 && !s7.ids.includes("terminal") && s7.ids.includes("bibliography");

// --- Ctrl+Alt+P clears the margin, editor refocused --------------------------------
await page.keyboard.down("Control");
await page.keyboard.down("Alt");
await page.keyboard.press("KeyP");
await page.keyboard.up("Alt");
await page.keyboard.up("Control");
await sleep(320);
const s8 = await panesState();
const clearOk = s8.ids.length === 0 && s8.editorFocused;

// --- Escape in a pane input closes it back to the editor ---------------------------
await alt("KeyR");
await page.keyboard.press("Escape");
await sleep(250);
const s9 = await panesState();
const escOk = s9.ids.length === 0 && s9.editorFocused;

// --- figure pane: wheel-zoom toward the cursor, drag-pan, dblclick reset ------------
await alt("KeyF");
const stageBox = await page.evaluate(() => {
  const s = document.querySelector(".fv .stage");
  if (!s) return null;
  const r = s.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
const zoomer = () => page.evaluate(() => document.querySelector(".fv .zoomer")?.style.transform ?? "");
let zoomOk = false;
let panOk = false;
let zresetOk = false;
if (stageBox) {
  const t0 = await zoomer();
  await page.mouse.move(stageBox.x, stageBox.y);
  await page.mouse.wheel({ deltaY: -240 }); // zoom in ≈ 1.43×
  await sleep(150);
  const t1 = await zoomer();
  zoomOk = t1 !== t0 && /scale\(1\.[2-9]/.test(t1);
  await page.mouse.down();
  await page.mouse.move(stageBox.x + 40, stageBox.y + 25, { steps: 4 });
  await page.mouse.up();
  await sleep(120);
  const t2 = await zoomer();
  panOk = t2 !== t1;
  await page.mouse.move(stageBox.x, stageBox.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
  await sleep(120);
  zresetOk = /translate3d\(0px, 0px, 0(px)?\) scale\(1\)/.test(await zoomer());
}

// --- Alt+D hides/shows the margin; open panes are retained -------------------------
await alt("KeyD");
const hidden = await page.evaluate(() => !document.querySelector(".dynmargin"));
await alt("KeyD");
await sleep(200);
const s10 = await panesState();
const toggleOk = hidden && s10.ids.join() === "figure";
await shot(page, "margin-panes-final");

// --- settings: paperMaxMarginPanes caps the stack; clean margin auto-clears --------
await page.evaluateOnNewDocument(() => {
  localStorage.setItem("flux.settings", JSON.stringify({ paperMaxMarginPanes: 2, paperCleanMargin: true }));
});
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3000 });
await clickMode(page, "Paper").catch(() => {});
await sleep(500);
await page.evaluate(() => window.__fluxView.focus());
await alt("KeyR");
await alt("KeyT");
await alt("KeyA"); // third summon with max 2 → the oldest (reference-search) evicts
const sm1 = await panesState();
const maxOk = sm1.ids.length === 2 && !sm1.ids.includes("reference-search");
await page.evaluate(() => window.__fluxView.focus());
await sleep(500); // clean-margin debounce is 180ms
const sm2 = await panesState();
const cleanOk = sm2.ids.length === 0 && sm2.editorFocused;

// Clean margin must NOT fire on a transient focus round-trip (the
// citation-group write path focuses the editor for <180ms and reclaims it).
await alt("KeyR");
await page.evaluate(() => {
  window.__fluxView.focus();
  setTimeout(() => document.querySelector(".rsp input")?.focus(), 60);
});
await sleep(600);
const sm3 = await panesState();
const debounceOk = sm3.ids.join() === "reference-search";

const errs = realErrors(page);
await browser.close();

const res = { restOk, summonOk, splitOk, fourOk, editorStableOk, refocusOk, closeActiveOk, notchOk, evictOk, clearOk, escOk, zoomOk, panOk, zresetOk, toggleOk, maxOk, cleanOk, debounceOk };
console.log(JSON.stringify({ panes: res, s4, s7, notch, errs }, null, 2));
const ok = Object.values(res).every(Boolean) && errs.length === 0;
if (!ok) {
  console.error("\nMARGIN PANES VERIFY: FAIL");
  process.exit(1);
}
console.log("\nMARGIN PANES VERIFY: PASS");
