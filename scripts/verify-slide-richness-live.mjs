// Live GUI verification of W3 (element richness): numbered lists + text
// formatting (italic / line-height / font family) rendering, the rotation field
// AND the rotation drag-handle, and drag-drop image import (write asset → element
// → render with object-fit:contain). Run with the dev server up on :1420.
import { launch, gotoApp, clickMode, shot, realErrors, sleep, APP_URL } from "./lib/driver.mjs";

const { browser, page } = await launch();
const log = (o) => console.log(JSON.stringify(o, null, 2));
// a real 1×1 red PNG
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

try {
  // ?fixture=demo backs window.fig with an in-memory project (real file bridge +
  // projectModel root), so drag-drop image import can round-trip to "disk".
  await gotoApp(page, { url: APP_URL + "?fixture=demo", settle: 1800 });
  await clickMode(page, "Slide");
  await sleep(1200);

  // ---- 1. numbered lists + text formatting ----
  const seed = await page.evaluate(() => {
    const F = window.__flux;
    const sid = F.get(F.slide.activeSlideId);
    let tb = "";
    F.slide.commitDeck((d) => {
      const s = F.slideOps.slideById(d, sid);
      s.elements = [];
      tb = F.slideOps.addTextBox(d, sid, {
        x: 80, y: 80, width: 700, height: 380,
        blocks: [
          F.slideOps.makeBlock("First point"),
          F.slideOps.makeBlock("Second point"),
          F.slideOps.makeBlock("Third point"),
        ],
      });
      const el = F.slideOps.findElement(d, tb).el;
      el.fontStyle = "italic";
      el.lineHeight = 1.8;
      el.fontFamily = "system-ui, sans-serif";
      for (const b of el.blocks) b.marker = "number";
    });
    return { sid, tb };
  });
  await sleep(400);

  const textRender = await page.evaluate(() => {
    const box = document.querySelector('.stage .sl-el[data-el-type="textBox"]');
    if (!box) return { err: "no textBox rendered" };
    const cs = getComputedStyle(box);
    const markers = [...box.querySelectorAll(".sl-mk")].map((m) => m.textContent);
    return {
      markers,
      fontStyle: cs.fontStyle,
      lineHeight: cs.lineHeight,
      fontFamily: cs.fontFamily,
    };
  });

  // ---- 2. rotation via the inspector field (commitDeck path) ----
  await page.evaluate((tb) => {
    const F = window.__flux;
    F.slide.commitDeck((d) => F.slideOps.setElementBox(d, tb, { rotation: 30 }));
  }, seed.tb);
  await sleep(250);
  const rotField = await page.evaluate(() => {
    const box = document.querySelector('.stage .sl-el[data-el-type="textBox"]');
    return { transform: getComputedStyle(box).transform, raw: box.style.transform };
  });

  // ---- 3. rotation via the DRAG handle ----
  // select the box, grab the .rot-knob, drag ~90° around the element center.
  await page.evaluate((tb) => window.__flux.slide.selection.set([tb]), seed.tb);
  await sleep(200);
  const knob = await page.evaluate(() => {
    const c = document.querySelector(".overlay .rot-knob");
    if (!c) return null;
    const r = c.getBoundingClientRect();
    // element center on screen: use the selbox rect center-x, and its vertical center
    const sb = document.querySelector(".overlay .selbox").getBoundingClientRect();
    return { kx: r.x + r.width / 2, ky: r.y + r.height / 2, cx: sb.x + sb.width / 2, cy: sb.y + sb.height / 2 };
  });
  let handleRot = { before: null, after: null, knobFound: !!knob };
  if (knob) {
    handleRot.before = await page.evaluate((tb) => window.__flux.slideOps.findElement(window.__flux.get(window.__flux.slide.deck), tb).el.rotation, seed.tb);
    // drag the knob from its position to a point rotated 90° CW about the center
    // (from straight-up to straight-right of the center).
    const dist = Math.hypot(knob.kx - knob.cx, knob.ky - knob.cy);
    await page.mouse.move(knob.kx, knob.ky);
    await page.mouse.down();
    await page.mouse.move(knob.cx + dist, knob.cy, { steps: 8 }); // 90° to the right
    await page.mouse.up();
    await sleep(200);
    handleRot.after = await page.evaluate((tb) => window.__flux.slideOps.findElement(window.__flux.get(window.__flux.slide.deck), tb).el.rotation, seed.tb);
  }

  // ---- 4. drag-drop image import ----
  const dropResult = await page.evaluate(async (b64) => {
    const F = window.__flux;
    const before = F.get(F.slide.deck);
    const beforeAssets = before.assets.length;
    const beforeEls = F.slideOps.slideById(before, F.get(F.slide.activeSlideId)).elements.length;
    // build a real File from the base64 PNG
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], "dropped.png", { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    const wrap = document.querySelector(".stage-wrap");
    wrap.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    return { beforeAssets, beforeEls };
  }, PNG_B64);

  // wait for the async import chain (file read → write → reload resolvers → render)
  let imgState = { imgEl: false, objectFit: null, assets: 0, imgCount: 0 };
  for (let i = 0; i < 40; i++) {
    imgState = await page.evaluate(() => {
      const F = window.__flux;
      const d = F.get(F.slide.deck);
      const img = document.querySelector('.stage .sl-el[data-el-type="image"] img');
      return {
        imgEl: !!img,
        objectFit: img ? getComputedStyle(img).objectFit : null,
        assets: d.assets.length,
        imgCount: F.slideOps.slideById(d, F.get(F.slide.activeSlideId)).elements.filter((e) => e.type === "image").length,
      };
    });
    if (imgState.imgEl && imgState.objectFit) break;
    await sleep(150);
  }

  await shot(page, "w3-richness-live");

  // ---- assertions ----
  const fails = [];
  const chk = (c, m) => { if (!c) fails.push(m); };
  chk(JSON.stringify(textRender.markers) === JSON.stringify(["1.", "2.", "3."]),
    `numbered markers render 1./2./3. (got ${JSON.stringify(textRender.markers)})`);
  chk(textRender.fontStyle === "italic", `italic applied (got ${textRender.fontStyle})`);
  // font-size defaults to 32px; line-height 1.8 → ~57.6px used value (not "normal")
  chk(textRender.lineHeight !== "normal" && parseFloat(textRender.lineHeight) > 40,
    `line-height 1.8 applied (got ${textRender.lineHeight})`);
  chk(/sans-serif|system-ui/.test(textRender.fontFamily), `font family applied (got ${textRender.fontFamily})`);
  chk(rotField.raw.includes("rotate(30deg)") || rotField.transform !== "none",
    `rotation field → wrapper rotated (got raw="${rotField.raw}")`);
  chk(handleRot.knobFound, "rotation drag-handle (.rot-knob) is present for a single selection");
  chk(handleRot.after != null && handleRot.after !== handleRot.before,
    `rotation drag-handle changes the model rotation (${handleRot.before} → ${handleRot.after})`);
  chk(imgState.assets === dropResult.beforeAssets + 1, `image drop registers 1 new deck asset (${dropResult.beforeAssets} → ${imgState.assets})`);
  chk(imgState.imgCount >= 1 && imgState.imgEl, "image drop adds a rendered <img> element");
  chk(imgState.objectFit === "contain", `dropped image uses object-fit:contain (got ${imgState.objectFit})`);

  log({ textRender, rotField, handleRot, dropResult, imgState, realErrors: realErrors(page), fails });
  if (fails.length) { console.error("\nW3 LIVE FAILED:\n" + fails.join("\n")); process.exitCode = 1; }
  else console.log("\nW3 RICHNESS LIVE GUI VERIFICATION PASSED");
} catch (e) {
  console.error("ERROR", e);
  process.exitCode = 1;
} finally {
  await browser.close();
}
