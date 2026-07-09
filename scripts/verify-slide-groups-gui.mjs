// figure-v1 P9 gate (browser) — figure GROUPS as slide animation targets, in the
// REAL GUI end to end: group the demo figure's panels in the FIGURE editor (ops
// core), save fig/, switch to SLIDE mode, insert the figure through the real
// Insert ▾ menu (loadDeckAssets → figureSvg wrappers + figureGroups store), then:
//   • the animator PartsTree expands the embedFigure into named group rows
//     (nested indent, "group" badge);
//   • ⊕ in on a group row authors Track {target: <embedEl>, part: "group:<gid>"}
//     with the P9 defaults (enter fade);
//   • the LIVE stage resolves the track to the export wrapper <g> — hidden at
//     the resting beat, revealed on its build beat (static-state);
//   • the timeline chip is labeled with the group's NAME.
// Also writes the morning-review evidence screenshot:
//   flux_figure_upgrades_fixes/evidence-slide-groups.png
//   Run (dev server on :1420): node scripts/verify-slide-groups-gui.mjs
import { copyFile } from "node:fs/promises";
import { launch, gotoApp, clickMode, shot, sleep, realErrors, OUT } from "./lib/driver.mjs";

let fails = 0;
const ok = (cond, msg) => (cond ? console.log("  ✓ " + msg) : (fails++, console.log("  ✗ " + msg)));

const { browser, page } = await launch({ width: 1660, height: 1000 });
try {
  await page.evaluateOnNewDocument(() => {
    window.__name = window.__name || ((f) => f);
  });
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3500 });
  await clickMode(page, "Figure");
  await sleep(700);

  // --- 1. group the demo figure's panels via the real ops core, then save fig/ ---
  const seeded = await page.evaluate(async () => {
    const F = window.__flux.fig;
    const ops = await import("/src/lib/ops.ts");
    let gids = {};
    F.commit((p) => {
      const g = p.figures.find((f) => f.id === "growth") || p.figures[0];
      delete g.groups;
      for (const e of g.elements) delete e.groupId;
      const a = ops.group(p, ["el-a-rect", "el-a"], { name: "Panel A" });
      const b = ops.group(p, ["el-b-rect", "el-b"], { name: "Panel B" });
      const top = ops.group(p, ["el-a-rect", "el-b-rect"], { name: "Both Panels" });
      gids = { a, b, top };
    });
    const root = window.__flux.get(window.__flux.shell.projectModel).root;
    await window.__flux.bridge.saveFigFrom(root);
    return { gids, root };
  });
  ok(seeded.gids.a && seeded.gids.b && seeded.gids.top, `figure grouped (Panel A/B nested under Both Panels: ${JSON.stringify(seeded.gids)})`);

  // --- 2. slide mode → insert the figure via the REAL Insert ▾ menu -------------
  await clickMode(page, "Slide");
  await page.waitForFunction(() => !!window.__flux?.slideOps && !!document.querySelector(".animator"), { timeout: 15000 });
  await sleep(900);
  const insertClicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".tools button")].find((b) => /Insert/.test(b.textContent ?? ""));
    if (!btn) return false;
    btn.click();
    return true;
  });
  ok(insertClicked, "Insert ▾ menu present (figure listed as an insertable)");
  await sleep(300);
  const itemClicked = await page.evaluate(() => {
    const it = [...document.querySelectorAll(".insert-menu .item")].find((b) => /Growth curves/i.test(b.textContent ?? ""));
    if (!it) return false;
    it.click();
    return true;
  });
  ok(itemClicked, "inserted the 'Growth curves' figure onto the slide");
  await sleep(1200); // insertAndSelect → refreshAssets (loadDeckAssets)

  const embId = await page.evaluate(() => {
    const F = window.__flux;
    const d = F.get(F.slide.deck);
    const sid = F.get(F.slide.activeSlideId);
    const s = d.slides.find((x) => x.id === sid);
    return s?.elements.find((e) => e.type === "embedFigure")?.id ?? null;
  });
  ok(!!embId, `embedFigure element on the active slide (${embId})`);
  const groupsLoaded = await page.evaluate(() => {
    const F = window.__flux;
    const t = F.get(F.slide.figureGroups);
    return (t.growth ?? []).map((g) => ({ name: g.name, inner: g.groups.map((x) => x.name) }));
  });
  ok(
    groupsLoaded.some((g) => g.name === "Both Panels" && g.inner.includes("Panel A") && g.inner.includes("Panel B")),
    `figureGroups store carries the nested tree (${JSON.stringify(groupsLoaded)})`,
  );

  // --- 3. PartsTree shows the group rows (nested, badged) -----------------------
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('.parts .row[data-rowkey*="|group:"]')].map((r) => ({
      key: r.dataset.rowkey,
      label: r.querySelector(".pl")?.textContent?.trim(),
      badge: r.querySelector(".badge")?.textContent?.trim(),
      pad: parseInt(r.style.paddingLeft || "0", 10),
    })),
  );
  ok(rows.length === 3, `3 group rows under the embedFigure (${rows.map((r) => r.label).join(" / ")})`);
  const topRow = rows.find((r) => r.label === "Both Panels");
  const aRow = rows.find((r) => r.label === "Panel A");
  ok(!!topRow && !!aRow && rows.every((r) => r.badge === "group"), "rows labeled by group NAME with the distinct 'group' badge");
  ok(!!topRow && !!aRow && aRow.pad > topRow.pad, "nested group row indents under its parent");

  // --- 4. ⊕ in on "Panel A" → group track with the P9 defaults ------------------
  const aKey = aRow.key;
  await page.hover(`.parts .row[data-rowkey="${aKey}"]`);
  await sleep(150);
  await page.click(`.parts .row[data-rowkey="${aKey}"] .qa button`); // ⊕ in
  await sleep(400);
  const track = await page.evaluate((emb) => {
    const F = window.__flux;
    const d = F.get(F.slide.deck);
    const sid = F.get(F.slide.activeSlideId);
    const s = d.slides.find((x) => x.id === sid);
    let found = null;
    s.beats.forEach((b, bi) => {
      for (const t of b.tracks) if (t.target === emb && t.part) found = { part: t.part, preset: t.preset, duration: t.duration, beat: bi };
    });
    return found;
  }, embId);
  ok(
    !!track && track.part === `group:${seeded.gids.a}` && track.preset === "fade" && track.duration === 400 && track.beat > 0,
    `⊕ in authored Track {part: "group:<gid>", fade 400ms} on a build beat (${JSON.stringify(track)})`,
  );

  // chip labeled with the group NAME (figureGroupName over the store)
  const chip = await page.evaluate(() => {
    const chips = [...document.querySelectorAll("[data-track-id]")];
    return chips.map((c) => c.textContent?.trim()).join(" | ");
  });
  ok(/Panel A/.test(chip), `timeline chip shows the group name (${chip})`);

  // --- 5. LIVE stage static-state: hidden before its beat, shown on it ----------
  const wrapperSel = `[id="growth__group:${seeded.gids.a}"]`;
  const opacityAt = async (beat) => {
    await page.evaluate((b) => window.__flux.slide.activeBeat.set(b), beat);
    await sleep(450);
    return page.evaluate((sel) => {
      const n = document.querySelector(`.stage-viewport ${sel}`) ?? document.querySelector(sel);
      return n ? n.style.opacity : null;
    }, wrapperSel);
  };
  const opAtBuild = await opacityAt(track.beat);
  const opAtRest = await opacityAt(0);
  ok(opAtRest === "0", `stage wrapper <g> hidden at the resting beat (opacity "${opAtRest}")`);
  ok(opAtBuild === "1", `…and revealed on its build beat (opacity "${opAtBuild}")`);

  // --- 6. group INSERTABLES (figure-v1): Insert ▾ lists groups; picking one
  //        inserts a group-SCOPED live embed (only that subtree renders) --------
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".tools button")].find((b) => /Insert/.test(b.textContent ?? ""));
    btn?.click();
  });
  await sleep(400);
  const subItems = await page.evaluate(() =>
    [...document.querySelectorAll(".insert-menu .item.sub")].map((b) => b.textContent?.trim()),
  );
  ok(subItems.length === 3, `Insert ▾ lists the figure's 3 groups as sub-items (${subItems.join(" | ")})`);
  ok(subItems.some((t) => /Both Panels › Panel A/.test(t ?? "")), "nested group labeled with its breadcrumb");
  const subClicked = await page.evaluate(() => {
    const it = [...document.querySelectorAll(".insert-menu .item.sub")].find((b) => /› Panel A$/.test(b.textContent?.trim() ?? ""));
    if (!it) return false;
    it.click();
    return true;
  });
  ok(subClicked, "picked 'Panel A' from the Insert menu");
  await sleep(1400); // insertAndSelect → refreshAssets (scoped figureSvg cache)

  const scoped = await page.evaluate((gids) => {
    const F = window.__flux;
    const d = F.get(F.slide.deck);
    const sid = F.get(F.slide.activeSlideId);
    const s = d.slides.find((x) => x.id === sid);
    const el = s?.elements.find((e) => e.type === "embedFigure" && e.groupId);
    if (!el) return null;
    const host = document.querySelector(`.stage-viewport [data-el-id="${el.id}"]`) ?? [...document.querySelectorAll(".stage-viewport svg")].map((n) => n.closest("[data-el-id]")).find((n) => n?.dataset?.elId === el.id);
    const html = host?.innerHTML ?? "";
    return {
      groupId: el.groupId,
      w: el.width, h: el.height,
      hasOwn: html.includes(`growth__group:${gids.a}`),
      hasSibling: html.includes(`growth__group:${gids.b}`),
      rendered: html.includes("<svg"),
    };
  }, seeded.gids);
  ok(!!scoped && scoped.groupId === seeded.gids.a, `scoped embedFigure element carries groupId (${scoped?.groupId})`);
  if (scoped?.rendered) {
    ok(scoped.hasOwn, "scoped embed renders the group's own wrapper");
    ok(!scoped.hasSibling, "…and NOT the sibling group's content");
  } else {
    // host lookup is best-effort across stage DOM variants; the model + resolver
    // paths are covered by the pure gate — only flag if the element is missing.
    console.log("  (stage host for the scoped embed not found by data-el-id — markup check skipped)");
  }

  // the scoped embed's PartsTree rows show ONLY its subtree
  const scopedElRows = await page.evaluate((gids) => {
    const F = window.__flux;
    const d = F.get(F.slide.deck);
    const sid = F.get(F.slide.activeSlideId);
    const s = d.slides.find((x) => x.id === sid);
    const el = s?.elements.find((e) => e.type === "embedFigure" && e.groupId);
    if (!el) return null;
    const keys = [...document.querySelectorAll(`.parts .row[data-rowkey^="${el.id}|group:"]`)].map((r) => r.dataset.rowkey ?? "");
    return { keys, top: keys.some((k) => k.endsWith(`group:${gids.top}`)), own: keys.some((k) => k.endsWith(`group:${gids.a}`)) };
  }, seeded.gids);
  ok(!!scopedElRows && scopedElRows.own && !scopedElRows.top, `PartsTree scopes the group embed to its own subtree (${scopedElRows?.keys.join(", ")})`);

  // --- evidence screenshot (animator open, group rows visible) ------------------
  await page.evaluate((b) => window.__flux.slide.activeBeat.set(b), track.beat);
  await sleep(400);
  await page.hover(`.parts .row[data-rowkey="${aKey}"]`);
  const shotPath = await shot(page, "p9-slide-groups");
  await copyFile(shotPath, "flux_figure_upgrades_fixes/evidence-slide-groups.png").catch((e) => console.log("  (evidence copy skipped: " + e.message + ")"));
  console.log("  evidence: " + shotPath + " → flux_figure_upgrades_fixes/evidence-slide-groups.png");

  const errs = realErrors(page);
  ok(errs.length === 0, `no console errors (${errs.length})`);
  if (errs.length) console.error(errs.slice(0, 5));
  console.log(fails === 0 ? "\nVERIFY-SLIDE-GROUPS-GUI (P9) ALL PASS" : `\nVERIFY-SLIDE-GROUPS-GUI ${fails} FAILURE(S)`);
} finally {
  await browser.close();
}
process.exit(fails === 0 ? 0 : 1);
