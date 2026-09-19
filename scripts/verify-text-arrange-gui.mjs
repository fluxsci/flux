// Text ARRANGEMENT inside the box (2026-09-18, ui) — the live surfaces over
// text.ts blockLayout:
//   · the Inspector's Align gains Justify; the live <text> stretches every line
//     but the last of each paragraph (textLength + lengthAdjust="spacing") and
//     the stretched lines really reach the box's right edge
//   · Vertical align drops the block inside a FIXED box — the painted baseline
//     and the inline editor's overlay move together (editor⇄render parity) and
//     returning to Top deletes the property
//   · Paragraph spacing opens a gap at a hard break only — the lines WITHIN one
//     wrapped paragraph keep the plain advance — and grows a hugging box
//   · Letter spacing is a WRAP METRIC with real font metrics: tracking a
//     wrapping box re-wraps it, and the attribute reaches the live <text>
//   · the F menu carries the rows (vertical align, letter spacing, and the
//     paragraph row only once there is a second paragraph); each armed edit is
//     ONE undo entry
//   Run (dev server on :1420): node scripts/verify-text-arrange-gui.mjs
import { launch, gotoApp, clickMode, shot, sleep, realErrors, waitFor } from "./lib/driver.mjs";

let fails = 0;
const ok = (cond, msg) => (cond ? console.log("  ✓ " + msg) : (fails++, console.log("  ✗ " + msg)));

const { browser, page } = await launch({ width: 1500, height: 950 });
try {
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
  await clickMode(page, "Figure");
  await sleep(700);

  // Seed: a FIXED tall box (vertical align), a WRAPPED two-paragraph box
  // (paragraph spacing must not touch the wrapped lines) and a wrapping
  // one-paragraph box (justification + tracking).
  await page.evaluate(() => {
    const F = window.__flux.fig;
    const base = {
      type: "text", rotation: 0, fontFamily: "Arial", fontSize: 16, fontWeight: 400,
      fontStyle: "normal", color: "#222222", align: "left", lineHeight: 1.2,
    };
    F.commit((p) => {
      const g = p.figures[0];
      g.x = 0; g.y = 0; g.width = 1100; g.height = 760;
      g.elements = [
        { ...base, id: "ta-fixed", x: 40, y: 40, width: 220, height: 200, text: "Boxed", sizing: "fixed" },
        { ...base, id: "ta-paras", x: 320, y: 40, width: 200, height: 120, text: "alpha beta gamma delta epsilon\nsecond paragraph", sizing: "auto-h" },
        { ...base, id: "ta-wrap", x: 640, y: 40, width: 240, height: 140, text: "the quick brown fox jumps over the lazy dog and then keeps running", sizing: "auto-h" },
      ];
      window.__figId = g.id;
      F.activeFigureId.set(g.id);
    });
    // A seeded element carries no wrap cache: measure it once, exactly as any
    // GUI edit would (the gate is about the arrangement, not about seeding).
    F.commit((p) => window.__flux.text.reflowTexts(p, ["ta-fixed", "ta-paras", "ta-wrap"]));
    F.viewport.set({ panX: 60, panY: 80, zoom: 1 });
    F.resetHistory();
  });
  await sleep(600);

  const model = (id) => page.evaluate((id) => structuredClone(window.__flux.figures().flatMap((f) => f.elements).find((e) => e.id === id)), id);
  const hist = () => page.evaluate(() => window.__flux.fig.historyStats());
  // The live <text> for an element: its y/anchor/tracking and each tspan's
  // dy / textLength, found by its first painted line.
  const painted = (id) =>
    page.evaluate((id) => {
      const m = window.__flux.figures().flatMap((f) => f.elements).find((e) => e.id === id);
      const first = (m.lines?.[0] ?? m.text.split("\n")[0]) || "";
      const t = [...document.querySelectorAll(".scene-svg text")].find((n) => (n.firstElementChild?.textContent ?? "") === first);
      if (!t) return null;
      return {
        y: Number(t.getAttribute("y")),
        anchor: t.getAttribute("text-anchor"),
        tracking: t.getAttribute("letter-spacing"),
        spans: [...t.children].map((s) => ({
          text: s.textContent,
          dy: Number(s.getAttribute("dy")),
          len: s.getAttribute("textLength"),
          adjust: s.getAttribute("lengthAdjust"),
        })),
      };
    }, id);
  const select = async (id) => {
    await page.evaluate((id) => window.__flux.fig.selectOnly(id), id);
    await sleep(250);
  };
  // The Inspector's selects are found by their aria-label or their <label> text.
  const setSelect = async (label, value) => {
    await page.evaluate(
      (label, value) => {
        const sel = [...document.querySelectorAll("select")].find(
          (s) => (s.getAttribute("aria-label") ?? s.closest("label")?.textContent ?? "").trim().startsWith(label),
        );
        if (!sel) throw new Error("no select for " + label);
        sel.value = value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      },
      label,
      value,
    );
    await sleep(350);
  };
  // The F menu: open it, read its rows, arm one by its hotkey.
  const openMenu = async () => {
    await page.keyboard.press("f");
    await waitFor(page, () => !!document.querySelector(".fluxFigMenu"), null, { label: "property menu" });
    await sleep(180);
    return page.evaluate(() =>
      [...document.querySelectorAll(".fluxFigMenu .field")].map((f) => ({
        key: f.getAttribute("data-key"),
        label: (f.querySelector(".label")?.textContent ?? "").trim(),
      })),
    );
  };
  const closeMenu = async () => {
    await page.keyboard.press("Escape");
    await sleep(220);
  };

  // --- 1. justification ------------------------------------------------------
  console.log("\n1. justify");
  await select("ta-wrap");
  const wrapBefore = await painted("ta-wrap");
  ok(wrapBefore && wrapBefore.spans.length >= 3, `the wrapping box really wraps (${wrapBefore?.spans.length} lines)`);
  ok(wrapBefore.spans.every((s) => s.len === null), "nothing is stretched before justifying");
  await setSelect("Align", "justify");
  ok((await model("ta-wrap")).align === "justify", "the Inspector's Align offers (and applies) Justify");
  const just = await painted("ta-wrap");
  const stretched = just.spans.filter((s) => s.len !== null);
  ok(stretched.length === just.spans.length - 1, `every line but the last is stretched (${stretched.length}/${just.spans.length})`);
  ok(stretched.every((s) => Number(s.len) === 240 && s.adjust === "spacing"), "…to the box width, by spacing");
  ok(just.spans[just.spans.length - 1].len === null, "the paragraph's last line keeps its natural width");
  ok(just.anchor === "start", "justified text still anchors at the left edge");
  // Real painted geometry, not just the attribute.
  const ends = await page.evaluate(() => {
    const t = [...document.querySelectorAll(".scene-svg text")].find((n) => (n.textContent ?? "").includes("quick"));
    return [...t.children].map((s) => Math.round(s.getBBox().x + s.getBBox().width));
  });
  ok(ends.slice(0, -1).every((x) => Math.abs(x - 880) <= 2), `stretched lines reach the box's right edge at x=880 (${ends.join(", ")})`);
  ok(ends[ends.length - 1] < 878, `…and the last line stops short of it (${ends[ends.length - 1]})`);
  await shot(page, "text-arrange-01-justified");

  // --- 2. vertical alignment -------------------------------------------------
  console.log("\n2. vertical align");
  await select("ta-fixed");
  const topY = (await painted("ta-fixed")).y;
  ok(topY === 40 + 16, `top: the baseline is y + fontSize, exactly as before the feature (${topY})`);
  await setSelect("Vertical", "middle");
  ok((await model("ta-fixed")).valign === "middle", "Vertical align writes the property");
  const midY = (await painted("ta-fixed")).y;
  // box 200 tall, one 19.2px line → (200 − 19.2) / 2 = 90.4 below the box top.
  ok(Math.abs(midY - (40 + 90.4 + 16)) < 0.5, `middle: the block is centred in the box (y=${midY})`);
  await setSelect("Vertical", "bottom");
  const botY = (await painted("ta-fixed")).y;
  ok(Math.abs(botY - (40 + 180.8 + 16)) < 0.5, `bottom: the block sits on the box floor (y=${botY})`);
  const fixedBox = await model("ta-fixed");
  ok(fixedBox.height === 200 && fixedBox.y === 40, "…and the box itself never moves or resizes");
  await setSelect("Vertical", "top");
  ok(!("valign" in (await model("ta-fixed"))), "returning to Top DELETES the property (no file noise)");
  await setSelect("Vertical", "middle");

  // Editor⇄render parity: the inline editor overlays the painted glyphs.
  const host = await page.evaluate(() => {
    const r = document.querySelector(".canvas-host").getBoundingClientRect();
    const vp = window.__flux.get(window.__flux.fig.viewport);
    return { left: r.left, top: r.top, panX: vp.panX, panY: vp.panY, zoom: vp.zoom };
  });
  // Aim at the painted glyphs themselves — a text element has no invisible hit
  // box, so the pointer must land on the ink (which is exactly what has moved).
  const ink = await page.evaluate(() => {
    const t = [...document.querySelectorAll(".scene-svg text")].find((n) => (n.textContent ?? "").includes("Boxed"));
    const b = t.getBBox();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  });
  await page.mouse.click(host.left + host.panX + ink.x * host.zoom, host.top + host.panY + ink.y * host.zoom, { count: 2 });
  await waitFor(page, () => !!document.querySelector("textarea.text-edit"), null, { label: "inline editor" });
  const overlayTop = await page.evaluate(() => document.querySelector("textarea.text-edit").getBoundingClientRect().top);
  const wantTop = host.top + host.panY + (40 + 90.4) * host.zoom;
  ok(Math.abs(overlayTop - wantTop) < 2, `the inline editor follows the vertical alignment (${overlayTop.toFixed(1)} vs ${wantTop.toFixed(1)})`);
  await page.keyboard.press("Escape");
  await sleep(250);

  // --- 3. paragraph spacing (through the F menu) -----------------------------
  console.log("\n3. paragraph spacing");
  await select("ta-paras");
  const parasBefore = await painted("ta-paras");
  const hugBefore = (await model("ta-paras")).height;
  ok(parasBefore.spans.length >= 3, `the first paragraph wraps (${parasBefore.spans.length} lines in two paragraphs)`);
  ok(parasBefore.spans.slice(1).every((s) => s.dy === 19.2), "every line starts one plain advance below the last");
  let rows = await openMenu();
  const paraRow = rows.find((r) => /paragraph spacing/i.test(r.label));
  ok(!!paraRow, `a multi-paragraph text gets the paragraph spacing row (${paraRow?.key})`);
  const h0 = (await hist()).past;
  await page.keyboard.press(paraRow.key);
  await sleep(180);
  await page.keyboard.type("9"); // 9 pt = 12 canvas px
  await page.keyboard.press("Enter");
  await sleep(300);
  ok(Math.abs((await model("ta-paras")).paragraphSpacing - 12) < 1e-6, `9 pt lands as 12 canvas px (${(await model("ta-paras")).paragraphSpacing})`);
  ok((await hist()).past === h0 + 1, "the whole armed edit is ONE undo entry");
  await closeMenu();
  const parasAfter = await painted("ta-paras");
  const lastOfFirst = parasBefore.spans.length - 1; // the second paragraph's only line
  ok(parasAfter.spans[lastOfFirst].dy === 19.2 + 12, `the gap lands on the second paragraph's first line (${parasAfter.spans[lastOfFirst].dy})`);
  ok(
    parasAfter.spans.slice(1, lastOfFirst).every((s) => s.dy === 19.2),
    "the lines WITHIN the wrapped first paragraph are untouched",
  );
  ok((await model("ta-paras")).height === hugBefore + 12, `a hugging box grows by exactly the gap (${hugBefore} → ${(await model("ta-paras")).height})`);

  // --- 4. letter spacing is a wrap metric ------------------------------------
  console.log("\n4. letter spacing");
  await select("ta-wrap");
  const firstLineBefore = (await painted("ta-wrap")).spans[0].text;
  rows = await openMenu();
  const trackRow = rows.find((r) => /letter spacing/i.test(r.label));
  ok(!!trackRow, `the menu carries a letter spacing row (${trackRow?.key})`);
  await page.keyboard.press(trackRow.key);
  await sleep(180);
  await page.keyboard.type("2.25"); // 2.25 pt = 3 canvas px
  await page.keyboard.press("Enter");
  await sleep(350);
  await closeMenu();
  const tracked = await painted("ta-wrap");
  ok(tracked.tracking === "3", `the live <text> carries letter-spacing (${tracked.tracking})`);
  // The wrap BOUNDARY has to move: tracking is part of the metric the wrapper
  // measures with, so fewer words fit on the first line.
  ok(
    tracked.spans[0].text.length < firstLineBefore.length,
    `tracking re-wraps with REAL font metrics ("${firstLineBefore}" → "${tracked.spans[0].text}")`,
  );
  ok(!(await model("ta-wrap")).needsLayout, "…and the GUI reflow left no stale-layout flag");
  await shot(page, "text-arrange-02-tracked");

  // --- 5. the vertical-align row, and one undo -------------------------------
  console.log("\n5. the property menu's vertical align");
  await select("ta-fixed");
  rows = await openMenu();
  const vRow = rows.find((r) => /vertical align/i.test(r.label));
  ok(!!vRow, `a FIXED box gets the vertical align row (${vRow?.key})`);
  const h1 = (await hist()).past;
  await page.keyboard.press(vRow.key);
  await sleep(180);
  const vopts = await page.evaluate(() => [...document.querySelectorAll(".fluxFigMenu .field.opts-open .opt")].map((o) => o.textContent.trim().replace(/^\d/, "")));
  ok(vopts.length === 3 && /Bottom/.test(vopts[2]), `it expands Top · Middle · Bottom (${vopts.join(" | ")})`);
  await page.keyboard.press("3");
  await sleep(300);
  ok((await model("ta-fixed")).valign === "bottom", "…and 3 picks Bottom");
  ok((await hist()).past === h1 + 1, "one menu edit = one undo entry");
  await closeMenu();
  await page.evaluate(() => window.__flux.fig.undo());
  await sleep(300);
  ok((await model("ta-fixed")).valign === "middle", "one undo restores the previous arrangement");

  const errs = realErrors(page);
  ok(errs.length === 0, `clean console (${errs.length})`);
  if (errs.length) console.log(errs.slice(0, 5).join("\n"));
} finally {
  await browser.close();
}
console.log(`\n##VERIFY## ${JSON.stringify({ name: "text-arrange-gui", pass: fails === 0, fails })}`);
process.exit(fails === 0 ? 0 : 1);
