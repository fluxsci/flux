"use strict";
// Calibrated display-referred signals, not SDR pixels with HDR metadata.
// The independent numerical oracle and tolerances are documented alongside the fixture.
const fs = require("node:fs/promises"), path = require("node:path"), assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const gray = [0, .01, .1, .5, 1, 2, 4, 8, 10]; // units of 100 cd/m²
const patches = [...gray.map(v => [v, v, v]), [.4, .2, .15], [.2, .4, .2], [.15, .2, .4]];
const width = patches.length * 32, height = 64;
const matrix = [[1.660491, -.587641, -.072850], [-.124550, 1.132900, -.008349], [-.018151, -.100579, 1.118730]];
const hable = x => (x * (.15 * x + .05) + .004) / (x * (.15 * x + .5) + .06) - 1 / 15;
function reference(rgb) {
  const gamut = matrix.map(row => row.reduce((sum, v, i) => sum + v * rgb[i], 0));
  const signal = Math.max(...gamut, 1e-6), gain = hable(signal) / hable(10) / signal;
  // zscale defaults to display-referred BT.709, whose inverse display EOTF is BT.1886.
  return gamut.map(v => Math.round(255 * Math.max(0, Math.min(1, v * gain)) ** (1 / 2.4)));
}
function transfer(value, kind) {
  if (value === 0) return 0;
  if (kind === "pq") {
    const p = (value / 100) ** (2610 / 16384);
    return ((3424 / 4096 + (2413 / 128) * p) / (1 + (2392 / 128) * p)) ** (2523 / 32);
  }
  const scene = (value / 10) ** (1 / 1.2);
  return scene <= 1 / 12 ? Math.sqrt(3 * scene) : .17883277 * Math.log(12 * scene - .28466892) + .55991073;
}
function run(encoder, args) { return execFileSync(encoder, ["-v", "error", ...args], { timeout: 20000, maxBuffer: 8 * 1024 * 1024 }); }
function metadata(encoder, file) {
  const result = spawnSync(encoder, ["-hide_banner", "-i", file, "-frames:v", "1", "-f", "null", "-"], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr); return result.stderr;
}
function centers(bytes, pixelFormat = "rgb24", frame = 0) {
  if (pixelFormat === "gbrpf32le") return patches.map((_, i) => [2, 0, 1].map(plane => bytes.readFloatLE(4 * (plane * width * height + 32 * width + i * 32 + 16))));
  return patches.map((_, i) => [...bytes.subarray((frame * width * height + 32 * width + i * 32 + 16) * 3, (frame * width * height + 32 * width + i * 32 + 16) * 3 + 3)]);
}
async function createHdrFixture(encoder, file, kind) {
  assert.ok(["pq", "hlg"].includes(kind));
  const raw = Buffer.alloc(width * height * 12), input = `${file}.linear-f32`;
  for (let plane = 0; plane < 3; plane++) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
    raw.writeFloatLE(patches[Math.floor(x / 32)][[1, 2, 0][plane]], 4 * (plane * width * height + y * width + x));
  await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(input, raw);
  const trc = kind === "pq" ? "smpte2084" : "arib-std-b67";
  try {
    run(encoder, ["-stream_loop", "-1", "-f", "rawvideo", "-pixel_format", "gbrpf32le", "-video_size", `${width}x${height}`, "-framerate", "30", "-i", input,
      "-t", "1.2", "-vf", `zscale=pin=bt2020:tin=linear:min=gbr:rin=full:p=bt2020:t=${trc}:m=bt2020nc:r=limited:npl=100,format=yuv420p10le`, "-filter_threads", "1",
      "-c:v", "libx265", "-x265-params", "pools=1:frame-threads=1:log-level=error:lossless=1:max-cll=1000,100", "-tag:v", "hvc1", "-color_primaries", "bt2020", "-color_trc", trc, "-colorspace", "bt2020nc", "-threads", "2", "-y", file]);
  } finally { await fs.rm(input, { force: true }); }
  assert.ok(metadata(encoder, file).includes(`yuv420p10le(tv, bt2020nc/bt2020/${trc},`), "input carries actual 10-bit BT.2020 matrix/primaries/transfer metadata");
  const signal = centers(run(encoder, ["-i", file, "-frames:v", "1", "-vf", "zscale=m=gbr:r=full,format=gbrpf32le", "-f", "rawvideo", "pipe:1"]), "gbrpf32le");
  gray.forEach((v, i) => signal[i].forEach(actual => assert.ok(Math.abs(actual - transfer(v, kind)) < .002, `${kind} input transfer at ${v * 100} nit: ${actual} vs ${transfer(v, kind)}`)));
  const linear = centers(run(encoder, ["-i", file, "-frames:v", "1", "-vf", "zscale=t=linear:npl=100,format=gbrpf32le", "-f", "rawvideo", "pipe:1"]), "gbrpf32le");
  patches.forEach((rgb, i) => rgb.forEach((v, c) => assert.ok(Math.abs(linear[i][c] - v) <= Math.max(.002, v * .015), `${kind} input linear patch ${i}/${c}: ${linear[i][c]} vs ${v}`)));
  return { kind, width, height, peakNits: 1000, patchNits: patches.map(rgb => rgb.map(v => v * 100)), signal, decodedLinear: linear, referenceRgb: patches.map(reference) };
}
function verifyHdrOutput(encoder, file, calibration, posterFile) {
  assert.match(metadata(encoder, file), /yuv420p\(tv, bt709,/, "canonical output declares limited-range 8-bit BT.709 matrix/primaries/transfer");
  const bytes = run(encoder, ["-i", file, "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"]);
  const count = bytes.length / (width * height * 3); assert.equal(count, 36, "all calibrated HDR frames survive normalization");
  const observed = centers(bytes);
  for (let frame = 0; frame < count; frame++) centers(bytes, "rgb24", frame).forEach((rgb, i) => rgb.forEach((v, c) =>
    assert.ok(Math.abs(v - calibration.referenceRgb[i][c]) <= 5, `${calibration.kind} frame ${frame} patch ${i}/${c}: ${v} vs ${calibration.referenceRgb[i][c]}`)));
  for (let i = 1; i < gray.length; i++) assert.ok(observed[i][0] > observed[i - 1][0], "black-to-peak ramp remains strictly monotonic, including highlight detail");
  assert.ok(observed[0].every(v => v <= 2) && observed[8].every(v => v >= 253), "calibrated black and declared peak map to display endpoints");
  assert.ok(observed[6][0] < observed[7][0] && observed[7][0] < observed[8][0], "400, 800 and 1000 nit highlights stay distinguishable");
  if (posterFile) {
    const poster = centers(run(encoder, ["-i", posterFile, "-vf", `scale=${width}:${height}`, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"]));
    poster.forEach((rgb, i) => rgb.forEach((v, c) => assert.ok(Math.abs(v - calibration.referenceRgb[i][c]) <= 5, `poster ${calibration.kind} patch ${i}/${c}`)));
    calibration.posterRgb = poster;
  }
  return { ...calibration, outputRgb: observed, decodedFrames: count, maxChannelError: Math.max(...observed.flatMap((rgb, i) => rgb.map((v, c) => Math.abs(v - calibration.referenceRgb[i][c])))) };
}
module.exports = { createHdrFixture, verifyHdrOutput, width, height };
