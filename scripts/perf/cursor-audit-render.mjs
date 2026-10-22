// node --import tsx scripts/perf/cursor-audit-render.mjs  → /tmp/cursor-audit/*.png + index.json
// Render every cursor state of both styles at DPR 1 and 2 through Chromium (same Skia
// rasteriser as the hardware cursor) into PNGs for a pixel audit.
import { launch } from "../lib/driver.mjs";
import { writeFileSync } from "node:fs";
const fam = await import("../../src/lib/cursor/cursorFamily.ts");
const STYLES = { classic: {}, crosshair: { style: "crosshair" } };
const { browser } = await launch({ width: 400, height: 400 });
const index = [];
for (const dpr of [1, 2]) {
  const page = await browser.newPage();
  await page.setViewport({ width: 400, height: 400, deviceScaleFactor: dpr });
  await page.setContent("<body style='margin:0;background:transparent'><img id=i style='display:block;image-rendering:auto'></body>", { waitUntil: "load" });
  for (const [style, params] of Object.entries(STYLES)) {
    const f = fam.buildCursorFamily(params);
    for (const st of Object.keys(f)) {
      const css = f[st].css;
      const m = css.match(/^url\("([^"]+)"\) (\d+) (\d+)/);
      if (!m) continue;
      const url = m[1];
      await page.evaluate(async (u) => { const i = document.getElementById("i"); i.src = u; await i.decode(); }, url);
      const el = await page.$("#i");
      const box = await el.boundingBox();
      const file = `/tmp/cursor-audit/${style}-${st}@${dpr}x.png`;
      await el.screenshot({ path: file, omitBackground: true });
      // the same drawing on a canvas padded by PAD px on every side: anything that
      // lands in the padding ring is clipped by the real cursor's canvas
      const PAD = 3;
      const padded = f[st].svg.replace(/width='(\d+)' height='(\d+)' viewBox='0 0 \d+ \d+'/, (_, w, h) => `width='${+w + 2 * PAD}' height='${+h + 2 * PAD}' viewBox='${-PAD} ${-PAD} ${+w + 2 * PAD} ${+h + 2 * PAD}'`);
      await page.evaluate(async (u) => { const i = document.getElementById("i"); i.src = u; await i.decode(); }, `data:image/svg+xml,${padded}`);
      const filePad = `/tmp/cursor-audit/${style}-${st}@${dpr}x-padded.png`;
      await (await page.$("#i")).screenshot({ path: filePad, omitBackground: true });
      index.push({ style, state: st, dpr, file, filePad, pad: PAD, w: box.width, h: box.height, hotspot: [+m[2], +m[3]] });
    }
  }
  await page.close();
}
await browser.close();
writeFileSync("/tmp/cursor-audit/index.json", JSON.stringify(index, null, 1));
console.log("rendered", index.length, "bitmaps");
