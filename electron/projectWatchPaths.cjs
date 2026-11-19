"use strict";

const path = require("node:path");

// Figure renders are derived, including their directories. A first poster mkdir
// is not a self-write-marked file; watching it would reload canonical figures
// (and Paper's reference chips) merely because their cache was populated.
function isDerivedFigureRenderPath(root, absolute) {
  const relative = path.relative(root, absolute).split(path.sep).join("/");
  return relative === "fig/renders" || relative.startsWith("fig/renders/");
}

// A placed fluximg bundle, `fig/assets/<id>.fluximg/`, is an immutable directory of
// up to 20,000 files, and its import stages in a hidden sibling
// (`.<id>.fluximg.tmp-<uuid>`, also used to discard one) before one rename. The
// figure learns about a bundle from fig/index.json, never from the bundle itself,
// so watching inside it would only spend a descriptor per Zarr chunk folder and
// flood the "fig" subsystem with thousands of unmarked events per import.
// Temp names: electron/fluximgFiles.cjs (verify-fluximg-files pins the two).
const FLUXIMG_ASSET_RE = /^fig\/assets\/[^/]+\.fluximg(?:\.tmp-[^/]*)?(?:\/|$)/;
function isFluximgAssetBundlePath(root, absolute) {
  return FLUXIMG_ASSET_RE.test(path.relative(root, absolute).split(path.sep).join("/"));
}

module.exports = { isDerivedFigureRenderPath, isFluximgAssetBundlePath };
