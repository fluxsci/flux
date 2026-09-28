"use strict";
const { app, BrowserWindow, session } = require("electron");
const fs = require("node:fs/promises"), path = require("node:path");
const { createStaticPrint } = require("../../electron/ipc/staticPrint.cjs");
const root = process.env.FLUX_PDF_PROBE_ROOT;
app.setPath("userData", path.join(root, "user-data"));
process.stdin.resume();
process.stdin.on("end", () => app.exit(1));
process.stdin.on("close", () => app.exit(1));
app.whenReady().then(async () => {
  let current;
  class CapturedWindow extends BrowserWindow {
    constructor(opts) {
      super(opts);
      const print = this.webContents.printToPDF.bind(this.webContents);
      this.webContents.printToPDF = async opts => {
        const bytes = await print(opts);
        await fs.writeFile(path.join(root, `${current}-raw.pdf`), bytes);
        return bytes;
      };
    }
  }
  const owner = createStaticPrint({ BrowserWindow: CapturedWindow, session,
    underDir: (p, r) => p === r || p.startsWith(r + path.sep),
    atomicWriteMain: async (p, bytes) => { await fs.writeFile(p + ".tmp", bytes); await fs.rename(p + ".tmp", p); },
    fsGuard: p => { if (!p.startsWith(root + path.sep)) throw Error("outside scratch"); },
    rootFor: () => root, appRoot: path.resolve(__dirname, "../.."),
  });
  const handlers = new Map(); owner.registerHandlers({ handle: (name, fn) => handlers.set(name, fn) });
  try {
    for (const [name, w, h] of [["integer", 600, 450], ["fractional", 601.25, 449.375], ["small", 320, 240]]) {
      current = name;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="white"/><rect x=".5" y=".5" width="${w-1}" height="${h-1}" fill="none" stroke="red"/><text x="8" y="18" font-size="12">TOP vector</text><text x="8" y="${h-8}" font-size="12">BOTTOM vector</text></svg>`;
      await handlers.get("export:pdf")({ sender: { id: 1 } }, { svg, outPath: path.join(root, `${name}.pdf`), w, h });
    }
    current = "document";
    await handlers.get("print:pdf")({ sender: { id: 1 } }, { html: '<html><head><style>@page{size:400px 300px;margin:0}body{margin:0}</style></head><body>Document unchanged</body></html>', outPath: path.join(root, "document.pdf") });
    console.log("FIGURE PDF NATIVE READY");
  } finally { owner.dispose(); }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
