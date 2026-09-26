// The Inspector's figure Background field (2026-09-26): a ColorField, never a native
// <input type="color"> (whose eyedropper segfaults Electron on Linux/Wayland). Drives the
// real control: click the swatch → the spectrum popover opens; press-drag-release on the
// HSV square → ONE background change lands on the figure model; Escape closes it; the
// hex field commits on Enter. No native colour input exists anywhere in the panel.
import { launch, gotoApp, clickMode, realErrors, sleep } from "./lib/driver.mjs";
import { waitFor } from "./lib/wait.mjs";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-color-field");
const { browser, page } = await launch();
try {
  await gotoApp(page, { url: "http://127.0.0.1:1420/?fixture=demo", settle: 3000 });
  await clickMode(page, "Figure");
  await sleep(700);
  await page.evaluate(() => {
    const F = window.__flux;
    F.fig.selection.set(new Set());
    F.fig.selectedFrameId.set("growth");
    F.fig.activeFigureId.set("growth");
  });
  const bg = () => page.evaluate(() => window.__flux.get(window.__flux.fig.project).figures.find((f) => f.id === "growth").background);
  await waitFor(page, () => !!document.querySelector(".fieldlbl button.swatch"), null, { timeout: 4000, label: "figure inspector shows the Background field" });
  h.ok((await page.$$('input[type="color"]')).length === 0, "no native <input type=color> anywhere in the panel");
  const before = await bg();
  await page.click(".fieldlbl button.swatch");
  await waitFor(page, () => !!document.querySelector(".pop .sv"), null, { timeout: 2000, label: "spectrum popover opens" });
  const sv = await page.$(".pop .sv");
  const r = await sv.boundingBox();
  // press near the top-right (saturated, bright), drag, release → one commit
  await page.mouse.move(r.x + r.width * 0.9, r.y + r.height * 0.15);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width * 0.8, r.y + r.height * 0.2, { steps: 4 });
  await page.mouse.up();
  await sleep(150);
  const after = await bg();
  h.ok(/^#[0-9a-f]{6}$/.test(after) && after !== before, `drag on the spectrum sets the figure background (${before} → ${after})`);
  // hex entry commits on Enter
  // The hex field kept focus through the drag (the square's pointerdown is preventDefault'd),
  // so select its text explicitly rather than relying on a focus event.
  await page.$eval(".pop .hex", (el) => { el.focus(); el.select(); });
  await page.keyboard.type("#123456");
  await page.keyboard.press("Enter");
  await sleep(150);
  h.ok((await bg()) === "#123456", "typing a hex + Enter commits it");
  await page.keyboard.press("Escape");
  await waitFor(page, () => !document.querySelector(".pop"), null, { timeout: 2000, label: "Escape closes the popover" });
  h.ok((await bg()) === "#123456", "Escape closes without reverting the committed colour");
  const errs = await realErrors(page);
  h.ok(errs.length === 0, `console clean (${errs.length} errors)`);
} finally {
  await browser.close();
}
await h.done();
