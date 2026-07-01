// W7 (figure half): the figure autosave must not clobber an agent/CLI write to
// the fig/ subsystem. Loads the demo project's figure editor, dirties it, then
// simulates an external write to fig/index.json and forces a flush — disk must
// keep the external version and the divergence banner must appear.
import { launch, gotoApp, clickMode, sleep, realErrors } from "./lib/driver.mjs";

const R = "/demo/myc-growth-paper";
const IDX = R + "/fig/index.json";
const { browser, page } = await launch();
await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3000 });
await clickMode(page, "Figure");
await sleep(1500); // loadFigInto → figIndexBaseline seeded

// Dirty the editor, then simulate an agent editing fig/index.json underneath us.
const setup = await page.evaluate(async (IDX) => {
  window.__flux.fig.commit((p) => {
    if (p.figures[0]) p.figures[0].name = "HUMAN EDIT " + p.figures[0].name;
  });
  const parsed = JSON.parse(await window.fig.readText(IDX));
  parsed._agentMarker = "W7-AGENT-WROTE-THIS";
  await window.fig.writeText(IDX, JSON.stringify(parsed, null, 2) + "\n");
  return { dirtied: window.__flux.get(window.__flux.fig.dirty) };
}, IDX);

// Force every dirty mode to flush — the figure autosave must detect the divergence
// and refuse to overwrite (ConflictError → banner), not clobber the agent's write.
await page.evaluate(() => window.__flux.lifecycle.flushAll());
await sleep(400);

const res = await page.evaluate(async (IDX) => {
  const disk = await window.fig.readText(IDX);
  return {
    diskKeptAgentMarker: disk.includes("W7-AGENT-WROTE-THIS"),
    diskNotClobberedByEditor: !disk.includes("HUMAN EDIT"),
    bannerShown: !!document.querySelector(".disk-toast"),
  };
}, IDX);

const out = { dirtied: setup.dirtied, ...res, errs: realErrors(page) };
console.log(JSON.stringify(out, null, 2));
await browser.close();

const pass =
  out.dirtied &&
  out.diskKeptAgentMarker &&
  out.diskNotClobberedByEditor &&
  out.bannerShown &&
  out.errs.length === 0;
console.log(pass ? "W7-FIG VERIFY: PASS" : "W7-FIG VERIFY: FAIL");
process.exit(pass ? 0 : 1);
