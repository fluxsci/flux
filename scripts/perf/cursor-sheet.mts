// Contact sheet of the generated cursor family (2026-10-21). CDP screenshots
// never include the pointer, so this is how the family is LOOKED at: every
// state × scheme at 1×, 2× and 4× on dark and light swatches, rendered through
// Chrome into test-results/cursor-sheet.png.
//   node --import tsx scripts/perf/cursor-sheet.mts [--params '{"size":32}']
import { mkdirSync } from "node:fs";
import path from "node:path";
import { launch } from "../lib/driver.mjs";
import { buildCursorFamily, CURSOR_STATES, CURSOR_SCHEMES, type CursorParams } from "../../src/lib/cursor/cursorFamily";

const argIdx = process.argv.indexOf("--params");
const extra: Partial<CursorParams> = argIdx > 0 ? JSON.parse(process.argv[argIdx + 1]) : {};
const onlyIdx = process.argv.indexOf("--states");
const only = onlyIdx > 0 ? new Set(process.argv[onlyIdx + 1].split(",")) : null;
const scaleIdx = process.argv.indexOf("--scales");
const scales = scaleIdx > 0 ? process.argv[scaleIdx + 1].split(",").map(Number) : [1, 2, 4];
const states = only ? CURSOR_STATES.filter((s) => only.has(s)) : CURSOR_STATES;
const schemes = only ? (["ink"] as const) : CURSOR_SCHEMES;
const out = path.resolve(only ? "test-results/cursor-sheet-detail.png" : "test-results/cursor-sheet.png");
mkdirSync(path.dirname(out), { recursive: true });

const rows: string[] = [];
for (const scheme of schemes) {
  const fam = buildCursorFamily({ ...extra, scheme });
  for (const bg of ["#1c1b1a", "#fffcf0", "#4385be"]) {
    rows.push(
      `<div class="row" style="background:${bg}"><div class="lbl" style="color:${bg === "#fffcf0" ? "#333" : "#eee"}">${scheme} · ${bg}</div>` +
        states.map((s) => {
          const svg = fam[s].svg.replace(/%23/g, "#");
          return `<div class="cell"><div class="name" style="color:${bg === "#fffcf0" ? "#333" : "#eee"}">${s}</div>${scales
            .map((k) => `<div class="mark" style="width:${24 * k}px;height:${24 * k}px">${svg.replace(/width='[\d.]+' height='[\d.]+'/, `width='100%' height='100%'`)}</div>`)
            .join("")}</div>`;
        }).join("") +
        `</div>`,
    );
  }
}
const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;font:10px ui-monospace,monospace}
.row{display:flex;gap:6px;padding:6px 8px;align-items:flex-end}
.lbl{width:110px;align-self:center}
.cell{display:flex;flex-direction:column;align-items:center;gap:4px;min-width:104px}
.name{font-size:9px}
.mark{display:block} .mark svg{display:block}
</style><body>${rows.join("")}</body>`;

const { browser, page } = await launch({ width: 1600, height: 1200 });
await page.setContent(html);
const h = await page.evaluate(() => document.body.scrollHeight);
await page.setViewport({ width: 1600, height: Math.min(h + 10, 6000), deviceScaleFactor: 1 });
await page.screenshot({ path: out, fullPage: true });
await browser.close();
console.log("wrote", out);
