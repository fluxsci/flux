// The global plot library in the Plot gallery (browser, demo fixture).
// <FluxConfig>/plot_library is the user's machine-wide plots folder: the gallery's
// Project | Global switch (Alt+1 / Alt+2) browses either tree with the same rules
// (any folder structure, reserved collections hidden), and Settings → Figure →
// "Search reaches" decides what a query covers — default: the whole tree of the
// selected scope. A plot inserted from the library keeps its library file as an
// external source; picks from both scopes can go in as one batch.
//   Run (dev server on :1420 must be up): node scripts/verify-plot-library.mjs
import { launch, gotoApp, clickMode, realErrors, waitFor, APP_URL } from "./lib/driver.mjs";

let fails = 0, checks = 0;
const ok = (cond, msg, extra = "") => {
  checks++;
  cond ? console.log("  ✓ " + msg) : (fails++, console.log("  ✗ " + msg + (extra ? ` — ${extra}` : "")));
};

const ROOT = "/demo/myc-growth-paper";
const LIB = "/home/demo/FluxConfig/plot_library"; // memBridge prefsGet().plotLibraryResolved
const { browser, page } = await launch();
await gotoApp(page, { url: new URL("?fixture=demo", APP_URL).href, settle: 3000 });
await clickMode(page, "Figure");
await waitFor(page, () => !!window.__flux?.figures?.()?.length, null, { label: "figure mode ready" });

// Names are deliberately unique so fixture plots can never satisfy an assertion.
const SVG = (fill) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="72pt" height="72pt" viewBox="0 0 72 72"><rect width="72" height="72" fill="${fill}"/></svg>`;
await page.evaluate(async ({ root, a, b }) => {
  await window.fig.writeText(`${root}/plots/kilo-proj.svg`, a);
  await window.fig.writeText(`${root}/plots/sub/lima-proj.svg`, b);
}, { root: ROOT, a: SVG("#d95f02"), b: SVG("#1b9e77") });

const snap = () =>
  page.evaluate(() => {
    const F = window.__flux;
    const p = F.get(F.fig.project);
    const fig = F.figures()[0];
    const rowEls = [...document.querySelectorAll(".importer .row")];
    return {
      open: !!document.querySelector(".importer"),
      scope: document.querySelector('.scope-switch [aria-pressed="true"]')?.dataset.scope ?? "",
      globalDisabled: !!document.querySelector('.scope-switch [data-scope="global"]')?.disabled,
      rootLabel: document.querySelector(".importer .rootbtn")?.textContent?.trim() ?? "",
      rows: rowEls.map((r) => r.querySelector(".nm")?.textContent),
      dirs: rowEls.filter((r) => r.dataset.kind === "dir").map((r) => r.querySelector(".nm")?.textContent),
      where: Object.fromEntries(rowEls.map((r) => [r.querySelector(".nm")?.textContent, r.querySelector("[data-where]")?.textContent ?? ""])),
      placeholder: document.querySelector(".search-in")?.getAttribute("placeholder") ?? "",
      search: document.querySelector(".search-in")?.value ?? "",
      focused: document.activeElement === document.querySelector(".search-in"),
      pill: document.querySelector(".pickpill")?.textContent?.trim() ?? "",
      tree: [...document.querySelectorAll(".folder-sidebar .tree-name")].map((n) => n.textContent),
      globalEmpty: !!document.querySelector("[data-global-empty]"),
      els: fig.elements.map((e) => ({
        type: e.type,
        asset: p.assets.find((a) => a.id === e.assetId)?.name ?? null,
        svgPath: e.source?.svgPath ?? null,
        external: !!e.source?.external,
      })),
    };
  });
const rowsSettled = (want) =>
  waitFor(page, (names) => {
    const got = [...document.querySelectorAll(".importer .row .nm")].map((n) => n.textContent);
    return names.every((n) => got.includes(n));
  }, want, { label: `rows include ${want.join(",")}` }).catch(() => {});
const scanned = () =>
  waitFor(page, () => !/Scanning/.test(document.querySelector(".search-in")?.getAttribute("placeholder") ?? "Scanning"), null, { label: "search scan done" });
const chord = async (mod, key) => {
  await page.keyboard.down(mod);
  await page.keyboard.press(key);
  await page.keyboard.up(mod);
};
const openGallery = async () => {
  await chord("Alt", "KeyG");
  await waitFor(page, () => !!document.querySelector(".importer .scope-switch"), null, { label: "gallery open" });
  await scanned();
};
const setSearch = async (text) => {
  await page.$eval(".search-in", (el) => el.focus());
  if ((await snap()).search) await page.keyboard.press("Escape"); // clears a non-empty box (never closes it)
  if (text) await page.keyboard.type(text, { delay: 8 });
  await scanned();
  await waitFor(page, (t) => (document.querySelector(".search-in")?.value ?? "") === t, text, { label: `query "${text}"` });
};
const closeGallery = async () => {
  await page.keyboard.press("Escape");
  if ((await snap()).open) await page.keyboard.press("Escape");
  await waitFor(page, () => !document.querySelector(".importer"), null, { label: "gallery closed" });
};
const setSearchReach = async (value) => {
  await page.click('.titlebar button[aria-label="Settings"]');
  await waitFor(page, () => !!document.querySelector("#settings-tab-figure"), null, { label: "settings open" });
  await page.click("#settings-tab-figure");
  await page.select('select[aria-label="Plot gallery search scope"]', value);
  const hint = await page.$eval("#settings-pane-figure", (el) => el.textContent || "");
  await page.keyboard.press("Escape");
  await waitFor(page, () => !document.querySelector('.modal[aria-label="Settings"]'), null, { label: "settings closed" });
  return hint;
};

let s;
// ---- 0. a library that does not exist yet: created on first use, says how to fill it ----
ok(!(await page.evaluate((lib) => window.fig.exists(lib), LIB)), "precondition: no plot_library folder yet");
await openGallery();
await chord("Alt", "Digit2");
await waitFor(page, () => !!document.querySelector("[data-global-empty]"), null, { label: "global empty state" }).catch(() => {});
s = await snap();
ok(s.scope === "global" && s.globalEmpty, "an empty library explains itself", s.scope);
ok(await page.evaluate((lib) => window.fig.exists(lib), LIB), "the folder is created on first use, ready to fill");
const emptyText = await page.$eval("[data-global-empty]", (el) => el.textContent || "").catch(() => "");
ok(emptyText.includes(LIB), "the empty state shows the library's path", emptyText);
await chord("Alt", "Digit1");
await rowsSettled(["kilo-proj"]);
await closeGallery();

await page.evaluate(async ({ lib, svgs }) => {
  const [m, n, o, p, q] = svgs;
  await window.fig.writeText(`${lib}/mike-glob.svg`, m);
  await window.fig.writeText(`${lib}/figs/november-glob.svg`, n);
  await window.fig.writeText(`${lib}/figs/deep/oscar-glob.svg`, o);
  await window.fig.writeText(`${lib}/figs2/papa-glob.svg`, p);
  // Reserved collections are hidden in the library exactly as in a project.
  await window.fig.writeText(`${lib}/_lighttable/sweep/quebec-glob.svg`, q);
}, { lib: LIB, svgs: ["#7570b3", "#e7298a", "#66a61e", "#a6761d", "#666666"].map(SVG) });

// ---- 1. default: Project scope, project-only search ---------------------------------
await openGallery();
s = await snap();
ok(s.open && s.scope === "project", "the gallery opens on the Project scope", s.scope);
ok(!s.globalDisabled, "the Global scope is available");
ok(s.rootLabel === "plots" && s.rows.includes("kilo-proj") && !s.rows.includes("mike-glob"), "Project browses the project's plots/", s.rows.join(","));
await setSearch("glob");
s = await snap();
ok(s.rows.length === 0, "default search (the selected scope) does not reach global plots", s.rows.join(","));
await setSearch("proj");
s = await snap();
ok(s.rows.includes("kilo-proj") && s.rows.includes("lima-proj"), "…and does reach the whole project tree", s.rows.join(","));
ok(!Object.values(s.where).some((w) => /Project|Global/.test(w)), "single-scope results carry no scope label", JSON.stringify(s.where));

// ---- 2. Alt+2 → Global: same browse rules, created on first use ------------------------
await chord("Alt", "Digit2");
await rowsSettled(["mike-glob"]);
await scanned();
s = await snap();
ok(s.scope === "global" && s.rootLabel === "plot_library", "Alt+2 switches to the global library", `${s.scope} ${s.rootLabel}`);
ok(s.search === "proj" && s.focused, "the query survives the switch and focus stays in the search box", s.search);
ok(s.rows.length === 0, "…and now searches the library (no project plots)", s.rows.join(","));
await setSearch("");
s = await snap();
ok(s.rows.includes("mike-glob") && s.dirs.includes("figs") && s.dirs.includes("figs2"), "Global lists the library root with its folders", s.rows.join(","));
ok(!s.dirs.includes("_lighttable"), "reserved collections stay hidden in the library", s.dirs.join(","));
ok(s.tree.includes("plot_library") || s.tree.includes("mike-glob.svg"), "the folder tree follows the scope", s.tree.slice(0, 6).join(","));
await setSearch("glob");
s = await snap();
ok(["mike-glob", "november-glob", "oscar-glob", "papa-glob"].every((n) => s.rows.includes(n)) && !s.rows.includes("quebec-glob"),
  "search covers the whole library, reserved collections excluded", s.rows.join(","));
ok(s.where["oscar-glob"] === "figs/deep" && s.where["mike-glob"] === "", "rows show their folder inside the library", JSON.stringify(s.where));
ok(/global plot library/i.test(s.placeholder), "the box says what it searches", s.placeholder);

// ---- 3. picks span scopes; one batch inserts both --------------------------------------
await page.evaluate(() => [...document.querySelectorAll(".importer .row")].find((r) => r.querySelector(".nm")?.textContent === "oscar-glob")?.click());
await chord("Alt", "Digit1");
await rowsSettled(["kilo-proj"]);
s = await snap();
ok(s.scope === "project" && s.pill === "1 selected", "Alt+1 returns to Project with the global pick kept", `${s.scope} ${s.pill}`);
await setSearch("");
await page.evaluate(() => [...document.querySelectorAll(".importer .row")].find((r) => r.querySelector(".nm")?.textContent === "kilo-proj")?.click());
const before = (await snap()).els.length;
await chord("Control", "Enter");
await waitFor(page, (n) => window.__flux.figures()[0].elements.length >= n + 2, before, { label: "two plots inserted" }).catch(() => {});
s = await snap();
const added = s.els.slice(before);
const glob = added.find((e) => e.asset === "oscar-glob.svg"), proj = added.find((e) => e.asset === "kilo-proj.svg");
ok(added.length === 2 && glob && proj, "one Ctrl+Enter inserts the project and the global pick", JSON.stringify(added));
ok(glob?.type === "plot" && glob.external && glob.svgPath === `${LIB}/figs/deep/oscar-glob.svg`,
  "the library plot keeps its library file as an external source", JSON.stringify(glob));
ok(proj && !proj.external && proj.svgPath === "plots/kilo-proj.svg", "the project plot stays project-relative", JSON.stringify(proj));

// ---- 4. the scope choice is remembered ---------------------------------------------------
await openGallery();
await chord("Alt", "Digit2");
await rowsSettled(["mike-glob"]);
await closeGallery();
await openGallery();
await rowsSettled(["mike-glob"]);
s = await snap();
ok(s.scope === "global", "the gallery reopens on the scope you last chose", s.scope);
await closeGallery();

// ---- 5. Settings → "Everything": both scopes, labelled -------------------------------------
const hint = await setSearchReach("all");
ok(/plot_library/.test(hint), "the setting's hint names the library folder", hint.slice(0, 80));
await openGallery();
await setSearch("-");
s = await snap();
ok(["kilo-proj", "lima-proj", "mike-glob", "oscar-glob"].every((n) => s.rows.includes(n)), "Everything searches project and global together", s.rows.join(","));
ok(s.where["kilo-proj"] === "Project" && s.where["oscar-glob"] === "Global · figs/deep", "mixed results name their scope", JSON.stringify(s.where));
ok(s.rows.indexOf("mike-glob") < s.rows.indexOf("kilo-proj"), "the browsed scope's matches come first on a tie", s.rows.join(","));
await closeGallery();

// ---- 6. "Only project plots" while browsing Global -----------------------------------------
await setSearchReach("project");
await openGallery();
await setSearch("-");
s = await snap();
ok(s.scope === "global" && s.rows.includes("kilo-proj") && !s.rows.includes("mike-glob"), "project-only searches the project even from Global", s.rows.join(","));
ok(/project plots only/i.test(s.placeholder) && s.where["kilo-proj"] === "Project", "…and says so", `${s.placeholder} ${JSON.stringify(s.where)}`);
await closeGallery();

// ---- 7. "Only the current folder" ---------------------------------------------------------
await setSearchReach("folder");
await openGallery();
await setSearch("");
await page.evaluate(() => [...document.querySelectorAll(".importer .row")].find((r) => r.dataset.kind === "dir" && r.querySelector(".nm")?.textContent === "figs")?.click());
await rowsSettled(["november-glob"]);
await setSearch("glob");
s = await snap();
ok(s.rows.includes("november-glob") && s.rows.includes("oscar-glob"), "folder search reaches the folder and its subfolders", s.rows.join(","));
ok(!s.rows.includes("mike-glob") && !s.rows.includes("papa-glob"), "…and nothing outside it (not even figs2/)", s.rows.join(","));
ok(/inside figs\//.test(s.placeholder), "the box names the folder", s.placeholder);
await closeGallery();

const errs = realErrors(page);
ok(errs.length === 0, "no console/page errors", errs.join(" | "));

await browser.close();
console.log(`##VERIFY## ${JSON.stringify({ script: "verify-plot-library", ok: fails === 0, checks, failed: fails })}`);
console.log(fails ? `\n${fails} FAILED` : "\nall green");
process.exit(fails ? 1 : 0);
