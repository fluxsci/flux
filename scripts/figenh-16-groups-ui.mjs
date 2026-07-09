// figure-v1 P7-canvas gate (browser) — the Figma GROUP INTERACTION model on the
// real canvas, driven by real mouse/keyboard:
//   · click a member → the whole group unit selects (hover previews the same)
//   · group-bbox selection chrome rides free (8 handles + rotate; resize works)
//   · double-click ENTERS the group (enteredGroupId; selection = the unit under
//     the cursor, one level per double-click, nested groups drill progressively)
//   · inside the scope: drags move only the member; hover previews the member;
//     a marquee selects scope-bounded units and KEEPS the scope
//   · a plain background click exits the scope entirely (Figma full exit)
//   · Esc steps the scope out one level BEFORE the classic clear-selection
//   · group eye (bridge set_group_state) removes members from the LIVE scene
//     DOM (effectiveHidden — P7-core closed exports, this closes the canvas)
//   · a locked group blocks member click-select + hover preview
//   · alt-drag duplicate of a grouped selection mints a NEW GroupDef (name
//     preserved, fresh ids — the performAltDup cloneGroupsFor fix) and undo
//     removes copies + cloned defs coherently
//   · dissolving the entered group (⌘⇧G) drops the stale scope
//   Run (dev server on :1420): node scripts/figenh-16-groups-ui.mjs
import { launch, gotoApp, clickMode, shot, sleep, realErrors } from "./lib/driver.mjs";

let fails = 0;
const ok = (cond, msg) => (cond ? console.log("  ✓ " + msg) : (fails++, console.log("  ✗ " + msg)));
const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;

const { browser, page } = await launch({ width: 1500, height: 950 });
try {
  await page.evaluateOnNewDocument(() => {
    window.__name = window.__name || ((f) => f);
  });
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
  await clickMode(page, "Figure");
  await sleep(700);

  // --- seed: A/B (to group), C loose; figure at (0,0), zoom 1 ---
  const ids = await page.evaluate(() => {
    const F = window.__flux.fig;
    const out = [];
    F.commit((p) => {
      const g = p.figures.find((f) => f.id === "growth") || p.figures[0];
      g.x = 0; g.y = 0; g.width = 900; g.height = 420; g.elements = []; delete g.groups;
      const mk = (fill, x, y) => {
        const id = F.newId("rect");
        g.elements.push({ type: "rect", id, x, y, width: 140, height: 100, rotation: 0, fill, stroke: "#222222", strokeWidth: 3, cornerRadius: 0 });
        out.push(id);
      };
      mk("#d62728", 40, 60);   // A
      mk("#2ca02c", 240, 60);  // B
      mk("#1f77b4", 520, 60);  // C (loose)
      window.__figId = g.id;
      F.activeFigureId.set(g.id);
    });
    F.viewport.set({ panX: 60, panY: 120, zoom: 1 });
    return out;
  });
  const [A, B, C] = ids;
  await sleep(350); // > ZOOM_SETTLE_MS — programmatic viewport.set folds

  // --- helpers -------------------------------------------------------------
  const model = () =>
    page.evaluate(() => {
      const F = window.__flux;
      const g = F.figures().find((f) => f.id === window.__figId);
      return {
        n: g.elements.length,
        els: g.elements.map((e) => ({ id: e.id, x: e.x, y: e.y, w: e.width, groupId: e.groupId ?? null, hidden: !!e.hidden })),
        groups: g.groups ?? {},
        sel: [...F.get(F.fig.selection)].sort(),
        scope: F.get(F.fig.enteredGroupId),
      };
    });
  const geom = async (id) => (await model()).els.find((e) => e.id === id);
  // figure-local → screen (fig at 0,0; pan 60/120; zoom 1; host origin added)
  const scr = async (x, y) => {
    const h = await page.evaluate(() => {
      const r = document.querySelector(".canvas-host").getBoundingClientRect();
      return { left: r.left, top: r.top };
    });
    return { x: h.left + 60 + x, y: h.top + 120 + y };
  };
  const elCenter = async (id) => {
    const e = await geom(id);
    return scr(e.x + 70, e.y + 50);
  };
  const click = async (p) => {
    await page.mouse.move(p.x, p.y, { steps: 3 });
    await page.mouse.down();
    await page.mouse.up();
    await sleep(180);
  };
  // A REAL double-click: two down/up pairs, the second with clickCount 2 —
  // that's what makes Chrome synthesize the dblclick event (citegroup recipe).
  const dblclick = async (p) => {
    await page.mouse.move(p.x, p.y, { steps: 3 });
    await page.mouse.down();
    await page.mouse.up();
    await page.mouse.down({ clickCount: 2 });
    await page.mouse.up({ clickCount: 2 });
    await sleep(220);
  };
  const drag = async (from, dx, dy) => {
    await page.mouse.move(from.x, from.y, { steps: 3 });
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(from.x + (dx * i) / 10, from.y + (dy * i) / 10);
    await sleep(100);
    await page.mouse.up();
    await sleep(220);
  };
  const hoverBoxW = async (p) => {
    await page.mouse.move(p.x - 30, p.y - 20, { steps: 2 });
    await page.mouse.move(p.x, p.y, { steps: 3 });
    await sleep(200);
    return page.evaluate(() => {
      const hb = document.querySelector(".overlay-svg .hover-box");
      return hb ? parseFloat(hb.getAttribute("width")) : null;
    });
  };
  const key = async (k, mods = []) => {
    for (const m of mods) await page.keyboard.down(m);
    await page.keyboard.press(k);
    for (const m of [...mods].reverse()) await page.keyboard.up(m);
    await sleep(220);
  };
  const rectVisible = (fill) =>
    page.evaluate((f) => document.querySelectorAll(`.scene-svg rect[fill="${f}"]`).length > 0, fill);

  // === PHASE A — flat group ==================================================
  console.log("Click scoping (flat group):");
  await page.evaluate((sel) => window.__flux.fig.selection.set(new Set(sel)), [A, B]);
  await sleep(120);
  await key("g", ["Control"]);
  let m = await model();
  const gid1 = Object.keys(m.groups)[0];
  ok(!!gid1 && m.groups[gid1].name === "Group 1", `⌘G created "Group 1" (${gid1})`);
  await page.evaluate(() => window.__flux.fig.clearSelection());
  await sleep(120);

  // hover preview == click result (group unit at top scope)
  const wHover = await hoverBoxW(await elCenter(A));
  ok(wHover != null && wHover > 300, `hover over a member previews the GROUP bbox (w=${wHover})`);
  await click(await elCenter(A));
  m = await model();
  ok(m.sel.length === 2 && m.sel.includes(A) && m.sel.includes(B), `click on one member selected BOTH (${m.sel.length})`);
  ok(m.scope === null, "top-level click leaves enteredGroupId null");

  // group-bbox selection chrome rides free: handles + rotate + a real resize
  console.log("Group-bbox chrome:");
  const chrome = await page.evaluate(() => ({
    handles: document.querySelectorAll(".overlay-svg .handle").length,
    rot: !!document.querySelector(".overlay-svg .rot-handle"),
  }));
  ok(chrome.handles === 8 && chrome.rot, `selection chrome over the group (8 handles + rotate) (${chrome.handles})`);
  await drag(await scr(380, 160), 40, 30); // SE corner of the group bbox
  let gA = await geom(A);
  let gB = await geom(B);
  ok(gB.x > 250 && gA.w > 145, `resize handle scaled both members (B.x=${gB.x.toFixed(1)}, A.w=${gA.w.toFixed(1)})`);
  await key("z", ["Control"]);
  gA = await geom(A);
  gB = await geom(B);
  ok(near(gB.x, 240) && near(gA.w, 140), "undo restored the resize");

  // --- double-click enters -------------------------------------------------
  console.log("Double-click enters:");
  await dblclick(await elCenter(A));
  m = await model();
  ok(m.scope === gid1, `enteredGroupId set (${m.scope})`);
  ok(m.sel.length === 1 && m.sel[0] === A, `selection became the single member (${m.sel.length})`);

  // hover inside the scope previews the MEMBER, not the group
  const wHoverIn = await hoverBoxW(await elCenter(B));
  ok(wHoverIn != null && wHoverIn > 100 && wHoverIn < 200, `hover inside scope previews the member bbox (w=${wHoverIn})`);

  // drag inside scope moves ONLY that member
  await drag(await elCenter(A), 10, 170);
  gA = await geom(A);
  gB = await geom(B);
  ok(near(gA.x, 50, 8) && near(gA.y, 230, 8), `scoped drag moved the member (${gA.x},${gA.y})`);
  ok(gB.x === 240 && gB.y === 60, "the other member did NOT move");
  m = await model();
  ok(m.scope === gid1 && m.sel.length === 1 && m.sel[0] === A, "scope + member selection survive the drag");

  // marquee inside the scope: scope-bounded units, scope KEPT
  await drag(await scr(215, 30), 185, 170); // (215,30)→(400,200) covers only B
  m = await model();
  ok(m.sel.length === 1 && m.sel[0] === B, `marquee inside scope selected the member unit (${m.sel.join(",")})`);
  ok(m.scope === gid1, "a real marquee drag KEEPS the entered scope");

  // plain background click = full exit
  await click(await scr(700, 300));
  m = await model();
  ok(m.scope === null, "background click exits the scope entirely");
  ok(m.sel.length === 0, "…and clears the selection");

  // --- Esc steps out one level ----------------------------------------------
  console.log("Esc ladder (flat):");
  await click(await elCenter(A));
  await dblclick(await elCenter(A));
  m = await model();
  ok(m.scope === gid1 && m.sel.length === 1, "re-entered the group (setup)");
  await key("Escape");
  m = await model();
  ok(m.scope === null, "Esc stepped the scope out (group → top)");
  ok(m.sel.length === 2 && m.sel.includes(A) && m.sel.includes(B), "…and the group reads as selected (units re-resolved)");
  await key("Escape");
  m = await model();
  ok(m.sel.length === 0, "next Esc clears the selection (classic stage preserved)");

  // --- alt-drag duplicate → NEW GroupDef + undo coherence --------------------
  console.log("Alt-drag duplicate (performAltDup fix):");
  await click(await elCenter(A)); // selects the whole group
  await page.keyboard.down("Alt");
  await drag(await elCenter(A), 150, 30);
  await page.keyboard.up("Alt");
  await sleep(200);
  m = await model();
  ok(m.n === 5, `alt-drag duplicated the grouped selection (${m.n} elements)`);
  const gids = Object.keys(m.groups);
  const gid1b = gids.find((g) => g !== gid1);
  ok(gids.length === 2 && !!gid1b, `a NEW GroupDef exists (${gids.length} defs)`);
  ok(m.groups[gid1b]?.name === "Group 1", `name preserved on the clone ("${m.groups[gid1b]?.name}")`);
  const copies = m.els.filter((e) => e.groupId === gid1b);
  ok(copies.length === 2 && copies.every((c) => c.id !== A && c.id !== B), "both copies carry the fresh group id (no dangling groupId)");
  ok(m.sel.length === 2 && m.sel.every((id) => copies.some((c) => c.id === id)), "the copies are the live selection");
  const srcA = m.els.find((e) => e.id === A);
  const cA = copies.find((c) => near(c.y - srcA.y, 30, 9));
  ok(!!cA && near(cA.x - srcA.x, 150, 9), "copy offset matches the drag");
  await key("z", ["Control"]);
  m = await model();
  ok(m.n === 3 && Object.keys(m.groups).length === 1 && Object.keys(m.groups)[0] === gid1, "undo removed copies AND the cloned def (coherent)");
  ok(m.sel.length === 0, "selection pruned to live ids after undo");

  // === PHASE B — nested groups ==============================================
  console.log("Nested double-drill:");
  await page.evaluate((sel) => window.__flux.fig.selection.set(new Set(sel)), [A, B, C]);
  await sleep(120);
  await key("g", ["Control"]);
  m = await model();
  const gid2 = Object.keys(m.groups).find((g) => g !== gid1);
  ok(!!gid2 && m.groups[gid1]?.parentId === gid2, `⌘G nested the group under a new outer def (${gid2})`);
  await page.evaluate(() => window.__flux.fig.clearSelection());
  await sleep(150);

  await dblclick(await elCenter(A));
  m = await model();
  ok(m.scope === gid2, `first double-click enters the OUTER group (${m.scope})`);
  ok(m.sel.length === 2 && m.sel.includes(A) && m.sel.includes(B), "…selecting the inner group as ONE unit");
  await dblclick(await elCenter(A));
  m = await model();
  ok(m.scope === gid1, "second double-click drills into the INNER group");
  ok(m.sel.length === 1 && m.sel[0] === A, "…selecting the member alone");
  await shot(page, "p7c-nested-entered");

  await key("Escape");
  m = await model();
  ok(m.scope === gid2 && m.sel.length === 2, "Esc stepped inner → outer (selection = inner group)");
  await key("Escape");
  m = await model();
  ok(m.scope === null && m.sel.length === 3, "Esc stepped outer → top (selection = whole outer group)");
  await key("Escape");
  m = await model();
  ok(m.sel.length === 0, "final Esc clears");

  // --- group eye: members leave the LIVE scene DOM ---------------------------
  console.log("Group eye (live canvas):");
  ok((await rectVisible("#d62728")) && (await rectVisible("#2ca02c")) && (await rectVisible("#1f77b4")), "all three rects render before the eye");
  await page.evaluate(async (gid) => {
    const { dispatchCommand } = await import("/src/lib/bridge/commands.ts");
    await dispatchCommand({ type: "set_group_state", groupId: gid, hidden: true });
  }, gid1);
  await sleep(250);
  const hidA = await rectVisible("#d62728");
  const hidB = await rectVisible("#2ca02c");
  const hidC = await rectVisible("#1f77b4");
  ok(!hidA && !hidB, "hidden group's members left the live scene DOM (effectiveHidden)");
  ok(hidC, "the sibling outside the hidden group still renders");
  m = await model();
  ok(m.els.every((e) => !e.hidden), "member hidden flags untouched (registry eye only)");
  await page.evaluate(async (gid) => {
    const { dispatchCommand } = await import("/src/lib/bridge/commands.ts");
    await dispatchCommand({ type: "set_group_state", groupId: gid, hidden: false });
  }, gid1);
  await sleep(250);
  ok(await rectVisible("#d62728"), "clearing the eye brings the members back");

  // --- locked group blocks member click-select -------------------------------
  console.log("Locked group:");
  await page.evaluate(async (gid) => {
    const { dispatchCommand } = await import("/src/lib/bridge/commands.ts");
    await dispatchCommand({ type: "set_group_state", groupId: gid, locked: true });
  }, gid2);
  await sleep(200);
  const wLocked = await hoverBoxW(await elCenter(A));
  ok(wLocked === null, "no hover preview over a group-locked member");
  await click(await elCenter(A));
  m = await model();
  ok(m.sel.length === 0, "click on a group-locked member selects nothing");
  await page.evaluate(async (gid) => {
    const { dispatchCommand } = await import("/src/lib/bridge/commands.ts");
    await dispatchCommand({ type: "set_group_state", groupId: gid, locked: false });
  }, gid2);
  await sleep(200);

  // --- dissolving the entered group drops the stale scope --------------------
  console.log("Scope hygiene:");
  await dblclick(await elCenter(A)); // scope = outer
  await dblclick(await elCenter(A)); // scope = inner
  m = await model();
  ok(m.scope === gid1, "re-entered the inner group (setup)");
  await key("g", ["Control", "Shift"]); // dissolves the TOP group (outer)
  m = await model();
  ok(!m.groups[gid2] && !!m.groups[gid1], "⌘⇧G dissolved the outer group");
  ok(m.scope === gid1, "inner scope survives (its def is alive)");
  await key("g", ["Control", "Shift"]); // dissolves the inner group
  m = await model();
  ok(Object.keys(m.groups).length === 0, "second ⌘⇧G dissolved the inner group");
  ok(m.scope === null, "the stale entered scope was dropped with its def");

  const errs = realErrors(page);
  ok(errs.length === 0, `no console errors (${errs.length})`);
  if (errs.length) console.error(errs.slice(0, 5));
  console.log(fails === 0 ? "\nFIGENH-16-GROUPS-UI ALL PASS" : `\nFIGENH-16-GROUPS-UI ${fails} FAILURE(S)`);
} finally {
  await browser.close();
}
process.exit(fails === 0 ? 0 : 1);
