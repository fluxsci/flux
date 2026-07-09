// figure-v1 Phase 3 (ui) — named text styles through the REAL Inspector UI:
//   • "New from selection…" creates a project style linked to the element
//   • the Style select applies it to a second text (props + link)
//   • a manual font edit DETACHES (select flips back to None)
//   • ⚙ popover "Update" re-applies the (changed) look to every linked text
//   • delete keeps the look, drops the link
//   • persistence round-trip via __flux.bridge saveFigFrom/loadFigInto
//   • machine-global library (memBridge localStorage): "→ Lib" saves; applying
//     a Library entry COPIES it into project.textStyles (copy-on-apply)
import { launch, gotoApp, clickMode, shot, realErrors, sleep } from "./lib/driver.mjs";

let fails = 0;
function assert(cond, msg) {
  if (cond) console.log("  ok:", msg);
  else {
    fails++;
    console.error("  FAIL:", msg);
  }
}

const { browser, page } = await launch({ width: 1440, height: 900 });
try {
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
  await clickMode(page, "Figure");
  await sleep(700);

  await page.evaluate(() => {
    localStorage.removeItem("flux.textstyles"); // clean library between runs
    const F = window.__flux.fig;
    F.commit((p) => {
      const g = p.figures.find((f) => f.id === "growth") || p.figures[0];
      g.x = 0;
      g.y = 0;
      g.width = 900;
      g.height = 500;
      g.elements = [];
      const mk = (id, x, text, size) => ({
        type: "text", id, x, y: 60, width: 200, height: 24, rotation: 0,
        text, fontFamily: "Arial", fontSize: size, fontWeight: 400,
        fontStyle: "normal", align: "left", color: "#111111", sizing: "auto",
      });
      g.elements.push(mk("ts-a", 60, "Alpha text", 21)); // 21px ≈ 15.75pt — distinctive
      g.elements.push(mk("ts-b", 320, "Beta text", 12));
    });
    F.selectOnly("ts-a");
    F.viewport.set({ panX: 120, panY: 120, zoom: 1 });
  });
  await sleep(400);

  const el = (id) => page.evaluate((id) => window.__flux.figures().flatMap((f) => f.elements).find((e) => e.id === id), id);
  const styles = () => page.evaluate(() => window.__flux.get(window.__flux.fig.project).textStyles ?? []);
  const styleSelect = () =>
    page.evaluate(() => {
      const s = document.querySelector('.inspector select[aria-label="Text style"]');
      if (!s) return null;
      const groups = [...s.querySelectorAll("optgroup")].map((g) => ({
        label: g.getAttribute("label"),
        options: [...g.querySelectorAll("option")].map((o) => ({ value: o.value, label: o.textContent })),
      }));
      return { value: s.value, groups };
    });
  const setStyleSelect = (v) =>
    page.evaluate((v) => {
      const s = document.querySelector('.inspector select[aria-label="Text style"]');
      if (!s) return false;
      s.value = v;
      s.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, v);
  const popBtn = (styleName, btnText) =>
    page.evaluate(
      ({ styleName, btnText }) => {
        const rows = [...document.querySelectorAll(".inspector .style-pop .style-row")];
        const row = rows.find((r) => r.querySelector("input.sname")?.value === styleName);
        if (!row) return false;
        const b = [...row.querySelectorAll("button")].find((x) => (x.textContent ?? "").trim() === btnText);
        if (!b) return false;
        b.click();
        return true;
      },
      { styleName, btnText },
    );

  // seeded defaults exist (Panel Label + Body ride normalizeProject)
  const seedSel = await styleSelect();
  assert(seedSel, "Inspector shows the Style select for a text selection");
  const projGroup = seedSel?.groups.find((g) => g.label === "Project");
  assert(projGroup?.options.some((o) => o.label === "Panel Label") && projGroup?.options.some((o) => o.label === "Body"), "default styles seeded (Panel Label + Body)");

  // ---- create from selection ---------------------------------------------------
  await setStyleSelect("__new__");
  await sleep(250);
  let list = await styles();
  const made = list.find((s) => !["ts-panel-label", "ts-body"].includes(s.id));
  assert(made && made.fontSize === 21, `"New from selection…" snapshots the look (fontSize 21 → ${made?.fontSize})`);
  assert((await el("ts-a")).styleId === made?.id, "…and links the source element");
  assert((await styleSelect())?.value === made?.id, "select shows the new style as current");
  await shot(page, "text-styles-01-created");

  // ---- apply to the second text --------------------------------------------------
  await page.evaluate(() => window.__flux.fig.selectOnly("ts-b"));
  await sleep(250);
  assert((await styleSelect())?.value === "", "fresh element shows — None —");
  await setStyleSelect(made.id);
  await sleep(250);
  let b = await el("ts-b");
  assert(b.styleId === made.id && b.fontSize === 21, `apply via select: props + link (fontSize ${b.fontSize})`);

  // ---- manual edit detaches ------------------------------------------------------
  await page.evaluate(() => {
    const nf = [...document.querySelectorAll(".inspector .nf")].find((n) => n.querySelector(".lb")?.textContent?.trim() === "Size (pt)");
    const inp = nf.querySelector("input");
    inp.value = "9";
    inp.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await sleep(250);
  b = await el("ts-b");
  assert(b.styleId === undefined && Math.abs(b.fontSize - 12) < 0.01, "manual Size edit DETACHES (props kept: 9pt = 12px)");
  assert((await styleSelect())?.value === "", "select flipped back to — None — after the manual edit");
  assert((await el("ts-a")).styleId === made.id, "the other linked element stays linked");

  // ---- update style from a changed look → every linked text follows ---------------
  // ts-b (selected, detached) now has the 12px look; Update takes ITS look into
  // the style and re-applies to linked elements (ts-a).
  // (open the ⚙ popover if it isn't already — "New from selection…" opens it too)
  await page.evaluate(() => {
    if (!document.querySelector(".inspector .style-pop")) {
      const g = [...document.querySelectorAll(".inspector button")].find((x) => x.getAttribute("aria-label") === "Manage text styles");
      g.click();
    }
  });
  await sleep(200);
  assert(await page.evaluate(() => !!document.querySelector(".inspector .style-pop")), "⚙ manage popover open");
  assert(await popBtn(made.name, "Update"), "popover Update button found + clicked");
  await sleep(250);
  const a2 = await el("ts-a");
  list = await styles();
  assert(list.find((s) => s.id === made.id)?.fontSize === 12, "style definition took the selection's look (21 → 12)");
  assert(Math.abs(a2.fontSize - 12) < 0.01 && a2.styleId === made.id, "LIVE link: the linked text followed the update");
  await shot(page, "text-styles-02-updated");

  // ---- save to library (memBridge localStorage) ------------------------------------
  assert(await popBtn(made.name, "→ Lib"), "popover Save-to-library clicked");
  await sleep(300);
  const lib1 = await page.evaluate(() => JSON.parse(localStorage.getItem("flux.textstyles") ?? "[]"));
  assert(lib1.some((s) => s.id === made.id && s.fontSize === 12), "style landed in the machine-global library (localStorage)");

  // ---- delete keeps props, drops link ------------------------------------------------
  assert(await popBtn(made.name, "✕"), "popover Delete clicked");
  await sleep(250);
  list = await styles();
  const a3 = await el("ts-a");
  assert(!list.some((s) => s.id === made.id), "style removed from the project");
  assert(a3.styleId === undefined && Math.abs(a3.fontSize - 12) < 0.01, "linked text KEPT its look, dropped the link");

  // ---- library copy-on-apply -----------------------------------------------------------
  await page.evaluate(() => window.__flux.fig.selectOnly("ts-a"));
  await sleep(250);
  const selNow = await styleSelect();
  const libGroup = selNow?.groups.find((g) => g.label === "Library");
  assert(libGroup?.options.some((o) => o.value === `lib:${made.id}`), "deleted project style still listed under Library");
  await setStyleSelect(`lib:${made.id}`);
  await sleep(300);
  list = await styles();
  const a4 = await el("ts-a");
  assert(list.some((s) => s.id === made.id), "applying a Library style COPIES it into project.textStyles (copy-on-apply)");
  assert(a4.styleId === made.id, "…and links the element to the project copy");

  // ---- persistence round-trip (memBridge fig/ subsystem) --------------------------------
  const persisted = await page.evaluate(async () => {
    const F = window.__flux;
    const root = F.get(F.fig.embeddedProjectRoot);
    await F.bridge.saveFigFrom(root);
    const idxText = await window.fig.readText(root + "/fig/index.json");
    const idx = JSON.parse(idxText);
    await F.bridge.loadFigInto(root, "roundtrip");
    const p = F.get(F.fig.project);
    const a = p.figures.flatMap((f) => f.elements).find((e) => e.id === "ts-a");
    return {
      idxStyles: (idx.textStyles ?? []).map((s) => s.id),
      projStyles: (p.textStyles ?? []).map((s) => s.id),
      link: a?.styleId ?? null,
      fontSize: a?.fontSize ?? null,
    };
  });
  assert(persisted.idxStyles.includes(made.id), "fig/index.json carries the project styles (explicit writeback)");
  assert(persisted.projStyles.includes(made.id) && persisted.projStyles.includes("ts-panel-label"), "reload restores project styles (incl. seeded defaults)");
  assert(persisted.link === made.id && Math.abs(persisted.fontSize - 12) < 0.01, "element link + props survive the round-trip");
  await shot(page, "text-styles-03-roundtrip");

  const errs = realErrors(page);
  assert(errs.length === 0, `no console errors (${errs.length})`);
  if (errs.length) console.error(errs.slice(0, 5));
  console.log(fails === 0 ? "\nTEXT STYLES ALL PASS" : `\nTEXT STYLES ${fails} FAILURE(S)`);
} finally {
  await browser.close();
}
process.exit(fails === 0 ? 0 : 1);
