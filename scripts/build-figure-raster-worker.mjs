// A small dedicated Node entry: packaged main never imports the CLI or TS.
// Keep the scene engine external so its font/resource URLs retain their owner.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Parallel pure gates read the bundle while check/dev/build and the worker gate regenerate it:
// build in memory, leave identical bytes untouched, and replace changed bytes by rename.
export async function buildFigureRasterWorker({ outfile = path.join(root, 'electron/generated/figureRasterWorker.bundle.mjs') } = {}) {
  const result = await build({
    entryPoints: [path.join(root, 'electron/figureRasterWorker.mjs')],
    outfile, write: false,
    bundle: true, platform: 'node', format: 'esm', target: 'node22', legalComments: 'none', logLevel: 'warning',
    external: ['@resvg/resvg-js', '@xmldom/xmldom', 'electron', '@napi-rs/canvas', 'pdfjs-dist', 'pdfjs-dist/legacy/build/pdf.mjs', 'esbuild'],
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    plugins: [{ name: 'shared-scene-engine', setup(b) {
      b.onResolve({ filter: /sceneRasterEngine\.mjs$/ }, () => ({ path: '../sceneRasterEngine.mjs', external: true }));
      // linkedom's optional canvas peer is never used by SVG composition.
      b.onResolve({ filter: /^canvas$/ }, () => ({ path: path.join(root, 'node_modules/linkedom/commonjs/canvas-shim.cjs') }));
    } }],
  });
  const [file] = result.outputFiles;
  if ((await readFile(outfile).catch(() => null))?.equals(file.contents)) return;
  await mkdir(path.dirname(outfile), { recursive: true });
  const temp = `${outfile}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, file.contents); await rename(temp, outfile);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildFigureRasterWorker();
