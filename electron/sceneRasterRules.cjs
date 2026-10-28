"use strict";
const MAX_SVG_BYTES = 64 * 1024 * 1024;
const MAX_SIDE = 4096;
function validateSceneRequest(request) {
  if (!request || typeof request.rid !== "string" || !/^[\w.:-]{1,160}$/.test(request.rid)) throw Error("Invalid raster request identity");
  if (typeof request.svg !== "string" || request.svg.length > MAX_SVG_BYTES || Buffer.byteLength(request.svg) > MAX_SVG_BYTES) throw Error("Scene SVG exceeds 64 MiB");
  if (!Array.isArray(request.regions) || request.regions.length < 1 || request.regions.length > 2) throw Error("Expected one sharp region and optional coarse region");
  let pixels = 0;
  const regions = request.regions.map((region, i) => {
    const { bx, by, bw, bh, width, height } = region ?? {};
    if (![bx, by, bw, bh].every(v => Number.isFinite(v) && Math.abs(v) <= 1e12) || !(bw > 0 && bh > 0)) throw Error("Invalid raster world region");
    if (![width, height].every(v => Number.isInteger(v) && v > 0 && v <= MAX_SIDE) || width * height > (i ? 1_000_000 : 3_000_000)) throw Error("Raster exceeds its pixel budget");
    pixels += width * height; return { bx, by, bw, bh, width, height };
  });
  if (pixels > 4_000_000) throw Error("Scene raster exceeds total pixel budget");
  return { rid: request.rid, svg: request.svg, regions };
}
module.exports = { MAX_SVG_BYTES, MAX_SIDE, validateSceneRequest };
