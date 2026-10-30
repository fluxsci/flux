// A small dedicated Node entry: packaged main never imports the CLI or TS.
// Keep the scene engine external so its font/resource URLs retain their owner.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function buildFigureRasterWorker() {
  await build({
    entryPoints: [path.join(root, 'electron/figureRasterWorker.mjs')],
    outfile: path.join(root, 'electron/generated/figureRasterWorker.bundle.mjs'),
    bundle: true, platform: 'node', format: 'esm', target: 'node22', legalComments: 'none', logLevel: 'warning',
    external: ['@resvg/resvg-js', '@xmldom/xmldom', 'electron', '@napi-rs/canvas', 'pdfjs-dist', 'pdfjs-dist/legacy/build/pdf.mjs', 'esbuild'],
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    plugins: [{ name: 'shared-scene-engine', setup(b) {
      b.onResolve({ filter: /sceneRasterEngine\.mjs$/ }, () => ({ path: '../sceneRasterEngine.mjs', external: true }));
      // linkedom's optional canvas peer is never used by SVG composition.
      b.onResolve({ filter: /^canvas$/ }, () => ({ path: path.join(root, 'node_modules/linkedom/commonjs/canvas-shim.cjs') }));
    } }],
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildFigureRasterWorker();
