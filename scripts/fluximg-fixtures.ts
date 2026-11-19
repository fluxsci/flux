// Write the fluximg/1 reference fixtures into a directory:
//   node --import tsx scripts/fluximg-fixtures.ts <outdir>
import path from "node:path";
import { writeAllFixtures } from "./lib/fluximgFixtures";

const out = process.argv[2];
if (!out) { console.error("usage: fluximg-fixtures <outdir>"); process.exit(2); }
const done = await writeAllFixtures(path.resolve(out));
for (const { fixture, report } of done) {
  console.log(`${fixture.name.padEnd(22)} ${String(report.files).padStart(3)} files ${(report.bytes / 1024).toFixed(1).padStart(9)} kB  ${report.manifest.pixels.encoding.kind}  ${fixture.about}`);
}
console.log(`\n${done.length} bundles, expected/*.npy, inputs/*.npy and fixtures.json written to ${path.resolve(out)}`);
