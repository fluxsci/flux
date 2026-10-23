#!/usr/bin/env node
"use strict";
// Is LCD (sub-pixel) text anti-aliasing observable in OFFSCREEN Electron's `paint` bitmaps, and does a will-change layer lose it? (lane J, class iii)
// Black text on white in a plain page and inside a `will-change: transform` layer; prints how many ink pixels carry colour fringes. On the dev
// machine (Linux, x11 ozone, GPU): plain text 64 % chromatic, the layer 0 %. That is why the slide stage (a will-change camera layer) is grayscale
// end to end, and why the real-time gate pins its chromatic share (scripts/lib/slideSettleRealtime.ts GRAYSCALE_MAX_SHARE). No window is shown.
//   node_modules/.bin/electron scripts/perf/slide-lcd-probe.cjs --ozone-platform=x11
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { app, BrowserWindow } = require("electron");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flux-lcd-"));
app.setPath("userData", path.join(dir, "profile"));
app.commandLine.appendSwitch("force-color-profile", "srgb");
app.whenReady().then(async () => {
  const text = "Flux text sample hamburgefonstiv 42";
  const html = `<body style="margin:0;background:#fff"><div style="font:22px Georgia;color:#000;padding:20px">${text}</div><div style="font:22px Georgia;color:#000;padding:20px;will-change:transform;transform:translateX(0.4px)">${text}</div></body>`;
  fs.writeFileSync(path.join(dir, "p.html"), html);
  const win = new BrowserWindow({ show: false, width: 600, height: 200, useContentSize: true, webPreferences: { offscreen: true, backgroundThrottling: false } });
  let img = null; win.webContents.on("paint", (_e, _d, i) => { img = i; });
  await win.loadFile(path.join(dir, "p.html")); await new Promise(r => setTimeout(r, 800));
  const bm = img.toBitmap(), size = img.getSize(), half = Math.floor(size.height / 2);
  const stat = (y0, y1) => { let ink = 0, chromatic = 0; for (let y = y0; y < y1; y++) for (let x = 0; x < size.width; x++) { const i = (y * size.width + x) * 4, b = bm[i], g = bm[i + 1], r = bm[i + 2]; if (r < 250 || g < 250 || b < 250) { ink++; if (Math.max(r, g, b) - Math.min(r, g, b) > 6) chromatic++; } } return { ink, chromatic, share: +(chromatic / Math.max(1, ink)).toFixed(3) }; };
  console.log(JSON.stringify({ plainPage: stat(0, half), willChangeLayer: stat(half, size.height) }));
  fs.rmSync(dir, { recursive: true, force: true }); app.exit(0);
});
