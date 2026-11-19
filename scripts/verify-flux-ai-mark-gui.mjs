// The Flux AI mark's performance contract, running (owner, 2026-11-19: "be absolutely CERTAIN
// that the performance of flux itself is not at all affected"), and what the mark reports.
// The contract is written at the top of src/shell/agent/fluxAiMarkEngine.ts; the written part
// (no frame loop, idle time only, limits) is scripts/verify-flux-ai-mark.ts.
//   Run (dev server must be up): node scripts/verify-flux-ai-mark-gui.mjs
import { launch, gotoApp, waitFor, APP_URL, realErrors, shot, sleep } from "./lib/driver.mjs";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-flux-ai-mark-gui");
const { browser, page } = await launch();
try {
  await gotoApp(page, { url: `${APP_URL}?fixture=demo`, settle: 1200 });
  // Every idle callback is timed (the engine asks for idle time by the global name, so this sees all of its work).
  await page.evaluate(() => {
    const probe = (window.__fam = { idle: [], raf: 0 });
    const ric = window.requestIdleCallback.bind(window);
    window.requestIdleCallback = (fn, o) => ric((d) => { const t = performance.now(); try { fn(d); } finally { probe.idle.push(performance.now() - t); } }, o);
  });
  const stats = () => page.evaluate(async () => { const m = await import("/src/shell/agent/fluxAiMarkEngine.ts"); return { ...m.fluxAiMarkStats, alive: m.fluxAiMarkEngines().length }; });
  const head = () => page.evaluate(() => {
    const m = document.querySelector(".inbox-panel header .flux-ai-mark");
    if (!m) return null;
    const all = m.getAnimations({ subtree: true });
    return { held: m.classList.contains("held"), running: all.filter((a) => a.playState === "running").length, paused: all.filter((a) => a.playState === "paused").length, css: all.filter((a) => a.animationName).map((a) => a.animationName).sort(),
      live: getComputedStyle(m.querySelector(".fam-live") ?? m).opacity, pres: m.querySelectorAll(".fam-pres").length, layers: m.querySelector(".fam-net").children.length, contain: getComputedStyle(m).contain };
  });
  const set = (state) => page.evaluate(async (state) => { const m = await import("/src/shell/agent/fluxAiMarkEngine.ts"); for (const c of m.fluxAiMarkEngines()) c.set(state); }, state);
  const signal = (kind) => page.evaluate(async (kind) => (await import("/src/shell/agent/fluxAiMark.ts")).fluxAiSignal(kind), kind);
  const firesIn = async (ms) => { const a = (await stats()).fires; await sleep(ms); return (await stats()).fires - a; };

  h.section("at rest in the title bar: a still picture");
  const bar = await page.evaluate(() => { const m = document.querySelector(".ai-indicator .flux-ai-mark"); return m && { still: m.classList.contains("still"), animations: m.getAnimations({ subtree: true }).length, layers: m.querySelector(".fam-net").children.length, label: m.closest("button").getAttribute("aria-label"), text: m.closest("button").textContent.trim() }; });
  h.eq(bar, { still: true, animations: 0, layers: 1, label: "AI status", text: "" }, "the title bar's AI indicator is the mark, at rest: one layer, nothing moving, no \"AI\" text");
  h.eq((await stats()).alive, 0, "no engine exists while no live mark is on screen");

  h.section("alive in the Inbox header");
  await page.keyboard.down("Alt"); await page.keyboard.press("KeyQ"); await page.keyboard.up("Alt");
  await waitFor(page, () => !!document.querySelector(".inbox-panel header .flux-ai-mark .fam-live"), null, { timeout: 8000, label: "the engine attaches" });
  await page.mouse.move(700, 600);
  await sleep(900); // the opening chord was input: let the hands-off pause pass
  let s = await stats();
  h.eq([s.alive, s.engines], [1, 1], "one engine, for the one live mark");
  const fired = await firesIn(2600);
  h.ok(fired >= 2, `left alone, its points fire (${fired} in 2.6 s)`);
  let m = await head();
  h.eq(m.css, ["fam-orbit-a", "fam-orbit-b", "flux-ai-turn"], "its CSS life: a turn and two drifting fronts");
  h.ok(m.contain.includes("strict") || (m.contain.includes("size") && m.contain.includes("layout") && m.contain.includes("paint")), `its box is strictly contained (${m.contain})`);
  h.ok(!m.held, "it is not held while the user's hands are idle");
  s = await stats();
  h.ok(s.idleRuns > 0 && s.idleRuns <= s.fires + 40, "its firings came through idle callbacks");

  h.section("hands off: nothing while the user types");
  await page.click(".inbox-panel .inbox-search");
  const before = (await stats()).fires;
  await page.evaluate(() => { window.__fam.idle = []; });
  for (let i = 0; i < 26; i++) { await page.keyboard.type("abc defgh ijk"[i % 13]); await sleep(55); }
  const during = (await stats()).fires - before, idleDuring = await page.evaluate(() => window.__fam.idle.reduce((a, b) => a + b, 0));
  h.eq(during, 0, "not one firing started during a 1.4 s burst of typing");
  h.ok(idleDuring < 2, `and its idle work in that time was the one-off settle (${idleDuring.toFixed(2)} ms)`);
  m = await head();
  h.ok(m.held, "the mark is held");
  h.eq(m.running, 0, "nothing of it is animating: the turn and the fronts are paused, the glows are gone");
  h.eq(m.live, "0", "everything the engine drew has been faded out as one layer");
  await sleep(1300);
  m = await head();
  h.ok(!m.held && m.running >= 3, `a moment after the hands stop it is alive again (${m.running} running)`);
  h.ok((await firesIn(2600)) >= 2, "and firing again");

  h.section("hands off: a held pointer, the wheel");
  await page.mouse.move(700, 600); await page.mouse.down();
  await sleep(700);
  const dragStart = (await stats()).fires; await sleep(1500);
  h.eq((await stats()).fires - dragStart, 0, "nothing fires while a pointer is held down, however long (a drag, a pan)");
  h.ok((await head()).held, "and the mark stays held for the whole press");
  await page.mouse.up(); await sleep(1300);
  h.ok(!(await head()).held, "released, it comes back");
  await page.mouse.wheel({ deltaY: 4 }); await sleep(120); // (a signal already on its way may still land in the first instant)
  const wheelStart = (await stats()).fires;
  for (let i = 0; i < 12; i++) { await page.mouse.wheel({ deltaY: 4 }); await sleep(90); }
  h.eq((await stats()).fires - wheelStart, 0, "nothing fires while the wheel is turning");
  await sleep(1300);

  h.section("what it reports");
  await set({ tone: "live", agents: ["hamerkop"] });
  h.ok((await firesIn(1500)) >= 10, "an agent claims: a wave crosses every point");
  h.eq((await head()).pres, 1, "and the agent holds one point");
  await set({ tone: "live", agents: ["hamerkop", "heron"] }); await sleep(300);
  h.eq((await head()).pres, 2, "two agents, two points");
  await set({ tone: "wait", agents: ["hamerkop"], waiting: true });
  h.ok((await firesIn(3600)) >= 30, "an agent asks: the heartbeat (two pulses across the network, again and again)");
  await set({ tone: "live", agents: ["hamerkop"], waiting: false }); await sleep(1900);
  await signal("sent");
  h.ok((await firesIn(1200)) >= 10, "you send something: one pulse runs through every point");
  await set({ tone: "done", agents: [] });
  h.ok((await firesIn(1200)) >= 10, "an agent finishes: one lap");
  h.eq((await head()).pres, 0, "and it holds no point any more");
  await set({ tone: "error", agents: [] });
  h.ok((await firesIn(900)) >= 20, "a failure: three flickers of every point");
  await sleep(1500);
  h.ok((await firesIn(2500)) <= 4, "then it is quiet");
  // A report that arrives while the user types waits for the pause; it is not dropped and not shown early.
  await set({ tone: "ready", agents: [] }); await sleep(900);
  await page.click(".inbox-panel .inbox-search");
  const typed = (await stats()).fires;
  for (let i = 0; i < 6; i++) { await page.keyboard.type("x"); await sleep(60); if (i === 2) await set({ tone: "live", agents: ["wren"] }); }
  h.eq((await stats()).fires - typed, 0, "a claim that arrives mid-typing starts nothing");
  h.ok((await firesIn(2200)) >= 10, "it plays when the hands stop");
  await set({ tone: "ready", agents: [] });

  h.section("the cost of being alive");
  await page.mouse.move(700, 600); await sleep(900);
  await page.evaluate(() => { window.__fam.idle = []; });
  await set({ tone: "live", agents: ["hamerkop", "heron"], waiting: true }); // its busiest state
  const t0 = Date.now(), f0 = (await stats()).fires; await sleep(4000);
  const secs = (Date.now() - t0) / 1000, busiest = await page.evaluate(() => window.__fam.idle), f1 = (await stats()).fires;
  const perSecond = busiest.reduce((a, b) => a + b, 0) / secs, longest = Math.max(0, ...busiest);
  console.log(`  busiest state: ${((f1 - f0) / secs).toFixed(1)} firings/s, ${perSecond.toFixed(2)} ms of script per second, longest single run ${longest.toFixed(2)} ms`);
  h.ok((f1 - f0) / secs <= 3 * 12 + 1, "firings are capped");
  h.ok(perSecond < 12, `at its busiest it spends ${perSecond.toFixed(2)} ms of script a second (budget 12: about 1% of a core)`);
  h.ok(longest < 4, `and never more than ${longest.toFixed(2)} ms at once (budget 4)`);
  await set({ tone: "ready", agents: [], waiting: false });

  h.section("nothing when it cannot be seen");
  await page.evaluate(() => { document.querySelector(".inbox-panel").style.display = "none"; });
  await sleep(600);
  h.eq(await firesIn(1800), 0, "hidden from view, it fires nothing");
  await page.evaluate(() => { document.querySelector(".inbox-panel").style.display = ""; });
  await sleep(900);
  h.ok((await firesIn(2600)) >= 2, "shown again, it resumes");
  await page.keyboard.down("Alt"); await page.keyboard.press("KeyQ"); await page.keyboard.up("Alt"); // the Inbox's own chord closes it
  await waitFor(page, () => !document.querySelector(".inbox-panel"), null, { timeout: 5000, label: "inbox closed" });
  s = await stats();
  h.eq(s.alive, 0, "the surface closed: its engine is gone");
  h.eq(await firesIn(1500), 0, "and nothing fires");

  h.section("limits");
  const cap = await page.evaluate(async () => {
    const mark = await import("/src/shell/agent/fluxAiMark.ts"), eng = await import("/src/shell/agent/fluxAiMarkEngine.ts");
    const host = document.createElement("div"); host.style.cssText = "position:fixed;left:8px;bottom:8px;display:flex;gap:4px"; document.body.append(host);
    const made = []; for (let i = 0; i < 5; i++) { const el = mark.fluxAiMarkElement(document, 20); host.append(el); made.push(eng.attachFluxAiMark(el, 20, { tone: "ready" })); }
    const still = mark.fluxAiMarkElement(document, 20, "ready", true); host.append(still);
    const inert = eng.attachFluxAiMark(still, 20, { tone: "ready" });
    const out = { alive: made.filter((c) => c.alive).length, firing: made.filter((c) => c.alive && !c.quiet).length, quiet: made.filter((c) => c.quiet).length, stillAlive: inert.alive };
    for (const c of made) c.destroy(); host.remove();
    return { ...out, after: eng.fluxAiMarkEngines().length, left: document.querySelectorAll(".fam-live").length };
  });
  h.eq([cap.firing, cap.quiet, cap.stillAlive], [3, 2, false], "at most three marks fire at once; further ones only turn; a still mark gets no engine");
  h.eq([cap.after, cap.left], [0, 0], "a destroyed engine leaves nothing behind");

  await shot(page, "flux-ai-mark");
  h.eq(realErrors(page), [], "no console errors");
} catch (e) {
  h.fail(`threw: ${e?.stack || e}`);
}
await h.done(() => browser.close());
