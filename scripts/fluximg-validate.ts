// Check a bundle against fluximg/1, and optionally dump what a correct reader returns:
//   node --import tsx scripts/fluximg-validate.ts <bundle.fluximg> [--quick] [--json] [--values out.npy]
// Exit status 0 = conforms, 1 = does not, 2 = usage.
import path from "node:path";
import { nodeBundleReader, nodeZstd, writeNpy } from "../flux-core/fluximgIo";
import { validateFluximg } from "../src/lib/fluximg/validate";
import { readValues } from "./lib/fluximgFixtures";

const args = process.argv.slice(2);
const bundle = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--values");
if (!bundle) { console.error("usage: fluximg-validate <bundle.fluximg> [--quick] [--json] [--values out.npy]"); process.exit(2); }
const dir = path.resolve(bundle);
const result = await validateFluximg(nodeBundleReader(dir), await nodeZstd(), { quick: args.includes("--quick") });
const vi = args.indexOf("--values");
if (vi >= 0 && result.manifest) {
  const v = await readValues(dir);
  await writeNpy(path.resolve(args[vi + 1]), v.values, v.shape);
}
if (args.includes("--json")) console.log(JSON.stringify({ ok: result.ok, issues: result.issues, chunks: result.chunks, shards: result.shards, pixels: result.manifest?.pixels ?? null }, null, 1));
else {
  const p = result.manifest?.pixels;
  if (p) console.log(`${path.basename(dir)}: ${p.dims.join(",")} ${JSON.stringify(p.shape)} ${p.dtype} ${p.encoding.kind}, ${p.levels.length} level(s), ${result.manifest!.layers.length} layer(s); ${result.shards} shard(s), ${result.chunks} chunk(s) decoded`);
  for (const i of result.issues) console.error(`✗ [${i.code}] ${i.message}${i.path ? `  (${i.path})` : ""}`);
  console.log(result.ok ? "✓ conforms to fluximg/1" : `✗ ${result.issues.length} problem(s)`);
}
process.exit(result.ok ? 0 : 1);
