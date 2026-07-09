// figure-v1 P0b gate (browser) — the Alt+I Plot Importer's multi-select in FIGURE
// mode, end-to-end against the demo fixture: Enter TOGGLES a plot into the picked
// set (✓ + count pill, no close), Enter on a dir descends, Space toggles only
// while the search box is empty (else it types — filenames contain spaces), the
// selection survives folder navigation AND browse↔search, row clicks toggle and
// hand focus back to the search input, and Ctrl+Enter inserts the whole batch —
// or exactly the highlighted plot when nothing is picked (no-op on a dir). The
// batch lands via io.importPlotsFromPaths: physical size, grid-packed without
// overlap, ONE selection of all new elements, per-file failures → ONE error toast.
//   Run (dev server on :1420 must be up): node scripts/verify-importer-multi.mjs
import { launch, gotoApp, clickMode, sleep, realErrors } from "./lib/driver.mjs";

let fails = 0;
const ok = (cond, msg, extra = "") =>
  cond ? console.log("  ✓ " + msg) : (fails++, console.log("  ✗ " + msg + (extra ? ` — ${extra}` : "")));

const ROOT = "/demo/myc-growth-paper";
const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3000 });
await clickMode(page, "Figure");
await sleep(700);

// ---- seed a plots/ tree BEFORE opening the importer (open() scans once) -------
await page.evaluate(async (root) => {
  const svg = (fill) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="72pt" height="72pt" viewBox="0 0 72 72"><rect width="72" height="72" fill="${fill}"/></svg>`;
  const manifest = JSON.stringify({ schemaVersion: "0.1.0", axes: [], series: [], guides: [], overlays: [] });
  await window.fig.writeText(`${root}/plots/alpha decay.svg`, svg("#d95f02"));
  await window.fig.writeText(`${root}/plots/bravo.svg`, svg("#1b9e77"));
  await window.fig.writeText(`${root}/plots/bravo.fluxplot.json`, manifest);
  await window.fig.writeText(`${root}/plots/sub/charlie.svg`, svg("#7570b3"));
  await window.fig.writeText(`${root}/plots/sub/delta.svg`, svg("#e7298a"));
}, ROOT);

const snap = () =>
  page.evaluate(() => {
    const F = window.__flux;
    const p = F.get(F.fig.project);
    const fig = F.figures()[0];
    return {
      open: !!document.querySelector(".importer"),
      pill: document.querySelector(".pickpill")?.textContent?.trim() ?? "",
      pickedRows: [...document.querySelectorAll(".row.picked .nm")].map((n) => n.textContent),
      glyphs: [...document.querySelectorAll(".row.picked .ic")].map((n) => n.textContent?.trim()),
      curDir: document.querySelector(".path .cur")?.textContent ?? "",
      search: document.querySelector(".search-in")?.value ?? "",
      inputFocused: document.activeElement === document.querySelector(".search-in"),
      els: fig.elements.map((e) => ({
        id: e.id,
        type: e.type,
        x: e.x,
        y: e.y,
        w: e.width,
        h: e.height,
        asset: p.assets.find((a) => a.id === e.assetId)?.name ?? null,
        // fluxplot vs vanilla discriminator (figure-v1 P4: ALL svgs are plots;
        // a real sidecar shows up as manifestRef + source.manifestPath)
        semantic: !!(e.manifestRef && e.source?.manifestPath),
      })),
      selection: [...F.get(F.fig.selection)],
    };
  });

const altI = async () => {
  await page.keyboard.down("Alt");
  await page.keyboard.press("KeyI");
  await page.keyboard.up("Alt");
  await sleep(450); // open() + rAF focus + background scan
};
const ctrlEnter = async () => {
  await page.keyboard.down("Control");
  await page.keyboard.press("Enter");
  await page.keyboard.up("Control");
  await sleep(500);
};

const base = (await snap()).els.length;

// ---- open + toggle mechanics ---------------------------------------------------
await altI();
let s = await snap();
ok(s.open, "Alt+I opens the importer");
ok(s.inputFocused, "search input holds keyboard focus on open");

// browse rows (dirs first, then files alphabetical): [sub, alpha decay, bravo]
await page.keyboard.press("ArrowDown"); // → "alpha decay"
await page.keyboard.press("Enter");
s = await snap();
ok(s.open && s.pill === "1 selected", `Enter on a file TOGGLES it — no close, count pill (${s.pill || "no pill"})`);
ok(s.glyphs.includes("✓"), "picked row shows the ✓ glyph", s.glyphs.join(","));
await page.keyboard.press("Enter");
s = await snap();
ok(s.pill === "" && s.pickedRows.length === 0, "Enter again un-toggles (pill hidden at 0)");
await page.keyboard.press(" ");
s = await snap();
ok(s.pill === "1 selected", `Space toggles while the search box is empty (${s.pill || "no pill"})`);

await page.keyboard.press("ArrowDown"); // → bravo (semantic)
await page.keyboard.press("Enter");
s = await snap();
ok(s.pill === "2 selected", `picked a second plot (${s.pill})`);

// ---- selection survives folder navigation --------------------------------------
await page.keyboard.press("ArrowUp");
await page.keyboard.press("ArrowUp"); // → sub/
await page.keyboard.press("Enter");
await sleep(250);
s = await snap();
ok(s.curDir === "sub", `Enter on a dir descends (now in "${s.curDir}")`);
ok(s.pill === "2 selected", `selection survives folder navigation (${s.pill})`);
await page.keyboard.press("ArrowDown"); // → charlie
await page.keyboard.press(" ");
s = await snap();
ok(s.pill === "3 selected", `Space-picked a file in the subfolder (${s.pill})`);

// ---- selection survives browse↔search; Space types when the box has text -------
await page.keyboard.type("delta");
await sleep(250);
await page.keyboard.press("Enter"); // toggle the (only) search hit
s = await snap();
ok(s.pill === "4 selected", `toggled a search-mode row (${s.pill})`);
await page.keyboard.press("Escape"); // clear search → back to browse
s = await snap();
ok(s.open && s.search === "" && s.pill === "4 selected", `selection survives search → browse (${s.pill})`);
await page.keyboard.type("char");
await page.keyboard.press(" ");
s = await snap();
ok(s.search === "char " && s.pill === "4 selected", `Space TYPES while searching — no toggle ("${s.search}", ${s.pill})`);
await page.keyboard.press("Escape");
await sleep(150);

// ---- Ctrl+Enter inserts the batch ----------------------------------------------
await ctrlEnter();
s = await snap();
const added = s.els.slice(base);
ok(!s.open, "importer closed after Ctrl+Enter");
ok(added.length === 4, `inserted all 4 picked plots (got ${added.length})`);
ok(
  JSON.stringify(added.map((e) => e.asset)) === JSON.stringify(["alpha decay.svg", "bravo.svg", "charlie.svg", "delta.svg"]),
  "placement order = pick order",
  added.map((e) => e.asset).join(","),
);
// figure-v1 P4: EVERY svg imports as an inline semantic plot (vanilla svgs get
// a derived manifest); the fluxplot/vanilla discriminator is the sidecar refs.
const bravo = added.find((e) => e.asset === "bravo.svg");
ok(
  added.every((e) => e.type === "plot"),
  `all svgs import as inline plots (${added.map((e) => e.type).join(",")})`,
);
ok(
  bravo?.semantic === true && added.filter((e) => e.semantic).length === 1,
  `sidecar resolution intact through the batch (only bravo carries manifestRef)`,
);
ok(
  added.every((e) => Math.abs(e.w - 96) <= 0.5 && Math.abs(e.h - 96) <= 0.5),
  "batch lands at TRUE physical size (72pt → 96px each)",
  added.map((e) => `${e.w}×${e.h}`).join(","),
);
const overlaps = [];
for (let i = 0; i < added.length; i++)
  for (let j = i + 1; j < added.length; j++) {
    const a = added[i], b = added[j];
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    if (w > 0 && h > 0) overlaps.push(`${a.asset}∩${b.asset}`);
  }
ok(overlaps.length === 0, "grid placement is non-overlapping", overlaps.join(","));
ok(
  s.selection.length === 4 && added.every((e) => s.selection.includes(e.id)),
  `all new elements selected (${s.selection.length} selected)`,
);

// ---- nothing picked: Ctrl+Enter inserts EXACTLY the highlighted plot ------------
await altI();
await page.keyboard.press("ArrowDown"); // highlight "alpha decay" (no toggle)
await ctrlEnter();
s = await snap();
ok(!s.open && s.els.length === base + 5, `nothing-picked Ctrl+Enter inserts ONLY the highlighted plot (+1 → ${s.els.length - base})`);
ok(s.els[s.els.length - 1].asset === "alpha decay.svg" && s.selection.length === 1, "…and it is the highlighted one, selected alone");

// ---- nothing picked, highlighted row is a dir: Ctrl+Enter is a no-op ------------
await altI();
s = await snap();
ok(s.open && s.pill === "", "importer re-opens with a FRESH empty selection");
await ctrlEnter(); // index 0 = sub/ (a dir)
s = await snap();
ok(s.open && s.els.length === base + 5, "Ctrl+Enter on a dir with nothing picked is a no-op (stays open, nothing inserted)");

// ---- mouse: click toggles + refocuses the input; dblclick inserts ---------------
await page.click('.row[data-i="1"]'); // click "alpha decay" → toggle
await sleep(200);
s = await snap();
ok(s.pill === "1 selected", `row click toggles (${s.pill || "no pill"})`);
ok(s.inputFocused, "row click returns focus to the search input (keyboard keeps working)");
await page.click('.row[data-i="2"]', { count: 2 }); // dblclick bravo → insert selection + bravo
await sleep(500);
s = await snap();
ok(!s.open && s.els.length === base + 7, `dblclick inserts the selection plus the clicked plot (+2 → ${s.els.length - base})`);

// ---- per-file failure → the batch still imports, ONE error toast ----------------
const toast = await page.evaluate(async (root) => {
  const F = window.__flux;
  const before = F.figures()[0].elements.length;
  await F.io.importPlotsFromPaths([`${root}/plots/nope.svg`, `${root}/plots/bravo.svg`]);
  const toasts = F.get(F.toast.toasts);
  return {
    added: F.figures()[0].elements.length - before,
    err: toasts.find((t) => t.level === "error")?.msg ?? "",
    detail: toasts.find((t) => t.level === "error")?.detail ?? "",
  };
}, ROOT);
ok(toast.added === 1, `partial failure: the good file still imports (${toast.added})`);
ok(/import failed/i.test(toast.err) && /nope\.svg/.test(toast.detail), "failure toast names the failed file", `${toast.err} | ${toast.detail}`);

const errs = realErrors(page);
ok(errs.length === 0, "no console/page errors", errs.join(" | "));

await browser.close();
console.log(fails ? `\n${fails} FAILED` : "\nall green");
process.exit(fails ? 1 : 0);
