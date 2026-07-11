// figure-v1 P7 gate (browser) — named groups in the REAL GUI: ⌘G through the
// actual keyboard path creates a named registry group; the Sidebar Layers list
// renders the derived tree (group row + indented members, count badge);
// double-click rename via the bridge updates the row; the group EYE writes
// registry hidden, dims member rows, and drops members from the export string
// builder (figureToSvg — same fn flux-core uses); the group grip drags the
// WHOLE run; ⌘⇧G dissolves back.
//   Run (dev server on :1420): node scripts/verify-groups-layers.mjs
import { launch, gotoApp, clickMode, shot, sleep, realErrors } from "./lib/driver.mjs";

let fails = 0;
const ok = (cond, msg) => (cond ? console.log("  ✓ " + msg) : (fails++, console.log("  ✗ " + msg)));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const { browser, page } = await launch({ width: 1500, height: 950 });
try {
  await page.evaluateOnNewDocument(() => {
    window.__name = window.__name || ((f) => f);
  });
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
  await clickMode(page, "Figure");
  await sleep(700);

  // --- seed 3 rects (bottom→top = [r1, r2, r3]) ---
  const ids = await page.evaluate(() => {
    const F = window.__flux.fig;
    const out = [];
    F.commit((p) => {
      const g = p.figures.find((f) => f.id === "growth") || p.figures[0];
      g.x = 0; g.y = 0; g.width = 900; g.height = 400; g.elements = []; delete g.groups;
      const mk = (fill, x) => {
        const id = F.newId("rect");
        g.elements.push({ type: "rect", id, x, y: 120, width: 200, height: 140, rotation: 0, fill, stroke: "#222222", strokeWidth: 3, cornerRadius: 0 });
        out.push(id);
      };
      mk("#d62728", 40); mk("#2ca02c", 350); mk("#1f77b4", 660);
    });
    F.viewport.set({ panX: 40, panY: 120, zoom: 1 });
    window.__ids = out;
    return out;
  });
  const [r1, r2, r3] = ids;
  await sleep(300);

  const model = () =>
    page.evaluate(() => {
      const g = window.__flux.figures().find((f) => f.id === "growth");
      return { order: g.elements.map((e) => e.id), groups: g.groups ?? {}, els: g.elements.map((e) => ({ id: e.id, groupId: e.groupId ?? null, hidden: !!e.hidden })) };
    });
  const layerRows = () =>
    page.evaluate(() =>
      [...document.querySelectorAll(".layers li.layer")].map((li) => ({
        grp: li.classList.contains("grp"),
        gid: li.dataset.gid ?? null,
        name: li.querySelector(".item")?.textContent.trim() ?? "",
        dim: li.classList.contains("isHidden"),
        pad: li.style.paddingLeft || "0px",
      })),
    );

  // --- ⌘G through the REAL keyboard path (figure focused) ---
  await page.evaluate((sel) => {
    const F = window.__flux.fig;
    F.selection.set(new Set(sel));
  }, [r1, r2]);
  await sleep(120);
  await page.keyboard.down("Control");
  await page.keyboard.press("g");
  await page.keyboard.up("Control");
  await sleep(250);

  let m = await model();
  const gid = Object.keys(m.groups)[0];
  ok(!!gid && m.groups[gid].name === "Group 1", `⌘G created a named registry group (${gid} "${m.groups[gid]?.name}")`);
  ok(m.els.filter((e) => e.groupId === gid).length === 2, "both selected elements joined it");
  const selAfter = await page.evaluate(() => [...window.__flux.get(window.__flux.fig.selection)]);
  ok(selAfter.length === 2 && selAfter.includes(r1) && selAfter.includes(r2), "selection kept the members after ⌘G");

  // --- Sidebar tree: group row + indented member rows + count ---
  let rows = await layerRows();
  const gRow = rows.find((r) => r.grp);
  ok(!!gRow && gRow.gid === gid && gRow.name === "Group 1", `Layers shows the group row ("${gRow?.name}")`);
  const memberRows = rows.filter((r) => !r.grp && r.pad !== "0px" && r.pad !== "");
  ok(memberRows.length === 2, `member rows indented under it (${memberRows.length})`);
  ok(rows.length === 4, `rows = group + 2 members + 1 loose (${rows.length})`);
  const gCount = await page.evaluate(() => document.querySelector(".layers li.grp .gcount")?.textContent.trim());
  ok(gCount === "2", `member count badge (${gCount})`);
  await shot(page, "p7-01-group-row");

  // --- rename via the bridge → row updates ---
  await page.evaluate(async (gid) => {
    const { dispatchCommand } = await import("/src/lib/bridge/commands.ts");
    await dispatchCommand({ type: "rename_group", groupId: gid, name: "Panel A" });
  }, gid);
  await sleep(200);
  rows = await layerRows();
  ok(rows.find((r) => r.grp)?.name === "Panel A", "bridge rename_group updates the Layers row");

  // --- inline dbl-click rename on the group row (GUI path) ---
  await page.evaluate(() => {
    const btn = document.querySelector(".layers li.grp .item");
    btn.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  await sleep(150);
  const hasInput = await page.evaluate(() => !!document.querySelector(".layers li.grp input.rename"));
  ok(hasInput, "double-click opens the inline rename input");
  await page.keyboard.type(" Left");
  await page.keyboard.press("Enter");
  await sleep(200);
  m = await model();
  ok(/Left/.test(m.groups[gid]?.name ?? ""), `inline rename commits via ops.renameGroup ("${m.groups[gid]?.name}")`);

  // --- group EYE: registry hidden + row dimming + export exclusion ---
  await page.evaluate(() => {
    const eye = document.querySelector(".layers li.grp .tog");
    eye.click();
  });
  await sleep(200);
  m = await model();
  ok(m.groups[gid]?.hidden === true, "group eye wrote registry hidden (not member flags)");
  ok(m.els.every((e) => !e.hidden), "member hidden flags untouched");
  rows = await layerRows();
  ok(rows.find((r) => r.grp)?.dim && rows.filter((r) => !r.grp && r.dim).length === 2, "group + member rows dim (effectiveHidden)");
  const svgHidden = await page.evaluate(async () => {
    const { figureToSvg } = await import("/src/lib/export.ts");
    const g = window.__flux.figures().find((f) => f.id === "growth");
    return figureToSvg(g, () => undefined);
  });
  ok(!svgHidden.includes("#d62728") && !svgHidden.includes("#2ca02c") && svgHidden.includes("#1f77b4"),
    "export (figureToSvg) excludes the hidden group's members, keeps the loose element");
  await shot(page, "p7-02-group-hidden");
  await page.evaluate(() => document.querySelector(".layers li.grp .tog").click()); // unhide
  await sleep(200);
  m = await model();
  ok(m.groups[gid]?.hidden === undefined, "second eye click clears the flag");

  // --- drag the GROUP row to the bottom → whole run moves ---
  // Layers display (top-first): [r3, Panel A Left, r2, r1]  (group holds r1+r2,
  // spliced at r2's old slot). Drag the group grip below the last row.
  const gripBox = await page.evaluate(() => {
    const li = document.querySelector(".layers li.grp");
    const grip = li.querySelector(".grip").getBoundingClientRect();
    const all = [...document.querySelectorAll(".layers li.layer")];
    const last = all[all.length - 1].getBoundingClientRect();
    return { gx: grip.left + grip.width / 2, gy: grip.top + grip.height / 2, endY: last.top + last.height - 2 };
  });
  await page.mouse.move(gripBox.gx, gripBox.gy);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(gripBox.gx, gripBox.gy + ((gripBox.endY - gripBox.gy) * i) / 10);
  await sleep(80);
  await page.mouse.up();
  await sleep(250);
  m = await model();
  ok(eq(m.order.slice(0, 2).sort(), [r1, r2].sort()), `group grip drag moved the WHOLE run to the bottom (${m.order})`);
  const runIdx = m.order.map((id, i) => (m.els.find((e) => e.id === id)?.groupId === gid ? i : -1)).filter((i) => i >= 0);
  ok(runIdx.length === 2 && runIdx[1] - runIdx[0] === 1, "run stayed contiguous through the drag");

  // --- ⌘⇧G dissolves through the real keyboard path ---
  await page.evaluate((sel) => window.__flux.fig.selection.set(new Set(sel)), [r1]);
  await sleep(100);
  await page.keyboard.down("Control");
  await page.keyboard.down("Shift");
  await page.keyboard.press("g");
  await page.keyboard.up("Shift");
  await page.keyboard.up("Control");
  await sleep(250);
  m = await model();
  ok(Object.keys(m.groups).length === 0, "⌘⇧G dissolved the group (registry GC'd)");
  ok(m.els.every((e) => !e.groupId), "members went loose");
  rows = await layerRows();
  ok(rows.length === 3 && rows.every((r) => !r.grp), "Layers back to a flat 3-row list");
  await shot(page, "p7-03-ungrouped");

  // --- WS-1 Fix 6: reorder across virtual-window boundaries. Seed 120 rows so
  // the Layers list windows (rendered ≪ total), scroll mid-list, drag a row 10
  // display slots down through the grip — the LOGICAL drop index (pointer Y +
  // scrollTop / fixed row height) must produce the exact splice the old
  // full-DOM rect scan produced. ---
  await page.evaluate(() => {
    const F = window.__flux.fig;
    F.commit((p) => {
      const g = p.figures.find((f) => f.id === "growth") || p.figures[0];
      g.elements = [];
      delete g.groups;
      for (let i = 0; i < 120; i++)
        g.elements.push({ type: "rect", id: "w" + i, x: (i % 12) * 70 + 10, y: Math.floor(i / 12) * 36 + 10, width: 60, height: 30, rotation: 0, fill: "#4385be", stroke: "#222222", strokeWidth: 1, cornerRadius: 0 });
    });
    window.__flux.fig.clearSelection?.();
  });
  await sleep(350);
  const win = await page.evaluate(() => {
    const ul = document.querySelector(".layers ul[data-total]");
    const aside = document.querySelector("aside.sidebar");
    aside.scrollTop = 900; // jump the window into the middle of the list
    return { total: +(ul?.dataset.total ?? 0), rendered: document.querySelectorAll(".layers li.layer").length };
  });
  ok(win.total === 120 && win.rendered < 120, `windowed list: data-total=${win.total}, rendered=${win.rendered} < 120`);
  await sleep(200);
  const dragInfo = await page.evaluate(() => {
    const aside = document.querySelector("aside.sidebar");
    const top = aside.getBoundingClientRect().top;
    const li = [...document.querySelectorAll(".layers li.layer")].find(
      (n) => n.getBoundingClientRect().top > top + 8,
    ); // first FULLY-VISIBLE rendered row (skip overscan above the fold)
    const label = li.querySelector(".item").textContent.trim(); // "rect N" → seed z = N-1
    const grip = li.querySelector(".grip").getBoundingClientRect();
    return { label, gx: grip.left + grip.width / 2, gy: grip.top + grip.height / 2 };
  });
  const zCur = Number(dragInfo.label.replace(/\D+/g, "")) - 1;
  ok(zCur > 20 && zCur < 110, `drag source is a mid-list row that was off-window at seed time (z=${zCur})`);
  await page.mouse.move(dragInfo.gx, dragInfo.gy);
  await page.mouse.down();
  // Final pointer rests 6px ABOVE the target row's midpoint (mid-band, not the
  // boundary) so the midpoint drop rule is deterministic.
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(dragInfo.gx, dragInfo.gy + 25 * i - 6);
    await sleep(15);
  }
  await sleep(80);
  await page.mouse.up();
  await sleep(250);
  const orderAfter = await page.evaluate(() =>
    window.__flux.figures().find((f) => f.id === "growth").elements.map((e) => e.id),
  );
  const expected = Array.from({ length: 120 }, (_, i) => "w" + i);
  expected.splice(zCur, 1);
  expected.splice(zCur - 10, 0, "w" + zCur); // 10 display rows DOWN = 10 z-slots earlier
  ok(eq(orderAfter, expected), `windowed drag reordered exactly 10 slots down (moved w${zCur})`);

  const errs = realErrors(page);
  ok(errs.length === 0, `no console errors (${errs.length})`);
  if (errs.length) console.error(errs.slice(0, 5));
  console.log(fails === 0 ? "\nVERIFY-GROUPS-LAYERS ALL PASS" : `\nVERIFY-GROUPS-LAYERS ${fails} FAILURE(S)`);
} finally {
  await browser.close();
}
process.exit(fails === 0 ? 0 : 1);
