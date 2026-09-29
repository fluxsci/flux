import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function buildModel3dAssets(outdir = path.join(root, 'dist'), { runtimeOnly = false } = {}) {
  await mkdir(outdir, { recursive: true });
  const three = JSON.parse(await readFile(path.join(root, 'node_modules/three/package.json'), 'utf8'));
  const notice = await readFile(path.join(root, 'node_modules/three/LICENSE'), 'utf8');
  const entries = [['flux-model3d-runtime.js', 'src/lib/slide/export/model3dRuntime.ts', 'FluxModel3dRuntime']];
  if (!runtimeOnly) entries.push(['flux-model3d-viewer.js', 'src/lib/model3d/notebookViewer.ts', 'FluxModel3dViewer']);
  const outputs = {};
  for (const [name, entry, globalName] of entries) {
    const result = await build({ absWorkingDir: root, entryPoints: [entry], bundle: true, format: 'iife', globalName, platform: 'browser', target: 'es2022', minify: true, write: false, legalComments: 'none' });
    // Embeddable verbatim in a notebook <script>; no external resources or dynamic chunks.
    const code = `/* Flux model3d; three ${three.version} (MIT), see flux-model3d-THIRD-PARTY.txt */\n${result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}`;
    await writeFile(path.join(outdir, name), code);
    outputs[name] = { sha256: createHash('sha256').update(code).digest('hex'), bytes: Buffer.byteLength(code) };
  }
  await writeFile(path.join(outdir, 'flux-model3d-THIRD-PARTY.txt'), `three ${three.version}\n\n${notice}`);
  const versionSource = await readFile(path.join(root, 'src/lib/model3d/poster.ts'), 'utf8');
  const version = versionSource.match(/export const RENDERER_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1];
  if (!version) throw new Error('Missing canonical model3d renderer version');
  const stamp = { renderer: version, three: three.version, outputs };
  if (outputs['flux-model3d-viewer.js']) await writeFile(path.join(outdir, 'flux-model3d-viewer.stamp.json'), JSON.stringify({ sha256: outputs['flux-model3d-viewer.js'].sha256, version }) + '\n');
  await writeFile(path.join(outdir, 'flux-model3d-viewer.version.json'), JSON.stringify(stamp, null, 2) + '\n');
  return stamp;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await buildModel3dAssets(process.env.FLUX_MODEL3D_OUT, { runtimeOnly: process.argv.includes('--runtime-only') }), null, 2));
}
