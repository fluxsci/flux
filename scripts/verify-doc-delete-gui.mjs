// Deleting a document from the Paper rail — the × on a row and the Delete key,
// against the real app. The pure contract (policy, sidecar, manifest, flux-core)
// lives in verify-doc-delete.ts; this gate covers the wiring only the app has:
//   A. the × is offered on exactly the deletable rows — never the main
//      manuscript, never a Context row
//   B. the × asks first: a confirmation dialog, and Cancel / Escape keep
//      everything (the row, the file, the open document)
//   C. confirming deletes: the row goes, the editor moves to the main
//      manuscript, the file and its manifest registration are gone — and the
//      figures (fig/index.json) and the main manuscript are byte-identical
//   D. Delete on a focused row is the same request; Enter confirms it (the
//      Delete button holds focus), and the editor gets focus back afterwards
//   E. pressing the × never OPENS the document (it is not the row's click)
//      and never starts a drag (the order is untouched)
// Run (dev server on :1420): node scripts/verify-doc-delete-gui.mjs
import { launch, gotoApp, clickMode, sleep, realErrors, waitFor, APP_URL } from "./lib/driver.mjs";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-doc-delete-gui");
const ROOT = "/demo/myc-growth-paper";
const MAIN = "manuscript/main.qmd";

const { browser, page } = await launch();
await gotoApp(page, { url: `${APP_URL.replace(/\/$/, "")}/?fixture=demo`, settle: 3500 });

await clickMode(page, "Paper");
await waitFor(page, () => document.querySelectorAll(".docpicker .dp-item").length >= 2, null, {
  timeout: 10000,
  label: "the Documents list is populated",
});

/** The rail's rows by path, each with whether it offers a ×. */
const rows = () =>
  page.evaluate(() => {
    const list = (ul) =>
      [...(ul?.querySelectorAll("li") ?? [])].map((li) => ({
        path: li.querySelector(".dp-item")?.getAttribute("title") ?? null,
        del: !!li.querySelector(".dp-del"),
      }));
    const uls = [...document.querySelectorAll(".docpicker ul")];
    return { docs: list(uls[0]), ctx: list(uls[1]) };
  });
const activeDoc = () =>
  page.evaluate(() => document.querySelector(".docpicker .dp-item.active")?.getAttribute("title") ?? null);
const dialogOpen = () => page.evaluate(() => !!document.querySelector("#doc-delete-dialog"));
const readText = (rel) => page.evaluate(async (p) => window.fig.readText(p), `${ROOT}/${rel}`);
const exists = (rel) => page.evaluate(async (p) => window.fig.exists(p), `${ROOT}/${rel}`);
const manifest = async () => JSON.parse(await readText("project.json"));
const clickRow = (path) =>
  page.evaluate((p) => {
    [...document.querySelectorAll(".docpicker .dp-item")].find((b) => b.getAttribute("title") === p)?.click();
  }, path);
const clickDel = (path) =>
  page.evaluate((p) => {
    const li = [...document.querySelectorAll(".docpicker li")].find(
      (l) => l.querySelector(".dp-item")?.getAttribute("title") === p,
    );
    const btn = li?.querySelector(".dp-del");
    if (!btn) return false;
    btn.click();
    return true;
  }, path);
/** Create a document through the rail's own "+ New document" (it opens it). */
async function createDoc(name) {
  await page.evaluate(() => document.querySelector(".docpicker .dp-new").click());
  await waitFor(page, () => !!document.querySelector("#new-doc-input"), null, { timeout: 5000, label: "the new-document prompt" });
  await page.type("#new-doc-input", name);
  await page.keyboard.press("Enter");
  await waitFor(
    page,
    (t) => [...document.querySelectorAll(".docpicker .dp-title")].some((e) => e.textContent === t),
    name,
    { timeout: 8000, label: `the new document "${name}" is listed` },
  );
  await sleep(300);
  return page.evaluate(
    (t) =>
      [...document.querySelectorAll(".docpicker .dp-item")]
        .find((b) => b.querySelector(".dp-title")?.textContent === t)
        ?.getAttribute("title") ?? null,
    name,
  );
}

// What must NOT change, captured before anything is created or deleted.
const figIndexBefore = await readText("fig/index.json");
const mainBefore = await readText(MAIN);
const start = await rows();

// --- A. the × is offered on exactly the deletable rows -----------------------
h.section("A — which rows offer a ×");
{
  const main = start.docs.find((r) => r.path === MAIN);
  h.ok(!!main && !main.del, "the main manuscript's row has no × (it can't be deleted)");
  h.ok(start.ctx.length > 0 && start.ctx.every((r) => !r.del), `no Context row has a × (${start.ctx.length} rows)`);
  h.ok(
    start.docs.filter((r) => r.path !== MAIN).every((r) => r.del),
    `every other document row has one (${start.docs.filter((r) => r.path !== MAIN).map((r) => r.path).join(" · ")})`,
  );
}

// --- B. it asks first, and Cancel keeps everything ---------------------------
h.section("B — the × asks first; Cancel and Escape keep everything");
const SCRATCH = await createDoc("Scratch");
h.ok(!!SCRATCH, `"+ New document" created ${SCRATCH}`);
h.eq(await activeDoc(), SCRATCH, "…and opened it");
{
  h.ok(await clickDel(SCRATCH), "the new row offers a ×");
  await waitFor(page, () => !!document.querySelector("#doc-delete-dialog"), null, { timeout: 4000, label: "the confirmation dialog" });
  const focused = await page.evaluate(() => document.activeElement?.id ?? null);
  h.eq(focused, "doc-delete-confirm", "the dialog opens with the Delete button focused");
  h.ok(
    await page.evaluate((p) => document.querySelector("#doc-delete-dialog")?.textContent?.includes(p), SCRATCH),
    "…and names the file it is about to remove",
  );
  await page.keyboard.press("Escape");
  await sleep(200);
  h.eq(await dialogOpen(), false, "Escape closes the dialog");
  h.ok((await rows()).docs.some((r) => r.path === SCRATCH), "…the row is still listed");
  h.eq(await exists(SCRATCH), true, "…the file is still there");
  h.eq(await activeDoc(), SCRATCH, "…and it is still the open document");

  await clickDel(SCRATCH);
  await waitFor(page, () => !!document.querySelector("#doc-delete-dialog"), null, { timeout: 4000, label: "the dialog again" });
  await page.evaluate(() => document.querySelector("#doc-delete-cancel").click());
  await sleep(200);
  h.eq(await dialogOpen(), false, "Cancel closes it too");
  h.eq(await exists(SCRATCH), true, "…and the file is still there");
}

// --- C. confirming deletes ---------------------------------------------------
h.section("C — Delete removes the document and nothing else");
{
  await clickDel(SCRATCH);
  await waitFor(page, () => !!document.querySelector("#doc-delete-dialog"), null, { timeout: 4000, label: "the dialog" });
  await page.evaluate(() => document.querySelector("#doc-delete-confirm").click());
  await waitFor(
    page,
    (p) => ![...document.querySelectorAll(".docpicker .dp-item")].some((b) => b.getAttribute("title") === p),
    SCRATCH,
    { timeout: 6000, label: "the deleted row is gone from the list" },
  );
  await sleep(300);
  h.eq(await dialogOpen(), false, "the dialog closed");
  h.eq(await activeDoc(), MAIN, "the editor moved to the main manuscript (the deleted one was open)");
  h.eq(await exists(SCRATCH), false, "the file is gone");
  const m = await manifest();
  h.ok(!(m.supplementary ?? []).some((s) => s.path === SCRATCH), "project.json no longer registers it");
  h.ok(!(m.documentOrder ?? []).includes(SCRATCH), "…and documentOrder doesn't name it");
  h.eq(await readText("fig/index.json"), figIndexBefore, "fig/index.json is byte-identical — figures are untouched");
  h.eq(await readText(MAIN), mainBefore, "the main manuscript is byte-identical");
  const now = await rows();
  h.eq(
    now.docs.map((r) => r.path),
    start.docs.map((r) => r.path),
    "the list is exactly what it was before the document existed",
  );
  h.eq(now.ctx.map((r) => r.path), start.ctx.map((r) => r.path), "…Context rows included");
}

// --- D. the Delete key on a focused row --------------------------------------
h.section("D — Delete on a focused row, Enter to confirm");
const KEYED = await createDoc("Keyed");
{
  await clickRow(MAIN); // back to main: the deletion must not need the document open
  await sleep(400);
  h.eq(await activeDoc(), MAIN, "back on the main manuscript");
  await page.evaluate(
    (p) => [...document.querySelectorAll(".docpicker .dp-item")].find((b) => b.getAttribute("title") === p)?.focus(),
    KEYED,
  );
  await page.keyboard.press("Delete");
  await waitFor(page, () => !!document.querySelector("#doc-delete-dialog"), null, { timeout: 4000, label: "Delete key opens the dialog" });
  h.ok(true, "Delete on the focused row asks to delete it");
  await page.keyboard.press("Enter");
  await waitFor(
    page,
    (p) => ![...document.querySelectorAll(".docpicker .dp-item")].some((b) => b.getAttribute("title") === p),
    KEYED,
    { timeout: 6000, label: "the row is gone" },
  );
  await sleep(300);
  h.eq(await exists(KEYED), false, "Enter confirmed — the file is gone");
  h.eq(await activeDoc(), MAIN, "the open document is unchanged (it wasn't the deleted one)");
  h.ok(
    await page.evaluate(() => !!document.activeElement?.closest(".cm-editor")),
    "focus returned to the editor",
  );
  // The main row must ignore the key: nothing to confirm.
  await page.evaluate(
    (p) => [...document.querySelectorAll(".docpicker .dp-item")].find((b) => b.getAttribute("title") === p)?.focus(),
    MAIN,
  );
  await page.keyboard.press("Delete");
  await sleep(300);
  h.eq(await dialogOpen(), false, "Delete on the main manuscript's row does nothing");
  h.eq(await exists(MAIN), true, "…and the main manuscript is still there");
}

// --- E. the × is not the row's click, and not a drag handle -------------------
h.section("E — the × neither opens the document nor drags the row");
const THIRD = await createDoc("Third");
{
  await clickRow(MAIN);
  await sleep(400);
  const orderBefore = (await rows()).docs.map((r) => r.path);
  const box = await page.evaluate((p) => {
    const li = [...document.querySelectorAll(".docpicker li")].find(
      (l) => l.querySelector(".dp-item")?.getAttribute("title") === p,
    );
    li.querySelector(".dp-del").style.opacity = "1"; // it shows on hover; a real pointer is over it
    const r = li.querySelector(".dp-del").getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, THIRD);
  // A press on the × that wanders (a shaky hand) — must not become a row drag.
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x, box.y - 40, { steps: 4 });
  await page.mouse.up();
  await sleep(300);
  h.eq((await rows()).docs.map((r) => r.path), orderBefore, "a press on the × never drags the row");
  h.eq(await activeDoc(), MAIN, "…and never opens the document");
  await page.evaluate(() => document.querySelector("#doc-delete-cancel")?.click()); // if it did open a dialog, close it
  await sleep(200);
  await page.mouse.click(box.x, box.y);
  await waitFor(page, () => !!document.querySelector("#doc-delete-dialog"), null, { timeout: 4000, label: "a real click on the × asks" });
  h.eq(await activeDoc(), MAIN, "a click on the × asks to delete WITHOUT opening the document");
  await page.evaluate(() => document.querySelector("#doc-delete-confirm").click());
  await waitFor(
    page,
    (p) => ![...document.querySelectorAll(".docpicker .dp-item")].some((b) => b.getAttribute("title") === p),
    THIRD,
    { timeout: 6000, label: "the row is gone" },
  );
  h.eq(await exists(THIRD), false, "…and confirming removes it");
}

const errs = realErrors(page);
h.ok(errs.length === 0, errs.length ? `console errors: ${errs.join(" | ")}` : "zero console errors");
await h.done(() => browser.close());
