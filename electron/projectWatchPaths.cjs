"use strict";

const path = require("node:path");

// Figure renders are derived, including their directories. A first poster mkdir
// is not a self-write-marked file; watching it would reload canonical figures
// (and Paper's reference chips) merely because their cache was populated.
function isDerivedFigureRenderPath(root, absolute) {
  const relative = path.relative(root, absolute).split(path.sep).join("/");
  return relative === "fig/renders" || relative.startsWith("fig/renders/");
}

module.exports = { isDerivedFigureRenderPath };
