// 2026-09-15 Snapshot & annotate (ui tier — dev server on :1420, demo fixture).
//   node scripts/verify-annotate-gui.mjs
// Covers the freeze-and-draw overlay end to end in a browser build (no window
// capture there — the note records marks + DOM anchors and says "no screenshot"):
// Ctrl+Shift+A opens it, dragging draws a numbered arrow anchored to the element
// under its head, `b` + drag draws a box, Backspace undoes, Escape cancels
// cleanly, Enter hands the crop to the Note-to-agent popover (chip + draft text
// kept), Add appends ONE ledger line whose stamp carries the snapshot, and the
// palette command reaches the same overlay.
import { launch, gotoApp, clickMode, realErrors, waitFor } from "./lib/driver.mjs";

const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 2500 });
await clickMode(page, "Figure").catch(() => {});
await waitFor(page, () => !!document.querySelector(".toolbar .tools button"), null, { timeout: 15000, label: "figure toolbar mounted" });

const checks = [];
const ok = (cond, msg) => {
  checks.push([!!cond, msg]);
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
};
const key = (code, opts = {}) =>
  page.evaluate(({ code, opts }) => {
    window.dispatchEvent(new KeyboardEvent("keydown", { code, bubbles: true, cancelable: true, ...opts }));
  }, { code, opts });
const centre = (sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
const drag = async (a, b) => { await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2); await page.mouse.move(b.x, b.y); await page.mouse.up(); };
const overlay = () => page.evaluate(() => {
  const root = document.querySelector(".annot");
  if (!root) return null;
  return {
    frozen: root.classList.contains("frozen"),
    marks: [...root.querySelectorAll(".annot-marks .mark")].map((g) => ({ kind: g.dataset.kind, n: g.dataset.n, badge: g.querySelector(".badge-n")?.textContent })),
    tool: [...root.querySelectorAll(".annot-tools button")].find((b) => b.classList.contains("on"))?.textContent?.trim(),
    hint: root.querySelector(".annot-tools .hint")?.textContent ?? "",
    covers: (() => { const r = root.getBoundingClientRect(); return r.width >= innerWidth - 1 && r.height >= innerHeight - 1; })(),
  };
});

// --- 1. the chord opens the overlay over the whole window --------------------------
await key("KeyA", { ctrlKey: true, shiftKey: true });
await waitFor(page, () => !!document.querySelector(".annot .annot-tools"), null, { timeout: 5000, label: "annotate overlay open" });
let o = await overlay();
ok(o && o.covers, "Ctrl+Shift+A opens the annotate overlay across the whole window");
ok(o && !o.frozen && /no screenshot/.test(o.hint), "a browser build says it has no screenshot (marks still count)");
ok(o && o.tool === "aarrow", `the arrow tool is armed by default (${o?.tool})`);

// --- 2. drag = a numbered arrow anchored to the element under its head --------------
const gallery = await centre('.toolbar button[title^="Plot gallery"]');
await drag({ x: gallery.x + 140, y: gallery.y + 120 }, gallery);
await waitFor(page, () => document.querySelectorAll(".annot .mark").length === 1, null, { label: "one mark" });
o = await overlay();
ok(o.marks[0].kind === "arrow" && o.marks[0].badge === "1", `the drag drew arrow #1 (${JSON.stringify(o.marks[0])})`);

// --- 3. b + drag = a box; Backspace undoes it ----------------------------------------
await page.keyboard.press("b");
o = await overlay();
ok(o.tool === "bbox", "b arms the box tool");
const layers = await centre(".sidebar");
await drag({ x: layers.x - 40, y: layers.y - 30 }, { x: layers.x + 40, y: layers.y + 30 });
await waitFor(page, () => document.querySelectorAll(".annot .mark").length === 2, null, { label: "two marks" });
o = await overlay();
ok(o.marks[1].kind === "box" && o.marks[1].badge === "2", "the second drag drew box #2");
await page.keyboard.press("Backspace");
await waitFor(page, () => document.querySelectorAll(".annot .mark").length === 1, null, { label: "undo" });
ok(true, "Backspace removes the last mark");

// --- 4. Enter → the note popover with the snapshot chip; the note lands in the ledger --
await page.keyboard.press("Enter");
await waitFor(page, () => !!document.querySelector(".fc textarea") && !document.querySelector(".annot"), null, { timeout: 5000, label: "note popover with the crop" });
const chip = await page.evaluate(() => document.querySelector(".fc .fc-cap")?.textContent?.replace(/\s+/g, " ").trim() ?? "");
ok(/snapshot · 1 mark/.test(chip) && /no screenshot/.test(chip), `the popover shows the snapshot chip (${chip})`);
const stampLine = await page.evaluate(() => document.querySelector(".fc-stamp")?.textContent ?? "");
ok(/snapshot ×1 \(1 → .*button/.test(stampLine), `the stamp line names the anchored button (${stampLine})`);
await page.type(".fc textarea", "1 should sit flush with the left rail");
await page.evaluate(() => { [...document.querySelectorAll(".fc button")].find((b) => b.textContent?.trim() === "Add")?.click(); });
await waitFor(page, () => { const f = window.fig?._files; if (!f) return false; for (const k of f.keys()) if (k.endsWith(".meta/feedback.ndjson")) return true; return false; }, null, { timeout: 8000, label: "ledger written" });
const ledger = await page.evaluate(() => { const f = window.fig._files; for (const [k, v] of f.entries()) if (k.endsWith(".meta/feedback.ndjson")) return new TextDecoder().decode(v); return ""; });
const lines = ledger.trim().split("\n").map((l) => JSON.parse(l));
const note = lines.find((l) => l.kind === "note");
const snap = note?.context?.snapshot;
ok(lines.length === 1 && note?.text === "1 should sit flush with the left rail", "ONE ledger line: the note");
ok(snap && snap.image === null && snap.marks.length === 1 && snap.marks[0].kind === "arrow" && snap.marks[0].n === 1, `the stamp carries the snapshot (marks=${snap?.marks?.length}, image=${snap?.image})`);
ok(snap && typeof snap.marks[0].anchor?.path === "string" && /button/.test(snap.marks[0].anchor.path) && /Gallery/.test(snap.marks[0].anchor.text ?? ""), `arrow #1 is anchored to the Gallery button (${snap?.marks?.[0]?.anchor?.path} "${snap?.marks?.[0]?.anchor?.text}")`);
ok(snap && snap.rect.w >= 240 && snap.rect.h >= 160 && snap.rect.x >= 0 && snap.rect.y >= 0 && snap.window.w > 0, `the crop is a sane window rect (${JSON.stringify(snap?.rect)})`);
const pngWritten = await page.evaluate(() => { const f = window.fig._files; for (const k of f.keys()) if (/\.meta\/feedback\/.*\.png$/.test(k)) return true; return false; });
ok(!pngWritten, "no PNG is written when there is no window capture");
await waitFor(page, () => !document.querySelector(".fc textarea"), null, { timeout: 5000, label: "popover closed after Add" });
ok(true, "Add closes the popover");

// --- 5. Escape cancels the overlay without a note; the popover keeps its draft ----------
await key("KeyM", { ctrlKey: true, shiftKey: true });
await waitFor(page, () => !!document.querySelector(".fc textarea"), null, { label: "popover" });
await page.type(".fc textarea", "draft kept");
await page.evaluate(() => { document.querySelector(".fc .fc-annot")?.click(); });
await waitFor(page, () => !!document.querySelector(".annot") && !document.querySelector(".fc textarea"), null, { label: "overlay from the popover button" });
ok(true, "the popover's Snapshot & annotate button opens the overlay (popover hidden)");
await page.keyboard.press("Escape");
await waitFor(page, () => !document.querySelector(".annot"), null, { label: "overlay closed" });
ok(!(await page.$(".fc textarea")), "Escape cancels the overlay without reopening the popover");
await key("KeyM", { ctrlKey: true, shiftKey: true });
await waitFor(page, () => !!document.querySelector(".fc textarea"), null, { label: "popover again" });
const draft = await page.$eval(".fc textarea", (el) => el.value);
ok(draft === "draft kept", `the draft text survived the hand-off (${JSON.stringify(draft)})`);
ok(!(await page.$(".fc .fc-cap")), "a cancelled overlay attaches nothing");
await page.keyboard.press("Escape");
await waitFor(page, () => !document.querySelector(".fc textarea"), null, { label: "popover closed" });
const after = await page.evaluate(() => { const f = window.fig._files; for (const [k, v] of f.entries()) if (k.endsWith(".meta/feedback.ndjson")) return new TextDecoder().decode(v).trim().split("\n").length; return 0; });
ok(after === 1, "no extra ledger lines from the cancelled round");

// --- 6. the palette reaches the overlay too ----------------------------------------------
await key("KeyK", { ctrlKey: true });
await waitFor(page, () => !!document.querySelector(".cp input"), null, { timeout: 5000, label: "global palette" });
await page.type(".cp input", "snapshot & annotate");
await page.keyboard.press("Enter");
await waitFor(page, () => !!document.querySelector(".annot .annot-tools"), null, { timeout: 5000, label: "overlay via palette" });
ok(true, "the ⌘K palette command opens the overlay");
await page.keyboard.press("Escape");
await waitFor(page, () => !document.querySelector(".annot"), null, { label: "closed" });

const errs = await realErrors(page);
ok(errs.length === 0, `clean console (${errs.length} errors${errs.length ? ": " + errs[0] : ""})`);

await browser.close();
const failed = checks.filter(([c]) => !c).length;
console.log(`##VERIFY## ${JSON.stringify({ script: "verify-annotate-gui", ok: failed === 0, checks: checks.length, failed })}`);
console.log(failed ? `verify-annotate-gui: FAIL (${failed}/${checks.length})` : `verify-annotate-gui: PASS (${checks.length} checks)`);
process.exit(failed ? 1 : 0);
