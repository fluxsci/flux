// Deterministic throwaway collections for the verify gates and manual runs.
// Tiny solid-colour+label PNGs via @napi-rs/canvas; SVG/GIF/bogus variants by
// extension. No network.
//
// CLI: node scripts/make-fixture.mjs [outDir]   (default lighttable/test/fixture)
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function hueFor(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

let canvasMod = null;
async function png(label, { w = 640, h = 400 } = {}) {
  if (!canvasMod) canvasMod = await import("@napi-rs/canvas");
  const c = canvasMod.createCanvas(w, h);
  const g = c.getContext("2d");
  g.fillStyle = `hsl(${hueFor(label)}, 55%, 42%)`;
  g.fillRect(0, 0, w, h);
  g.fillStyle = "#ffffff";
  g.font = "600 24px sans-serif";
  g.textAlign = "center";
  g.fillText(label, w / 2, h / 2);
  return c.encode("png");
}

const SVG = (label) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="200" height="120" fill="hsl(${hueFor(label)},55%,42%)"/><text x="100" y="66" fill="#fff" text-anchor="middle" font-size="18">${label}</text></svg>`;

// A 1-frame GIF (tiny hand-rolled bytes: 2x2, single colour).
const GIF_BYTES = Buffer.from(
  "47494638396102000200800000ff450000000021f90400000000002c000000000200020000020284510005003b",
  "hex"
);

async function contentFor(name) {
  const ext = path.extname(name).toLowerCase();
  const label = name.replace(/\.[^.]+$/, "");
  if (ext === ".svg") return SVG(label);
  if (ext === ".gif") return GIF_BYTES;
  if (name.startsWith("bogus")) return "this is not an image, whatever the extension says";
  return png(label);
}

// spec: { sets?: { [setName]: string[] }, loose?: string[], emptyDirs?: string[], big?: {set, count} }
export async function makeFixture(dir, spec) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [setName, files] of Object.entries(spec.sets ?? {})) {
    const d = path.join(dir, setName);
    mkdirSync(d, { recursive: true });
    for (const f of files) writeFileSync(path.join(d, f), await contentFor(f));
  }
  for (const f of spec.loose ?? []) writeFileSync(path.join(dir, f), await contentFor(f));
  for (const d of spec.emptyDirs ?? []) mkdirSync(path.join(dir, d), { recursive: true });
  if (spec.big) {
    const d = path.join(dir, spec.big.set);
    mkdirSync(d, { recursive: true });
    const buf = await png(spec.big.set, { w: 320, h: 200 });
    for (let i = 1; i <= spec.big.count; i++)
      writeFileSync(path.join(d, `item_${String(i).padStart(4, "0")}.png`), buf);
  }
  return dir;
}

// The standard 2-set fixture used by the electron smoke gate and manual runs:
// 6 items in A, item_004 missing from B (placeholder + flip-book alignment).
export const DEFAULT_SPEC = {
  sets: {
    A: ["item_001.png", "item_002.png", "item_003.png", "item_004.png", "item_005.png", "item_006.png"],
    B: ["item_001.png", "item_002.png", "item_003.png", "item_005.png", "item_006.png"],
  },
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const out = process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "test", "fixture");
  await makeFixture(out, DEFAULT_SPEC);
  console.log(`fixture written to ${out}`);
}
