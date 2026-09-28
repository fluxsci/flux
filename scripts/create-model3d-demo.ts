/** Build only a new, disposable project; never initialize the user's Flux state. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { isolatedEnv } from './lib/verifyRuntime.mjs';
import { createModel3dDemo, emptyScratchDestination } from './lib/model3dDemo';
const args = process.argv.slice(2), options: Record<string, string | boolean> = {};
for (let i = 0; i < args.length; i++) {
  const key = args[i]; if (!['--out', '--fluxplot-root', '--posters'].includes(key) || options[key] !== undefined) throw new Error(`Unknown/repeated demo option ${key}`);
  if (key === '--posters') options[key] = true;
  else { const value = args[++i]; if (!value || value.startsWith('--')) throw new Error(`${key} needs a value`); options[key] = value; }
}
if (typeof options['--out'] !== 'string') throw new Error('Usage: node --import tsx scripts/create-model3d-demo.ts --out /tmp/flux-3d-demo [--fluxplot-root /path/to/scene3d] [--posters]');
await emptyScratchDestination(options['--out']);
const environment = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-model3d-demo-env-'));
Object.assign(process.env, isolatedEnv(environment), { FLUX_NO_MIGRATE: '1', XDG_DATA_HOME: path.join(environment, 'data'), UV_CACHE_DIR: path.join(environment, 'uv-cache') });
const result = await createModel3dDemo(options['--out'], { fluxplotRoot: options['--fluxplot-root'] as string | undefined, posters: options['--posters'] === true, environment });
console.log(JSON.stringify({ ...result, environment }, null, 2));
