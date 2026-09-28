"use strict";
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), assert = require("node:assert/strict");
const { PDFDocument } = require("pdf-lib"), { exactFigurePdf } = require("../electron/figurePdf.cjs");

async function main(h) {
  const repo = path.resolve(__dirname, ".."), scratch = await fs.mkdtemp(path.join(os.tmpdir(), "flux-figure-pdf-"));
  const artifacts = path.join(repo, "test-results/model3d/pdf-size");
  const { TestProcessScope } = await import("./lib/testProcess.mjs"), scope = new TestProcessScope();
  try {
    await fs.mkdir(artifacts, { recursive: true });
    const child = scope.spawn(path.join(__dirname, "lib/figurePdfProbe.cjs"), process.platform === 'linux' ? ['--ozone-platform=x11'] : [], {
      command: require("electron"), nodeArgs: [], cwd: repo, deadlineMs: 45000,
      env: { ...process.env, FLUX_PDF_PROBE_ROOT: scratch, HOME: path.join(scratch, "home"), XDG_CONFIG_HOME: path.join(scratch, "config"), XDG_DATA_HOME: path.join(scratch, "data"), XDG_CACHE_HOME: path.join(scratch, "cache"), FLUX_PRIVATE_DISPLAY: '1', DISPLAY: process.env.DISPLAY || ':0', FLUX_NO_MIGRATE: "1", ELECTRON_RUN_AS_NODE: undefined },
    });
    const result = await scope.waitExit(child);
    await fs.writeFile(path.join(artifacts, "native.log"), child.stdout + child.stderr);
    assert.equal(result.code, 0, child.stdout + child.stderr);
    const canvas = require("@napi-rs/canvas");
    for (const key of ["DOMMatrix", "ImageData", "Path2D"]) globalThis[key] = canvas[key];
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const inspect = async bytes => {
      const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, isEvalSupported: false });
      const doc = await task.promise, page = await doc.getPage(1), viewport = page.getViewport({ scale: 96 / 72 });
      const c = canvas.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height)), ctx = c.getContext("2d");
      await page.render({ canvasContext: ctx, viewport, canvas: c }).promise;
      const text = (await page.getTextContent()).items.filter(item => item.str).map(item => ({ str: item.str, x: item.transform[4], fromTop: page.view[3] - item.transform[5], height: item.height }));
      const pixels = ctx.getImageData(0, 0, c.width, c.height).data;
      await task.destroy(); return { width: c.width, height: c.height, pixels, text, png: c.toBuffer("image/png") };
    };
    const receipt = [];
    for (const [name, w, ht] of [["integer", 600, 450], ["fractional", 601.25, 449.375], ["small", 320, 240]]) {
      const bytes = await fs.readFile(path.join(scratch, `${name}.pdf`)), raw = await fs.readFile(path.join(scratch, `${name}-raw.pdf`));
      const doc = await PDFDocument.load(bytes), box = doc.getPage(0).getMediaBox();
      assert.equal(doc.getPageCount(), 1); assert.ok(Math.abs(box.width - w * .75) < .02 && Math.abs(box.height - ht * .75) < .02);
      h.ok(true, `${name}: production figure PDF retains exact physical page dimensions`);
      const before = await inspect(raw), after = await inspect(bytes);
      assert.deepEqual(after.text, before.text); assert.ok(after.text.some(item => item.str.includes("TOP")) && after.text.some(item => item.str.includes("BOTTOM")));
      h.ok(true, `${name}: native vector text and top/bottom anchor coordinates remain exact`);
      assert.equal(after.width, Math.ceil(w)); assert.equal(after.height, Math.ceil(ht));
      let max = 0;
      for (let y = 0; y < Math.min(before.height, after.height); y++) for (let x = 0; x < Math.min(before.width, after.width) * 4; x++) max = Math.max(max, Math.abs(before.pixels[y * before.width * 4 + x] - after.pixels[y * after.width * 4 + x]));
      assert.ok(max <= 1, `top-anchored raster pixel difference ${max}`);
      h.ok(true, `${name}: page correction leaves shared raster pixels unchanged (max ${max})`);
      await fs.writeFile(path.join(artifacts, `${name}.pdf`), bytes); await fs.writeFile(path.join(artifacts, `${name}.png`), after.png);
      receipt.push({ name, css: [w, ht], box, pixels: [after.width, after.height], text: after.text, maxPixelDifference: max, inputBytes: raw.length, outputBytes: bytes.length });
    }
    assert.deepEqual(await fs.readFile(path.join(scratch, "document.pdf")), await fs.readFile(path.join(scratch, "document-raw.pdf")));
    h.ok(true, "document PDF path preserves the Chromium output byte-for-byte");
    const multi = await PDFDocument.create(); multi.addPage(); multi.addPage();
    await assert.rejects(exactFigurePdf(await multi.save(), 100, 100), /more than one page/);
    await assert.rejects(exactFigurePdf(Buffer.from("invalid"), 100, 100));
    h.ok(true, "invalid or multipage figure output refuses normalization before publication");
    // Exercise the packaged dependency closure outside every checkout. Only
    // files admitted by electron-builder's explicit runtime allowlist are copied.
    const isolated = path.join(scratch, "isolated"), { minimatch } = require("minimatch");
    const config = require("js-yaml").load(await fs.readFile(path.join(repo, "electron-builder.yml"), "utf8"));
    let shippedBytes = 0; const shipped = [];
    const included = relative => { let keep = false; for (const pattern of config.files) { const deny = pattern.startsWith("!"); if (minimatch(relative, deny ? pattern.slice(1) : pattern)) keep = !deny; } return keep; };
    const copy = async (from, relative) => {
      for (const item of await fs.readdir(from, { withFileTypes: true })) {
        const file = path.join(from, item.name), rel = `${relative}/${item.name}`;
        if (item.isDirectory()) await copy(file, rel);
        else if (included(rel)) { const bytes = await fs.readFile(file); await fs.mkdir(path.dirname(path.join(isolated, rel)), { recursive: true }); await fs.writeFile(path.join(isolated, rel), bytes); shippedBytes += bytes.length; shipped.push(bytes); }
      }
    };
    for (const name of ["pdf-lib", "@pdf-lib/standard-fonts", "@pdf-lib/upng", "pako", "tslib"]) {
      let from = path.dirname(require.resolve(name, { paths: name === 'tslib' ? [repo] : [path.dirname(require.resolve("pdf-lib")), repo] }));
      while (JSON.parse(await fs.readFile(path.join(from, "package.json"), "utf8").catch(() => '{}')).name !== name) {
        const parent = path.dirname(from); if (parent === from) throw Error(`Missing package root for ${name}`); from = parent;
      }
      await copy(from, `node_modules/${name}`);
    }
    await fs.copyFile(path.join(repo, "electron/figurePdf.cjs"), path.join(isolated, "figurePdf.cjs"));
    await fs.writeFile(path.join(isolated, "probe.cjs"), `const{PDFDocument}=require('pdf-lib'),{exactFigurePdf}=require('./figurePdf.cjs');process.stdin.resume();process.stdin.on('end',()=>process.exit(1));(async()=>{const d=await PDFDocument.create();d.addPage([450,337.91998]);const p=await PDFDocument.load(await exactFigurePdf(await d.save(),450,337.5));if(p.getPage(0).getMediaBox().height!==337.5)throw Error('wrong size');process.exit(0)})().catch(e=>{console.error(e);process.exit(1)});`);
    const packaged = scope.spawn(path.join(isolated, "probe.cjs"), [], { nodeArgs: [], cwd: isolated, env: { ...process.env, NODE_PATH: "" }, deadlineMs: 15000 });
    assert.equal((await scope.waitExit(packaged)).code, 0, packaged.stderr);
    h.ok(true, "isolated packaged runtime normalizes a real PDF without borrowing checkout modules");
    await fs.writeFile(path.join(artifacts, "dependency-size.json"), JSON.stringify({ shippedBytes, gzipBytes: require("node:zlib").gzipSync(Buffer.concat(shipped)).length }, null, 2) + "\n");
    await fs.writeFile(path.join(artifacts, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  } finally { await scope.dispose(); await fs.rm(scratch, { recursive: true, force: true }); }
}
import("./lib/harness.mjs").then(async ({ harness }) => { const h = harness("verify-figure-pdf-size"); try { await main(h); } catch (error) { h.ok(false, String(error.stack || error)); } await h.done(); });
