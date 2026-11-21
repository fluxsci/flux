// The property menu's LOOK (2026-11-20 redesign), in the browser. The owner's pick from a click-to-try viewer:
// "B Compact · geometry=pairs · on/off=keys · key caps=letter · words=serif · numbers=short · row=24 ·
// measure on object=on", with the colour picker kept whole and refreshed.
//   · one LINE per property (24 px), no boxes at rest: a number gets its well under the pointer or in hand
//   · position pairs with size (x | width, y | height); the cell still carries the field's full label
//   · on/off properties are paper keys on their group's head, lit when on, still fields (same key, same label)
//   · a number at rest shows two decimals; in hand it shows and steps its exact value
//   · instruments draw what they set (fader, dial, corner, line sample) and follow the value; a fader, a track
//     and the dial can be DRAGGED: one undo entry, nothing left in hand, and Escape backs out of the drag
//   · one hint line says what the hand can do; search stands at its end
//   · a geometric row in hand is measured on the object itself; nothing is drawn when the menu is closed
//   · the colour picker keeps its collections, colormaps, dropper, hex and spectrum
//   · nothing animates at rest
// What the menu DOES (arming, wheel, typing, undo, anchoring) is verify-fmenu-surface.mjs; the layout rules are
// verify-fmenu-look.ts.
//   Run (dev server on :1420): node scripts/verify-fmenu-look-gui.mjs
import { launch, gotoApp, clickMode, shot, sleep, realErrors, waitFor, waitForGone } from "./lib/driver.mjs";

let fails = 0;
const ok = (cond, msg) => (cond ? console.log("  ✓ " + msg) : (fails++, console.log("  ✗ " + msg)));

const { browser, page } = await launch({ width: 1500, height: 950 });
try {
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
  await clickMode(page, "Figure");
  await sleep(700);
  await page.evaluate(() => {
    const F = window.__flux.fig;
    F.commit((p) => {
      const g = p.figures[0];
      g.x = 0; g.y = 0; g.width = 1000; g.height = 700;
      g.elements = [
        { type: "rect", id: "lk-rect", x: 26.024712, y: 76.570151, width: 119.689177, height: 68.184982, rotation: 0, fill: "#d95f02", stroke: "#222222", strokeWidth: 2, cornerRadius: 0, opacity: 1 },
        { type: "text", id: "lk-text", x: 60, y: 260, width: 220, height: 40, rotation: 0, text: "Hello look", fontFamily: "Georgia", fontSize: 18, fontWeight: 400, fontStyle: "normal", color: "#222222", align: "left", lineHeight: 1.2, sizing: "auto" },
      ];
      F.activeFigureId.set(g.id);
    });
    F.viewport.set({ panX: 120, panY: 110, zoom: 2 });
    F.resetHistory();
  });
  await sleep(400);
  const rect = () => page.evaluate(() => { const f = window.__flux.figures()[0]; return { ...structuredClone(f.elements.find((e) => e.id === "lk-rect")), past: window.__flux.fig.historyStats().past }; });
  const open = async (ids, at = [420, 420]) => {
    await page.evaluate((ids) => { const F = window.__flux.fig; F.setPartSelections([]); if (ids.length === 1) F.selectOnly(ids[0]); else F.selection.set(new Set(ids)); }, ids);
    await sleep(200);
    await page.mouse.move(at[0], at[1]);
    await page.keyboard.press("f");
    await waitFor(page, () => !!document.querySelector(".fluxFigMenu.placed"), null, { label: "menu placed" });
    await sleep(120);
  };
  const close = async () => { await page.keyboard.press("Escape"); await waitForGone(page, ".fluxFigMenu"); };
  const box = (sel) => page.evaluate((sel) => { const n = document.querySelector(sel); if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; }, sel);
  const row = (key) => `.fluxFigMenu .field[data-key="${key}"]`;
  // The hint line's words; it throws if they do not fit (a hint that is cut says nothing).
  const foot = () => page.evaluate(() => { const h = document.querySelector(".fluxFigMenu .foot .hints"); const cut = h.scrollWidth > h.clientWidth + 1 || [...h.children].some((c) => c.scrollWidth > c.clientWidth + 1); const t = h.textContent.replace(/\s+/g, " ").trim(); if (cut) throw new Error(`the hint line is cut: ${t}`); return t; });
  const parkOnHead = async () => { const b = await box(".fluxFigMenu .menu-head .mark"); await page.mouse.move(b.cx, b.cy); await sleep(80); };

  // --- 1. condensed: one line per property, pairs, no scroll ---------------------------------------------
  await open(["lk-rect"]);
  await parkOnHead();
  const panel = await box(".fluxFigMenu");
  ok(panel.w === 272 && panel.h < 470, `the rectangle's menu is one 272 px column, under 470 px tall (${panel.w} × ${Math.round(panel.h)}; it was 452 × 710)`);
  const layout = await page.evaluate(() => {
    const m = document.querySelector(".fluxFigMenu"), top = (k) => Math.round(m.querySelector(`.field[data-key="${k}"]`).getBoundingClientRect().top), left = (k) => m.querySelector(`.field[data-key="${k}"]`).getBoundingClientRect().left;
    const rows = [...m.querySelectorAll(".group > .field")].map((f) => f.getBoundingClientRect().height);
    const body = m.querySelector(".body");
    return { heights: [...new Set(rows)], count: rows.length, sameLine: top("x") === top("w") && top("z") === top("e"), below: top("z") > top("x"), order: left("x") < left("w") && left("z") < left("e"), scrolls: body.scrollHeight > body.clientHeight + 1,
      groups: [...m.querySelectorAll(".gtitle .gname")].map((g) => g.textContent.trim()), fields: m.querySelectorAll(".field[data-key]").length };
  });
  ok(layout.heights.length === 1 && layout.heights[0] === 24, `every property is ONE 24 px line (${layout.count} rows: ${layout.heights.join(", ")})`);
  ok(layout.sameLine && layout.below && layout.order, "position pairs with size: x | width over y | height");
  ok(!layout.scrolls, "nothing scrolls");
  ok(layout.groups.join("|") === "Geometry|Fill|Stroke" && layout.fields === 17, `the groups keep their names and every field is there (${layout.groups.join(", ")}; ${layout.fields} fields; Presets is one row and needs no head)`);
  // [the label's text, the word a paired cell shows in its place (drawn by CSS; "" = the label itself is shown)]
  const labels = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll(".fluxFigMenu .field[data-key]")].map((f) => { const l = f.querySelector(".label"), shown = getComputedStyle(l, "::before").content; return [f.dataset.key, [l?.textContent.trim(), parseFloat(getComputedStyle(l).fontSize) === 0 && shown !== "none" ? shown.replace(/"/g, "") : ""]]; })));
  ok(labels.x[0] === "x position" && labels.z[0] === "y position" && labels.x[1] === "x" && labels.z[1] === "y", `a paired cell shows the leading word and still carries the whole label (${labels.x.join(" / ")})`);
  ok(labels.w[1] === "" && labels.a[1] === "" && labels.r[1] === "", "…and only position does that: width, height and every full row show their label");
  ok(labels.w[0] === "width" && labels.a[0] === "opacity" && labels.c[0] === "fill color" && labels["`"][0] === "save as preset…", "every other label is unchanged");
  await shot(page, "fmenu-look-01-rest");

  // --- 2. no boxes at rest; a well under the pointer; exact value in hand --------------------------------
  const ninStyle = (key) => page.evaluate((sel) => { const cs = getComputedStyle(document.querySelector(sel + " .nin")); return { bg: cs.backgroundColor, shadow: cs.boxShadow, border: cs.borderTopWidth }; }, row(key));
  let st = await ninStyle("w");
  ok(/rgba\(0, 0, 0, 0\)|transparent/.test(st.bg) && st.shadow === "none" && st.border === "0px", `a number has no box at rest (${JSON.stringify(st)})`);
  const wl = await box(row("w") + " .label");
  await page.mouse.move(wl.cx, wl.cy);
  await sleep(120);
  st = await ninStyle("w");
  ok(st.shadow !== "none" && !/rgba\(0, 0, 0, 0\)/.test(st.bg), "…and gets its well under the pointer");
  ok((await page.$eval(row("x") + " .nin", (n) => n.value)) === "26.02" && (await page.$eval(row("w") + " .nin", (n) => n.value)) === "119.69", "a number at rest shows two decimals");
  await page.keyboard.press("x");
  await waitFor(page, () => document.activeElement?.closest(".field")?.dataset.key === "x", null, { label: "x armed" });
  ok((await page.$eval(row("x") + " .nin", (n) => n.value)) === "26.024712", "in hand it shows its exact value");
  const lit = await page.evaluate((sel) => { const k = document.querySelector(sel + " > .hk"); const cs = getComputedStyle(k); return { bg: cs.backgroundColor, armed: document.querySelector(sel).classList.contains("editing") }; }, row("x"));
  ok(lit.armed && lit.bg === "rgb(67, 133, 190)", `the key of the row in hand is lit in the menu's blue (${lit.bg})`);
  ok(/type or roll/.test(await foot()) && /revert/.test(await foot()), `the hint line says what the hand can do with a row in hand (${await foot()})`);
  await page.keyboard.down("Alt"); await page.keyboard.press("ArrowUp"); await page.keyboard.up("Alt");
  let m = await rect();
  ok(Math.abs(m.x - 26.124712) < 1e-9, `a fine step moves the exact value, not the rounded one (${m.x})`);
  await page.keyboard.press("Escape");
  await sleep(120);
  m = await rect();
  ok(m.x === 26.024712 && m.past === 0, "Escape reverts it");

  // Rolling over the value arms the row. As the digit count changes, the well and its adjacent preview stay put.
  for (const [key, name, preview, deltaY] of [
    ["d", "stroke width", ".weight", -100],
    ["a", "opacity", ".fader", 100],
    ["r", "rotation", ".dial", -100],
  ]) {
    const input = row(key) + " .nin";
    const well = await box(input);
    await page.mouse.move(well.cx, well.cy);
    const geometry = () => page.$eval(row(key), (field, preview) => {
      return [".nin", preview].flatMap(selector => {
        const { left, right } = field.querySelector(selector).getBoundingClientRect();
        return [left, right];
      });
    }, preview);
    const initial = await geometry();
    let movement = 0;
    for (const fine of [false, true]) {
      const previous = await page.$eval(input, el => el.value);
      if (fine) await page.keyboard.down("Alt");
      await page.mouse.wheel({ deltaY });
      if (fine) await page.keyboard.up("Alt");
      await waitFor(page, ({ input, previous }) => document.querySelector(input).value !== previous,
        { input, previous }, { label: `wheel updates ${name}` });
      const current = await geometry();
      movement = Math.max(movement, ...current.map((edge, j) => Math.abs(edge - initial[j])));
    }
    ok(movement === 0, `${name} value box and preview hold their edges through wheel edits (max movement ${movement}px)`);
    await page.keyboard.press("Escape");
    await waitForGone(page, row(key) + ".editing");
  }

  // --- 3. on/off properties: paper keys on the group head ------------------------------------------------
  const keys = await page.evaluate(() => [...document.querySelectorAll(".fluxFigMenu .field.tkey")].map((k) => ({ key: k.dataset.key, group: k.closest(".group").querySelector(".gname").textContent.trim(), inHead: !!k.closest(".gtitle"), label: k.querySelector(".label").textContent.trim(), state: k.querySelector(".toggle").textContent.trim(), pressed: k.querySelector(".toggle").getAttribute("aria-pressed"), mark: !!k.querySelector(".toggle svg"), cap: k.querySelector(".hk").textContent.trim(), bg: getComputedStyle(k).backgroundColor })));
  ok(keys.map((k) => `${k.key}:${k.group}`).join(" ") === "1:Geometry 2:Fill 3:Stroke 4:Stroke" && keys.every((k) => k.inHead), `lock, no fill, no stroke and dashed are keys on their group's head (${keys.map((k) => `${k.key}:${k.group}`).join(" ")})`);
  ok(keys.map((k) => k.label).join("|") === "lock aspect ratio|no fill (outline only)|no stroke|dashed stroke", "each is still a field with its full label");
  ok(keys.every((k) => k.mark && k.cap === k.key && k.state === "off" && k.pressed === "false"), "each shows its letter and its mark, and says off");
  ok(keys.every((k) => k.bg === "rgb(255, 252, 240)"), "an off key is paper");
  await page.keyboard.press("4");
  await sleep(150);
  m = await rect();
  const dashed = await page.evaluate((sel) => { const k = document.querySelector(sel); return { on: k.classList.contains("on"), state: k.querySelector(".toggle").textContent.trim(), pressed: k.querySelector(".toggle").getAttribute("aria-pressed"), bg: getComputedStyle(k).backgroundColor }; }, row("4"));
  ok(m.dash?.length === 2 && m.past === 1 && dashed.on && dashed.state === "on" && dashed.pressed === "true", `4 dashes the stroke: one undo entry, the key says on (${JSON.stringify(dashed)})`);
  ok(dashed.bg === "rgb(67, 133, 190)", "an on key is lit in the menu's blue");
  ok(await page.evaluate(() => !!document.querySelector('.fluxFigMenu .field[data-key="5"] .gtrack') && !!document.querySelector('.fluxFigMenu .field[data-key="6"] .gtrack')), "dash length and dash gap appear as rows with a track each");
  ok(/repeating-linear-gradient/.test(await page.$eval(row("d") + " .weight i", (n) => n.getAttribute("style"))), "the stroke width's sample is dashed too");
  const k1 = await box(row("1"));
  await page.mouse.click(k1.cx, k1.cy);
  await sleep(150);
  m = await rect();
  ok(m.lockAspect === true && m.past === 2, "a click on a key is the same as its letter (lock aspect ratio)");
  const tipText = await page.evaluate(() => document.querySelector(".fluxFigMenu .fm-tip")?.textContent.replace(/\s+/g, " ").trim() ?? "");
  ok(/^lock aspect ratio ?1$/.test(tipText), `a key that is only a mark names itself on paper under the pointer (${tipText})`);
  ok(/lock aspect ratio/.test(await foot()), "…and on the hint line");
  await page.evaluate(() => { window.__flux.fig.undo(); window.__flux.fig.undo(); });
  await sleep(150);
  m = await rect();
  ok(!m.dash?.length && !m.lockAspect && m.past === 0, "undo, twice, restores both");
  await shot(page, "fmenu-look-02-keys");

  // --- 4. instruments draw what they set, and can be dragged ---------------------------------------------
  await parkOnHead();
  const viz = () => page.evaluate(() => { const m = document.querySelector(".fluxFigMenu"), q = (s) => m.querySelector(s);
    return { fader: q('.field[data-key="a"] .fader .knob').style.left, faderInk: q('.field[data-key="b"] .fader').style.getPropertyValue("--c"), strokeInk: q('.field[data-key="t"] .fader').style.getPropertyValue("--c"),
      dial: q('.field[data-key="r"] .dial .hand').getAttribute("transform"), corner: q('.field[data-key="v"] .corner path:not(.box)').getAttribute("d"), weight: q('.field[data-key="d"] .weight i').style.height, weightInk: q('.field[data-key="d"] .weight i').style.background, unit: q('.field[data-key="r"] .unit')?.textContent ?? "" }; });
  let v = await viz();
  ok(v.fader === "100%" && v.faderInk === "#d95f02" && v.strokeInk === "#222222", `opacity is a fader over the object's own colours (${v.fader}; fill ${v.faderInk}, stroke ${v.strokeInk})`);
  ok(v.dial === "rotate(0 10 10)" && v.unit === "°", "rotation is a dial, and its value carries a degree sign");
  ok(v.weight === "2px" && /34, 34, 34|#222222/.test(v.weightInk), `stroke width is a sample of the line: 2 px of the stroke's colour (${v.weight}, ${v.weightInk})`);
  const corner0 = v.corner;
  for (const [key, text] of [["r", "30"], ["v", "20"], ["d", "6"], ["a", "0.5"]]) { await page.keyboard.press(key); await sleep(60); await page.keyboard.type(text); await page.keyboard.press("Enter"); await sleep(80); }
  v = await viz();
  ok(v.fader === "50%" && v.dial === "rotate(30 10 10)" && v.weight === "6px" && v.corner !== corner0 && / a/.test(" " + v.corner.replace(/a/, " a")), `each follows its value (fader ${v.fader}, dial ${v.dial}, line ${v.weight}, corner ${v.corner})`);
  m = await rect();
  ok(m.opacity === 0.5 && m.rotation === 30 && m.cornerRadius === 20 && m.strokeWidth === 6 && m.past === 4, "four typed edits, four undo entries");
  // drag the opacity fader from the middle to three quarters
  const fd = await box(row("a") + " .fader");
  await page.mouse.move(fd.x + fd.w * 0.5, fd.cy);
  await page.mouse.down();
  for (const t of [0.55, 0.62, 0.7, 0.75]) { await page.mouse.move(fd.x + fd.w * t, fd.cy); await sleep(25); }
  m = await rect();
  ok(Math.abs(m.opacity - 0.75) < 1e-9, `the value follows the pointer along the fader, on the field's step (${m.opacity})`);
  await page.mouse.up();
  await sleep(150);
  m = await rect();
  const after = await page.evaluate(() => ({ armed: !!document.querySelector(".fluxFigMenu .field.editing"), open: !!document.querySelector(".fluxFigMenu") }));
  ok(m.opacity === 0.75 && m.past === 5 && !after.armed && after.open, `the whole drag is ONE undo entry and leaves nothing in hand (past ${m.past}, armed ${after.armed})`);
  // the dial: the hand points where the pointer is from its hub
  const dl = await box(row("r") + " .dial");
  await page.mouse.move(dl.cx, dl.cy - 6);
  await page.mouse.down();
  await page.mouse.move(dl.cx + 30, dl.cy, { steps: 4 });
  await page.mouse.up();
  await sleep(150);
  m = await rect();
  ok(m.rotation === 90 && m.past === 6, `dragging the dial to three o'clock turns the object a quarter turn, one undo entry (${m.rotation}°, past ${m.past})`);
  // a drag that is cancelled leaves nothing behind
  await page.mouse.move(fd.x + fd.w * 0.75, fd.cy);
  await page.mouse.down();
  await page.mouse.move(fd.x + fd.w * 0.2, fd.cy, { steps: 3 });
  await page.$eval(row("a") + " .fader", (n) => n.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 1 })));
  await page.mouse.up();
  await sleep(150);
  m = await rect();
  ok(m.opacity === 0.75 && m.past === 6, `a cancelled drag restores the value and adds no undo entry (${m.opacity}, past ${m.past})`);
  // Escape during a drag backs out of it, as it does while dragging a name (independent review, 2026-11-20).
  await page.mouse.move(dl.cx, dl.cy - 6);
  await page.mouse.down();
  await page.mouse.move(dl.cx - 30, dl.cy, { steps: 4 });
  const turned = (await rect()).rotation;
  await page.keyboard.press("Escape");
  await sleep(120);
  m = await rect();
  const backed = await page.evaluate(() => ({ open: !!document.querySelector(".fluxFigMenu"), armed: !!document.querySelector(".fluxFigMenu .field.editing"), focus: document.activeElement === document.querySelector(".fluxFigMenu") }));
  ok(turned === -90 && m.rotation === 90 && m.past === 6 && backed.open && !backed.armed && backed.focus, `Escape in the middle of a drag reverts it and leaves the menu open with its keys (was ${turned}°, now ${m.rotation}°, past ${m.past})`);
  await page.mouse.up();
  await sleep(100);
  m = await rect();
  ok(m.rotation === 90 && m.past === 6, "…and the release that follows changes nothing");
  // No input keeps the keyboard during a drag: the keys must not step another field from this one's value.
  await page.keyboard.press("x");
  await waitFor(page, () => document.activeElement?.closest(".field")?.dataset.key === "x", null, { label: "x in hand before a drag" });
  await page.mouse.move(fd.x + fd.w * 0.75, fd.cy);
  await page.mouse.down();
  await page.mouse.move(fd.x + fd.w * 0.5, fd.cy, { steps: 3 });
  const midFocus = await page.evaluate(() => document.activeElement === document.querySelector(".fluxFigMenu"));
  await page.mouse.up();
  await sleep(120);
  await page.keyboard.press("ArrowUp");
  await sleep(80);
  m = await rect();
  ok(midFocus && m.opacity === 0.5 && m.x === 26.024712, `a drag takes the keyboard from the field that had it: an arrow key afterwards does not step that field from the fader's value (x ${m.x})`);
  await page.evaluate(() => window.__flux.fig.undo());
  await sleep(100);
  m = await rect();
  ok(m.opacity === 0.75 && m.past === 6, "…and that drag was one undo entry too");
  await shot(page, "fmenu-look-03-instruments");

  // --- 5. the hint line and search ----------------------------------------------------------------------
  await parkOnHead();
  ok(/close/.test(await foot()) && /wheel adjusts/.test(await foot()), `at rest the hint line says how to leave and that the wheel adjusts (${await foot()})`);
  const al = await box(row("a") + " .label");
  await page.mouse.move(al.cx, al.cy);
  await sleep(100);
  ok(/±0\.05/.test(await foot()) && /×10/.test(await foot()) && /×0\.1/.test(await foot()), `over a number it gives the wheel's steps (${await foot()})`);
  const cl = await box(row("c") + " .label");
  await page.mouse.move(cl.cx, cl.cy);
  await sleep(100);
  ok(/fill color/.test(await foot()) && /or click/.test(await foot()), `over anything else, its name and key (${await foot()})`);
  const sk = await box(".fluxFigMenu .foot .skey");
  await page.mouse.click(sk.cx, sk.cy);
  await waitFor(page, () => document.activeElement?.classList.contains("search-in"), null, { label: "search focused" });
  await page.keyboard.type("op");
  await sleep(120);
  const found = await page.evaluate(() => [...document.querySelectorAll(".fluxFigMenu .res .rlabel")].map((r) => r.textContent.trim()));
  ok(found.join("|") === "opacity|fill opacity|stroke opacity", `the search key at the hint line's end opens search (${found.join(", ")})`);
  await page.keyboard.press("Escape");
  await sleep(120);
  ok(await page.evaluate(() => !document.querySelector(".fluxFigMenu .search-row") && document.querySelectorAll(".fluxFigMenu .group > .field").length > 8), "Escape returns to the properties");

  // --- 6. the measure on the object ---------------------------------------------------------------------
  const measure = () => page.evaluate(() => { const g = document.querySelector(".canvas-host [data-fm-measure]"); return g ? { prop: g.dataset.fmMeasure, text: g.querySelector("text")?.textContent, paths: g.querySelectorAll("path").length } : null; });
  await parkOnHead();
  ok((await measure()) === null, "nothing is measured while no geometric row is in hand");
  await page.mouse.move(wl.cx, wl.cy);
  await sleep(120);
  let ms = await measure();
  ok(ms?.prop === "width" && ms.text === "119.69", `the pointer on width draws the width on the object (${JSON.stringify(ms)})`);
  const pill = await page.evaluate(() => { const t = document.querySelector(".canvas-host [data-fm-measure] text").getBoundingClientRect(), e = document.querySelector('.canvas-host [data-editor-element-id="lk-rect"]').getBoundingClientRect(), x = (t.left + t.right) / 2, y = (t.top + t.bottom) / 2;
    return { near: x > e.left - 34 && x < e.right + 34 && y > e.top - 34 && y < e.bottom + 34, outside: x < e.left || x > e.right || y < e.top || y > e.bottom }; });
  ok(pill.near && pill.outside, `…just outside it, where its width is (${JSON.stringify(pill)})`);
  await page.mouse.move(al.cx, al.cy);
  await sleep(120);
  ok((await measure()) === null, "opacity has nothing to measure");
  await parkOnHead();
  await page.keyboard.press("r");
  await sleep(150);
  ms = await measure();
  ok(ms?.prop === "rotation" && ms.text === "90°", `rotation in hand draws its turn (${JSON.stringify(ms)})`);
  await page.keyboard.press("Escape");
  await sleep(120);
  await page.keyboard.press("v");
  await sleep(150);
  ms = await measure();
  ok(ms?.prop === "cornerRadius" && ms.text === "r 20", `corner radius in hand draws the circle that rounds the corner (${JSON.stringify(ms)})`);
  await shot(page, "fmenu-look-04-measure");
  await page.keyboard.press("Escape");
  await sleep(100);
  for (const [key, prop] of [["x", "x"], ["z", "y"], ["e", "height"]]) { const b = await box(row(key) + " .label"); await page.mouse.move(b.cx, b.cy); await sleep(100); ms = await measure(); ok(ms?.prop === prop, `${prop} is measured too (${ms?.text})`); }
  await close();
  ok((await measure()) === null && (await page.evaluate(() => document.querySelectorAll("[data-fm-measure]").length)) === 0, "closing the menu takes the measure away");
  const perfIdle = await page.evaluate(() => document.querySelectorAll(".canvas-host [data-fm-measure]").length);
  ok(perfIdle === 0, "with the menu closed the canvas carries no measure element at all");

  // --- 7. several objects: two columns, no single dimension to draw --------------------------------------
  await open(["lk-rect", "lk-text"], [700, 500]);
  const multi = await page.evaluate(() => { const m = document.querySelector(".fluxFigMenu"), b = m.querySelector(".body"); return { w: m.getBoundingClientRect().width, cols: getComputedStyle(b).columnCount, ctx: m.querySelector(".ctx")?.textContent.trim(), name: m.querySelector(".ttl").textContent.trim(), mixed: m.querySelector('.field[data-key="x"] .nin').placeholder }; });
  ok(multi.w === 540 && multi.cols === "2" && multi.name === "2 selected" && multi.ctx === "rect, text" && multi.mixed === "Mixed", `two objects: two columns, the head counts them and says their kinds on its second line (${JSON.stringify(multi)})`);
  const wl2 = await box(row("w") + " .label");
  await page.mouse.move(wl2.cx, wl2.cy);
  await sleep(120);
  ok((await measure()) === null, "several objects have no single width to draw");
  await close();

  // --- 8. text: keys with marks, a choice with its options under it ---------------------------------------
  await open(["lk-text"], [700, 500]);
  const text = await page.evaluate(() => ({ keys: [...document.querySelectorAll(".fluxFigMenu .field.tkey")].map((k) => `${k.querySelector(".label").textContent.trim()}:${!!k.querySelector("svg")}`), sel: document.querySelector('.fluxFigMenu .field[data-key="3"] .selbtn')?.textContent.trim(), wide: getComputedStyle(document.querySelector('.fluxFigMenu .field[data-key="t"] .tin')).width }));
  ok(["panel label:true", "italic:true", "underline:true", "lock aspect ratio:true"].every((k) => text.keys.includes(k)), `a text object's on/off properties are keys with marks (${text.keys.join(", ")})`);
  ok(text.sel === "Left" && parseFloat(text.wide) > 150, `a choice shows its value; the text itself gets the row's width (${text.sel}, ${text.wide})`);
  await page.keyboard.press("3");
  await sleep(150);
  const optsBox = await page.evaluate(() => { const f = document.querySelector('.fluxFigMenu .field.opts-open'), o = f?.querySelector(".opts"); if (!o) return null; const a = f.querySelector(".label").getBoundingClientRect(), b = o.getBoundingClientRect(); return { under: b.top >= a.bottom - 1, n: o.querySelectorAll(".opt").length, cur: o.querySelector(".opt.cur")?.textContent.trim() }; });
  ok(optsBox?.under && optsBox.n === 4 && /Left/.test(optsBox.cur ?? ""), `in hand its options open under its line, the current one lit (${JSON.stringify(optsBox)})`);
  ok(/pick/.test(await foot()), `…and the hint line says how to pick (${await foot()})`);
  await page.keyboard.press("Escape");
  await sleep(100);
  // The value key of an open choice confirms what is shown and closes the strip (independent review, 2026-11-20:
  // it used to leave the strip open with nothing left to revert).
  const textOf = () => page.evaluate(() => { const e = window.__flux.figures()[0].elements.find((x) => x.id === "lk-text"); return { align: e.align, past: window.__flux.fig.historyStats().past }; });
  const t0 = await textOf();
  await page.keyboard.press("3");
  await sleep(120);
  const centre = await page.evaluate(() => { const o = [...document.querySelectorAll(".fluxFigMenu .field.opts-open .opt")].find((x) => /Center/.test(x.textContent)); const r = o.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(centre.x, centre.y);
  await sleep(100);
  const vb = await box(row("3") + " .selbtn");
  await page.mouse.click(vb.cx, vb.cy);
  await sleep(150);
  const t1 = await textOf();
  ok(t1.align === "center" && t1.past === t0.past + 1 && (await page.evaluate(() => !document.querySelector(".fluxFigMenu .field.opts-open") && !document.querySelector(".fluxFigMenu .field.editing"))), `a click on the value of an open choice confirms what is shown and closes it: one undo entry (${JSON.stringify(t1)})`);
  await page.evaluate(() => window.__flux.fig.undo());
  await sleep(100);
  ok((await page.evaluate(() => [...document.querySelectorAll(".fluxFigMenu .field.tkey .toggle")].every((b) => b.tabIndex === 0))), "the on/off keys are reached by Tab, as their buttons always were");
  await close();

  // --- 9. the colour picker is whole, in the menu's look --------------------------------------------------
  // A colormap fill has no one colour to fade: the fader keeps its track, in the menu's own ink (review, 2026-11-20).
  await page.evaluate(() => { const F = window.__flux.fig; F.commit((p) => { const e = p.figures[0].elements.find((x) => x.id === "lk-rect"); e.fillMap = { map: "review", axis: "x", stops: ["#123456", "#abcdef"] }; }); });
  await open(["lk-rect"]);
  const mapped = await page.evaluate(() => { const f = document.querySelector('.fluxFigMenu .field[data-key="b"] .fader'); return { image: getComputedStyle(f).backgroundImage, chip: document.querySelector('.fluxFigMenu .field[data-key="c"] .dot').style.background }; });
  ok(/^linear-gradient/.test(mapped.image) && /conic-gradient/.test(mapped.image) && /linear-gradient/.test(mapped.chip), `with a colormap fill the fader still has its track and the chip shows the map (${mapped.image.slice(0, 40)}…)`);
  await close();
  await page.evaluate(() => { const F = window.__flux.fig; F.commit((p) => { const e = p.figures[0].elements.find((x) => x.id === "lk-rect"); delete e.fillMap; }); });
  await open(["lk-rect"]);
  await page.keyboard.press("c");
  await waitFor(page, () => !!document.querySelector(".fluxFigMenu .cs .grid"), null, { label: "picker" });
  await sleep(250);
  const cp = await page.evaluate(() => { const c = document.querySelector(".fluxFigMenu .cs"), q = (s) => c.querySelector(s), r = (s) => q(s)?.getBoundingClientRect();
    return { tabs: [...c.querySelectorAll(".tabs .tab")].map((t) => t.textContent.trim()), swatches: c.querySelectorAll(".sw:not(.none)").length, hex: !!q("input.hex"), dropper: !!q(".drop"), spectrum: !!q(".sv") && !!q("input.hue"), opacity: !!q(".erow input"),
      beside: r(".side").left >= r(".grid").right - 1, onTab: getComputedStyle(q(".tabs .tab.on")).backgroundColor, dropBg: q(".drop") ? getComputedStyle(q(".drop")).backgroundColor : "", w: document.querySelector(".fluxFigMenu").getBoundingClientRect().width, inView: document.querySelector(".fluxFigMenu").getBoundingClientRect().right <= innerWidth }; });
  ok(cp.tabs.join("|") === "Flexoki|ColorBrewer|Paul Tol|Colormaps" && cp.swatches > 100 && cp.hex && cp.spectrum && cp.opacity, `the picker keeps its collections, its ${cp.swatches} swatches, hex, spectrum and opacity`);
  ok(cp.beside && cp.inView, `the spectrum still stands beside the palette (menu ${cp.w} px wide)`);
  ok(cp.onTab === "rgb(67, 133, 190)" && (!cp.dropper || cp.dropBg === "rgb(255, 252, 240)"), "its open collection is lit and its dropper is a paper key");
  await shot(page, "fmenu-look-05-picker");
  await page.keyboard.press("Tab");
  await waitFor(page, () => !!document.querySelector(".fluxFigMenu .cs .cmp"), null, { label: "colormaps" });
  const maps = await page.evaluate(() => ({ n: document.querySelectorAll(".fluxFigMenu .cmp .cm").length, h: [...new Set([...document.querySelectorAll(".fluxFigMenu .cmp .cm")].map((r) => r.getBoundingClientRect().height))] }));
  ok(maps.n > 80 && maps.h.length === 1 && maps.h[0] === 22, `the colormaps are all there, 22 px a row (${maps.n})`);
  await page.keyboard.press("Escape");
  await waitFor(page, () => !document.querySelector(".fluxFigMenu .cs") && !!document.querySelector(".fluxFigMenu .group"), null, { label: "back to the properties" });
  ok(await page.evaluate(() => document.activeElement === document.querySelector(".fluxFigMenu")), "Escape returns from the picker to the properties, the menu keeping the keyboard");

  // --- 10. nothing animates at rest; no errors -------------------------------------------------------------
  await parkOnHead();
  await sleep(300);
  const idle = await page.evaluate(() => ({ anims: document.getAnimations().filter((a) => a.effect?.target?.closest?.(".fluxFigMenu")).length, blur: [...document.querySelectorAll(".fluxFigMenu, .fluxFigMenu *")].filter((n) => { const cs = getComputedStyle(n); return (cs.backdropFilter && cs.backdropFilter !== "none") || (cs.filter && cs.filter !== "none"); }).length }));
  ok(idle.anims === 0 && idle.blur === 0, `nothing in the menu animates at rest, and nothing is filtered or blurred (${JSON.stringify(idle)})`);
  await close();

  const errs = realErrors(page);
  ok(errs.length === 0, `no console errors (${errs.length})`);
  if (errs.length) console.error(errs.slice(0, 5));
  console.log(fails === 0 ? "\nVERIFY-FMENU-LOOK-GUI ALL PASS" : `\nVERIFY-FMENU-LOOK-GUI ${fails} FAILURE(S)`);
} finally {
  await browser.close();
}
process.exit(fails === 0 ? 0 : 1);
