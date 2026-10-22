// Plot thumbnail engine — the raster work behind the Plots rail, in plain Node. It runs inside
// the thumbnail worker (electron/plotThumbWorker.mjs, a long-lived ELECTRON_RUN_AS_NODE child —
// never the Electron main process and never the renderer: native raster work stays out of both,
// guide §9) and in-process under the pure gate (scripts/verify-plot-thumbs.ts).
//
//   list(root, opts)        walk a plots tree: files + size/mtime + cached size/analysis
//   probe(paths)            placed size from file headers (no raster)
//   thumb(abs, bucket)      a cached PNG at a bucket width + the ink analysis (backdrop law)
//
// Cache: <cacheDir>/<2 hex>/<key>.png (+ .json meta) keyed by path, size, mtime, bucket and
// PLOT_THUMB_GEN, plus one per-root index (index-<sha1(root)>.json) holding each file's size,
// analysis and quarantine state so the next open lays out and colours tiles at first paint.
// A file that crashes or times out the renderer is quarantined by (size, mtime) and never
// retried until it changes.

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import {
  ANALYSIS_WIDTH,
  PLOT_THUMB_GEN,
  THUMB_BUCKETS,
  analyzeInk,
  probeImageSize,
} from "./plotThumbRules.mjs";

const RASTER_RE = /\.(png|jpe?g|gif|webp)$/i;
const MAX_RASTER_PIXELS = 100e6;
const MAX_SVG_BYTES = 64 * 1024 * 1024;
const HEAD_BYTES = 64 * 1024;
/** A render taller than this many bucket widths is fitted to height instead. */
const MAX_TALL = 2;

const sha1 = (s) => createHash("sha1").update(s).digest("hex");

async function readHead(file, n = HEAD_BYTES) {
  const fh = await fsp.open(file, "r");
  try {
    const b = Buffer.alloc(n);
    const { bytesRead } = await fh.read(b, 0, n, 0);
    return b.subarray(0, bytesRead);
  } finally { await fh.close(); }
}

async function writeAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

/** The cache files for one (file version, bucket). */
export function thumbCacheFiles(cacheDir, abs, size, mtimeMs, bucket) {
  const key = sha1(`${abs}\0${size}\0${mtimeMs}\0${bucket}\0${PLOT_THUMB_GEN}`);
  const png = path.join(cacheDir, key.slice(0, 2), `${key}.png`);
  return { key, png, meta: png.replace(/\.png$/, ".json") };
}

async function refsFreshOf(meta) {
  for (const ref of meta.refs ?? []) {
    try { const st = await fsp.stat(ref.path); if (st.size !== ref.size || st.mtimeMs !== ref.mtimeMs) return false; }
    catch { return false; }
  }
  return true;
}

/** A cached thumbnail, without rendering (null on a miss). The Electron main process serves
 *  warm tiles through this directly — no worker round trip, no raster work in main. */
export async function cachedThumb(cacheDir, abs, bucket, st = null) {
  try {
    st ??= await fsp.stat(abs);
    const files = thumbCacheFiles(cacheDir, abs, st.size, st.mtimeMs, bucket);
    const meta = JSON.parse(await fsp.readFile(files.meta, "utf8"));
    if (!meta?.stats || !(await refsFreshOf(meta))) return null;
    await fsp.access(files.png);
    // Last-used, at most once a day (never atime — relatime/noatime mounts lie).
    if (Date.now() - (meta.used ?? 0) > 864e5) { meta.used = Date.now(); void writeAtomic(files.meta, JSON.stringify(meta)).catch(() => {}); }
    return { path: files.png, width: meta.width, height: meta.height, stats: meta.stats, paper: meta.paper ?? null, naturalWidth: meta.naturalWidth, naturalHeight: meta.naturalHeight };
  } catch { return null; }
}

/** Every font request (family stack × weight × style) an SVG makes, de-duplicated. */
export function svgFontRequests(svgText) {
  const stacks = new Set();
  const re = /font-family\s*(?::\s*([^;}"<>]+)|=\s*(?:"([^"]*)"|'([^']*)'))/gi;
  for (let m; (m = re.exec(svgText)); ) {
    const v = (m[1] ?? m[2] ?? m[3] ?? "").replace(/&quot;|&#34;|&apos;|&#39;/g, "'").trim();
    if (v) stacks.add(v);
  }
  // CSS shorthand `font: [style] [weight] size[/lh] family-stack` (matplotlib's older output).
  for (const m of svgText.matchAll(/[;"'{\s]font\s*:\s*([^;}"<>]+)/gi)) {
    const f = /(?:\d*\.?\d+(?:px|pt|em|%)?(?:\/\S+)?)\s+(.+)$/.exec(m[1].trim());
    if (f) stacks.add(f[1].replace(/&quot;|&#34;|&apos;|&#39;/g, "'").trim());
  }
  if (!stacks.size) stacks.add("sans-serif");
  const bold = /font-weight\s*[:=]\s*["']?\s*(bold|[6-9]00)/i.test(svgText) || /font\s*:\s*[^;}"]*\bbold\b/i.test(svgText);
  const italic = /font-style\s*[:=]\s*["']?\s*(italic|oblique)/i.test(svgText) || /font\s*:\s*[^;}"]*\b(italic|oblique)\b/i.test(svgText);
  const out = [];
  for (const family of stacks)
    for (const weight of bold ? [400, 700] : [400])
      for (const style of italic ? ["normal", "italic"] : ["normal"]) out.push({ family, weight, style });
  return out;
}

/**
 * @param {object} o
 * @param {string} o.cacheDir           machine-local cache root (lowercase app dir, fluxPaths)
 * @param {string} o.resvgFrom          a file URL/path createRequire resolves @resvg/resvg-js from
 * @param {(req:{family:string,weight:number,style:string}) => Promise<{file:string|null,family:string}|null>} [o.resolveFont]
 * @param {number} [o.maxCacheBytes]
 */
export function createThumbEngine(o) {
  const require = createRequire(o.resvgFrom);
  let Resvg = null;
  const resvg = () => (Resvg ??= require("@resvg/resvg-js").Resvg);
  const fontMemo = new Map(); // request key → Promise<{file, family} | null>
  const indexes = new Map(); // root → { file, data, dirty }
  const maxCacheBytes = o.maxCacheBytes ?? 512 * 1024 * 1024;

  async function fontsFor(svgText) {
    const files = new Set();
    let defaultFamily = "";
    if (!o.resolveFont) return { files: [], defaultFamily };
    for (const req of svgFontRequests(svgText)) {
      const key = `${req.family}\0${req.weight}\0${req.style}`;
      if (!fontMemo.has(key)) fontMemo.set(key, o.resolveFont(req).catch(() => null));
      const hit = await fontMemo.get(key);
      if (hit?.file) { files.add(hit.file); if (!defaultFamily && req.weight === 400 && req.style === "normal") defaultFamily = hit.family; }
    }
    // Generic fallback for anything the stacks do not name.
    const genericKey = "sans-serif\0" + "400\0normal";
    if (!fontMemo.has(genericKey)) fontMemo.set(genericKey, o.resolveFont({ family: "sans-serif", weight: 400, style: "normal" }).catch(() => null));
    const generic = await fontMemo.get(genericKey);
    if (generic?.file) files.add(generic.file);
    return { files: [...files], defaultFamily: defaultFamily || generic?.family || "", sans: generic?.family || "" };
  }

  // ------------------------------------------------------------------ per-root index
  async function rootIndex(root) {
    let ix = indexes.get(root);
    if (!ix) {
      ix = { file: path.join(o.cacheDir, `index-${sha1(root)}.json`), data: {}, dirty: false, timer: null };
      try {
        const parsed = JSON.parse(await fsp.readFile(ix.file, "utf8"));
        if (parsed && parsed.gen === PLOT_THUMB_GEN && parsed.entries && typeof parsed.entries === "object") ix.data = parsed.entries;
      } catch { /* a fresh index */ }
      indexes.set(root, ix);
    }
    return ix;
  }
  function touchIndex(ix) {
    ix.dirty = true;
    if (ix.timer) return;
    ix.timer = setTimeout(() => { ix.timer = null; void flushIndex(ix); }, 400);
  }
  async function flushIndex(ix) {
    if (!ix.dirty) return;
    ix.dirty = false;
    try { await writeAtomic(ix.file, JSON.stringify({ gen: PLOT_THUMB_GEN, entries: ix.data })); } catch { ix.dirty = true; }
  }
  async function flushAll() {
    for (const ix of indexes.values()) { if (ix.timer) { clearTimeout(ix.timer); ix.timer = null; } await flushIndex(ix); }
  }
  /** The index entry for `abs` (under `root`) if its stamp still matches. */
  function fresh(entry, st) { return entry && entry.size === st.size && entry.mtimeMs === st.mtimeMs ? entry : null; }

  // ------------------------------------------------------------------ list
  /**
   * Walk `base` (a project's plots/ or the global library). `skipDir(name)` prunes reserved
   * folders; `accept(name)` picks files. Returns rel paths under `base` with stamps and
   * whatever the index already knows (size, analysis, manifest paper).
   */
  async function list(base, { skipDir = () => false, accept = (n) => /\.(svg|png)$/i.test(n), maxFiles = 20000, maxDepth = 20, indexRoot = base, dirs = null } = {}) {
    const ix = await rootIndex(indexRoot);
    const out = [];
    const missing = [];
    let truncated = false;
    const visit = async (dir, rel, depth, recurse = true) => {
      if (depth > maxDepth || out.length >= maxFiles) { truncated = true; return; }
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { missing.push(dir); return; }
      const names = new Set(entries.map((e) => e.name));
      const files = [];
      for (const e of entries) {
        if (e.isDirectory()) continue;
        if (e.isFile() && accept(e.name)) files.push(e.name);
      }
      const stats = await Promise.all(files.map((n) => fsp.stat(path.join(dir, n)).catch(() => null)));
      files.forEach((name, i) => {
        const st = stats[i];
        if (!st || out.length >= maxFiles) { if (st) truncated = true; return; }
        const r = rel ? `${rel}/${name}` : name;
        const abs = path.join(dir, name);
        const hit = fresh(ix.data[abs], st);
        const lower = name.toLowerCase();
        out.push({
          rel: r,
          abs,
          size: st.size,
          mtimeMs: st.mtimeMs,
          semantic: /\.(svg|glb)$/.test(lower) && names.has(name.replace(/\.(svg|glb)$/i, ".fluxplot.json")),
          snip: lower.endsWith(".png") && names.has(name.replace(/\.png$/i, ".snip.json")),
          ...(hit?.w ? { w: hit.w, h: hit.h, physMm: hit.physMm ?? null } : {}),
          ...(hit?.stats ? { stats: hit.stats } : {}),
          ...(hit?.paper ? { paper: hit.paper } : {}),
          ...(hit?.bad ? { bad: hit.bad } : {}),
        });
      });
      if (!recurse) return;
      for (const e of entries.filter((d) => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
        if (skipDir(e.name, rel)) continue;
        await visit(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1);
        if (out.length >= maxFiles) { truncated = true; return; }
      }
    };
    if (Array.isArray(dirs)) {
      // Incremental: just these folders' own files (a watcher batch named them). A folder that
      // is gone comes back in `missing` — its entries are the caller's to drop.
      for (const dir of dirs) {
        if (dir !== base && !dir.startsWith(base + path.sep)) continue;
        const rel = path.relative(base, dir).split(path.sep).join("/");
        if (rel.split("/").some((seg) => skipDir(seg))) continue;
        await visit(dir, rel, 0, false);
      }
      return { entries: out, truncated, missing };
    }
    await visit(base, "", 0);
    return { entries: out, truncated, missing };
  }

  // ------------------------------------------------------------------ probe
  async function probeOne(abs, indexRoot) {
    const ix = indexRoot ? await rootIndex(indexRoot) : null;
    let st;
    try { st = await fsp.stat(abs); } catch { return { abs, error: "missing" }; }
    const hit = ix && fresh(ix.data[abs], st);
    const stamp = { size: st.size, mtimeMs: st.mtimeMs };
    if (hit?.w) return { abs, w: hit.w, h: hit.h, physMm: hit.physMm ?? null, ...stamp };
    let size = null;
    try {
      const lower = abs.toLowerCase();
      // SVG: the root tag sits in the first bytes. PNG: pHYs may follow big iCCP/tEXt chunks.
      size = probeImageSize(abs, await readHead(abs, lower.endsWith(".svg") ? 16 * 1024 : HEAD_BYTES));
    } catch { /* unreadable → no size */ }
    if (!size) return { abs, error: "unknown", ...stamp };
    if (ix) {
      const prev = fresh(ix.data[abs], st) ?? { size: st.size, mtimeMs: st.mtimeMs };
      ix.data[abs] = { ...prev, w: size.width, h: size.height, physMm: size.physMm };
      touchIndex(ix);
    }
    return { abs, w: size.width, h: size.height, physMm: size.physMm, ...stamp };
  }
  async function probe(paths, indexRoot) {
    const out = [];
    // Bounded parallelism: header reads are cheap but a 20k list must not flood the fd table.
    for (let i = 0; i < paths.length; i += 32) out.push(...await Promise.all(paths.slice(i, i + 32).map((p) => probeOne(p, indexRoot))));
    return out;
  }

  // ------------------------------------------------------------------ render
  /** The SVG text to render for `abs` (rasters are wrapped in a one-<image> document). */
  async function sourceFor(abs, st) {
    if (RASTER_RE.test(abs)) {
      // resvg-js 2.6 decodes PNG / JPEG / GIF but not WebP; a WebP tile takes the renderer's
      // fallback path (thumbClient), which Chromium decodes.
      if (/\.webp$/i.test(abs)) throw Object.assign(new Error("unsupported image format"), { unsupported: true });
      if (st.size > MAX_SVG_BYTES) throw Object.assign(new Error("image too large to preview"), { tooLarge: true });
      const bytes = await fsp.readFile(abs);
      const lower = abs.toLowerCase();
      // Pixel size (not the DPI-scaled placed size) — a raster renders 1:1 into its own box.
      const px = lower.endsWith(".png")
        ? (bytes.length >= 24 ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : null)
        : probeImageSize(abs, bytes);
      if (!px || !px.width || !px.height) throw new Error("unreadable image");
      if (px.width * px.height > MAX_RASTER_PIXELS) throw Object.assign(new Error("image too large to preview"), { tooLarge: true });
      const mime = lower.endsWith(".png") ? "image/png" : lower.endsWith(".gif") ? "image/gif" : "image/jpeg";
      // A data URI: resvg-js only offers imagesToResolve() for remote hrefs.
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${px.width}" height="${px.height}" viewBox="0 0 ${px.width} ${px.height}"><image width="${px.width}" height="${px.height}" href="data:${mime};base64,${bytes.toString("base64")}"/></svg>`;
      return { svg, raster: true, naturalWidth: px.width, naturalHeight: px.height, refs: [] };
    }
    if (st.size > MAX_SVG_BYTES) throw Object.assign(new Error("plot too large to preview"), { tooLarge: true });
    const svg = await fsp.readFile(abs, "utf8");
    const size = probeImageSize(abs, svg.slice(0, 16 * 1024));
    return { svg, raster: false, naturalWidth: size?.width ?? 0, naturalHeight: size?.height ?? 0, refs: [] };
  }

  /** Resolve external <image> hrefs (relative to the file, contained to `roots`). */
  async function resolveImages(r, abs, roots, refs) {
    let hrefs = [];
    try { hrefs = r.imagesToResolve(); } catch { return; }
    for (const href of hrefs) {
      if (/^data:/i.test(href)) continue;
      let target = href.replace(/^file:\/\//i, "");
      try { target = decodeURIComponent(target); } catch { /* keep */ }
      target = path.resolve(path.dirname(abs), target);
      if (!roots.some((root) => target === root || target.startsWith(root + path.sep))) continue;
      try {
        const [bytes, st] = await Promise.all([fsp.readFile(target), fsp.stat(target)]);
        r.resolveImage(href, bytes);
        refs.push({ path: target, size: st.size, mtimeMs: st.mtimeMs });
      } catch { /* a missing reference renders empty, as in a browser */ }
    }
  }

  async function renderPng(src, abs, width, fonts, roots) {
    const R = resvg();
    const tallFit = src.naturalWidth && src.naturalHeight && src.naturalHeight / src.naturalWidth > MAX_TALL;
    const nativeW = src.raster ? src.naturalWidth : 0;
    const fit = tallFit
      ? { mode: "height", value: Math.round(width * MAX_TALL) }
      : { mode: "width", value: nativeW ? Math.min(width, nativeW) : width };
    const r = new R(src.svg, {
      fitTo: fit,
      font: { loadSystemFonts: false, fontFiles: fonts.files, defaultFontFamily: fonts.defaultFamily || undefined, sansSerifFamily: fonts.sans || undefined },
      logLevel: "off",
    });
    if (!src.raster) await resolveImages(r, abs, roots, src.refs);
    return r.render();
  }

  async function manifestPaper(abs) {
    if (!/\.svg$/i.test(abs)) return null;
    try {
      const st = await fsp.stat(abs.replace(/\.svg$/i, ".fluxplot.json"));
      if (st.size > 4 * 1024 * 1024) return null;
      const m = JSON.parse(await fsp.readFile(abs.replace(/\.svg$/i, ".fluxplot.json"), "utf8"));
      const t = m?.style?.tokens;
      const paper = t?.paper ?? t?.plot;
      return typeof paper === "string" && /^#[0-9a-f]{3,8}$/i.test(paper.trim()) ? paper.trim() : null;
    } catch { return null; }
  }

  /**
   * A thumbnail of `abs` at `bucket` px wide. Returns { path, width, height, stats, paper,
   * naturalWidth, naturalHeight } — or { error, quarantined?, tooLarge? }.
   * `roots` contains external <image> resolution; `indexRoot` names the per-root index.
   */
  async function thumb(abs, bucket, { roots = [], indexRoot = null } = {}) {
    if (!THUMB_BUCKETS.includes(bucket)) bucket = THUMB_BUCKETS[1];
    let st;
    try { st = await fsp.stat(abs); } catch { return { error: "missing" }; }
    const ix = indexRoot ? await rootIndex(indexRoot) : null;
    const entry = ix ? fresh(ix.data[abs], st) : null;
    if (entry?.bad) return { error: entry.bad, quarantined: true };
    const hit = await cachedThumb(o.cacheDir, abs, bucket, st);
    if (hit) return hit;
    const { png, meta: metaFile } = thumbCacheFiles(o.cacheDir, abs, st.size, st.mtimeMs, bucket);
    let src;
    try { src = await sourceFor(abs, st); }
    catch (e) { return { error: String(e?.message ?? e), tooLarge: !!e?.tooLarge, unsupported: !!e?.unsupported }; }
    const fonts = src.raster ? { files: [], defaultFamily: "" } : await fontsFor(src.svg);
    const rendered = await renderPng(src, abs, bucket, fonts, roots);
    // The analysis always reads an ANALYSIS_WIDTH render, so a file's backdrop does not depend on
    // the bucket asked for first.
    let stats = entry?.stats ?? null;
    if (!stats) {
      const a = bucket === ANALYSIS_WIDTH ? rendered : await renderPng(src, abs, ANALYSIS_WIDTH, fonts, roots);
      stats = analyzeInk(a.pixels, a.width, a.height, { premultiplied: true });
    }
    const paper = await manifestPaper(abs);
    const meta = { width: rendered.width, height: rendered.height, stats, paper, naturalWidth: src.naturalWidth, naturalHeight: src.naturalHeight, refs: src.refs, used: Date.now() };
    await writeAtomic(png, rendered.asPng());
    await writeAtomic(metaFile, JSON.stringify(meta));
    if (ix) {
      const prev = fresh(ix.data[abs], st) ?? { size: st.size, mtimeMs: st.mtimeMs };
      // Placed size (w/h) belongs to probe(): a PNG's render size is its pixels, its placed size
      // honours pHYs. The index only learns the analysis here.
      ix.data[abs] = { ...prev, stats, ...(paper ? { paper } : {}) };
      touchIndex(ix);
    }
    return { path: png, width: meta.width, height: meta.height, stats, paper, naturalWidth: src.naturalWidth, naturalHeight: src.naturalHeight };
  }

  /** Record a crash/timeout so the file is skipped until it changes. */
  async function quarantine(abs, indexRoot, reason) {
    if (!indexRoot) return;
    let st;
    try { st = await fsp.stat(abs); } catch { return; }
    const ix = await rootIndex(indexRoot);
    const prev = fresh(ix.data[abs], st) ?? { size: st.size, mtimeMs: st.mtimeMs };
    ix.data[abs] = { ...prev, bad: String(reason || "preview failed") };
    touchIndex(ix);
    await flushIndex(ix);
  }

  /** Delete least-recently-used thumbnails until the cache fits. */
  async function sweep() {
    const items = [];
    let total = 0;
    let dirs = [];
    try { dirs = await fsp.readdir(o.cacheDir, { withFileTypes: true }); } catch { return { removed: 0, total: 0 }; }
    for (const d of dirs) {
      if (!d.isDirectory() || !/^[0-9a-f]{2}$/.test(d.name)) continue;
      const dir = path.join(o.cacheDir, d.name);
      let files = [];
      try { files = await fsp.readdir(dir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith(".png")) {
          // Orphaned temp files from an interrupted write.
          if (f.endsWith(".tmp")) await fsp.rm(path.join(dir, f), { force: true }).catch(() => {});
          continue;
        }
        const p = path.join(dir, f);
        try {
          const st = await fsp.stat(p);
          let used = st.mtimeMs;
          try { used = JSON.parse(await fsp.readFile(p.replace(/\.png$/, ".json"), "utf8")).used ?? used; } catch { /* keep mtime */ }
          items.push({ p, bytes: st.size, used });
          total += st.size;
        } catch { /* vanished */ }
      }
    }
    let removed = 0;
    if (total > maxCacheBytes) {
      items.sort((a, b) => a.used - b.used);
      for (const it of items) {
        if (total <= maxCacheBytes * 0.8) break;
        await fsp.rm(it.p, { force: true }).catch(() => {});
        await fsp.rm(it.p.replace(/\.png$/, ".json"), { force: true }).catch(() => {});
        total -= it.bytes; removed++;
      }
    }
    return { removed, total };
  }

  return { list, probe, thumb, quarantine, sweep, flushAll, svgFontRequests };
}
