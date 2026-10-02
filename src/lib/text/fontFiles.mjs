// ---------------------------------------------------------------------------
// Flux — FONT FILE RESOLVER (oct2 W3 §3.2). Node-only ESM, the glbCore.mjs
// precedent: Electron main (the `fonts:lookup` IPC) and flux-core (the export
// glyph bake) load this ONE module, so both engines resolve a CSS family stack
// to the same file and the same bytes.
//
// Resolution mimics the browser: walk the CSS stack and take the first family
// the system actually has (a generic family takes whatever the system maps it
// to). Linux asks fontconfig (`fc-match`, which also names the face index of a
// collection); macOS/Windows scan the standard font folders once, reading only
// each file's `name`/`OS/2` tables, and cache that index as JSON in the machine
// config dir (`<configDir>/fonts-index.json`, keyed by path + mtime + size).
// A TrueType/OpenType collection face is extracted into a standalone sfnt so
// one parser handles it; WOFF2 (brotli + transformed tables) is reported as
// such and left to the caller's fallback.
// ---------------------------------------------------------------------------

import { execFile } from "node:child_process";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseFamilyStack, fontRequestKey } from "./fontRequest.mjs";

export { parseFamilyStack, fontRequestKey };

/** Families the APP itself serves through @font-face (src/styles/fonts.css): the
 *  browser stops at them whatever the system has, so resolution must too. Only
 *  variable WOFF2 is bundled, which the parser cannot read → the caller falls back. */
export const BUNDLED_FAMILIES = Object.freeze({ gelasio: "woff2" });
const GENERIC = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace"]);

/** CSS weight → fontconfig weight. */
function fcWeight(w) {
  const table = [[100, 0], [200, 40], [300, 50], [400, 80], [500, 100], [600, 180], [700, 200], [800, 205], [900, 210]];
  let best = table[3];
  for (const row of table) if (Math.abs(row[0] - w) < Math.abs(best[0] - w)) best = row;
  return best[1];
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 4000, maxBuffer: 1 << 20 }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

// --- sfnt reading (name + OS/2 only; no full parse) ----------------------------

const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const tag = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

/** The container format of font bytes. */
export function fontFormat(bytes) {
  if (!bytes || bytes.length < 12) return null;
  const t = tag(bytes, 0);
  if (t === "wOF2") return "woff2";
  if (t === "wOFF") return "woff";
  if (t === "ttcf") return "ttc";
  if (t === "OTTO") return "otf";
  if (u32(bytes, 0) === 0x00010000 || t === "true") return "ttf";
  return null;
}

/** Offsets of each face's table directory (one for a plain sfnt). */
function faceOffsets(bytes) {
  if (tag(bytes, 0) !== "ttcf") return [0];
  const n = u32(bytes, 8), out = [];
  for (let i = 0; i < n; i++) out.push(u32(bytes, 12 + 4 * i));
  return out;
}

function tables(bytes, at) {
  const n = u16(bytes, at + 4), out = {};
  for (let i = 0; i < n; i++) {
    const r = at + 12 + 16 * i;
    out[tag(bytes, r)] = { offset: u32(bytes, r + 8), length: u32(bytes, r + 12), checksum: u32(bytes, r + 4) };
  }
  return out;
}

function decodeName(bytes, platform, encoding) {
  // Unicode platform or Windows Unicode BMP/full: UTF-16BE. Mac Roman: latin-ish.
  if (platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10))) {
    let s = "";
    for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode(u16(bytes, i));
    return s;
  }
  if (platform === 1 && encoding === 0) return String.fromCharCode(...bytes);
  return null;
}

/** Family/subfamily/weight/italic of every face in sfnt or collection bytes.
 *  Pure over the bytes it is given (`read` lets the index scan avoid loading
 *  whole files: it may return just the header and the two tables). */
export function readFontFaces(bytes) {
  const fmt = fontFormat(bytes);
  if (fmt !== "ttf" && fmt !== "otf" && fmt !== "ttc") return [];
  const faces = [];
  faceOffsets(bytes).forEach((at, index) => {
    try {
      const t = tables(bytes, at);
      const names = {};
      if (t.name) {
        const base = t.name.offset, count = u16(bytes, base + 2), strings = base + u16(bytes, base + 4);
        for (let i = 0; i < count; i++) {
          const r = base + 6 + 12 * i;
          const platform = u16(bytes, r), encoding = u16(bytes, r + 2), language = u16(bytes, r + 4), id = u16(bytes, r + 6);
          if (![1, 2, 16, 17].includes(id)) continue;
          const len = u16(bytes, r + 8), off = u16(bytes, r + 10);
          const value = decodeName(bytes.subarray(strings + off, strings + off + len), platform, encoding);
          if (!value) continue;
          // Prefer English (Windows 0x409 / Mac 0) names; keep the first otherwise.
          const english = (platform === 3 && language === 0x409) || (platform === 1 && language === 0) || platform === 0;
          if (!names[id] || english && !names[`${id}en`]) { names[id] = value; if (english) names[`${id}en`] = true; }
        }
      }
      let weight = 400, italic = false;
      if (t["OS/2"]) { weight = u16(bytes, t["OS/2"].offset + 4) || 400; italic = !!(u16(bytes, t["OS/2"].offset + 62) & 0x201); }
      const sub = String(names[17] ?? names[2] ?? "");
      if (/italic|oblique/i.test(sub)) italic = true;
      faces.push({ index, family: String(names[16] ?? names[1] ?? ""), legacyFamily: String(names[1] ?? ""), subfamily: sub, weight, italic });
    } catch { /* a damaged face is skipped */ }
  });
  return faces;
}

/** A standalone sfnt for face `index` of a collection (tables copied, the
 *  directory rewritten with fresh offsets). Plain sfnt bytes pass through. */
export function extractFace(bytes, index = 0) {
  if (fontFormat(bytes) !== "ttc") return bytes;
  const at = faceOffsets(bytes)[index];
  if (at === undefined) return null;
  const n = u16(bytes, at + 4);
  const entries = [];
  for (let i = 0; i < n; i++) {
    const r = at + 12 + 16 * i;
    entries.push({ tag: bytes.subarray(r, r + 4), checksum: u32(bytes, r + 4), offset: u32(bytes, r + 8), length: u32(bytes, r + 12) });
  }
  const header = 12 + 16 * n;
  let size = header;
  for (const e of entries) size += (e.length + 3) & ~3;
  const out = new Uint8Array(size);
  out.set(bytes.subarray(at, at + 12), 0); // sfnt version + numTables + search fields
  let cursor = header;
  const w32 = (o, v) => { out[o] = v >>> 24; out[o + 1] = (v >>> 16) & 255; out[o + 2] = (v >>> 8) & 255; out[o + 3] = v & 255; };
  entries.forEach((e, i) => {
    const r = 12 + 16 * i;
    out.set(e.tag, r); w32(r + 4, e.checksum); w32(r + 8, cursor); w32(r + 12, e.length);
    out.set(bytes.subarray(e.offset, e.offset + e.length), cursor);
    cursor += (e.length + 3) & ~3;
  });
  return out;
}

// --- the per-platform face index -------------------------------------------------

export function systemFontDirs(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === "darwin") return ["/System/Library/Fonts", "/System/Library/Fonts/Supplemental", "/Library/Fonts", path.join(home, "Library/Fonts")];
  if (platform === "win32") return [path.join(env.WINDIR ?? "C:\\Windows", "Fonts"), ...(env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, "Microsoft", "Windows", "Fonts")] : [])];
  return ["/usr/share/fonts", "/usr/local/share/fonts", path.join(home, ".fonts"), path.join(home, ".local/share/fonts")];
}

async function walk(dir, out, depth = 0) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth < 4) await walk(p, out, depth + 1);
    else if (e.isFile() && /\.(ttf|otf|ttc|otc)$/i.test(e.name)) out.push(p);
  }
}

/** Read just enough of a font file for readFontFaces: the directory, then each
 *  face's name and OS/2 tables, laid into a sparse buffer at their offsets. */
async function readHeaders(file) {
  const fh = await fsp.open(file, "r");
  try {
    const { size } = await fh.stat();
    if (size > 80 * 1024 * 1024) return new Uint8Array(0); // a giant CJK collection is skipped by the scan
    const at = async (offset, length) => { const b = Buffer.alloc(Math.max(0, Math.min(length, size - offset))); await fh.read(b, 0, b.length, offset); return b; };
    const head = await at(0, 12 + 16 * 64 + 4 * 64);
    const buf = new Uint8Array(size);
    buf.set(head, 0);
    for (const face of faceOffsets(buf)) {
      if (face + 12 > size) continue;
      const dir = await at(face, 12 + 16 * 256); buf.set(dir, face);
      const t = tables(buf, face);
      for (const name of ["name", "OS/2"]) if (t[name] && t[name].offset + t[name].length <= size) buf.set(await at(t[name].offset, t[name].length), t[name].offset);
    }
    return buf;
  } finally { await fh.close(); }
}

/** Load (and refresh) the cached face index for `dirs`. */
export async function fontIndex({ dirs = systemFontDirs(), cacheFile } = {}) {
  const files = [];
  for (const d of dirs) await walk(d, files);
  let cache = {};
  if (cacheFile) { try { cache = JSON.parse(await fsp.readFile(cacheFile, "utf8")); } catch { cache = {}; } }
  const next = {};
  let dirty = false;
  for (const file of files.sort()) {
    let st;
    try { st = await fsp.stat(file); } catch { continue; }
    const stamp = `${st.mtimeMs}:${st.size}`, hit = cache[file];
    if (hit && hit.stamp === stamp) { next[file] = hit; continue; }
    dirty = true;
    try { next[file] = { stamp, faces: readFontFaces(await readHeaders(file)) }; } catch { next[file] = { stamp, faces: [] }; }
  }
  if (Object.keys(cache).length !== Object.keys(next).length) dirty = true;
  if (cacheFile && dirty) {
    try { await fsp.mkdir(path.dirname(cacheFile), { recursive: true }); await fsp.writeFile(cacheFile, JSON.stringify(next)); } catch { /* cache is optional */ }
  }
  return next;
}

/** Best face for (family, weight, italic) in an index, or null. */
export function pickFace(index, family, weight, italic) {
  const want = family.toLowerCase();
  let best = null, score = Infinity;
  for (const [file, entry] of Object.entries(index)) for (const face of entry.faces) {
    if (face.family.toLowerCase() !== want && face.legacyFamily.toLowerCase() !== want) continue;
    const s = Math.abs(face.weight - weight) + (face.italic === italic ? 0 : 1000);
    if (s < score) { score = s; best = { file, index: face.index, family: face.family }; }
  }
  return best;
}

// --- resolution ---------------------------------------------------------------------

/** Resolve a CSS font request to a file: `{file, index, family}` or null.
 *  `opts.platform` / `opts.dirs` / `opts.cacheFile` / `opts.fcMatch` exist for
 *  gates (the scan path is exercised on Linux by passing dirs). */
export async function resolveFontFile(req, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const weight = Math.min(900, Math.max(100, Math.round((Number(req.weight) || 400) / 100) * 100));
  const italic = req.style === "italic" || req.style === "oblique";
  const families = parseFamilyStack(req.family);
  const useFc = opts.fcMatch !== false && platform !== "darwin" && platform !== "win32" && !opts.dirs;
  let index = null;
  for (const family of families) {
    if (BUNDLED_FAMILIES[family.toLowerCase()]) return { file: null, index: 0, family, bundled: BUNDLED_FAMILIES[family.toLowerCase()] };
    if (useFc) {
      const out = await run("fc-match", ["-f", "%{family}\n%{file}\n%{index}", `${family}:weight=${fcWeight(weight)}:slant=${italic ? 100 : 0}`]);
      if (!out) continue;
      const [fams = "", file = "", idx = "0"] = out.split("\n");
      const got = fams.split(",").map((f) => f.trim().toLowerCase());
      if (GENERIC.has(family.toLowerCase()) || got.includes(family.toLowerCase())) return file ? { file, index: Number(idx) || 0, family: fams.split(",")[0].trim() } : null;
      continue;
    }
    if (GENERIC.has(family.toLowerCase())) continue; // no portable generic mapping on a scan
    index ??= await fontIndex({ dirs: opts.dirs ?? systemFontDirs(platform), cacheFile: opts.cacheFile });
    const face = pickFace(index, family, weight, italic);
    if (face) return face;
  }
  return null;
}

/** The IPC/bake contract: `{key, bytes|null, format, file?}`. bytes are a
 *  standalone TTF/OTF/WOFF (a collection face is extracted); WOFF2 and
 *  unresolvable requests return null bytes so the caller falls back. */
export async function lookupFont(req, opts = {}) {
  const key = fontRequestKey(req);
  const hit = await resolveFontFile(req, opts);
  if (!hit) return { key, bytes: null, format: null };
  if (hit.bundled) return { key, bytes: null, format: hit.bundled, bundled: hit.family };
  let raw;
  try { raw = new Uint8Array(await fsp.readFile(hit.file)); } catch { return { key, bytes: null, format: null, file: hit.file }; }
  const format = fontFormat(raw);
  if (format === "woff2" || !format) return { key, bytes: null, format, file: hit.file };
  const bytes = format === "ttc" ? extractFace(raw, hit.index) : raw;
  return { key, bytes, format: format === "ttc" ? "ttf" : format, file: hit.file };
}
