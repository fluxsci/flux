// X-ray CONTEXT (browser, 2026-10-23) — the owner's two complaints and the integrations:
//   · search "tick" over two plots: every row says X or Y axis, hits group under a header
//     naming their PLOT (its distinctive key), the search row counts them
//   · the Common section nests (X axis › Tick labels …); a value that differs reads "varies"
//   · a ctrl-clicked tick label + Alt+R opens WITH that tick label picked (it is a row);
//     ↓ walks its siblings, ← picks its family; the canvas outlines the family's leaves
//   · Shift+Alt+R opens on the family directly; ⇧A takes a part to every plot that has it
//   · hovering a row outlines its parts on the canvas; the detail strip names the row
//   · x hides, Ctrl+Z undoes it without leaving the X-ray; ◐ marks a partly hidden family
//   · Ctrl+A (plots + a loose shape) + Alt+R x-rays the plots; a big group's members cap
//   · the property menu's header names the part's place ("Y axis › Tick labels")
//   Run (dev server on :1420): node scripts/verify-xray-context-gui.mjs
import { launch, gotoApp, clickMode, shot, sleep, realErrors, waitFor, waitForGone } from "./lib/driver.mjs";
import { bandpowerManifest, bandpowerSvg } from "./fixtures/xray-context/bandpower.mjs";

let fails = 0;
const ok = (cond, msg) => (cond ? console.log("  ✓ " + msg) : (fails++, console.log("  ✗ " + msg)));

const PLOTS = [
  { key: "delta", title: "Delta", yTitle: "Delta power (µV²)", yTicks: ["0", "1000", "2000", "3000"], points: 23 },
  { key: "sigma", title: "Sigma", yTitle: "Sigma power (µV²)", yTicks: ["0", "800", "1600", "2400"], points: 23 },
  { key: "dense", title: "Dense", yTitle: "Power", yTicks: ["0", "1", "2"], points: 400 },
];

const { browser, page } = await launch({ width: 1500, height: 950 });
try {
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
  await clickMode(page, "Figure");
  await sleep(700);
  await page.evaluate((plots) => {
    const F = window.__flux.fig;
    for (const p of plots) window.__flux.io.reimportPlot("xc-" + p.key, p.svg, p.manifest);
    F.commit((pr) => {
      const g = pr.figures[0];
      g.x = 0; g.y = 0; g.width = 1100; g.height = 760;
      g.elements = [
        ...plots.map((p, i) => ({ type: "plot", id: "xc-" + p.key, x: 30 + (i % 2) * 460, y: 30 + Math.floor(i / 2) * 340, width: 420, height: 280, rotation: 0, assetId: "xc-" + p.key, overrides: {}, source: { svgPath: `plots/hypno/sd-early-hypno-substates-bandpower-${p.key}.svg` } })),
        { type: "rect", id: "xc-letter", x: 4, y: 4, width: 20, height: 20, rotation: 0, fill: "#eee", stroke: "#000", strokeWidth: 1, cornerRadius: 0 },
      ];
      F.activeFigureId.set(g.id);
    });
    F.viewport.set({ panX: 60, panY: 60, zoom: 0.8 });
  }, PLOTS.map((p) => ({ key: p.key, manifest: bandpowerManifest(p.yTitle, p.yTicks, p.points), svg: bandpowerSvg(p.title, p.yTitle, p.yTicks, p.points) })));
  await sleep(500);

  const F = (fn, arg) => page.evaluate(fn, arg);
  const parts = () => F(() => window.__flux.get(window.__flux.fig.partSelections).map((p) => `${p.elementId}:${p.partId}`).sort());
  const altR = async (shift = false) => {
    await page.mouse.move(1300, 150);
    if (shift) await page.keyboard.down("Shift");
    await page.keyboard.down("Alt"); await page.keyboard.press("KeyR"); await page.keyboard.up("Alt");
    if (shift) await page.keyboard.up("Shift");
    await waitFor(page, () => document.querySelectorAll(".xray .row").length > 0, null, { label: "x-ray rows" });
    await sleep(150);
  };
  const close = async () => { await page.keyboard.press("Escape"); await waitForGone(page, ".xray"); };
  const rowInfo = () => F(() => [...document.querySelectorAll(".xray .row")].map((r) => ({
    rid: r.dataset.rid, kind: r.dataset.kind, label: r.querySelector(".rlabel")?.textContent.trim(), path: r.querySelector(".rpath")?.textContent.replace(/\s*›\s*$/, "").trim() ?? "",
    preview: r.querySelector(".rprev")?.textContent.trim() ?? "", eye: r.querySelector(".eye")?.textContent.trim(), sel: r.classList.contains("sel"), primary: r.classList.contains("primary"),
  })));
  const select = (ids, partSel = []) => F(([ids, ps]) => { const f = window.__flux.fig; f.selection.set(new Set(ids)); if (ps.length) f.setPartSelections(ps); else f.partSelection.set(null); }, [ids, partSel]);

  // --- 1. the owner's search: "tick" over two plots ---------------------------------------
  await select(["xc-delta", "xc-sigma"]);
  await altR();
  await page.keyboard.press("s");
  await waitFor(page, () => document.activeElement?.classList.contains("search-in"), null, { label: "search focused" });
  await page.keyboard.type("tick");
  await sleep(250);
  let rows = await rowInfo();
  const tickRows = rows.filter((r) => /^Tick (marks|labels)$/.test(r.label));
  ok(tickRows.length === 12, `"tick" lists 12 tick rows (4 common + 4 per plot): ${tickRows.length}`);
  ok(tickRows.every((r) => r.path === "X axis" || r.path === "Y axis"), `every tick row says its axis (${[...new Set(tickRows.map((r) => r.path))].join(", ")})`);
  ok(tickRows.filter((r) => r.kind === "common").map((r) => r.path).join() === "X axis,X axis,Y axis,Y axis", "…the common ones too: x marks, x labels, y marks, y labels");
  const heads = await F(() => [...document.querySelectorAll(".xray .shead")].map((h) => ({ key: h.querySelector(".hkey")?.textContent.trim(), hint: h.querySelector(".hhint")?.textContent.trim() ?? "", count: h.querySelector(".hcount")?.textContent.trim() })));
  ok(heads.map((h) => h.key).join() === "Common,sigma,delta", `hits group under Common + each plot's distinctive key (${heads.map((h) => h.key).join(", ")})`);
  ok(heads.find((h) => h.key === "sigma")?.hint === "Sigma", "…each plot header carries its identity hint (its title)");
  ok(/12 in 2 plots/.test(await F(() => document.querySelector(".xray .sres")?.textContent ?? "")), "the search row counts the hits across plots");
  ok(tickRows.filter((r) => r.label === "Tick labels" && r.path === "Y axis" && r.kind === "part").map((r) => r.preview).sort().join(" | ") === "0 · 1000 · 2000 · 3000 | 0 · 800 · 1600 · 2400", "per-plot y tick labels preview their own values");
  ok(tickRows.find((r) => r.kind === "common" && r.label === "Tick labels" && r.path === "Y axis")?.preview === "varies", "the common y tick labels read 'varies' (the plots differ)");
  ok(await F(() => [...document.querySelectorAll(".xray .row .rlabel")].every((l) => !/›/.test(l.textContent))), "context never enters the label itself");
  await page.keyboard.press("Escape"); // leave search
  await sleep(100);
  await page.keyboard.press("Backspace"); // clear it
  await sleep(150);
  await shot(page, "xray-context-01-search");

  // --- 2. the Common section nests --------------------------------------------------------
  rows = await rowInfo();
  const ci = rows.findIndex((r) => r.kind === "common" && r.label === "X axis");
  ok(ci >= 0 && rows[ci + 1]?.kind === "common" && rows.slice(ci + 1, ci + 4).map((r) => r.label).join() === "Spine,Tick marks,Tick labels", "Common parts nest: X axis › Spine / Tick marks / Tick labels");
  ok(rows.some((r) => r.kind === "common" && r.label === "Y axis" && r.preview === "varies"), "the common Y axis says its titles vary");
  // eyes read what is DRAWN: hide the common X axis → its common Tick labels read hidden too
  await page.click('.xray .row[data-rid="common:axis.x"] .eye');
  await sleep(200);
  rows = await rowInfo();
  ok(rows.find((r) => r.rid === "common:axis.x.tick-labels")?.eye === "○" && await F(() => document.querySelector('.xray .row[data-rid="common:axis.x.tick-labels"] .eye')?.classList.contains("ghost")), "a common part hidden with its axis reads hidden (ghosted: by its parent)");
  await page.click('.xray .row[data-rid="common:axis.x"] .eye');
  await sleep(200);
  ok((await rowInfo()).find((r) => r.rid === "common:axis.x.tick-labels")?.eye === "◉", "…and shown again with it");
  await close();

  // --- 3. a drilled tick label opens picked; ↓ siblings, ← family --------------------------
  await select(["xc-delta"], [{ elementId: "xc-delta", partId: "axis.x.ticklabel.2" }]);
  await altR();
  rows = await rowInfo();
  let prim = rows.find((r) => r.primary);
  ok(prim?.rid === "part:xc-delta__axis.x.ticklabel.2" && prim.preview === "SWS", `the drilled tick label is a picked row of its own (${prim?.label} · ${prim?.preview})`);
  ok((await parts()).join() === "xc-delta:axis.x.ticklabel.2", "…and the canvas pick is unchanged");
  const stripText = (sel) => F((sel) => [...(document.querySelector(sel)?.children ?? [])].map((c) => c.textContent.replace(/\s+/g, " ").trim()).filter(Boolean).join(" "), sel);
  const strip = { path: await stripText(".xray .xdetail .dpath"), val: await F(() => document.querySelector(".xray .xdetail .dval")?.textContent.trim()), meta: await stripText(".xray .xdetail .dmeta") };
  ok(strip.path === "X axis › Tick labels › Tick label 2" && strip.val === "SWS" && /^text/.test(strip.meta) && /axis\.x\.ticklabel\.2$/.test(strip.meta), `the detail strip names it in full (${strip.path} | ${strip.val} | ${strip.meta})`);
  await page.keyboard.press("ArrowDown");
  await sleep(100);
  ok((await parts()).join() === "xc-delta:axis.x.ticklabel.3", "↓ walks to the next tick label (never jumps to the plot)");
  await page.keyboard.press("ArrowLeft");
  await sleep(200);
  ok((await parts()).join() === "xc-delta:axis.x.tick-labels", "← picks the FAMILY (Tick labels)");
  await waitFor(page, () => document.querySelectorAll(".part-box").length === 5, null, { label: "family outlined", timeout: 3000 }).catch(() => {});
  ok((await F(() => document.querySelectorAll(".part-box").length)) === 5, "the canvas outlines all five tick labels of the family (a group has no node of its own)");
  // hover → canvas outline
  const hov = await page.$('.xray .row[data-rid="part:xc-delta__axis.x.ticks"]');
  await hov.hover();
  await waitFor(page, () => document.querySelector("[data-xray-hover]")?.getAttribute("data-xray-hover") === "5", null, { label: "hover outline", timeout: 3000 }).catch(() => {});
  ok((await F(() => document.querySelector("[data-xray-hover]")?.getAttribute("data-xray-hover"))) === "5", "hovering Tick marks outlines its five ticks on the canvas");
  ok((await stripText(".xray .xdetail .dpath")) === "X axis › Tick marks", "…and the detail strip follows the hover");
  await shot(page, "xray-context-02-family");
  // closed from OUTSIDE the panel (the Become picker, a mode switch …), the outline goes too
  await F(() => window.__flux.fig.xrayOpen.set(false));
  await sleep(200);
  ok(!(await page.$("[data-xray-hover]")), "the hover outline never outlives the X-ray");
  await altR();
  await page.mouse.move(1450, 900);
  await sleep(150);

  // --- 4. x / Ctrl+Z inside the X-ray; ◐ for a partly hidden family ------------------------
  await page.keyboard.press("ArrowDown"); // → the first tick label
  await sleep(80);
  await page.keyboard.press("ArrowRight"); // tree nav: on a leaf, no-op
  ok((await parts()).join() === "xc-delta:axis.x.ticklabel.0", "→ from the family steps into its first member");
  await page.keyboard.press("x");
  await sleep(200);
  const hidden0 = () => F(() => window.__flux.figures()[0].elements.find((e) => e.id === "xc-delta").overrides?.["axis.x.ticklabel.0"]?.hidden === true);
  ok(await hidden0(), "x hides the tick label");
  ok((await rowInfo()).find((r) => r.rid === "part:xc-delta__axis.x.tick-labels")?.eye === "◐", "…its family's eye reads partly hidden (◐)");
  await page.keyboard.down("Control"); await page.keyboard.press("KeyZ"); await page.keyboard.up("Control");
  await sleep(200);
  ok(!(await hidden0()) && !!(await page.$(".xray")), "Ctrl+Z undoes it with the X-ray still open");
  await close();

  // --- 5. Shift+Alt+R opens on the family --------------------------------------------------
  await select(["xc-sigma"], [{ elementId: "xc-sigma", partId: "axis.y.ticklabel.1" }]);
  await altR(true);
  ok((await parts()).join() === "xc-sigma:axis.y.tick-labels", "Shift+Alt+R widens the drilled tick label to its family before opening");
  ok((await rowInfo()).find((r) => r.primary)?.rid === "part:xc-sigma__axis.y.tick-labels", "…and the X-ray lands on that family row");

  // --- 6. ⇧A: the same part in every plot ---------------------------------------------------
  await page.keyboard.down("Shift"); await page.keyboard.press("KeyA"); await page.keyboard.up("Shift");
  await waitFor(page, () => !!document.querySelector('.xray .row[data-kind="set"]'), null, { label: "re-rooted on every plot" });
  await sleep(200);
  const everywhere = await parts();
  ok(everywhere.join() === "xc-delta:axis.y.tick-labels,xc-dense:axis.y.tick-labels,xc-sigma:axis.y.tick-labels", `⇧A picks the y tick labels on every plot of the figure (${everywhere.join(", ")})`);
  ok((await rowInfo()).find((r) => r.primary)?.rid === "common:axis.y.tick-labels", "…on their common row");
  await page.keyboard.press("Enter");
  await waitFor(page, () => !!document.querySelector(".fluxFigMenu"), null, { label: "property menu", timeout: 3000 }).catch(() => {});
  const head = await F(() => { const m = document.querySelector(".fluxFigMenu"); return { name: m?.querySelector(".ttl")?.textContent.trim(), ctx: m?.querySelector(".ctx")?.textContent.trim() }; });
  ok(head.name === "Y axis › Tick labels" && /3 plot parts · 3 plots/.test(head.ctx ?? ""), `the property menu names the part's place (${head.name} — ${head.ctx})`);
  await page.keyboard.press("Escape");
  await sleep(150);
  await page.keyboard.press("Backspace");
  await sleep(250);
  ok(!(await page.$('.xray .row[data-kind="set"]')), "⌫ returns to the single plot");
  await close();

  // --- 7. Ctrl+A (plots + a loose shape) still x-rays the plots -----------------------------
  await select(["xc-delta", "xc-sigma", "xc-dense", "xc-letter"]);
  await altR();
  ok((await rowInfo()).some((r) => r.kind === "set" && r.label === "3 plots"), "a mixed selection x-rays its plots");
  await close();

  // --- 8. a big group's members cap -----------------------------------------------------------
  await select(["xc-dense"], [{ elementId: "xc-dense", partId: "quiet-wake-acquisitions.points" }]);
  await altR();
  await page.keyboard.press("ArrowRight"); // open the 400 points
  await sleep(250);
  const memberCount = () => F(() => document.querySelectorAll('.xray .row.member').length);
  ok((await memberCount()) === 60, `400 points render capped (${await memberCount()} rows)`);
  ok(/\+ 340 more/.test(await F(() => document.querySelector(".xray .xmore")?.textContent ?? "")), "…with a '+ 340 more' control that is not a row");
  await page.click(".xray .xmore");
  await sleep(250);
  ok((await memberCount()) === 260, "…which shows 200 more");
  await close();

  ok(realErrors(page).length === 0, `console is clean (${realErrors(page).slice(0, 2).join(" | ")})`);
} finally {
  await browser.close();
}
console.log(fails ? `VERIFY-XRAY-CONTEXT-GUI ${fails} FAILURE(S)` : "VERIFY-XRAY-CONTEXT-GUI ALL PASS");
process.exit(fails ? 1 : 0);
