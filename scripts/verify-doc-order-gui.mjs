// Document ORDER in the Paper rail — the drag and the Alt+↑/↓ chord, against
// the real app. The pure contract lives in verify-doc-order.ts (docOrder.ts);
// this gate covers the wiring nobody else can see:
//   A. drag a document row up the Documents list → the list reorders, and the
//      row that was dragged is NOT opened (a drag is not a click)
//   B. the order is recorded in project.json as `documentOrder`
//   C. a plain click still opens the document (the drag threshold, and the
//      suppressed post-drag click, never eat an ordinary click)
//   D. Alt+↑ / Alt+↓ move a focused row, and stop at the ends
//   E. the Context group is a separate list — a document move leaves it alone
// Run (dev server on :1420): node scripts/verify-doc-order-gui.mjs
import { launch, gotoApp, clickMode, sleep, realErrors, waitFor, APP_URL } from "./lib/driver.mjs";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-doc-order-gui");
const ROOT = "/demo/myc-growth-paper";
const MAIN = "manuscript/main.qmd";
const SUPP = "manuscript/supp.qmd";
const ALPHA = "manuscript/alpha.qmd";
const ZETA = "manuscript/zeta.qmd";

const { browser, page } = await launch();
await gotoApp(page, { url: `${APP_URL.replace(/\/$/, "")}/?fixture=demo`, settle: 3500 });

await clickMode(page, "Paper");
await waitFor(page, () => document.querySelectorAll(".docpicker .dp-item").length >= 2, null, {
  timeout: 10000,
  label: "the Documents list is populated",
});

// Two more documents, so there is an order to rearrange (the demo ships main +
// supp) — made through the rail's own "+ New document", which is also what puts
// them in the list without a reload.
for (const name of ["Alpha", "Zeta"]) {
  await page.evaluate(() => document.querySelector(".docpicker .dp-new").click());
  await waitFor(page, () => !!document.querySelector("#new-doc-input"), null, {
    timeout: 5000,
    label: "the new-document prompt",
  });
  await page.type("#new-doc-input", name);
  await page.keyboard.press("Enter");
  await waitFor(
    page,
    (t) => [...document.querySelectorAll(".docpicker .dp-title")].some((e) => e.textContent === t),
    name,
    { timeout: 8000, label: `the new document "${name}" is listed` },
  );
}
// Back to the main manuscript (creating a document opens it).
await page.evaluate((p) => {
  [...document.querySelectorAll(".docpicker .dp-item")].find((b) => b.getAttribute("title") === p)?.click();
}, MAIN);
await sleep(500);

/** The rail's rows, by project-relative path (the row's title attribute). */
const rows = () =>
  page.evaluate(() => {
    const list = (ul) => [...(ul?.querySelectorAll(".dp-item") ?? [])].map((b) => b.getAttribute("title"));
    const uls = [...document.querySelectorAll(".docpicker ul")];
    return { docs: list(uls[0]), ctx: list(uls[1]) };
  });
const activeDoc = () =>
  page.evaluate(() => document.querySelector(".docpicker .dp-item.active")?.getAttribute("title") ?? null);
const savedOrder = () =>
  page.evaluate(async (root) => {
    const m = JSON.parse(await window.fig.readText(`${root}/project.json`));
    return m.documentOrder ?? null;
  }, ROOT);
const rowBox = async (i) =>
  page.evaluate((idx) => {
    const li = document.querySelectorAll(".docpicker ul")[0]?.querySelectorAll("li")[idx];
    if (!li) return null;
    const r = li.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, i);

const start = await rows();
h.eq(start.docs, [MAIN, ALPHA, SUPP, ZETA], `the default order is main first, then by title (${start.docs.join(" · ")})`);
const ctx0 = start.ctx;
h.ok(ctx0.length > 0, `the Context group is listed too (${ctx0.length} rows)`);
h.eq(await activeDoc(), MAIN, "the main manuscript is the open document");
h.eq(await savedOrder(), null, "nothing is recorded until the user arranges the list");

// --- A. drag the last row to the top -----------------------------------------
h.section("A — drag a row up the list");
{
  const from = await rowBox(3);
  const to = await rowBox(0);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, from.y - 8); // past the drag threshold
  await page.mouse.move(from.x, to.y, { steps: 6 });
  await page.mouse.up();
  await sleep(250);
  const r = await rows();
  h.eq(r.docs, [ZETA, MAIN, ALPHA, SUPP], "the dragged document is now first");
  h.eq(await activeDoc(), MAIN, "…and the drag did NOT open it (a drag is not a click)");
}
{
  // …and back DOWN over several rows in one gesture (the drag must not stop
  // after the first slot when the row's DOM node moves under the pointer).
  const from = await rowBox(0);
  const to = await rowBox(3);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, from.y + 8); // past the drag threshold
  await page.mouse.move(from.x, to.y, { steps: 8 });
  await page.mouse.up();
  await sleep(250);
  h.eq((await rows()).docs, [MAIN, ALPHA, SUPP, ZETA], "one downward drag crosses three rows, not one");
  // Put it back for the sections below.
  const back = await rowBox(3);
  const top = await rowBox(0);
  await page.mouse.move(back.x, back.y);
  await page.mouse.down();
  await page.mouse.move(back.x, back.y - 8);
  await page.mouse.move(back.x, top.y, { steps: 8 });
  await page.mouse.up();
  await sleep(250);
  h.eq((await rows()).docs, [ZETA, MAIN, ALPHA, SUPP], "…and dragging it back up restores the arrangement");
}

// --- B. it is recorded --------------------------------------------------------
h.section("B — the order is persisted");
{
  await waitFor(
    page,
    async (root) => {
      const m = JSON.parse(await window.fig.readText(`${root}/project.json`));
      return Array.isArray(m.documentOrder) && m.documentOrder[0] === "manuscript/zeta.qmd";
    },
    ROOT,
    { timeout: 5000, label: "project.json records documentOrder" },
  );
  const order = await savedOrder();
  h.eq(order.slice(0, 4), [ZETA, MAIN, ALPHA, SUPP], "project.json documentOrder is the list order");
  h.eq(order.length, 4 + ctx0.length, "…and it names every row, Context group included");
}

// --- C. a plain click is still a plain click ---------------------------------
h.section("C — click still opens the document");
{
  const b = await rowBox(3); // Supplementary Material
  await page.mouse.click(b.x, b.y);
  await waitFor(page, () => !!document.querySelector(".docpicker .dp-item.active"), null, {
    timeout: 6000,
    label: "a row is active",
  });
  await sleep(400);
  h.eq(await activeDoc(), SUPP, "clicking the last row opens that document");
  h.eq((await rows()).docs, [ZETA, MAIN, ALPHA, SUPP], "…and changes no order");
}

// --- D. Alt+↑ / Alt+↓ on a focused row ---------------------------------------
h.section("D — Alt+↑ / Alt+↓ move a focused row");
{
  // Focus a row ONCE, then drive the chord through the real keyboard. Pressing
  // again must keep working without re-focusing: reordering moves the row's DOM
  // node, which blurs it, and re-focusing here instead of in the app would hide
  // exactly that (the chord was a one-shot downwards — one slot per click).
  const focusRow = (path) =>
    page.evaluate(
      (p) =>
        [...document.querySelectorAll(".docpicker .dp-item")]
          .find((b) => b.getAttribute("title") === p)
          .focus(),
      path,
    );
  const chord = async (key) => {
    await page.keyboard.down("Alt");
    await page.keyboard.press(key);
    await page.keyboard.up("Alt");
    await sleep(200);
  };
  const focused = () =>
    page.evaluate(() => document.activeElement?.closest?.(".dp-item")?.getAttribute("title") ?? null);

  await focusRow(ALPHA);
  await chord("ArrowUp");
  h.eq((await rows()).docs, [ZETA, ALPHA, MAIN, SUPP], "Alt+↑ moves the focused row one slot up");
  h.eq(await focused(), ALPHA, "…and the row it moved keeps the focus");
  await chord("ArrowDown");
  h.eq((await rows()).docs, [ZETA, MAIN, ALPHA, SUPP], "Alt+↓ moves it back down");
  await chord("ArrowDown");
  h.eq((await rows()).docs, [ZETA, MAIN, SUPP, ALPHA], "a SECOND Alt+↓ keeps going — no re-click between presses");
  await chord("ArrowUp");
  await chord("ArrowUp");
  h.eq((await rows()).docs, [ZETA, ALPHA, MAIN, SUPP], "two Alt+↑ walk it back up two slots, same row throughout");
  await chord("ArrowUp");
  h.eq((await rows()).docs, [ALPHA, ZETA, MAIN, SUPP], "a third reaches the top — one slot per press, never more");
  await chord("ArrowUp");
  h.eq((await rows()).docs, [ALPHA, ZETA, MAIN, SUPP], "Alt+↑ on the top row is a no-op");
  await chord("ArrowDown");
  await chord("ArrowDown");
  await chord("ArrowDown");
  h.eq((await rows()).docs, [ZETA, MAIN, SUPP, ALPHA], "three Alt+↓ walk it all the way back down");
  await chord("ArrowDown");
  h.eq((await rows()).docs, [ZETA, MAIN, SUPP, ALPHA], "…and Alt+↓ at the bottom is a no-op, not a wrap");
  // Back to where B left it, so E reads the recorded order it expects.
  await chord("ArrowUp");
  h.eq((await rows()).docs, [ZETA, MAIN, ALPHA, SUPP], "the chord is reversible, one slot per press");
  h.eq(await activeDoc(), SUPP, "…and moving rows never changes which document is open");
}

// --- E. the Context group is its own list ------------------------------------
h.section("E — Documents and Context stay separate");
{
  const r = await rows();
  h.eq(r.ctx, ctx0, "the Context group is untouched by the document moves");
  const order = await savedOrder();
  h.eq(order.slice(4), ctx0, "…and it still sits after the documents in the recorded order");
}

const errs = realErrors(page);
h.ok(errs.length === 0, errs.length ? `console errors: ${errs.join(" | ")}` : "zero console errors");
await h.done(() => browser.close());
