// figure-v1 P8 gate (browser) — the UNIFIED X-ray, driven for real:
//   · grouped content incl. a fluxplot; select the group; Alt+P → GROUP tree:
//     nested child-group row (by name) + the plot expanding under its own
//     figure root ("Plot area" et al.) next to sibling shapes
//   · eye on a group row removes its members from the LIVE scene DOM
//     (effectiveHidden); eye on a part row writes the id-keyed hidden override;
//     'x' toggles per FOCUSED row kind
//   · ctrl-click a part row RE-ROOTS to its owning plot "as if x-rayed alone"
//     (breadcrumb grows, part pre-selected); Backspace pops the root stack
//   · Show Properties (button + Enter) on a ticklabel row sets the selection
//     and opens the FluxFig Menu with TEXT-kind fields ABOVE the x-ray
//     (z-order asserted); the x-ray keeps NO embedded property editors
//   · Regenerate is present ONLY for a recipe-backed plot root (absent on the
//     group root)
//   Run (dev server on :1420): node scripts/figenh-18-xray.mjs
import { readFileSync } from "node:fs";
import { launch, gotoApp, clickMode, shot, realErrors, waitFor, waitForFrame, waitForGone } from "./lib/driver.mjs";

let fails = 0;
const ok = (cond, msg) => (cond ? console.log("  ✓ " + msg) : (fails++, console.log("  ✗ " + msg)));

const SVG = readFileSync("scripts/fixtures/pre-regen/06_scatter_regression.svg", "utf8");
const MANIFEST = JSON.parse(readFileSync("scripts/fixtures/pre-regen/06_scatter_regression.fluxplot.json", "utf8"));
const TICKS = "axis.x.tick-labels"; // ticklabel group node — a TEXT-kind part row

const { browser, page } = await launch({ width: 1500, height: 950 });
try {
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
  await clickMode(page, "Figure");
  await waitFor(page, () => !!(window.__flux?.fig && window.__flux.figures().length && document.querySelector(".canvas-host")), null, {
    timeout: 15000,
    label: "figure mode ready (dev handle + demo figures + canvas)",
  });

  // --- seed: outer group g2 = [inner g1(rectA,rectB), plot px, rectC] --------
  await page.evaluate(
    (svg, manifest) => {
      const F = window.__flux.fig;
      window.__flux.io.reimportPlot("xr-asset", svg, manifest);
      F.commit((p) => {
        const g = p.figures[0];
        g.x = 0;
        g.y = 0;
        g.width = 1100;
        g.height = 620;
        const rect = (id, fill, x, gid) => ({
          type: "rect", id, x, y: 60, width: 120, height: 90, rotation: 0,
          fill, stroke: "#222222", strokeWidth: 2, cornerRadius: 0, groupId: gid,
        });
        g.elements = [
          rect("rA", "#d62728", 40, "g1"),
          rect("rB", "#2ca02c", 200, "g1"),
          {
            type: "plot", id: "px", x: 380, y: 40, width: 504, height: 360, rotation: 0,
            assetId: "xr-asset", overrides: {}, groupId: "g2",
            source: { svgPath: "plots/scatter.svg", recipePath: "plots/scatter.recipe.json" },
          },
          rect("rC", "#1f77b4", 920, "g2"),
        ];
        g.groups = {
          g1: { id: "g1", name: "Panel A", parentId: "g2" },
          g2: { id: "g2", name: "Both Panels" },
        };
        window.__figId = g.id;
        F.activeFigureId.set(g.id);
      });
      F.viewport.set({ panX: 40, panY: 120, zoom: 0.7 });
    },
    SVG,
    MANIFEST,
  );
  await waitFor(page, () => !!document.querySelector('.scene-svg rect[fill="#d62728"]'), null, {
    label: "seeded scene painted",
  });

  // --- helpers ---------------------------------------------------------------
  const rowByLabel = (label) =>
    page.evaluateHandle((lbl) => {
      return [...document.querySelectorAll(".xray .row")].find(
        (r) => (r.querySelector(".rlabel")?.textContent ?? "").trim() === lbl,
      ) ?? null;
    }, label);
  const clickRow = async (label, { ctrl = false, expander = false, eye = false } = {}) => {
    const h = await rowByLabel(label);
    const found = await page.evaluate((el) => !!el, h);
    if (!found) return false;
    if (ctrl) await page.keyboard.down("Control");
    await page.evaluate(
      (el, exp, ey) => {
        const t = exp ? el.querySelector("button.tw") : ey ? el.querySelector("button.eye") : el;
        t?.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: !!window.__ctrlDown }));
      },
      h, expander, eye,
    );
    if (ctrl) await page.keyboard.up("Control");
    await waitForFrame(page);
    return true;
  };
  // real ctrl-click needs the ctrlKey ON the synthesized event:
  const ctrlClickRow = async (label) => {
    const h = await rowByLabel(label);
    const found = await page.evaluate((el) => !!el, h);
    if (!found) return false;
    await page.evaluate((el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true })), h);
    await waitForFrame(page);
    return true;
  };
  const rowLabels = () =>
    page.evaluate(() =>
      [...document.querySelectorAll(".xray .row")].map((r) => ({
        label: (r.querySelector(".rlabel")?.textContent ?? "").trim(),
        kind: r.getAttribute("data-kind"),
        sel: r.classList.contains("sel"),
        eyeOff: r.querySelector(".eye")?.classList.contains("off") ?? false,
      })),
    );
  const crumbs = () =>
    page.evaluate(() => [...document.querySelectorAll(".xray .crumb")].map((c) => (c.textContent ?? "").trim()));
  const override = (part) =>
    page.evaluate(
      (pt) => window.__flux.figures().flatMap((f) => f.elements).find((e) => e.id === "px")?.overrides?.[pt]?.hidden ?? null,
      part,
    );
  const rectVisible = (fill) =>
    page.evaluate((f) => document.querySelectorAll(`.scene-svg rect[fill="${f}"]`).length > 0, fill);
  const regenPresent = () => page.evaluate(() => !!document.querySelector(".xray .regen"));

  // === open on the GROUP =====================================================
  console.log("Group x-ray (Alt+P):");
  await page.evaluate(() => window.__flux.fig.selection.set(new Set(["rA", "rB", "px", "rC"])));
  await waitForFrame(page);
  await page.keyboard.down("Alt");
  await page.keyboard.press("KeyP");
  await page.keyboard.up("Alt");
  await waitFor(page, () => document.querySelectorAll(".xray .row").length > 0, null, {
    label: "x-ray open with rows",
  }).catch(() => {});

  ok(await page.evaluate(() => !!document.querySelector(".xray")), "Alt+P over a group selection opens the X-ray");
  let rows = await rowLabels();
  ok(rows[0]?.label === "Both Panels" && rows[0]?.kind === "group", `root row = the group, by NAME (${rows[0]?.label})`);
  ok(rows.some((r) => r.label === "Panel A" && r.kind === "group"), "nested child group row present (by name)");
  ok(rows.some((r) => r.label === "scatter" && r.kind === "element"), "the plot member is an element row (svg basename)");
  ok(rows.some((r) => r.label === "Plot area" && r.kind === "part"), "…expanded IN PLACE under its own figure root (part rows)");
  ok(rows.some((r) => r.label === "rect 4" && r.kind === "element"), "sibling shapes sit next to the plot's root");
  ok(!(await regenPresent()), "Regenerate ABSENT on a group root");

  const editors = await page.evaluate(() => ({
    props: document.querySelectorAll(".xray .props").length,
    selects: document.querySelectorAll(".xray select").length,
    inputs: [...document.querySelectorAll(".xray input")].map((i) => i.className),
  }));
  ok(editors.props === 0, "the right property pane is GONE (.props selectors)");
  ok(
    editors.selects === 0 && editors.inputs.length === 1 && /search/.test(editors.inputs[0]),
    `no embedded property editors — the only input is the search box (${editors.inputs.join(",")})`,
  );
  await shot(page, "figenh18-01-group-tree");

  // === eye per row kind =======================================================
  console.log("Eye / 'x' per row kind:");
  ok((await rectVisible("#d62728")) && (await rectVisible("#2ca02c")), "inner-group members render before the eye");
  await clickRow("Panel A", { eye: true });
  ok(!(await rectVisible("#d62728")) && !(await rectVisible("#2ca02c")), "eye on the GROUP row hides its members from the scene DOM");
  ok((await rectVisible("#1f77b4")), "…the sibling outside it still renders");
  await clickRow("Panel A", { eye: true });
  ok(await rectVisible("#d62728"), "second eye click brings them back");

  // part row: expand Plot area → X axis → Tick labels, then eye + 'x'
  await clickRow("Plot area", { expander: true });
  await clickRow("X axis", { expander: true });
  rows = await rowLabels();
  ok(rows.some((r) => r.label === "Tick labels"), "expanded down to the ticklabel group row");
  await clickRow("Tick labels", { eye: true });
  ok((await override(TICKS)) === true, "eye on a PART row writes the id-keyed hidden override");
  await clickRow("Tick labels"); // focus the row (also drives canvas selection)
  const drill = await page.evaluate(() => {
    const F = window.__flux;
    return { sel: [...F.get(F.fig.selection)], ps: F.get(F.fig.partSelection) };
  });
  ok(drill.sel.length === 1 && drill.sel[0] === "px", "part row click selects the owning plot on canvas");
  ok(drill.ps?.partId === TICKS && drill.ps?.elementId === "px", "…and drills partSelection to the part");
  await page.keyboard.press("x");
  await waitFor(
    page,
    (pt) => window.__flux.figures().flatMap((f) => f.elements).find((e) => e.id === "px")?.overrides?.[pt]?.hidden === false,
    TICKS,
    { label: "'x' toggled the part override back" },
  ).catch(() => {});
  ok((await override(TICKS)) === false, "'x' on the focused part row toggles the override back");
  await clickRow("rect 4");
  await page.keyboard.press("x");
  await waitFor(
    page,
    () => window.__flux.figures().flatMap((f) => f.elements).find((e) => e.id === "rC")?.hidden === true,
    null,
    { label: "'x' hid the element" },
  ).catch(() => {});
  ok(
    await page.evaluate(() => window.__flux.figures().flatMap((f) => f.elements).find((e) => e.id === "rC")?.hidden === true),
    "'x' on an ELEMENT row sets the element hidden flag",
  );
  await page.keyboard.press("x");
  await waitFor(
    page,
    () => window.__flux.figures().flatMap((f) => f.elements).find((e) => e.id === "rC")?.hidden !== true,
    null,
    { label: "'x' unhid the element" },
  ).catch(() => {});

  // === Show Properties (button + Enter) → FluxFigMenu ABOVE ==================
  console.log("Show Properties:");
  await clickRow("Tick labels");
  await page.evaluate(() => document.querySelector(".xray .showprops")?.click());
  await waitFor(page, () => !!document.querySelector(".fluxFigMenu"), null, { label: "FluxFig Menu open" }).catch(
    () => {},
  );
  let menu = await page.evaluate(() => {
    const m = document.querySelector(".fluxFigMenu");
    if (!m) return null;
    const labels = [...m.querySelectorAll(".field .label")].map((l) => (l.textContent ?? "").trim());
    const menuZ = +getComputedStyle(document.querySelector(".fwrap")).zIndex;
    const xrayZ = +getComputedStyle(document.querySelector(".xwrap")).zIndex;
    const xrayVisible = !!document.querySelector(".xray")?.getBoundingClientRect().width;
    return { labels, menuZ, xrayZ, xrayVisible };
  });
  ok(!!menu, "Show Properties button opens the FluxFig Menu");
  ok(menu && menu.labels.includes("size") && menu.labels.includes("weight") && menu.labels.includes("font"),
    `…with TEXT-kind part fields for the ticklabel row (${menu?.labels.slice(0, 6).join(", ")}…)`);
  ok(menu && menu.menuZ > menu.xrayZ && menu.xrayVisible,
    `…rendered ABOVE the still-open x-ray (menu z ${menu?.menuZ} > xray z ${menu?.xrayZ})`);
  await shot(page, "figenh18-02-props-over-xray");
  await page.keyboard.press("Escape");
  await waitFor(page, () => !document.querySelector(".fluxFigMenu") && !!document.querySelector(".xray"), null, {
    label: "menu closed, x-ray kept",
  }).catch(() => {});
  ok(await page.evaluate(() => !document.querySelector(".fluxFigMenu") && !!document.querySelector(".xray")),
    "Esc closes the menu; the x-ray stays");

  // Enter = the same flow
  await page.keyboard.press("Enter");
  await waitFor(page, () => !!document.querySelector(".fluxFigMenu"), null, { label: "FluxFig Menu open (Enter)" }).catch(
    () => {},
  );
  menu = await page.evaluate(() => {
    const m = document.querySelector(".fluxFigMenu");
    return m ? { labels: [...m.querySelectorAll(".field .label")].map((l) => (l.textContent ?? "").trim()) } : null;
  });
  ok(!!menu && menu.labels.includes("size"), "Enter opens the same properties for the focused row");
  await page.keyboard.press("Escape");
  await waitForGone(page, ".fluxFigMenu").catch(() => {});

  // === ctrl-click re-root + Backspace pop ====================================
  console.log("Re-root:");
  let cr = await crumbs();
  ok(cr.length === 1 && cr[0] === "Both Panels", `breadcrumb shows the root (${cr.join(" › ")})`);
  ok(await ctrlClickRow("Tick labels"), "ctrl-click on the part row dispatched");
  await waitFor(page, () => document.querySelectorAll(".xray .crumb").length === 2, null, {
    label: "re-rooted (breadcrumb grew)",
  }).catch(() => {});
  rows = await rowLabels();
  cr = await crumbs();
  ok(rows[0]?.label === "scatter" && rows[0]?.kind === "element", "re-rooted to the plot ALONE (root row = the plot)");
  ok(!rows.some((r) => r.kind === "group"), "…group rows gone — as if x-rayed alone");
  ok(cr.length === 2 && cr[0] === "Both Panels" && cr[1] === "scatter", `breadcrumb grew (${cr.join(" › ")})`);
  ok(rows.some((r) => r.label === "Tick labels" && r.sel), "the ctrl-clicked part landed pre-expanded + selected");
  ok(await regenPresent(), "Regenerate PRESENT for the recipe-backed plot root");
  await shot(page, "figenh18-03-rerooted");

  await page.keyboard.press("Backspace");
  await waitFor(page, () => document.querySelectorAll(".xray .crumb").length === 1, null, {
    label: "root stack popped (one crumb)",
  }).catch(() => {});
  rows = await rowLabels();
  cr = await crumbs();
  ok(rows[0]?.label === "Both Panels" && cr.length === 1, "Backspace pops the root stack back to the group");
  ok(!(await regenPresent()), "…and Regenerate disappears with the plot root");

  // === scope-aware openXray: inside an entered group, Alt+P roots on it ======
  console.log("Entered-scope Alt+P:");
  await page.keyboard.press("Escape"); // close the x-ray
  await waitForGone(page, ".xray").catch(() => {});
  await page.evaluate(() => {
    const F = window.__flux.fig;
    F.enteredGroupId.set("g1"); // standing inside Panel A
    F.partSelection.set(null); // a canvas click would have cleared the drill
    F.selection.set(new Set(["rA", "rB"])); // its direct members = loose units at scope
  });
  await waitForFrame(page);
  await page.keyboard.down("Alt");
  await page.keyboard.press("KeyP");
  await page.keyboard.up("Alt");
  await waitFor(page, () => document.querySelectorAll(".xray .row").length > 0, null, {
    label: "x-ray reopened at the entered scope",
  }).catch(() => {});
  rows = await rowLabels();
  ok(rows[0]?.label === "Panel A" && rows[0]?.kind === "group",
    `Alt+P inside the entered group roots on THAT group (${rows[0]?.label})`);
  await page.keyboard.press("Escape");
  await waitForGone(page, ".xray").catch(() => {});

  const errs = realErrors(page);
  ok(errs.length === 0, `no console errors (${errs.length})`);
  if (errs.length) console.error(errs.slice(0, 5));
  console.log(fails === 0 ? "\nFIGENH-18-XRAY ALL PASS" : `\nFIGENH-18-XRAY ${fails} FAILURE(S)`);
} finally {
  await browser.close();
}
process.exit(fails === 0 ? 0 : 1);
