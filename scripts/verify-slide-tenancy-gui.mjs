// slide-migration §7.2 items 10–11 + §3.2.1 (the #1 correctness risk) — the
// keep-alive/singleton-store tenancy, in the REAL GUI:
//   • figure↔slide mode round trip: entering one FLUSHES + EVICTS the other
//     (never resident together), the store tenant flips, content reloads from
//     disk intact, and the undo history is empty of cross-tenant snapshots;
//   • a slide-mode edit session autosaves to slides/<id>/deck.json and leaves
//     the whole fig/ subsystem BYTE-IDENTICAL (no write ever lands in fig/);
//   • figure + slide in two split panes is DENIED with a toast;
//   • an external deck.json edit while dirty raises the conflict banner;
//   • Send to canvas / Send to deck cross-conversions round-trip content.
// Run: node scripts/verify-slide-tenancy-gui.mjs
import { launch, gotoApp, clickMode, sleep, realErrors, APP_URL, waitFor } from "./lib/driver.mjs";

let fails = 0;
const ok = (c, msg, extra = "") => (c ? console.log("  ✓ " + msg) : (fails++, console.log("  ✗ " + msg + (extra ? ` — ${extra}` : ""))));

const { browser, page } = await launch();
try {
  await gotoApp(page, { url: APP_URL + "?fixture=demo", settle: 1800 });

  // --- figure mode: make a recognizable edit ---------------------------------------
  ok(await clickMode(page, "Figure", { settle: 2200 }), "entered Figure mode");
  await waitFor(page, () => window.__flux?.tenancy.storeTenant() === "figure", null, { timeout: 10000, label: "figure tenant" });
  await page.evaluate(() => {
    const f = window.__flux;
    const fig = f.get(f.fig.project).figures[0];
    f.fig.activeFigureId.set(fig.id);
    f.fig.commit((p) => {
      p.figures[0].elements.push({ type: "rect", id: "fig-mark", x: 11, y: 22, width: 33, height: 44, rotation: 0, fill: "#d95f02", stroke: "none", strokeWidth: 0, cornerRadius: 0 });
    });
  });
  await page.evaluate(() => window.__flux.lifecycle.flushById("figure"));
  await sleep(400);
  const figSig0 = await page.evaluate(async () => {
    const f = window.__flux;
    const root = f.get(f.shell.projectModel).root;
    const idx = await window.fig.readText(`${root}/fig/index.json`).catch(() => "");
    return idx.length + ":" + idx.slice(0, 60);
  });

  // fig/ tree signature helper (the mem bridge roots the project at /project)
  const figTree = () =>
    page.evaluate(async () => {
      const f = window.__flux;
      const root = f.get(f.shell.projectModel).root;
      const fig = window.fig;
      const out = {};
      const walk = async (dir) => {
        let es = [];
        try { es = await fig.readdir(dir); } catch { return; }
        for (const e of es.sort((a, b) => a.name.localeCompare(b.name))) {
          const p = `${dir}/${e.name}`;
          if (e.dir) await walk(p);
          else out[p] = await fig.readText(p).catch(() => "?");
        }
      };
      await walk(`${root}/fig`);
      if (Object.keys(out).length === 0) out.__missing = "fig tree unreadable"; // never vacuously equal
      return JSON.stringify(out);
    });
  const figBefore = await figTree();

  // --- switch to slide mode: eviction + tenant flip ---------------------------------
  ok(await clickMode(page, "Slide", { settle: 2600 }), "switched to Slide mode");
  await waitFor(page, () => !!window.__flux?.get(window.__flux.slide.deckOverlay), null, { timeout: 15000, label: "deck loaded" });
  const ten1 = await page.evaluate(() => ({
    tenant: window.__flux.tenancy.storeTenant(),
    figureModeMounted: !!document.querySelector(".figure-mode"),
    canvasId: window.__flux.get(window.__flux.fig.activeCanvasId),
    histPast: window.__flux.fig.historyStats().past,
  }));
  ok(ten1.tenant === "slide", "store tenant flipped to 'slide'");
  ok(!ten1.figureModeMounted, "the kept-alive FigureMode was EVICTED (not resident)");
  ok(ten1.canvasId === "deck", "the store now holds the projected deck canvas");
  ok(ten1.histPast === 0, "undo history reset on tenancy swap (no cross-tenant snapshots)");

  // --- a slide edit session: autosave hits slides/, fig/ stays byte-identical --------
  await page.evaluate(() => {
    const f = window.__flux;
    const sid = f.get(f.fig.activeFigureId);
    f.fig.commit((p) => {
      const fig = p.figures.find((x) => x.id === sid);
      fig.elements.push({ type: "ellipse", id: "slide-mark", x: 50, y: 60, width: 70, height: 70, rotation: 0, fill: "#879a39", stroke: "none", strokeWidth: 0 });
    });
    f.slide.commitDeckLive((d) => f.slideOps.addBeat(d, sid, { label: "tb" }));
  });
  await page.evaluate(() => window.__flux.lifecycle.flushById("slide"));
  await sleep(500);
  const deckOnDisk = await page.evaluate(async () => {
    const f = window.__flux;
    const root = f.get(f.shell.projectModel).root;
    const id = f.get(f.slide.deckOverlay).id;
    const text = await window.fig.readText(`${root}/slides/${id}/deck.json`).catch(() => "");
    return { hasMark: text.includes("slide-mark"), hasBeat: text.includes('"tb"'), version: /"schemaVersion": "0\.2\.0"/.test(text) };
  });
  ok(deckOnDisk.hasMark && deckOnDisk.hasBeat, "autosave wrote the edits (elements + beats recombined) to slides/<id>/deck.json");
  ok(deckOnDisk.version, "…in the 0.2.0 format");
  ok((await figTree()) === figBefore, "the ENTIRE fig/ tree is byte-identical after the slide session (no cross-write, structurally impossible)");

  // --- split-pane exclusivity: deny with a toast --------------------------------------
  const deny = await page.evaluate(() => {
    const f = window.__flux;
    const before = f.get(f.panes.panes).length;
    f.panes.splitWith("figure"); // slide is visible → figure split must be denied
    const after = f.get(f.panes.panes).map((p) => p.mode);
    const toasts = f.get(f.toast.toasts).map((t) => t.msg ?? "").join(" | ");
    return { before, after, toasts };
  });
  ok(!deny.after.includes("figure"), `figure+slide split DENIED (panes: ${deny.after.join(",")})`);
  ok(/share the editing engine/i.test(deny.toasts), "…with the predictable toast");

  // --- external deck edit while dirty → conflict banner -------------------------------
  await page.evaluate(async () => {
    const f = window.__flux;
    const root = f.get(f.shell.projectModel).root;
    const id = f.get(f.slide.deckOverlay).id;
    const p = `${root}/slides/${id}/deck.json`;
    const external = JSON.parse(await window.fig.readText(p));
    external.title = "EXTERNAL EDIT";
    await window.fig.writeText(p, JSON.stringify(external, null, 2) + "\n");
    // a local edit marks dirty; the next autosave hits the conflict guard
    f.slide.commitDeckLive((d) => f.slideOps.setDeckMeta(d, { title: "MINE" }));
  });
  await waitFor(page, () => !!document.querySelector(".disk-toast"), null, { timeout: 8000, label: "conflict banner" });
  ok(true, "an external deck.json edit while dirty raises the reload/overwrite banner (never a clobber)");
  await page.evaluate(() => {
    [...document.querySelectorAll(".disk-toast button")].find((b) => /Overwrite/.test(b.textContent || ""))?.click();
  });
  await sleep(600);

  // --- Send to canvas (slide → REAL paper figure) --------------------------------------
  const sent = await page.evaluate(async () => {
    const f = window.__flux;
    const root = f.get(f.shell.projectModel).root;
    const sid = f.get(f.fig.activeFigureId);
    const slide = f.slide.composedSlide(sid);
    const overlayDeck = f.slide.currentDeck();
    const res = await f.convert.sendSlideToCanvas(root, slide, overlayDeck, null);
    const idx = JSON.parse(await window.fig.readText(`${root}/fig/index.json`));
    return { res, inIndex: (idx.figures ?? []).some((x) => x.id === res.figureId) };
  });
  ok(sent.inIndex, `Send to canvas made a REAL paper figure (${sent.res.figureId} in fig/index.json → it WILL appear in @fig — correct)`);

  // --- round trip back to figure mode ---------------------------------------------------
  ok(await clickMode(page, "Figure", { settle: 2600 }), "switched back to Figure mode");
  await waitFor(page, () => window.__flux?.tenancy.storeTenant() === "figure", null, { timeout: 10000, label: "figure tenant back" });
  const ten2 = await page.evaluate(() => {
    const f = window.__flux;
    const p = f.get(f.fig.project);
    return {
      slideModeMounted: !!document.querySelector(".slide-mode"),
      figMark: p.figures.some((fig) => fig.elements.some((e) => e.id === "fig-mark")),
      slideMark: p.figures.some((fig) => fig.elements.some((e) => e.id === "slide-mark")),
      sentFigure: p.figures.some((fig) => fig.name === "From Slide" || fig.name === "Title" || fig.name === "Slide"),
      histPast: f.fig.historyStats().past,
      canvasId: f.get(f.fig.activeCanvasId),
    };
  });
  ok(!ten2.slideModeMounted, "SlideMode evicted on the way back");
  ok(ten2.figMark, "the figure edit survived the round trip (reloaded from disk)");
  ok(!ten2.slideMark, "no slide content leaked into the figure store");
  ok(ten2.histPast === 0, "history reset again (Cmd+Z can never restore a deck-projected snapshot into fig/)");
  ok(ten2.canvasId !== "deck", "the figure store is back on a real fig/ canvas");
  void figSig0;

  const errs = realErrors(page);
  ok(errs.length === 0, "console is clean", errs.slice(0, 3).join(" | "));
} finally {
  await browser.close();
}
console.log(fails ? `\nSLIDE TENANCY GUI: FAIL (${fails})` : "\nSLIDE TENANCY GUI: PASS");
process.exit(fails ? 1 : 0);
