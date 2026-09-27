"use strict";
const fs=require("node:fs"),path=require("node:path"),os=require("node:os");
/** One instance owns its private static-print session/window/queue. */
function createStaticPrint({BrowserWindow,session,underDir,atomicWriteMain,fsGuard,rootFor,appRoot,timeoutMs=120000}) {
if(!Number.isFinite(timeoutMs)||timeoutMs<=0)throw new Error("Invalid static print deadline");
// Render a standalone SVG to a vector PDF via Chromium's print engine.
// SHL-14: ONE reusable hidden window serves every PDF export (figure + document) —
// creating+destroying a BrowserWindow per call paid full window setup each export
// (the proxy engine proved the reuse pattern). Serialized: loadFile/printToPDF on a
// shared window must not interleave. Lazily created, recreated if it ever dies,
// blanked after each print so the last export's DOM doesn't sit resident.
let printWin = null, printSession=null, disposed=false, registered=false;
const partition="flux-print-static-"+require("node:crypto").randomUUID();
let printAllowedRoots = [];
let printDocument = "";
const failedAssets = new Set();
let printChain = Promise.resolve();
function bounded(fn, label, onTimeout) {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{onTimeout?.();reject(new Error(`Static PDF export timed out ${label}; retry the export.`));},timeoutMs);
    Promise.resolve().then(fn).then(resolve,reject).finally(()=>clearTimeout(timer));
  });
}
function runPrintExclusive(fn) {
  const run = printChain.then(fn, fn);
  printChain = run.then(
    () => {},
    () => {},
  );
  return run;
}
function getSession(){
  if(!printSession){
    printSession = session.fromPartition(partition);
    printSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    printSession.on("will-download", event => event.preventDefault());
    printSession.webRequest.onBeforeRequest({urls: ["<all_urls>"]}, (details, callback) => {
      try {
        const url = new URL(details.url);
        if (["data:", "blob:", "about:"].includes(url.protocol)) return callback({cancel: false});
        if (url.protocol !== "file:") {failedAssets.add(details.url);return callback({cancel: true});}
        const target = fs.realpathSync(require("node:url").fileURLToPath(url));
        const allowed = target === printDocument || printAllowedRoots.some(root => underDir(target, fs.realpathSync(root)));
        if(!allowed)failedAssets.add(details.url);
        callback({cancel: !allowed});
      } catch { failedAssets.add(details.url);callback({cancel: true}); }
    });
    printSession.webRequest.onErrorOccurred({urls:["<all_urls>"]},details=>{if(printDocument&&(details.webContentsId===undefined||details.webContentsId===printWin?.webContents.id))failedAssets.add(details.url);});
  }
  return printSession;
}
function getPrintWin() {
  if(disposed)throw new Error("Static print worker disposed");
  if (!printWin || printWin.isDestroyed()) {
    // javascript:false — the print window materializes figure/manuscript content
    // as a live DOM, but every print path feeds STATIC output (buildSvg for
    // figures; renderManuscript's KaTeX-prerendered, html:false HTML for docs),
    // so no page script is ever needed. Disabling JS means an unsanitized path
    // could never execute/exfiltrate even though this file:// load gets no
    // session CSP. printToPDF itself runs in the main process (JS-independent).
    const printSession=getSession();
    printWin = new BrowserWindow({ show: false, webPreferences: { offscreen: true, javascript: false, contextIsolation: true, nodeIntegration: false, sandbox: true, session: printSession } });
    printWin.webContents.setWindowOpenHandler(() => ({action: "deny"}));
    const ownedWindow=printWin;
    printWin.webContents.on("console-message",details=>{
      // Chromium can reject an asset at CSP before webRequest sees it. Keep
      // diagnostics generic: URL credentials/query strings never enter errors.
      if(printWin===ownedWindow&&printDocument&&/(?:img|font|style)-src|Failed to load resource/i.test(details.message||""))failedAssets.add("unavailable image/font/stylesheet");
    });
    printWin.webContents.on("will-navigate", (event, url) => {
      if (url !== "about:blank" && url !== require("node:url").pathToFileURL(printDocument).href) event.preventDefault();
    });
  }
  return printWin;
}
function dispose() {
  disposed=true;printAllowedRoots=[];printDocument="";failedAssets.clear();
  try {
    if (printWin && !printWin.isDestroyed()) printWin.destroy();
  } catch {
    /* already gone */
  }
}
async function printHtmlToPdf(html, outPath, pdfOpts, tmpTag, projectRoot) {
  return runPrintExclusive(async () => {
    if(disposed)throw new Error("Static print worker disposed");
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `flux-${tmpTag}-`));
    const tmp = path.join(dir, "print.html");
    let win;
    try {
      win = getPrintWin();
      failedAssets.clear();
      const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; object-src 'none'; connect-src 'none'; img-src data: blob: file:; style-src 'unsafe-inline' file:; font-src data: file:">`;
      html = /<head(?:\s[^>]*)?>/i.test(html) ? html.replace(/<head(?:\s[^>]*)?>/i, match => match + policy) : policy + html;
      await fs.promises.writeFile(tmp, html, "utf8");
      printDocument = await fs.promises.realpath(tmp);
      printAllowedRoots = [projectRoot, path.join(appRoot, "dist", "assets")].filter(root => root && fs.existsSync(root));
      const abandon=()=>{try{win.destroy();}catch{}if(printWin===win)printWin=null;};
      await bounded(()=>win.loadFile(tmp),"while loading assets",abandon);
      if(failedAssets.size)throw new Error("Static PDF export could not load an image, font, or stylesheet. Embed remote assets and check that local project assets still exist before retrying.");
      const data = await bounded(()=>win.webContents.printToPDF(pdfOpts),"while printing",abandon);
      if(failedAssets.size)throw new Error("Static PDF export could not load an image, font, or stylesheet; the previous output was preserved.");
      if(disposed)throw new Error("Static print worker disposed");
      await atomicWriteMain(outPath, data);
    } finally {
      if(win&&!win.isDestroyed())await bounded(()=>win.loadURL("about:blank"),"while resetting the print window",()=>{try{win.destroy();}catch{}if(printWin===win)printWin=null;}).catch(()=>{});
      printAllowedRoots = []; printDocument = "";failedAssets.clear();
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    return true;
  });
}

function registerHandlers(ipc) {
if(registered)throw new Error("Static print handlers already registered");registered=true;
ipc.handle("export:pdf", async (e, { svg, outPath, w, h }) => {
  fsGuard(outPath, e.sender.id); // W12 (SHL-6): was an unguarded write of any path
  if (![w, h].every(n => Number.isFinite(n) && n > 0)) throw new Error("PDF dimensions must be finite and positive.");
  // Defense-in-depth CSP: block scripts/plugins outright (the window also runs
  // javascript:false). Everything else stays permissive so embedded figure
  // assets (data:/blob: images, inline styles) still render.
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src * data: blob: 'unsafe-inline'; script-src 'none'; object-src 'none'">`;
  // A full-height inline SVG leaves a text baseline below itself, spilling a
  // blank line onto page two. The single figure is a block at its exact size.
  const html = `<!doctype html><html><head><meta charset="utf-8">${csp}<style>html,body{margin:0;padding:0}body>svg{display:block}</style></head><body>${svg}</body></html>`;
  // printToPDF custom sizes are INCHES (Electron PrintToPDFOptions), unlike
  // webContents.print's microns. Passing microns creates an enormous page and
  // Chromium's compositor fails even for an ordinary 320×240 figure.
  return printHtmlToPdf(
    html,
    outPath,
    {
      printBackground: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      pageSize: { width: w / 96, height: h / 96 },
    },
    "fig", rootFor(e),
  );
});

// Render a full HTML document to a multi-page PDF. Unlike export:pdf (one page
// sized to a figure), this lets CSS @page rules drive size + pagination.
ipc.handle("print:pdf", async (e, { html, outPath, opts = {} }) => {
  fsGuard(outPath, e.sender.id); // W12 (SHL-6): was an unguarded write of any path
  return printHtmlToPdf(
    html,
    outPath,
    {
      printBackground: true,
      preferCSSPageSize: true,
      ...(opts.margins ? { margins: opts.margins } : {}),
    },
    "doc", rootFor(e),
  );
});

}
  return {registerHandlers,printHtmlToPdf,dispose};
}
module.exports={createStaticPrint};
