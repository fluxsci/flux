// Plots rail thumbnail service (pure; Node — no Electron): the engine
// (electron/plotThumbEngine.mjs), the worker protocol (electron/plotThumbWorker.mjs) and the
// main-process family that supervises it (electron/ipc/plotThumbs.cjs), driven through a fake
// ipcMain exactly as main.cjs registers it.
//   * engine: the walk (reserved folders pruned, sidecars → semantic/snip flags, incremental
//     folder re-lists + vanished folders), header probes (SVG units, PNG pHYs, JPEG/GIF/WebP,
//     version stamps), cached renders keyed by the file version, PNG/JPEG via the data-URI
//     wrapper, WebP declined, the per-root index persisting across engine instances,
//     quarantine, the last-used LRU sweep, font requests;
//   * family: containment (only this project's plots/ and the plot library), the warm path
//     served from disk without the worker, cancel, dissection counts (listDissections
//     semantics), a crashing render quarantined + the worker respawned, a hanging render
//     killed at the timeout, and fallback ("unavailable") after repeated deaths.
//   Run: node scripts/run-verifies.mjs --tier pure --only verify-plot-thumbs
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, utimesSync, existsSync, symlinkSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-plot-thumbs");
const repo = join(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const tmp = mkdtempSync(join(tmpdir(), "flux-plot-thumbs-"));
const put = (p: string, data: string | Buffer) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, data); };
const svg = (wpt: number, hpt: number, fill = "#205ea6") => `<?xml version="1.0"?>\n<!-- a comment -->\n<svg xmlns="http://www.w3.org/2000/svg" width="${wpt}pt" height="${hpt}pt" viewBox="0 0 ${wpt} ${hpt}"><rect x="2" y="2" width="${wpt - 4}" height="${hpt - 4}" fill="${fill}"/><text x="4" y="12" style="font-family: 'DejaVu Sans', sans-serif">abc</text></svg>`;

// A PNG with a pHYs chunk (300 dpi), built by resvg (the same prebuilt the worker uses).
const { Resvg } = require("@resvg/resvg-js");
function pngWithDpi(w: number, h: number, dpi: number): Buffer {
  const png: Buffer = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#d14d41"/></svg>`).render().asPng();
  const crc = (buf: Buffer) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const data = Buffer.alloc(9); data.writeUInt32BE(Math.round(dpi / 0.0254), 0); data.writeUInt32BE(Math.round(dpi / 0.0254), 4); data[8] = 1;
  const type = Buffer.from("pHYs");
  const chunk = Buffer.concat([Buffer.alloc(4), type, data, Buffer.alloc(4)]);
  chunk.writeUInt32BE(9, 0); chunk.writeUInt32BE(crc(Buffer.concat([type, data])), 17);
  return Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]); // after IHDR (8 + 25)
}

try {
  const { createThumbEngine, cachedThumb, svgFontRequests } = await import(pathToFileURL(join(repo, "electron", "plotThumbEngine.mjs")).href);
  const { probeImageSize } = await import(pathToFileURL(join(repo, "electron", "plotThumbRules.mjs")).href);
  const { resolveFontFile } = await import(pathToFileURL(join(repo, "src", "lib", "text", "fontFiles.mjs")).href);
  const { RESERVED_PLOT_DIRNAMES } = await import(pathToFileURL(join(repo, "electron", "plotsFolders.js")).href);

  const ROOT = join(tmp, "proj"), P = join(ROOT, "plots"), CACHE = join(tmp, "cache");
  put(join(P, "a.svg"), svg(72, 48));
  put(join(P, "a.fluxplot.json"), JSON.stringify({ style: { tokens: { paper: "#1c1b1a" } } }));
  put(join(P, "figs", "b.svg"), svg(144, 36));
  put(join(P, "figs", "deep", "c.png"), pngWithDpi(600, 300, 300));
  put(join(P, "figs", "deep", "c.snip.json"), "{}");
  put(join(P, "notes.txt"), "x");
  put(join(P, "_dissections", "a", "s1.svg"), svg(10, 10));
  put(join(P, "_dissections", "a", "group", "s2.svg"), svg(10, 10));
  put(join(P, "_dissections", "a", "group", "s2.fluxplot.json"), "{}");
  put(join(P, "_lighttable", "set", "z.png"), pngWithDpi(4, 4, 72));
  const newEngine = () => createThumbEngine({ cacheDir: CACHE, resvgFrom: pathToFileURL(join(repo, "package.json")).href, resolveFont: (r: unknown) => resolveFontFile(r) });
  const engine = newEngine();

  h.section("engine: the walk");
  {
    const reserved = new Set(RESERVED_PLOT_DIRNAMES);
    const r = await engine.list(P, { skipDir: (n: string) => reserved.has(n), accept: (n: string) => /\.(svg|png)$/i.test(n) });
    const rels = r.entries.map((e: { rel: string }) => e.rel).sort();
    h.eq(rels.join(","), "a.svg,figs/b.svg,figs/deep/c.png", "plots + subfolders listed; reserved folders, sidecars and non-images skipped");
    const a = r.entries.find((e: { rel: string }) => e.rel === "a.svg"), c = r.entries.find((e: { rel: string }) => e.rel === "figs/deep/c.png");
    h.ok(a.semantic && !a.snip && c.snip && !c.semantic, "a .fluxplot.json marks a fluxplot; a .snip.json marks a paper snip");
    h.ok(a.size > 0 && a.mtimeMs > 0, "entries carry the version stamp (size + mtime)");
    const inc = await engine.list(P, { skipDir: (n: string) => reserved.has(n), dirs: [join(P, "figs"), join(P, "gone")] });
    h.eq(inc.entries.map((e: { rel: string }) => e.rel).join(","), "figs/b.svg", "an incremental re-list reads only the named folder's own files");
    h.eq(inc.missing.join(","), join(P, "gone"), "a vanished folder comes back in `missing`");
    symlinkSync(join(P, "a.svg"), join(P, "figs", "linked.svg"));
    const withLink = await engine.list(P, { skipDir: (n: string) => reserved.has(n) });
    h.ok(withLink.entries.some((e: { rel: string }) => e.rel === "figs/linked.svg"), "a symlinked plot is listed");
    rmSync(join(P, "figs", "linked.svg"));
    const insideReserved = await engine.list(join(P, "_dissections"), {});
    h.eq(insideReserved.entries.map((e: { rel: string }) => e.rel).sort().join(","), "a/group/s2.svg,a/s1.svg", "inside a collection nothing is pruned");
  }

  h.section("engine: probes");
  {
    const [a, b, c] = await engine.probe([join(P, "a.svg"), join(P, "figs", "b.svg"), join(P, "figs", "deep", "c.png")], P);
    h.ok(Math.abs(a.w - 96) < 0.01 && Math.abs(a.h - 64) < 0.01, "SVG pt → CSS px (72pt = 96px), through a prolog and a comment");
    h.ok(Math.abs(c.w - 192) < 0.5 && Math.abs(c.h - 96) < 0.5, "PNG: pixels scaled by its pHYs dpi (600 px at 300 dpi → 192 px), as io.ts places it");
    h.ok(a.size > 0 && a.mtimeMs > 0 && b.w > 0, "probes carry the version stamp");
    h.ok(probeImageSize("x.svg", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">')?.width === 300, "viewBox only → 300 px wide (Chromium's default)");
    h.ok(probeImageSize("x.svg", '<svg width="50%" height="20mm" viewBox="0 0 4 1">')?.height! > 75, "a percentage width falls back to the viewBox aspect");
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 50, 0, 80, 3, 0, 0, 0]);
    h.eq(JSON.stringify(probeImageSize("x.jpg", jpeg)), JSON.stringify({ width: 80, height: 50, physMm: null }), "JPEG SOF size");
    const gif = Buffer.from("GIF89a\x20\x00\x10\x00", "latin1");
    h.eq(probeImageSize("x.gif", gif)?.width, 32, "GIF size");
  }

  h.section("engine: renders and the cache");
  {
    const t1 = await engine.thumb(join(P, "a.svg"), 256, { roots: [P], indexRoot: P });
    h.ok(!t1.error && existsSync(t1.path) && t1.width === 256, "an SVG renders to a 256 px PNG");
    h.eq(t1.paper, "#1c1b1a", "a fluxplot's declared paper is read from its manifest");
    h.ok(t1.stats && t1.stats.v === 3 && t1.stats.exposed > 0, "the ink analysis rides along");
    const hit = await cachedThumb(CACHE, join(P, "a.svg"), 256);
    h.eq(hit?.path, t1.path, "a second request is a disk-cache hit (no render)");
    const later = new Date(Date.now() + 5000);
    utimesSync(join(P, "a.svg"), later, later);
    h.eq(await cachedThumb(CACHE, join(P, "a.svg"), 256), null, "a regenerated plot (new mtime) misses — a fresh thumbnail");
    const t2 = await engine.thumb(join(P, "a.svg"), 256, { roots: [P], indexRoot: P });
    h.ok(t2.path !== t1.path && !t2.error, "…and renders anew");
    const png = await engine.thumb(join(P, "figs", "deep", "c.png"), 1024, { roots: [P], indexRoot: P });
    h.ok(!png.error && png.width === 600, "a raster renders through the data-URI wrapper, never upscaled past its pixels");
    put(join(P, "w.webp"), Buffer.from("RIFF\x10\x00\x00\x00WEBPVP8X", "latin1"));
    const webp = await engine.thumb(join(P, "w.webp"), 256, { roots: [P], indexRoot: P });
    h.ok(webp.unsupported, "WebP is declined (resvg-js 2.6 cannot decode it) → the renderer's fallback");
    const order: string[] = [];
    const later2 = new Date(Date.now() + 20000);
    utimesSync(join(P, "figs", "b.svg"), later2, later2);
    await engine.thumb(join(P, "figs", "b.svg"), 256, { roots: [P], indexRoot: P, onRender: () => order.push("render") });
    h.ok(order.length >= 1, "the engine names the moment resvg runs (the supervisor times only that, not file reads)");
    const req = svgFontRequests(svg(10, 10) + '<text style="font-weight: bold; font-family: Arial">x</text>');
    h.ok(req.some((r: { weight: number }) => r.weight === 700) && req.some((r: { family: string }) => /DejaVu/.test(r.family)), "font requests: every family stack, bold when any text is bold");
  }

  h.section("engine: the per-root index and quarantine");
  {
    await engine.quarantine(join(P, "figs", "b.svg"), P, "preview crashed");
    const q = await engine.thumb(join(P, "figs", "b.svg"), 256, { roots: [P], indexRoot: P });
    h.ok(q.quarantined && /crashed/.test(q.error), "a quarantined file is not rendered again");
    await engine.flushAll();
    const fresh = newEngine();
    const listed = await fresh.list(P, { skipDir: (n: string) => n.startsWith("_") });
    const b = listed.entries.find((e: { rel: string }) => e.rel === "figs/b.svg");
    h.ok(b.bad && listed.entries.find((e: { rel: string }) => e.rel === "a.svg").stats, "the index survives a new engine: quarantine and analysis known at the next list");
    const later = new Date(Date.now() + 9000);
    utimesSync(join(P, "figs", "b.svg"), later, later);
    const retried = await fresh.thumb(join(P, "figs", "b.svg"), 256, { roots: [P], indexRoot: P });
    h.ok(!retried.error, "once the file changes, the quarantine lifts");
  }

  h.section("engine: the LRU sweep");
  {
    const small = createThumbEngine({ cacheDir: CACHE, resvgFrom: pathToFileURL(join(repo, "package.json")).href, maxCacheBytes: 1 });
    const r = await small.sweep();
    h.ok(r.removed > 0, `an over-budget cache is trimmed (removed ${r.removed})`);
  }

  // ---------------------------------------------------------------------- the family
  const family = require(join(repo, "electron", "ipc", "plotThumbs.cjs"));
  const fakeIpc = () => { const handlers = new Map<string, (...a: unknown[]) => unknown>(); return { handlers, handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn), on: () => {} }; };
  const sender = { id: 1, once: () => {}, isDestroyed: () => false };
  const ev = { sender };
  const LIB = join(tmp, "library");
  put(join(LIB, "lib.svg"), svg(20, 20));
  const guardCalls: string[] = [];

  h.section("family: containment, the warm path, counts");
  {
    const ipc = fakeIpc();
    const fam = family.createPlotThumbsFamily({
      app: { isPackaged: false }, appRoot: repo, rootFor: () => ROOT, libraryRoot: () => LIB,
      cacheDir: () => join(tmp, "cache2"), fontIndexFile: () => join(tmp, "fonts.json"),
      fsReadGuard: (p: string) => { guardCalls.push(p); }, log: () => {},
    });
    fam.registerHandlers(ipc);
    const call = (ch: string, ...a: unknown[]) => (ipc.handlers.get(ch) as (...x: unknown[]) => Promise<any>)(ev, ...a);
    try {
      const list = await call("plots:list", { scope: "project", accept: "svg,png" });
      h.eq(list.entries.map((e: { rel: string }) => e.rel).sort().join(","), "a.svg,figs/b.svg,figs/deep/c.png", "plots:list walks the project's plots/ in the worker, reserved folders pruned");
      const coll = await call("plots:list", { scope: "project", collection: "_dissections", accept: "svg" });
      h.ok(coll.base.endsWith("_dissections") && coll.entries.length === 2, "a reserved collection is listed inside, on request");
      const lib = await call("plots:list", { scope: "global" });
      h.eq(lib.entries.map((e: { rel: string }) => e.rel).join(","), "lib.svg", "the global scope lists the plot library");
      let threw = false;
      try { await call("thumbs:get", { path: join(tmp, "elsewhere.svg"), bucket: 256 }); } catch { threw = true; }
      h.ok(threw, "a path outside the project's plots/ and the library is refused");
      threw = false;
      try { await call("thumbs:get", { path: `${P}/../project.json`, bucket: 256 }); } catch { threw = true; }
      h.ok(threw, "a path that is not normalized (..) is refused");
      const sneaky = await call("plots:list", { scope: "project", accept: "svg,png,json", dirs: [`${P}/../..`, join(P, "figs")] });
      h.ok(sneaky.entries.every((e: { abs: string }) => e.abs.startsWith(P)) && sneaky.entries.some((e: { rel: string }) => e.rel === "figs/b.svg"), "incremental `dirs` with `..` are refused; in-root folders still list");
      const probes = await call("plots:probe", [join(P, "a.svg"), "/etc/passwd"]);
      h.eq(probes.length, 1, "probes outside the roots are dropped");
      const cold = await call("thumbs:get", { path: join(P, "a.svg"), bucket: 512, rid: "r1" });
      h.ok(cold.bytes?.length > 100 && cold.width === 512 && cold.stats, "a cold thumbnail renders in the worker and returns bytes + analysis");
      const state0 = fam._state();
      const warm = await call("thumbs:get", { path: join(P, "a.svg"), bucket: 512 });
      h.ok(warm.bytes?.length === cold.bytes.length, "a warm thumbnail is served from the disk cache");
      h.ok(guardCalls.includes(join(P, "a.svg")), "every served path passes the window's read guard");
      h.eq(fam._state().pending, state0.pending, "…without a worker round trip");
      // Pre-warm (the rail's idle generation): renders into the disk cache, answers without bytes.
      const warmCold = await call("thumbs:get", { path: join(P, "figs/b.svg"), bucket: 256, warm: true });
      h.ok(warmCold.warmed === true && !warmCold.bytes && !!warmCold.stats, "a pre-warm request renders in the worker and answers with the analysis, no bytes");
      const warmAgain = await call("thumbs:get", { path: join(P, "figs/b.svg"), bucket: 256, warm: true });
      h.ok(warmAgain.warmed === true && !warmAgain.bytes, "a pre-warm of a cached thumbnail is answered from the cache, no bytes");
      const stateW = fam._state();
      const served = await call("thumbs:get", { path: join(P, "figs/b.svg"), bucket: 256 });
      h.ok(served.bytes?.length > 100 && fam._state().pending === stateW.pending, "…and the tile that later asks for it is a disk-cache hit");
      const counts = await call("dissect:counts", ["a", "figs/b", "../x"]);
      h.eq(JSON.stringify(counts), JSON.stringify({ a: 2 }), "dissection counts: loose + one group level, sidecars excluded, unknown and unsafe keys omitted");
      await call("thumbs:cancel", ["nope"]);
      h.ok(true, "cancel of an unknown request is harmless");
    } finally { fam.shutdown(); }
  }

  h.section("family: crashes, hangs and fallback (a stub worker)");
  {
    const stubRoot = join(tmp, "stubapp");
    mkdirSync(join(stubRoot, "electron"), { recursive: true });
    for (const f of ["plotThumbEngine.mjs", "plotThumbRules.mjs", "plotsFolders.js", "dissectRules.js"]) copyFileSync(join(repo, "electron", f), join(stubRoot, "electron", f));
    writeFileSync(join(stubRoot, "package.json"), JSON.stringify({ type: "module" }));
    const log = join(tmp, "stub.log");
    writeFileSync(join(stubRoot, "electron", "plotThumbWorker.mjs"), `
import { createInterface } from "node:readline"; import { appendFileSync } from "node:fs";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  appendFileSync(${JSON.stringify(log)}, m.op + " " + (m.path ?? "") + "\\n");
  if (m.op === "thumb") {
    send({ started: m.id });
    if (m.path.includes("crash")) process.exit(3);
    if (m.path.includes("hang")) return;
    send({ id: m.id, ok: true, result: { error: "stub" } });
    return;
  }
  send({ id: m.id, ok: true, result: m.op === "list" ? { entries: [], truncated: false, missing: [] } : null });
});`);
    put(join(P, "crash.svg"), svg(10, 10));
    put(join(P, "hang.svg"), svg(10, 10));
    const ipc = fakeIpc();
    const fam = family.createPlotThumbsFamily({
      app: { isPackaged: false }, appRoot: stubRoot, rootFor: () => ROOT, libraryRoot: () => "",
      cacheDir: () => join(tmp, "cache3"), fontIndexFile: () => join(tmp, "fonts.json"), fsReadGuard: () => {}, log: () => {}, thumbTimeoutMs: 400,
    });
    fam.registerHandlers(ipc);
    const call = (ch: string, ...a: unknown[]) => (ipc.handlers.get(ch) as (...x: unknown[]) => Promise<any>)(ev, ...a);
    try {
      const crashed = await call("thumbs:get", { path: join(P, "crash.svg"), bucket: 256, warm: true });
      h.ok(crashed.quarantined && !crashed.warmed, "a render that kills the worker is answered (quarantined), not left hanging — a pre-warm too (the client then stops pre-warming)");
      const after = await call("thumbs:get", { path: join(P, "a.svg"), bucket: 256 });
      h.eq(after.error, "stub", "the worker respawned and serves the next request");
      h.ok(readFileSync(log, "utf8").includes(`quarantine ${join(P, "crash.svg")}`), "the culprit was quarantined in the respawned worker");
      const hung = await call("thumbs:get", { path: join(P, "hang.svg"), bucket: 256 });
      h.ok(hung.quarantined && /timed out/.test(hung.error), "a render past the timeout is killed and quarantined");
      await call("thumbs:get", { path: join(P, "crash.svg"), bucket: 512 });
      await call("thumbs:get", { path: join(P, "crash.svg"), bucket: 1024 });
      h.ok(fam._state().unavailable, "more than three deaths in ten minutes → fallback mode");
      const fb = await call("thumbs:get", { path: join(P, "a.svg"), bucket: 256 });
      h.ok(fb.unavailable, "in fallback mode thumbnails answer { unavailable } (the renderer draws them)");
      const listed = await call("plots:list", { scope: "project", accept: "svg,png" });
      h.ok(listed.entries.some((e: { rel: string }) => e.rel === "a.svg"), "…but listing still works (file IO in main): the gallery is never emptied by a dead worker");
      const probed = await call("plots:probe", [join(P, "a.svg")]);
      h.ok(probed[0]?.w > 0, "…and so do header probes");
    } finally { fam.shutdown(); }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

await h.done();
