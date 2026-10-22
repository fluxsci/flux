// Plot thumbnail rules: the contract between the thumbnail worker (electron/plotThumbWorker.mjs,
// a Node child with no asar support), the Electron main process, and the renderer's Plots rail.
// ONE definition of
//   * how big an image is before anything renders it (SVG root attributes, PNG IHDR + pHYs,
//     JPEG SOF, GIF/WebP headers) — the rail lays tiles out from this, and the drag ghost sizes
//     itself from it, so it must agree with what the import pipeline actually places
//     (io.ts: Chromium's naturalWidth for SVG, pHYs-scaled pixels for PNG);
//   * what the ink of a rendered image looks like where it meets a backdrop (analyzeInk);
//   * which backdrop shows every element of a transparent plot (chooseBackdrop — the law).
// Dependency-free ESM with an .mjs extension: the worker runs from app.asar.unpacked where no
// package.json says "type": "module". The renderer imports it through src/lib/plotsRail/rules.ts.

/** Raster widths the cache keeps. A tile asks for the smallest bucket ≥ its CSS width × DPR. */
export const THUMB_BUCKETS = [256, 512, 1024];
/** Bump to invalidate every cached thumbnail (render or analysis change). */
export const PLOT_THUMB_GEN = 8;
/** The analysis always runs on a render this wide, so a file's backdrop never depends on which
 *  bucket happened to be asked for first. */
export const ANALYSIS_WIDTH = 512;

/** The bucket for a tile `cssWidth` px wide on a `dpr` display. */
export function bucketFor(cssWidth, dpr = 1) {
  const want = Math.max(1, cssWidth) * Math.max(1, dpr || 1);
  for (const b of THUMB_BUCKETS) if (b >= want) return b;
  return THUMB_BUCKETS[THUMB_BUCKETS.length - 1];
}

// ---------------------------------------------------------------------------------------------
// Intrinsic size — before any pixels exist.
// ---------------------------------------------------------------------------------------------

const UNIT_PX = { px: 1, pt: 96 / 72, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6 };

/** An SVG length attribute in CSS px; null for percentages, relative or unparseable values. */
export function svgLengthPx(value) {
  if (value == null) return null;
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-z%]*)\s*$/i.exec(String(value));
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (!Number.isFinite(n) || n <= 0) return null;
  if (unit === "") return n;
  if (unit === "em") return n * 16;
  if (unit === "ex") return n * 8;
  const k = UNIT_PX[unit];
  return k ? n * k : null;
}

function attrOf(tag, name) {
  const m = new RegExp(`(?:^|[\\s"'])${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? (m[2] ?? m[3] ?? "") : null;
}

/** The root <svg ...> start tag in the first bytes of a document (prolog, doctype and comments
 *  skipped), or null. */
export function svgRootTag(text) {
  let s = String(text ?? "");
  for (let guard = 0; guard < 64; guard++) {
    const lt = s.indexOf("<");
    if (lt < 0) return null;
    s = s.slice(lt);
    if (s.startsWith("<?")) { const e = s.indexOf("?>"); if (e < 0) return null; s = s.slice(e + 2); continue; }
    if (s.startsWith("<!--")) { const e = s.indexOf("-->"); if (e < 0) return null; s = s.slice(e + 3); continue; }
    if (s.startsWith("<!")) {
      // DOCTYPE, possibly with an internal subset [...].
      const bracket = s.indexOf("["), close = s.indexOf(">");
      if (bracket >= 0 && bracket < close) { const e = s.indexOf("]>"); if (e < 0) return null; s = s.slice(e + 2); }
      else { if (close < 0) return null; s = s.slice(close + 1); }
      continue;
    }
    const m = /^<((?:[A-Za-z_][\w.-]*:)?svg)\b([^>]*)>/.exec(s);
    return m ? m[2] : null;
  }
  return null;
}

/**
 * The size Chromium gives an SVG document loaded as an image (`naturalWidth/Height`), in CSS
 * px, from the root element's width / height / viewBox — or null when the head is not an SVG.
 * Chromium's rules (pinned against intrinsicSize() by verify-plot-thumbs-electron):
 *   both lengths absolute            → those;
 *   one absolute + a viewBox         → the other from the viewBox aspect;
 *   neither (or %) + a viewBox       → width 300, height from the aspect… (see P0 parity notes);
 *   nothing usable                   → 300 × 150.
 */
export function svgIntrinsicSize(headText) {
  const tag = svgRootTag(headText);
  if (tag == null) return null;
  const w = svgLengthPx(attrOf(tag, "width"));
  const h = svgLengthPx(attrOf(tag, "height"));
  const vbRaw = attrOf(tag, "viewBox");
  let aspect = null;
  if (vbRaw) {
    const v = vbRaw.trim().split(/[\s,]+/).map(Number);
    if (v.length === 4 && v.every(Number.isFinite) && v[2] > 0 && v[3] > 0) aspect = v[2] / v[3];
  }
  if (w && h) return { width: w, height: h };
  if (w && aspect) return { width: w, height: w / aspect };
  if (h && aspect) return { width: h * aspect, height: h };
  if (aspect) return { width: 300, height: 300 / aspect };
  return { width: w ?? 300, height: h ?? 150 };
}

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const u32be = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const u16be = (b, o) => (b[o] << 8) | b[o + 1];
const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u24le = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);

/** PNG pixel size + declared DPI (pHYs, metre unit only — the same reading as
 *  src/lib/figure/pngDpi.ts readPngDpi). */
export function pngInfo(bytes) {
  if (!bytes || bytes.length < 24) return null;
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIG[i]) return null;
  const width = u32be(bytes, 16), height = u32be(bytes, 20);
  if (!width || !height) return null;
  let dpi = null;
  let p = 8;
  while (p + 12 <= bytes.length) {
    const len = u32be(bytes, p);
    const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
    if (type === "pHYs" && len === 9 && p + 17 <= bytes.length) {
      if (bytes[p + 16] === 1) { const ppm = u32be(bytes, p + 8); if (ppm) dpi = ppm * 0.0254; }
      break;
    }
    if (type === "IDAT" || type === "IEND") break;
    p += 12 + len;
  }
  return { width, height, dpi };
}

function jpegSize(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let p = 2;
  while (p + 9 < b.length) {
    if (b[p] !== 0xff) { p++; continue; }
    const marker = b[p + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
    const len = u16be(b, p + 2);
    // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return { width: u16be(b, p + 7), height: u16be(b, p + 5) };
    p += 2 + len;
  }
  return null;
}

function gifSize(b) {
  if (b.length < 10 || String.fromCharCode(b[0], b[1], b[2]) !== "GIF") return null;
  return { width: u16le(b, 6), height: u16le(b, 8) };
}

function webpSize(b) {
  if (b.length < 30 || String.fromCharCode(b[0], b[1], b[2], b[3]) !== "RIFF" || String.fromCharCode(b[8], b[9], b[10], b[11]) !== "WEBP") return null;
  const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
  if (chunk === "VP8X") return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  if (chunk === "VP8L") {
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8 ") return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  return null;
}

/**
 * Probe an image's PLACED size (CSS px at 96/in — what io.ts gives the element) from its first
 * bytes. `name` picks the parser. Returns { width, height, physMm: [w, h] | null } or null.
 * physMm is null for rasters without a declared DPI (their placed size is only nominal).
 */
export function probeImageSize(name, bytes) {
  const lower = String(name).toLowerCase();
  const mm = (px) => (px * 25.4) / 96;
  if (lower.endsWith(".svg")) {
    const text = typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes);
    const s = svgIntrinsicSize(text);
    return s ? { ...s, physMm: [mm(s.width), mm(s.height)] } : null;
  }
  if (typeof bytes === "string") return null;
  if (lower.endsWith(".png")) {
    const p = pngInfo(bytes);
    if (!p) return null;
    const k = p.dpi && p.dpi > 0 ? 96 / p.dpi : 1;
    return { width: p.width * k, height: p.height * k, physMm: p.dpi ? [mm(p.width * k), mm(p.height * k)] : null };
  }
  const s = /\.jpe?g$/.test(lower) ? jpegSize(bytes) : lower.endsWith(".gif") ? gifSize(bytes) : lower.endsWith(".webp") ? webpSize(bytes) : null;
  return s && s.width > 0 && s.height > 0 ? { ...s, physMm: null } : null;
}

// ---------------------------------------------------------------------------------------------
// Ink analysis — what of an image meets the backdrop it sits on.
// ---------------------------------------------------------------------------------------------

/** How far (px, at ANALYSIS_WIDTH) a rim may reach from the ink it outlines: matplotlib's
 *  marker rims run 0.5–2 pt, ≈ 1–5 px on a 512 px render of a 3–4 in figure. */
export const HUG_RADIUS = 5;
/** Luminance bins, uniform in CONTRAST space: t = log((L + .05) / .05) / log(21). */
export const INK_BINS = 32;
const LOG21 = Math.log(21);
const SRGB = new Float32Array(256);
for (let i = 0; i < 256; i++) { const s = i / 255; SRGB[i] = s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }

/** WCAG relative luminance of 8-bit sRGB. */
export function luminance8(r, g, b) { return 0.2126 * SRGB[r] + 0.7152 * SRGB[g] + 0.0722 * SRGB[b]; }
/** WCAG contrast ratio of two luminances. */
export function contrastRatio(la, lb) { const hi = Math.max(la, lb), lo = Math.min(la, lb); return (hi + 0.05) / (lo + 0.05); }
function binOf(L) { return Math.min(INK_BINS - 1, Math.max(0, Math.floor((Math.log((L + 0.05) / 0.05) / LOG21) * INK_BINS))); }
/** The luminance at a bin's centre. */
export function binLuminance(i) { return 0.05 * Math.exp(((i + 0.5) / INK_BINS) * LOG21) - 0.05; }

/**
 * Analyze RGBA pixels (straight, or `premultiplied` — resvg's RenderedImage.pixels are; Canvas
 * getImageData is straight. Colours are demultiplied first, or the antialiased fringe of white
 * text would count as mid-grey ink).
 *   opaqueBorder — fraction of the outer 2 px ring with alpha > .95 (≥ .9 → the image brings its
 *                  own background, so no backdrop can hide anything);
 *   bins         — per luminance bin, counts of EXPOSED THIN ink. Exposed: alpha ≥ .1 and either
 *                  translucent (alpha < .9, the backdrop shows through) or within 1 px of a
 *                  transparent pixel. The interior of an opaque axes panel or a filled bar never
 *                  meets the backdrop. Thin: the pixel belongs to a stroke — text, a line, a
 *                  marker — rather than to the outline of a solid REGION (no interior pixel of a
 *                  like-luminance solid area within 2 px). Losing a stroke loses content; a
 *                  region's outline is content only when it is much of the picture.
 *   edgeBins     — the same per-bin counts for region outlines (a white heatmap cell at the
 *                  border, a photo's white ground, a 3D render's silhouette).
 *   halo         — exposed ink that hugs strongly contrasting ink (≥ 3:1 within HUG_RADIUS): the
 *                  white rims matplotlib draws round markers, knockout outlines behind labels.
 *                  Designed to vanish into the plot's paper; never forces a backdrop.
 *   exposed      — exposed thin + region-outline pixels (halo excluded).
 */
export function analyzeInk(rgba, width, height, { premultiplied = false, classes = null } = {}) {
  const bins = new Array(INK_BINS).fill(0);
  const edgeBins = new Array(INK_BINS).fill(0);
  let exposed = 0, halo = 0;
  const w = width | 0, h = height | 0;
  if (!w || !h || rgba.length < w * h * 4) return { v: 3, opaqueBorder: 0, exposed: 0, halo: 0, bins, edgeBins };
  const A_INK = 26, A_CLEAR = 26, A_SOLID = 230, A_HUG = 77; // 0.1 / 0.1 / 0.9 / 0.3 of 255
  const n = w * h;
  const alpha = new Uint8Array(n);
  const lum = new Float32Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const a = rgba[i + 3];
    alpha[p] = a;
    if (a < A_INK) continue;
    if (premultiplied && a < 255) {
      const k = 255 / a;
      lum[p] = luminance8(Math.min(255, Math.round(rgba[i] * k)), Math.min(255, Math.round(rgba[i + 1] * k)), Math.min(255, Math.round(rgba[i + 2] * k)));
    } else lum[p] = luminance8(rgba[i], rgba[i + 1], rgba[i + 2]);
  }
  const solidAt = (x, y) => x >= 0 && y >= 0 && x < w && y < h && alpha[y * w + x] >= A_SOLID;
  // Interior: solid with a solid 8-neighbourhood (a region at least 3 px thick here).
  const interior = new Uint8Array(n);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++)
      if (solidAt(x, y) && solidAt(x - 1, y) && solidAt(x + 1, y) && solidAt(x, y - 1) && solidAt(x, y + 1)
        && solidAt(x - 1, y - 1) && solidAt(x + 1, y - 1) && solidAt(x - 1, y + 1) && solidAt(x + 1, y + 1)) interior[y * w + x] = 1;
  const clear = (x, y) => x < 0 || y < 0 || x >= w || y >= h || alpha[y * w + x] < A_CLEAR;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const a = alpha[p];
      if (a < A_INK) continue;
      let touches = a < A_SOLID;
      if (!touches)
        touches = clear(x - 1, y) || clear(x + 1, y) || clear(x, y - 1) || clear(x, y + 1)
          || clear(x - 1, y - 1) || clear(x + 1, y - 1) || clear(x - 1, y + 1) || clear(x + 1, y + 1);
      if (!touches) continue;
      const L = lum[p];
      let hugs = false, region = false;
      for (let dy = -HUG_RADIUS; dy <= HUG_RADIUS && !hugs; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -HUG_RADIUS; dx <= HUG_RADIUS; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (alpha[q] < A_HUG) continue;
          const c = contrastRatio(lum[q], L);
          // A rim hugs ink it contrasts with — a translucent marker face counts too.
          if (c >= 3) { hugs = true; break; }
          if (!region && interior[q] && c < 1.5 && dx >= -2 && dx <= 2 && dy >= -2 && dy <= 2) region = true;
        }
      }
      if (classes) classes[p] = hugs ? 3 : region ? 2 : 1;
      if (hugs) { halo++; continue; }
      exposed++;
      (region ? edgeBins : bins)[binOf(L)]++;
    }
  }
  let ring = 0, solid = 0;
  const band = Math.max(1, Math.min(2, Math.floor(Math.min(w, h) / 2)));
  for (let y = 0; y < h; y++) {
    const edgeRow = y < band || y >= h - band;
    for (let x = 0; x < w; x++) {
      if (!edgeRow && x >= band && x < w - band) { x = w - band - 1; continue; }
      ring++;
      if (alpha[y * w + x] > 242) solid++;
    }
  }
  return { v: 3, opaqueBorder: ring ? solid / ring : 0, exposed, halo, bins, edgeBins };
}

/** The share of exposed ink a region outline needs before it alone can decide a backdrop. */
export const EDGE_SHARE = 0.35;
/** Bins holding enough exposed ink to matter. Thin ink (strokes, text, markers): ≥ 0.2 % of the
 *  exposed ink (clamped to 12–20 px) — a short title counts, a 10-pixel speck does not. Region outlines: ≥ 35 % of the exposed ink —
 *  a white heatmap cell at the edge does not decide a backdrop, a render's silhouette does. */
export function presentBins(stats) {
  if (!stats || !stats.exposed) return [];
  const floor = Math.max(12, Math.min(20, stats.exposed * 0.002));
  const edgeFloor = Math.max(20, stats.exposed * EDGE_SHARE);
  const out = [];
  for (let i = 0; i < INK_BINS; i++) {
    if ((stats.bins[i] ?? 0) >= floor || (stats.edgeBins?.[i] ?? 0) >= edgeFloor) out.push(i);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The backdrop law.
// ---------------------------------------------------------------------------------------------

/** The candidate backdrops (Flexoki paper, the dark canvas tone, and a neutral mid grey whose
 *  luminance balances contrast against both white and black ink). */
export const BACKDROPS = Object.freeze({
  paper: "#fffcf0",
  dark: "#1c1b1a",
  mid: "#7b7974",
});
/** Below this contrast against its backdrop, ink is treated as LOST: white on paper is 1.03:1,
 *  black on the dark tone 1.16:1 — while Flexoki base-100 gridlines, deliberately subtle on
 *  paper, sit at 1.24:1. A backdrop that loses ink never gets a preference bonus. */
export const LOST_BELOW = 1.1;
/** Contrast beyond this is "plenty": scores are capped so a backdrop preference, not a raw
 *  ratio, decides between two backdrops that both show everything well. */
export const CONTRAST_CAP = 2.5;
/** Preference bonuses (added to the capped worst-case contrast). Paper is the house default; a
 *  fluxplot's declared paper is the author's intent. Tuned in P0 on real projects. */
export const BACKDROP_BIAS = Object.freeze({ manifest: 1.5, paper: 0.8, dark: 0.1, mid: 0 });
/** The share of a fluxplot's exposed ink that may be drawn in its own declared paper colour. */
export const KNOCKOUT_SHARE = 0.1;

function hexLuminance(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex ?? "").trim());
  if (!m) return null;
  let s = m[1];
  if (s.length === 3) s = [...s].map((c) => c + c).join("");
  return luminance8(parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16));
}

/** Worst contrast between a backdrop and any present ink (Infinity when nothing is present).
 *  `ignoreBelow`: skip ink below this contrast (the knockout ink a declared paper may swallow). */
export function backdropScore(stats, color, ignoreBelow = 0) {
  const L = hexLuminance(color);
  if (L == null) return -1;
  let worst = Infinity;
  for (const i of presentBins(stats)) {
    const c = contrastRatio(binLuminance(i), L);
    if (c >= ignoreBelow) worst = Math.min(worst, c);
  }
  return worst;
}

/** The share of exposed standalone ink a backdrop would lose (contrast < LOST_BELOW). */
export function lostShare(stats, color) {
  const L = hexLuminance(color);
  if (L == null || !stats?.exposed) return 0;
  // Region outlines count only where they are present (dominant) — the same rule as presence.
  const edgeFloor = Math.max(20, stats.exposed * EDGE_SHARE);
  let lost = 0;
  for (let i = 0; i < INK_BINS; i++) {
    const edge = stats.edgeBins?.[i] ?? 0;
    const count = (stats.bins[i] ?? 0) + (edge >= edgeFloor ? edge : 0);
    if (count && contrastRatio(binLuminance(i), L) < LOST_BELOW) lost += count;
  }
  return lost / stats.exposed;
}

/**
 * Choose the backdrop for a thumbnail.
 *   stats         — analyzeInk output (null → paper, the unknown case);
 *   manifestPaper — a fluxplot's declared paper/plot colour (style.tokens), the author's intent;
 *   mode          — "auto" (the law) | "paper" | "dark" | "checker" | "destination";
 *   destination   — the active figure's background, for mode "destination".
 * Returns { kind, color, reason }. kind "own" = the image is opaque at its edges: show it as is.
 * The result depends only on the file (its stats + manifest) and the mode — never on which
 * figure is active under "auto" — so a grid never changes colour because you clicked elsewhere.
 */
export function chooseBackdrop(stats, opts = {}) {
  const mode = opts.mode ?? "auto";
  if (mode === "paper") return { kind: "paper", color: BACKDROPS.paper, reason: "Paper (set in the view menu)" };
  if (mode === "dark") return { kind: "dark", color: BACKDROPS.dark, reason: "Dark (set in the view menu)" };
  if (mode === "checker") return { kind: "checker", color: null, reason: "Checkerboard (set in the view menu)" };
  if (mode === "destination") {
    const L = hexLuminance(opts.destination);
    return L == null
      ? { kind: "paper", color: BACKDROPS.paper, reason: "The figure has no solid background; showing paper" }
      : { kind: "destination", color: opts.destination, reason: "The active figure's background" };
  }
  if (!stats) return { kind: "paper", color: BACKDROPS.paper, reason: "Not analysed yet" };
  if (stats.opaqueBorder >= 0.9) return { kind: "own", color: null, reason: "The plot has its own background" };
  if (!presentBins(stats).length) return { kind: "paper", color: BACKDROPS.paper, reason: "No visible ink" };
  // A backdrop that loses no present ink scores min(worst-case contrast, CAP) + its preference
  // bonus: paper whenever it shows everything, the dark tone for light ink, grey when both
  // extremes are present. Only when EVERY backdrop loses something does the smallest lost share
  // decide (ties in candidate order: the author's paper, paper, dark, grey).
  const manifest = hexLuminance(opts.manifestPaper) != null ? opts.manifestPaper : null;
  const candidates = [
    ...(manifest ? [["manifest", manifest]] : []),
    ["paper", BACKDROPS.paper], ["dark", BACKDROPS.dark], ["mid", BACKDROPS.mid],
  ];
  let best = null;
  for (const [kind, color] of candidates) {
    let score = backdropScore(stats, color);
    // A fluxplot that declares its paper draws some ink IN that colour on purpose — white
    // separators between heatmap cells, knockouts behind labels, the dark end of a colormap on
    // dark paper. Up to KNOCKOUT_SHARE of its exposed ink may vanish into the declared paper;
    // the rest is then what the author's paper is judged on.
    const knockout = kind === "manifest" && score < LOST_BELOW && lostShare(stats, color) <= KNOCKOUT_SHARE;
    if (knockout) score = backdropScore(stats, color, LOST_BELOW);
    const lossless = score >= LOST_BELOW;
    const value = lossless ? Math.min(score, CONTRAST_CAP) + BACKDROP_BIAS[kind] : -lostShare(stats, color);
    const better = !best || (lossless && !best.lossless) || (lossless === best.lossless && value > best.value + 1e-9);
    if (better) best = { kind, color, value, lossless };
  }
  const reasons = {
    manifest: "The plot's own paper colour",
    paper: "Dark ink — paper backdrop",
    dark: "Light ink — dark backdrop",
    mid: "Light and dark ink — grey backdrop",
  };
  return { kind: best.kind, color: best.color, reason: reasons[best.kind] };
}

/** Ink below this contrast reads poorly (Peek's warning about the active figure). */
export const POOR_BELOW = 1.5;
/** Whether ink would read poorly on a figure background (Peek's warning). */
export function readsPoorlyOn(stats, background) {
  if (!stats || stats.opaqueBorder >= 0.9) return false;
  const L = hexLuminance(background);
  if (L == null) return false;
  return backdropScore(stats, background) < POOR_BELOW;
}

/** The tone a backdrop gives the cursor (cursorTone's 0.4 split). */
export function backdropTone(choice) {
  if (!choice || !choice.color) return choice?.kind === "checker" ? "dark" : "light";
  const L = hexLuminance(choice.color);
  return L != null && L >= 0.4 ? "light" : "dark";
}
