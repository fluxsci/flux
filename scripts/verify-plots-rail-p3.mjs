// The Plots rail, depth (P3; browser, demo fixture): the information and narrowing layer over the
// P2 gallery (verify-plots-rail.mjs).
//   * tile sizes: both ⋯ sliders (gallery + dissections) with live values, Reset sizes;
//   * Peek: the 350 ms dwell (not before), tile-to-tile without a new dwell, its facts (physical
//     size + width class, placements, dissection groups, the backdrop law's reason, the "reads
//     poorly" warning against a dark figure), the on-screen picture at once, hides on rail leave /
//     scroll / a key / a press, Shift+Space toggles, the ⋯ preference, a dissection table's 20 rows;
//   * filters: Unused · Fluxplots · Has dissections, the chip line (count, removal);
//   * the focus folder (tile + header context menus, chip, Backspace climbs) and Similar names;
//   * Fresh dots (a live write marks, a click clears, ⋯ clears all), the width-class badge;
//   * variant stacks (off by default; count badge; Enter / double-click expand, never insert;
//     the head collapses; drag places the shown variant);
//   * pre-warm: the idle queue renders what is not on screen, holds during a canvas press;
//   * clean console.
//   Run (dev server up; FLUX_URL for a worktree): node scripts/verify-plots-rail-p3.mjs
import { readFileSync } from "node:fs";
import path from "node:path";
import { launch, gotoApp, clickMode, sleep, realErrors, APP_URL } from "./lib/driver.mjs";
import { waitFor } from "./lib/wait.mjs";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-plots-rail-p3");
const ROOT = "/demo/myc-growth-paper";
const P = `${ROOT}/plots`;
const FIX = path.join(import.meta.dirname, "fixtures", "plots-rail");
const fixture = (n) => readFileSync(path.join(FIX, n), "utf8");

const { browser, page } = await launch({ width: 1500, height: 960 });
const errs = realErrors(page);
await gotoApp(page, { url: `${APP_URL}?fixture=demo`, settle: 2500 });
await clickMode(page, "Figure");

const svg = (fill, w = 72, hgt = 48) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}pt" height="${hgt}pt" viewBox="0 0 ${w} ${hgt}"><rect width="${w}" height="${hgt}" fill="${fill}"/></svg>`;
const write = (files) => page.evaluate(async (files) => { for (const [p, text] of Object.entries(files)) await window.fig.writeText(p, text); }, files);
const emit = (p) => page.evaluate((p) => window.__fluxEmitFsChange({ subsystem: "plots", path: p }), p);
const alt = async (code) => { await page.keyboard.down("Alt"); await page.keyboard.press(code); await page.keyboard.up("Alt"); };
const tile = (suffix) => `[data-plots-gallery] [data-tile$="${suffix}"]`;
const shown = () => page.evaluate(() => [...document.querySelectorAll("[data-plots-gallery] [data-tile]")].map((t) => t.getAttribute("data-tile").split("/plots/")[1]));
const peekName = () => page.evaluate(() => document.querySelector("[data-plots-peek] [data-peek-name]")?.textContent ?? "");
const pagePoint = (suffix, pane = "[data-plots-gallery]") => page.evaluate(async (suffix, pane) => {
  const vp = document.querySelector(`${pane} .viewport`);
  for (let i = 0; i < 80; i++) {
    const n = document.querySelector(`${pane} [data-tile$="${suffix}"] .page`);
    const r = n?.getBoundingClientRect(), v = vp.getBoundingClientRect();
    if (r && r.top >= v.top - 1 && r.bottom <= v.bottom + 1) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    if (r) vp.scrollTop += r.top < v.top ? r.top - v.top - 30 : r.bottom - v.bottom + 10; else vp.scrollTop += 120;
    await new Promise((res) => setTimeout(res, 40));
  }
  return null;
}, suffix, pane);
// Matches an item's LABEL (a checked item's text starts with its ✓).
const menuClick = (re) => page.evaluate((src) => { const b = [...document.querySelectorAll("[data-plots-rail-menu] button")].find((x) => new RegExp(src).test((x.querySelector(".label") ?? x).textContent.trim())); if (!b) return false; b.click(); return true; }, re.source);
const viewMenu = async (re) => { await page.click("[data-rail-menu]"); await waitFor(page, () => !!document.querySelector("[data-plots-rail-menu]"), null, { label: "view menu" }); if (!(await menuClick(re))) throw new Error(`no menu item ${re}`); };
const ctxMenu = async (suffix, re) => { const p = await pagePoint(suffix); await page.mouse.click(p.x, p.y, { button: "right" }); await waitFor(page, () => !!document.querySelector("[data-plots-rail-menu]"), null, { label: "context menu" }); if (!(await menuClick(re))) throw new Error(`no menu item ${re}`); };

// ---- seed: a small tree with variants, a dissected plot, a fluxplot, a deep folder ----------
{
  const files = {
    [`${P}/alpha.svg`]: svg("#d95f02", 96, 48),
    [`${P}/fixtures/dark.svg`]: fixture("dark.svg"),
    [`${P}/fixtures/light.svg`]: fixture("light.svg"),
    [`${P}/fixtures/white_text_only.svg`]: fixture("white_text_only.svg"),
    [`${P}/panels/fig1_a.svg`]: svg("#d14d41", 80, 60),
    [`${P}/panels/fig1_b.svg`]: svg("#4385be", 80, 60),
    [`${P}/panels/fig1_c.svg`]: svg("#879a39", 80, 60),
    [`${P}/panels/latency.svg`]: svg("#3aa99f", 500, 250),
    [`${P}/panels/latency_v2.svg`]: svg("#24837b", 500, 250),
    [`${P}/panels/editable.svg`]: svg("#8b7ec8", 200, 140),
    [`${P}/panels/editable.fluxplot.json`]: JSON.stringify({ version: 1 }),
    [`${P}/deep/er/hidden_1.svg`]: svg("#ce5d97"),
    [`${P}/deep/er/hidden_2.svg`]: svg("#d0a215"),
    [`${P}/cold/store/never_shown.svg`]: svg("#9c6d1f"),
    // > 2 MB: pre-warm leaves it to the moment its tile shows.
    [`${P}/cold/store/huge.svg`]: svg("#9c6d1f").replace("</svg>", `<!--${"x".repeat(2_200_000)}--></svg>`),
    [`${P}/deep/latency_v9.svg`]: svg("#24837b", 500, 250),
  };
  for (let i = 1; i <= 4; i++) files[`${P}/_dissections/alpha/by_subject/s0${i}.svg`] = svg("#e7298a");
  files[`${P}/_dissections/alpha/stats.csv`] = "subject,mean,sd\n" + Array.from({ length: 30 }, (_, i) => `s${i},${(i * 1.5).toFixed(1)},${(i / 10).toFixed(2)}`).join("\n");
  await write(files);
  await alt("KeyG");
  await waitFor(page, () => document.querySelector("[data-left-rail]")?.getAttribute("data-left-rail") === "plots", null, { label: "plots rail" });
  await waitFor(page, () => !!document.querySelector('[data-plots-gallery] [data-tile$="/alpha.svg"] img'), null, { label: "alpha tile", timeout: 10000 });
  await page.keyboard.press("Escape");
}

h.section("tile sizes");
{
  await page.click("[data-rail-menu]");
  await waitFor(page, () => !!document.querySelector("[data-plots-rail-menu]"), null, { label: "menu" });
  const sliders = await page.evaluate(() => [...document.querySelectorAll("[data-plots-rail-menu] .slider")].map((s) => ({ label: s.querySelector("span").textContent, out: s.querySelector("output").textContent })));
  h.ok(sliders.length === 2 && sliders[0].label === "Gallery" && sliders[0].out === "112 px" && sliders[1].label === "Dissections" && sliders[1].out === "84 px", `two size sliders with live values at the defaults (${JSON.stringify(sliders)})`);
  const before = await page.evaluate(() => Math.round(document.querySelector('[data-plots-gallery] [data-tile$="/alpha.svg"]').getBoundingClientRect().height));
  await page.evaluate(() => { const i = document.querySelectorAll("[data-plots-rail-menu] .slider input")[0]; i.value = "200"; i.dispatchEvent(new Event("input", { bubbles: true })); });
  await sleep(150);
  const after = await page.evaluate(() => ({ h: Math.round(document.querySelector('[data-plots-gallery] [data-tile$="/alpha.svg"]').getBoundingClientRect().height), out: document.querySelector("[data-plots-rail-menu] .slider output").textContent }));
  h.ok(after.h > before * 1.2 && after.out === "200 px", `the gallery slider resizes tiles live (${before} → ${after.h} px rows, ${after.out})`);
  await page.evaluate(() => { const i = document.querySelectorAll("[data-plots-rail-menu] .slider input")[1]; i.value = "120"; i.dispatchEvent(new Event("input", { bubbles: true })); });
  h.eq(await page.evaluate(() => JSON.parse(localStorage.getItem("flux.plotsRail")).dissectTileH), 120, "the dissections slider sets its own size (persisted)");
  await page.keyboard.press("Escape");
  await viewMenu(/^Reset sizes/);
  h.eq(await page.evaluate(() => { const p = JSON.parse(localStorage.getItem("flux.plotsRail")); return `${p.tileH}/${p.dissectTileH}`; }), "112/84", "Reset sizes restores the defaults");
}

h.section("Peek");
{
  // Place alpha once so Peek has a placement to report; then make the figure dark.
  const pa = await pagePoint("/alpha.svg");
  await page.mouse.click(pa.x, pa.y, { count: 2 });
  await waitFor(page, () => window.__flux.figures().some((f) => f.elements.some((e) => e.source?.svgPath?.endsWith("plots/alpha.svg"))), null, { label: "alpha placed" });
  await page.mouse.move(pa.x, pa.y + 200); await page.mouse.move(pa.x, pa.y);
  await sleep(200);
  h.ok(!(await page.evaluate(() => !!document.querySelector("[data-plots-peek]"))), "no Peek before the 350 ms dwell");
  await waitFor(page, () => !!document.querySelector("[data-plots-peek]"), null, { label: "peek after dwell", timeout: 2000 });
  const facts = await page.evaluate(() => {
    const p = document.querySelector("[data-plots-peek]");
    const rail = document.querySelector("[data-left-rail]").getBoundingClientRect();
    return { name: p.querySelector("[data-peek-name]").textContent, size: p.querySelector("[data-peek-size]")?.textContent, placed: p.querySelector("[data-peek-placements]")?.textContent.replace(/\s+/g, " ").trim(), dis: p.querySelector("[data-peek-dissections]")?.textContent.replace(/\s+/g, " ").trim(), backdrop: p.querySelector("[data-peek-backdrop]")?.getAttribute("data-peek-backdrop"), left: p.getBoundingClientRect().left - rail.right, img: !!p.querySelector(".img img")?.getAttribute("src"), pe: getComputedStyle(p).pointerEvents };
  });
  h.ok(facts.name.startsWith("alpha.svg") && facts.size === "33.9 × 16.9 mm · 1c", `name, physical size and width class (${facts.name} · ${facts.size})`);
  h.ok(/^Placed in Growth curves/.test(facts.placed ?? ""), `where it is placed (${facts.placed})`);
  h.ok(/5 dissection files/.test(facts.dis ?? "") && /by_subject 4/.test(facts.dis ?? ""), `its dissection groups (${facts.dis})`);
  h.ok(facts.backdrop === "own" && facts.img && facts.left >= 4 && facts.left <= 16 && facts.pe === "none", `the backdrop law's choice, a picture at once, against the rail's edge, non-interactive (${JSON.stringify(facts)})`);
  // Tile to tile: no new dwell.
  const pd = await pagePoint("/fixtures/dark.svg");
  await page.mouse.move(pd.x, pd.y);
  await sleep(60);
  h.ok((await peekName()).startsWith("dark.svg"), "moving to another tile switches Peek at once (no new dwell)");
  h.eq(await page.evaluate(() => document.querySelector("[data-plots-peek] [data-peek-backdrop]")?.textContent.trim()), "Light ink — dark backdrop", "the swatch explains the tile's backdrop");
  // Leaving the rail hides it instantly.
  await page.mouse.move(800, 500);
  await sleep(30);
  h.ok(!(await page.evaluate(() => !!document.querySelector("[data-plots-peek]"))), "leaving the rail hides Peek at once");
  // A dark figure: a dark-ink plot warns (only in Peek).
  await page.evaluate(() => { const F = window.__flux, id = F.get(F.fig.activeFigureId); F.fig.commit((p) => { p.figures.find((f) => f.id === id).background = "#100f0f"; }); });
  const pl = await pagePoint("/fixtures/light.svg");
  await page.mouse.move(pl.x, pl.y);
  await waitFor(page, () => !!document.querySelector("[data-plots-peek]"), null, { label: "peek light" });
  h.ok(await page.evaluate(() => /reads poorly on Growth curves/.test(document.querySelector("[data-peek-warning]")?.textContent ?? "")), "a dark-ink plot warns that it reads poorly on the dark figure");
  h.ok(await page.evaluate(() => !document.querySelector("[data-plots-gallery] [data-peek-warning], [data-plots-gallery] .warn")), "…and the warning lives only in Peek");
  // Scroll hides; a key hides.
  await page.evaluate(() => { const vp = document.querySelector("[data-plots-gallery] .viewport"); vp.scrollTop += 30; vp.dispatchEvent(new Event("scroll")); });
  await sleep(40);
  h.ok(!(await page.evaluate(() => !!document.querySelector("[data-plots-peek]"))), "scrolling hides Peek");
  await page.mouse.move(800, 500);
  // Shift+Space toggles for the focused tile; with hover Peek off it still works.
  await viewMenu(/^Peek on hover/);
  const pd2 = await pagePoint("/fixtures/dark.svg");
  await page.mouse.click(pd2.x, pd2.y);
  await sleep(500);
  h.ok(!(await page.evaluate(() => !!document.querySelector("[data-plots-peek]"))), "with “Peek on hover” off a dwell shows nothing");
  await page.keyboard.down("Shift"); await page.keyboard.press("Space"); await page.keyboard.up("Shift");
  await waitFor(page, () => !!document.querySelector("[data-plots-peek]"), null, { label: "shift+space peek" });
  h.ok((await peekName()).startsWith("dark.svg"), "Shift+Space shows the focused tile's Peek");
  await page.keyboard.press("ArrowRight");
  await sleep(40);
  h.ok(!(await page.evaluate(() => !!document.querySelector("[data-plots-peek]"))), "any other key hides it");
  await page.keyboard.down("Shift"); await page.keyboard.press("Space"); await page.keyboard.up("Shift");
  await waitFor(page, () => !!document.querySelector("[data-plots-peek]"), null, { label: "peek again" });
  await page.keyboard.down("Shift"); await page.keyboard.press("Space"); await page.keyboard.up("Shift");
  await sleep(40);
  h.ok(!(await page.evaluate(() => !!document.querySelector("[data-plots-peek]"))), "Shift+Space again hides it");
  await viewMenu(/^Peek on hover/);
  // A dissection table: its first 20 rows.
  const pa2 = await pagePoint("/alpha.svg");
  await page.mouse.click(pa2.x, pa2.y);
  await waitFor(page, () => !!document.querySelector('[data-plots-dissections] [data-grid-id$="stats.csv"]'), null, { label: "stats card", timeout: 8000 });
  const card = await page.evaluate(() => { const r = document.querySelector('[data-plots-dissections] [data-grid-id$="stats.csv"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 10 }; });
  await page.mouse.move(card.x, card.y);
  await waitFor(page, () => !!document.querySelector("[data-plots-peek] table"), null, { label: "table peek" });
  const rows = await page.evaluate(() => ({ n: document.querySelectorAll("[data-plots-peek] tbody tr").length, more: document.querySelector("[data-plots-peek] .more")?.textContent.trim() }));
  h.ok(rows.n === 20 && /10 more rows/.test(rows.more ?? ""), `a dissection table peeks at its first 20 rows (${rows.n}, “${rows.more}”)`);
  const panel = await pagePoint("/by_subject/s01.svg", "[data-plots-dissections]");
  await page.mouse.move(panel.x, panel.y);
  await waitFor(page, () => /s01\.svg/.test(document.querySelector("[data-plots-peek] [data-peek-name]")?.textContent ?? ""), null, { label: "panel peek" });
  const pf = await page.evaluate(() => document.querySelector("[data-plots-peek] .facts")?.textContent.replace(/\s+/g, " ").trim() ?? "");
  h.ok(/25\.4 × 16\.9 mm · 1c/.test(pf) && /modified/.test(pf), `a dissection panel peeks with its printed size and age (${pf})`);
  await page.mouse.move(800, 500);
}

h.section("filters");
{
  await viewMenu(/^Unused/);
  await waitFor(page, () => !!document.querySelector("[data-filter-chips]"), null, { label: "chip line" });
  let names = await shown();
  h.ok(!names.includes("alpha.svg") && names.includes("fixtures/dark.svg"), "Unused hides the placed plot");
  h.ok(/Unused ✕/.test(await page.evaluate(() => document.querySelector("[data-filter-chips]").textContent)), "an active filter shows as a removable chip");
  await viewMenu(/^Fluxplots/);
  await sleep(150);
  names = await shown();
  h.ok(names.length === 1 && names[0] === "panels/editable.svg", `filters combine: unused fluxplots (${names.join(",")})`);
  h.ok(/1 of \d+/.test(await page.evaluate(() => document.querySelector("[data-filter-chips] .fcount").textContent)), "the chip line counts what passes");
  // Placing from under Unused: the plot leaves the list and the selection — a second Enter
  // does not place it again.
  await page.click('[data-filter-chip="filterFluxplot"]');
  const pe = await pagePoint("/panels/editable.svg");
  await page.mouse.click(pe.x, pe.y);
  const placedCount = () => page.evaluate(() => window.__flux.figures().reduce((n, f) => n + f.elements.filter((e) => e.source?.svgPath?.endsWith("panels/editable.svg")).length, 0));
  await page.keyboard.press("Enter");
  await waitFor(page, async () => true, null, { label: "noop" });
  await page.waitForFunction(() => window.__flux.figures().some((f) => f.elements.some((e) => e.source?.svgPath?.endsWith("panels/editable.svg"))), { timeout: 6000 });
  await sleep(200);
  await page.keyboard.press("Enter");
  await sleep(500);
  h.eq(await placedCount(), 1, "under Unused, a placed plot leaves the selection: a second Enter places nothing");
  await page.click('[data-filter-chip="filterUnused"]');
  await sleep(100);
  h.ok(!(await page.evaluate(() => !!document.querySelector("[data-filter-chips]"))), "removing the chips clears the filters (no chip line when none is active)");
  await viewMenu(/^Has dissections/);
  await waitFor(page, () => { const t = [...document.querySelectorAll("[data-plots-gallery] [data-tile]")].map((x) => x.getAttribute("data-tile")); return t.length === 1 && t[0].endsWith("/alpha.svg"); }, null, { label: "has dissections", timeout: 6000 });
  h.ok(true, "Has dissections leaves only the dissected plot (counts fetched for every listed plot)");
  await page.click('[data-filter-chip="filterDissected"]');
}

h.section("focus folder and similar names");
{
  await waitFor(page, () => !!document.querySelector('[data-plots-gallery] [data-tile$="/panels/editable.svg"]'), null, { label: "panels back" });
  await ctxMenu("/panels/editable.svg", /^Show only panels/);
  await waitFor(page, () => document.querySelector("[data-focus-folder]")?.getAttribute("data-focus-folder") === "panels", null, { label: "focus chip" });
  const names = await shown();
  h.ok(names.length > 0 && names.every((n) => n.startsWith("panels/")), `Show only this folder scopes the gallery (${names.length} plots, all in panels/)`);
  await page.focus("[data-plots-search]");
  await page.keyboard.press("Backspace");
  await sleep(100);
  h.ok(!(await page.evaluate(() => !!document.querySelector("[data-focus-folder]"))) && (await shown()).includes("alpha.svg"), "Backspace in the empty search climbs out of the folder");
  // Section header context menu (deep/er is collapsed by default — it opens when focused).
  const head = await page.evaluate(async () => { const vp = document.querySelector("[data-plots-gallery] .viewport"); vp.scrollTop = 0; for (let i = 0; i < 60; i++) { const n = document.querySelector('[data-plots-gallery] .spacer [data-section="dir:deep/er"]'); if (n) { const r = n.getBoundingClientRect(); return { x: r.left + 60, y: r.top + 10 }; } vp.scrollTop += 120; await new Promise((r) => setTimeout(r, 30)); } return null; });
  await page.mouse.click(head.x, head.y, { button: "right" });
  await waitFor(page, () => !!document.querySelector("[data-plots-rail-menu]"), null, { label: "header menu" });
  await menuClick(/^Show only this folder/);
  await waitFor(page, () => document.querySelector("[data-focus-folder]")?.getAttribute("data-focus-folder") === "deep/er", null, { label: "deep focus" });
  h.ok((await shown()).join(",") === "deep/er/hidden_1.svg,deep/er/hidden_2.svg", "a folder header's menu focuses it, opened even though it starts collapsed");
  await page.click("[data-focus-folder]");
  await sleep(100);
  h.ok(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("flux.plotsRail.toggled:")).every((k) => !JSON.parse(localStorage.getItem(k)).includes("deep/er"))), "focusing a folder never rewrites its saved collapse");
  // Similar names — across folders, even from inside a folder shown alone.
  await ctxMenu("/panels/editable.svg", /^Show only panels/);
  await waitFor(page, () => document.querySelector("[data-focus-folder]")?.getAttribute("data-focus-folder") === "panels", null, { label: "focus panels again" });
  await ctxMenu("/panels/latency.svg", /^Similar names/);
  await waitFor(page, () => !!document.querySelector("[data-similar]"), null, { label: "similar chip" });
  const sim = await shown();
  h.ok(sim[0] === "panels/latency.svg" && sim.includes("panels/latency_v2.svg") && sim.includes("deep/latency_v9.svg") && sim.length === 3, `Similar names: the reference, then its variants in every folder (${sim.join(",")})`);
  await page.keyboard.press("Escape");
  await sleep(100);
  h.ok(!(await page.evaluate(() => !!document.querySelector("[data-similar]"))) && (await page.evaluate(() => document.querySelector("[data-focus-folder]")?.getAttribute("data-focus-folder"))) === "panels", "Esc leaves Similar names, back to the folder it came from");
  await page.click("[data-focus-folder]");
}

h.section("fresh dots and the width badge");
{
  await write({ [`${P}/panels/new_result.svg`]: svg("#5e409d") });
  await emit(`${P}/panels/new_result.svg`);
  for (let i = 0; i < 4 && !(await pagePoint("/new_result.svg")); i++) await sleep(300); // listed, and scrolled into view
  await waitFor(page, () => document.querySelector('[data-plots-gallery] [data-tile$="/new_result.svg"]')?.hasAttribute("data-fresh"), null, { label: "fresh dot", timeout: 6000 });
  h.ok((await page.evaluate(() => document.querySelectorAll("[data-plots-gallery] [data-fresh]").length)) === 1, "a file written after the listing gets the Fresh dot (no other tile does)");
  await write({ [`${P}/fixtures/dark.svg`]: fixture("dark.svg").replace("</svg>", "<!-- regenerated --></svg>") });
  await emit(`${P}/fixtures/dark.svg`);
  await waitFor(page, () => document.querySelector('[data-plots-gallery] [data-tile$="/fixtures/dark.svg"]')?.hasAttribute("data-fresh"), null, { label: "regenerated fresh", timeout: 6000 });
  h.ok(true, "a regenerated plot (new size:mtime) is fresh too");
  const pn = await pagePoint("/new_result.svg");
  await page.mouse.click(pn.x, pn.y);
  await sleep(80);
  h.ok(await page.evaluate(() => !!document.querySelector('[data-plots-gallery] [data-tile$="/new_result.svg"]') && !document.querySelector('[data-plots-gallery] [data-tile$="/new_result.svg"][data-fresh]')), "clicking a tile clears its dot");
  await viewMenu(/^Clear the new-file dots \(1\)/);
  await sleep(80);
  h.ok(!(await page.evaluate(() => !!document.querySelector("[data-plots-gallery] [data-fresh]"))), "⋯ Clear the new-file dots clears the rest");
  await viewMenu(/^Width class badge/);
  await waitFor(page, () => !!document.querySelector('[data-plots-gallery] [data-tile$="/panels/latency.svg"] [data-width-badge]'), null, { label: "badges" });
  const badges = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll("[data-plots-gallery] [data-tile]")].map((t) => [t.getAttribute("data-tile").split("/plots/")[1], t.querySelector("[data-width-badge]")?.getAttribute("data-width-badge") ?? ""])));
  h.ok(badges["panels/latency.svg"] === "2c" && badges["panels/editable.svg"] === "1c" && badges["fixtures/dark.svg"] === "1c", `width classes from the physical size: 176 mm → 2c, 71 mm → 1c (${JSON.stringify(badges)})`);
  await viewMenu(/^Width class badge/);
}

h.section("variant stacks");
{
  h.ok((await shown()).includes("panels/fig1_b.svg") && (await shown()).includes("panels/fig1_a.svg"), "off by default: every variant is its own tile");
  await viewMenu(/^Stack variants/);
  await waitFor(page, () => !!document.querySelector("[data-plots-gallery] [data-stack]"), null, { label: "stacks" });
  const stacks = await page.evaluate(() => [...document.querySelectorAll("[data-plots-gallery] [data-stack]")].map((t) => `${t.getAttribute("data-tile").split("/plots/")[1]}×${t.dataset.stack}`).sort());
  h.eq(stacks.join(" "), "panels/fig1_c.svg×3 panels/latency_v2.svg×2", "fig1_a…c and latency + latency_v2 fold into stacks topped by the newest");
  const before = await page.evaluate(() => window.__flux.figures().reduce((n, f) => n + f.elements.length, 0));
  const ps = await pagePoint("/panels/fig1_c.svg");
  await page.mouse.click(ps.x, ps.y, { count: 2 });
  await waitFor(page, () => !document.querySelector('[data-plots-gallery] [data-tile$="/fig1_c.svg"][data-stack]') && !!document.querySelector('[data-plots-gallery] [data-tile$="/fig1_a.svg"]'), null, { label: "expanded" });
  h.eq(await page.evaluate(() => window.__flux.figures().reduce((n, f) => n + f.elements.length, 0)), before, "double-clicking a stack opens it — it never places");
  h.ok(await page.evaluate(() => /◂ 3/.test(document.querySelector('[data-plots-gallery] [data-tile$="/fig1_a.svg"] [data-stack-toggle]')?.textContent ?? "")), "the expanded stack's first variant carries the collapse badge");
  await page.click('[data-plots-gallery] [data-tile$="/fig1_a.svg"] [data-stack-toggle]');
  await waitFor(page, () => !!document.querySelector('[data-plots-gallery] [data-tile$="/fig1_c.svg"][data-stack]'), null, { label: "restacked" });
  h.ok(true, "…which stacks them again");
  const pl = await pagePoint("/panels/latency_v2.svg");
  await page.mouse.click(pl.x, pl.y);
  await page.keyboard.press("Enter");
  await waitFor(page, () => !!document.querySelector('[data-plots-gallery] [data-tile$="/panels/latency.svg"]'), null, { label: "enter expands" });
  h.eq(await page.evaluate(() => window.__flux.figures().reduce((n, f) => n + f.elements.length, 0)), before, "Enter on a focused stack expands it too");
  await viewMenu(/^Stack variants/);
}

h.section("pre-warm");
{
  // deep/er is collapsed (depth 2): its plots are on no tile, yet pre-warm renders them.
  // (Pre-warm has been running since the first listing; the fixture records every warm render.)
  await waitFor(page, () => (window.__fluxPrewarmed ?? []).some((p) => p.endsWith("/cold/store/never_shown.svg")), null, { label: "prewarmed hidden plot", timeout: 15000 });
  h.ok(!(await page.evaluate(() => !!document.querySelector('[data-plots-gallery] [data-tile$="/cold/store/never_shown.svg"]'))), "pre-warm renders a plot that was never on a tile (a collapsed folder)");
  h.ok(!(await page.evaluate(() => (window.__fluxPrewarmed ?? []).some((p) => p.endsWith("/cold/store/huge.svg")))), "…but never a file over 2 MB (it would hold up the visible tiles behind it)");
  const warmCount = await page.evaluate(() => (window.__fluxPrewarmed ?? []).length);
  await viewMenu(/^Refresh/);
  await sleep(2500);
  h.eq(await page.evaluate(() => (window.__fluxPrewarmed ?? []).length), warmCount, "a re-list does not warm what is already warm");
  // Hold during a canvas press.
  await page.evaluate(() => { window.__fluxPrewarmed = []; });
  await write(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`${P}/deep/er/batch_${i}.svg`, svg("#66800b")])));
  const canvas = await page.evaluate(() => { const r = document.querySelector(".canvas-wrap").getBoundingClientRect(); return { x: r.left + r.width - 60, y: r.top + r.height - 60 }; });
  await page.mouse.move(canvas.x, canvas.y);
  await page.mouse.down();
  await emit(`${P}/deep/er/batch_0.svg`);
  await sleep(2600);
  const held = await page.evaluate(() => (window.__fluxPrewarmed ?? []).filter((p) => /batch_/.test(p)).length);
  await page.mouse.up();
  await waitFor(page, () => (window.__fluxPrewarmed ?? []).filter((p) => /batch_/.test(p)).length >= 12, null, { label: "resumed", timeout: 15000 });
  h.ok(held === 0, `pre-warm holds during a canvas press (${held} rendered while held) and resumes after it`);
  // A file that kills (or hangs) the worker stops pre-warm for the session: its deaths count
  // against the worker's respawn budget, which idle work must never spend.
  await write({ [`${P}/deep/er/a__kills_worker__.svg`]: svg("#af3029"), ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`${P}/deep/er/z_after_${i}.svg`, svg("#5e409d")])) });
  await page.evaluate(() => { window.__fluxPrewarmed = []; });
  await emit(`${P}/deep/er/a__kills_worker__.svg`);
  await waitFor(page, async () => (await import("/src/lib/plotsRail/thumbClient.ts")).prewarmState().disabled, null, { label: "pre-warm stopped", timeout: 15000 });
  await sleep(1500);
  h.ok(!(await page.evaluate(() => (window.__fluxPrewarmed ?? []).some((p) => /z_after_/.test(p)))), "a worker-killing file stops pre-warm for the session (nothing after it is warmed)");
}

h.eq(errs.length, 0, `console stays clean${errs.length ? `: ${errs.slice(0, 3).join(" | ")}` : ""}`);
await h.done(() => browser.close());
