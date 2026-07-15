"use strict";
// Pure helpers shared by the main-process modules. NO fs, NO Electron — this
// file must stay loadable by plain `node` so scripts/verify-pure.mjs can unit
// test it without a build step or a display.
const path = require("node:path");
const crypto = require("node:crypto");

// Supported image formats (case-insensitive). Everything else is ignored.
const IMG_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".bmp", ".svg"]);
const isImage = (name) => IMG_EXTS.has(path.extname(name).toLowerCase());

// Item key = basename without its extension ("item_007.png" -> "item_007", so
// a set that saved .jpg still aligns with a set that saved .png).
const keyOf = (name) => name.replace(/\.[^.]+$/, "");

// Natural sort: "img2" < "img10". Digit runs compare as numbers of arbitrary
// length (stripped-zeros length first, then lexicographic — no parseInt
// overflow), with a full-string tiebreak so zero-padding ties ("img007" vs
// "img7") order deterministically.
function naturalCompare(a, b) {
  const sa = String(a);
  const sb = String(b);
  const re = /(\d+|\D+)/g;
  const ax = sa.match(re) || [];
  const bx = sb.match(re) || [];
  const n = Math.min(ax.length, bx.length);
  for (let i = 0; i < n; i++) {
    const as = ax[i];
    const bs = bx[i];
    const an = as.charCodeAt(0) >= 48 && as.charCodeAt(0) <= 57;
    const bn = bs.charCodeAt(0) >= 48 && bs.charCodeAt(0) <= 57;
    if (an && bn) {
      const at = as.replace(/^0+(?=\d)/, "");
      const bt = bs.replace(/^0+(?=\d)/, "");
      if (at.length !== bt.length) return at.length < bt.length ? -1 : 1;
      if (at !== bt) return at < bt ? -1 : 1;
      // numerically equal (differing zero-padding) — fall through to next chunk
    } else {
      const d = as.localeCompare(bs);
      if (d) return d;
    }
  }
  if (ax.length !== bx.length) return ax.length - bx.length;
  return sa < sb ? -1 : sa > sb ? 1 : 0; // deterministic zero-padding tiebreak
}

// alignByKeys: given { setId: [filenames] }, build the natural-sorted union of
// item keys and, per set, an ItemCell array aligned to that key list (equal
// length and order across sets — cell (r,c) is the same item in every set).
// Duplicate keys within one set (a.png + a.jpg): first by natural sort wins.
function alignByKeys(setsFiles) {
  const keySet = new Set();
  const maps = new Map(); // setId -> Map(key -> filename)
  for (const [setId, files] of Object.entries(setsFiles)) {
    const m = new Map();
    for (const f of [...files].sort(naturalCompare)) {
      const k = keyOf(f);
      if (!m.has(k)) m.set(k, f);
      keySet.add(k);
    }
    maps.set(setId, m);
  }
  const keys = [...keySet].sort(naturalCompare);
  const bySet = {};
  for (const [setId, m] of maps) {
    bySet[setId] = keys.map((k) => {
      const f = m.get(k);
      return f ? { key: k, present: true, file: f } : { key: k, present: false, file: null };
    });
  }
  return { keys, bySet };
}

// Thumbnail size buckets: never thumbnail at the exact cell size (regenerates
// on every column drag) — round the requested px UP to a bucket.
const BUCKETS = [128, 192, 256, 384, 512, 768];
const bucketFor = (px) => BUCKETS.find((b) => b >= px) ?? BUCKETS[BUCKETS.length - 1];

// Cache key: path + mtime + size + bucket. An edited image re-thumbnails
// automatically; each size bucket caches independently.
const thumbKey = (absPath, mtimeMs, size, px) =>
  crypto.createHash("sha1").update(`${absPath}\0${mtimeMs}\0${size}\0${px}`).digest("hex");

// Formats we rasterize to webp thumbnails. svg scales freely in an <img> and
// gif must stay animated — both are served as originals.
const THUMBABLE = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".avif"]);
const wantsThumb = (p) => THUMBABLE.has(path.extname(p).toLowerCase());

// Explicit Content-Type for the ltfile:// handler — net.fetch on file URLs
// does not reliably set image MIME types, and SVG in an <img> renders nothing
// without image/svg+xml.
const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};
const mimeFor = (p) => MIME[path.extname(p).toLowerCase()] || "application/octet-stream";

module.exports = {
  IMG_EXTS,
  BUCKETS,
  isImage,
  keyOf,
  naturalCompare,
  alignByKeys,
  bucketFor,
  thumbKey,
  wantsThumb,
  mimeFor,
};
