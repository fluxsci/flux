// fluximg file-side rules: the ONE definition of what the Electron main process (fluximgFiles.cjs)
// and the in-memory dev bridge (src/lib/project/memBridge.ts) accept from a renderer when it imports,
// reads or discards a `.fluximg` bundle. Both engines validate with these functions and throw these
// messages, so the dev fixture refuses exactly what the desktop app refuses (twin-engine rule).
//
// Dependency-free ESM under electron/ for the same reason as dissectRules.js: the main process runs
// unbundled and cannot load from src/, and the renderer imports this file too (Vite serves a .cjs
// verbatim, so it would never run in a browser). Every string handed to these functions came from a
// renderer and is treated as hostile.

export const FLUXIMG_SPEC = "fluximg/1";
/** One ranged read. Pinned equal to `FLUXIMG_READ_LIMIT` in src/lib/fluximg/bridge.ts by verify-fluximg-files. */
export const FLUXIMG_READ_LIMIT = 32 * 1024 * 1024;
/** `fluximg.json` larger than this is not a manifest (SPEC §2 manifests are kilobytes). */
export const FLUXIMG_MANIFEST_MAX_BYTES = 8 * 1024 * 1024;
/** Files in one imported bundle. A bundle is a handful of shards per level plus layers; 20k is far past any real one. */
export const FLUXIMG_IMPORT_MAX_FILES = 20_000;
/** Directories in one imported bundle (Zarr chunk keys nest one directory per dimension). */
export const FLUXIMG_IMPORT_MAX_DIRS = 20_000;
/** Directory nesting below the bundle root (pixels/<level>/c/<i>/<j>/… is one level per dimension). */
export const FLUXIMG_IMPORT_MAX_DEPTH = 32;
/** Total bytes in one imported bundle: generous (a multi-hour two-photon movie is tens of GiB), but a bound. */
export const FLUXIMG_IMPORT_MAX_BYTES = 256 * 1024 ** 3;
/** Where placed bundles live, project-relative. */
export const FLUXIMG_ASSETS_REL = "fig/assets";
export const FLUXIMG_EXT = ".fluximg";

const SAFE_ID = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,180}$/;
// `CON.fluximg` is still the console device on Windows: refuse the reserved device names outright.
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i;

/** Plain-language messages, shared so both engines say the same thing. */
export const fluximgErrors = {
  assetId: (id) => `Invalid image asset id ${JSON.stringify(typeof id === "string" ? id.slice(0, 200) : String(id))}: use letters, digits, "-", "_" or "." (not first), at most 181 characters`,
  root: () => "Open a saved Flux project before adding an image",
  sourcePath: () => "Choose a .fluximg folder to import",
  sourceEscapes: () => "The image folder is outside the project: a relative source path must stay inside it",
  sourceSymlinkEscapes: () => "The image folder is a link that points outside the project",
  notDirectory: (p) => `${p} is not a folder: choose a .fluximg bundle folder`,
  notBundle: (p) => `${p} is not a fluximg bundle: it has no fluximg.json`,
  manifestTooLarge: () => `fluximg.json is larger than ${FLUXIMG_MANIFEST_MAX_BYTES / 1024 / 1024} MiB, so it is not a fluximg manifest`,
  manifestJson: (detail) => `fluximg.json is not valid JSON (${detail})`,
  manifestSpec: (spec) => `This bundle declares spec ${JSON.stringify(spec)}; this Flux reads only "${FLUXIMG_SPEC}". Update Flux, or re-export the image`,
  manifestShape: () => "fluximg.json must be a JSON object",
  destinationInsideSource: () => "The image folder contains this project's assets folder; choose the .fluximg bundle itself",
  exists: (id) => `An image asset named ${id} already exists in this project; import it under a new id`,
  symlink: (rel) => `The bundle contains a link (${rel}); links are not copied. Replace it with the real file or folder and import again`,
  special: (rel) => `The bundle contains ${rel}, which is neither a file nor a folder; remove it and import again`,
  nonPortableName: (rel) => `The bundle contains a name with a backslash (${rel}), which cannot be stored portably; rename it and import again`,
  tooManyFiles: (n) => `The bundle has more than ${n.toLocaleString("en-US")} files; re-export it with larger shards`,
  tooManyDirs: (n) => `The bundle has more than ${n.toLocaleString("en-US")} folders; re-export it with larger shards`,
  tooDeep: (n) => `The bundle nests folders more than ${n} deep, which no fluximg writer produces`,
  tooLarge: (bytes, limit) => `The bundle is ${formatBytes(bytes)}; images larger than ${formatBytes(limit)} cannot be imported`,
  changed: (rel) => `${rel} changed while it was being imported; import again once the bundle is finished`,
  noSpace: () => "Not enough disk space to copy the image into the project",
  projectChanged: () => "The project changed while working on the image",
  bundle: (bundle) => `Invalid image bundle path ${JSON.stringify(typeof bundle === "string" ? bundle.slice(0, 300) : String(bundle))}: expected fig/assets/<id>.fluximg or a .fluximg folder under plots/`,
  bundleEscapes: (bundle) => `The image bundle ${bundle} resolves outside fig/assets or plots`,
  bundleMissing: (bundle) => `ENOENT: no image bundle at ${bundle}`,
  path: (p) => `Invalid path inside an image bundle ${JSON.stringify(typeof p === "string" ? p.slice(0, 300) : String(p))}: expected a relative path like pixels/0/zarr.json`,
  pathEscapes: (p) => `${p} resolves outside its image bundle`,
  missing: (bundle, p) => `ENOENT: no file ${p} in the image bundle ${bundle}`,
  notFile: (p) => `${p} in the image bundle is not a regular file`,
  range: (detail) => `Invalid image read range: ${detail}`,
  tooLong: (length) => `A single image read is limited to ${FLUXIMG_READ_LIMIT / 1024 / 1024} MiB; ${length.toLocaleString("en-US")} bytes were asked for. Read it in smaller pieces`,
  beforeStart: (p, size, back) => `${p} is ${size} bytes long, so the last ${back} bytes cannot be read`,
  shortRead: (p, start, length, size) => `Short read: ${p} is ${size} bytes long, so ${length} bytes from byte ${start} do not exist`,
  saved: (id) => `The image asset ${id} is saved in this project's figures; it can only be removed by deleting it from the figure`,
  savedUnreadable: () => "fig/index.json cannot be read, so it is unknown whether this image is in use; nothing was removed",
  discardNotDirectory: (id) => `fig/assets/${id}.fluximg is not a folder; nothing was removed`,
};

function formatBytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  return `${n} bytes`;
}

/** The asset id, validated: one safe path component, never a Windows device name. Throws. */
export function fluximgAssetId(id) {
  if (typeof id !== "string" || !SAFE_ID.test(id) || WINDOWS_DEVICE.test(id)) throw new Error(fluximgErrors.assetId(id));
  return id;
}

/** `fig/assets/<id>.fluximg` (project-relative) and `assets/<id>.fluximg` (the way `Asset.path` is written). */
export const fluximgAssetRel = (id) => `${FLUXIMG_ASSETS_REL}/${id}${FLUXIMG_EXT}`;
export const fluximgAssetPath = (id) => `assets/${id}${FLUXIMG_EXT}`;

/** Relative POSIX segments of a renderer-supplied path, or null when it is not a plain relative path
 *  (absolute, a drive letter, a backslash, NUL, empty, ".", ".." or an empty segment anywhere). */
function plainSegments(p) {
  if (typeof p !== "string" || !p || p.length > 4096 || /[\\\0]/.test(p) || p.startsWith("/") || /^[A-Za-z]:/.test(p)) return null;
  const parts = p.split("/");
  return parts.every((s) => s !== "" && s !== "." && s !== "..") ? parts : null;
}

/** A bundle path relative to the project root: `fig/assets/<id>.fluximg` or `plots/…/<name>.fluximg`.
 *  Returns its segments and the area it must stay inside. Throws. */
export function fluximgBundleRel(bundle) {
  const parts = plainSegments(bundle);
  const ok = parts !== null && parts.length >= 2 &&
    parts[parts.length - 1].length > FLUXIMG_EXT.length && parts[parts.length - 1].endsWith(FLUXIMG_EXT) &&
    // A bundle never nests in another bundle.
    parts.slice(0, -1).every((s) => !s.endsWith(FLUXIMG_EXT)) &&
    ((parts[0] === "fig" && parts[1] === "assets" && parts.length === 3) || (parts[0] === "plots" && parts.length >= 2));
  if (!ok) throw new Error(fluximgErrors.bundle(bundle));
  return { rel: parts.join("/"), parts, area: parts[0] === "fig" ? FLUXIMG_ASSETS_REL : "plots" };
}

/** A path inside a bundle (`pixels/0/c/0/0`): its segments. Throws. */
export function fluximgInnerPath(p) {
  const parts = plainSegments(p);
  if (parts === null) throw new Error(fluximgErrors.path(p));
  return parts;
}

/** Offset and length as a renderer sent them, checked before any IO (so an over-limit read costs nothing). */
export function fluximgCheckRange(offset, length) {
  if (!Number.isSafeInteger(offset)) throw new Error(fluximgErrors.range("offset must be an integer"));
  if (!Number.isSafeInteger(length) || length < -1) throw new Error(fluximgErrors.range("length must be a non-negative integer, or -1 for the rest of the file"));
  if (length > FLUXIMG_READ_LIMIT) throw new Error(fluximgErrors.tooLong(length));
}

/** The byte range to read from a file of `size` bytes. Negative offsets count from the end; length -1
 *  reads to the end. Anything past the end is an error, never a silently short result. */
export function fluximgRange(p, size, offset, length) {
  fluximgCheckRange(offset, length);
  const start = offset < 0 ? size + offset : offset;
  if (start < 0) throw new Error(fluximgErrors.beforeStart(p, size, -offset));
  const n = length === -1 ? size - start : length;
  if (n < 0 || start + n > size) throw new Error(fluximgErrors.shortRead(p, start, Math.max(n, 0), size));
  if (n > FLUXIMG_READ_LIMIT) throw new Error(fluximgErrors.tooLong(n));
  return { start, length: n };
}

/** Operating-system litter that copying a folder between machines adds (Finder, Explorer, exFAT
 *  AppleDouble siblings). A fluximg reader ignores unknown files (SPEC §1), so the import leaves them
 *  behind: the same bundle then has the same content id wherever it was copied from. */
export function isFluximgJunkName(name) {
  return name === ".DS_Store" || name === "Thumbs.db" || name === "desktop.ini" || name.startsWith("._");
}

/** The manifest text, parsed and checked to be fluximg/1 (deeper validation is the renderer's, after import). Throws. */
export function parseFluximgManifest(text) {
  let manifest;
  try { manifest = JSON.parse(text); } catch (error) { throw new Error(fluximgErrors.manifestJson(error instanceof Error ? error.message : String(error))); }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error(fluximgErrors.manifestShape());
  if (manifest.spec !== FLUXIMG_SPEC) throw new Error(fluximgErrors.manifestSpec(manifest.spec));
  return manifest;
}

/** Code-point order, which is UTF-8 byte order (plain `<` on strings is UTF-16 order and differs for
 *  characters above U+FFFF). Another implementation (fluxplot) can reproduce it by sorting UTF-8 bytes. */
export function compareCodePoints(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; ) {
    const x = a.codePointAt(i), y = b.codePointAt(i);
    if (x !== y) return x < y ? -1 : 1;
    i += x > 0xffff ? 2 : 1;
  }
  return a.length - b.length;
}

/** The text whose SHA-256 is a bundle's content id: one line `<posix relative path>\0<file sha256 hex>\n`
 *  per file, sorted by path in UTF-8 byte order. Folders (empty or not) are not part of it. */
export function fluximgContentIdText(entries) {
  return [...entries].sort((a, b) => compareCodePoints(a.path, b.path)).map((e) => `${e.path}\0${e.sha256}\n`).join("");
}
