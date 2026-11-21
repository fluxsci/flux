// The TIFF conversion child and the Plots rail's TIFF picture: two small Node bundles of the pure TIFF reader, the
// fluximg writer and flux-core's Node adapters (electron/tiffWorker.mjs, electron/tiffThumb.mjs). Packaged main never
// imports TypeScript; these run in ELECTRON_RUN_AS_NODE children from app.asar.unpacked, so they bundle everything
// and import only Node's own modules. Built beside the figure raster worker by the same hooks
// (gen-slide-embed-assets.mjs: predev / prebuild / precheck; build-cli.mjs).
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TIFF_BUNDLES = { worker: 'electron/generated/tiffWorker.bundle.mjs', thumb: 'electron/generated/tiffThumb.bundle.mjs' };
// Parallel gates read the bundles while another hook regenerates them: identical bytes are left alone, changed bytes
// replaced by rename (the figure raster worker's rule).
export async function buildTiffWorker({ outDir = path.join(root, 'electron/generated') } = {}) {
  for (const [entry, out] of [['electron/tiffWorker.mjs', 'tiffWorker.bundle.mjs'], ['electron/tiffThumb.mjs', 'tiffThumb.bundle.mjs']]) {
    const outfile = path.join(outDir, out);
    const result = await build({
      entryPoints: [path.join(root, entry)], outfile, write: false,
      bundle: true, platform: 'node', format: 'esm', target: 'node22', legalComments: 'none', logLevel: 'warning',
      banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    });
    const [file] = result.outputFiles;
    if ((await readFile(outfile).catch(() => null))?.equals(file.contents)) continue;
    await mkdir(path.dirname(outfile), { recursive: true });
    const temp = `${outfile}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, file.contents); await rename(temp, outfile);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildTiffWorker();
