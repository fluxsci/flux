/** Regenerate recorded demo inputs through the public scene3d example. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { isolatedEnv } from './lib/verifyRuntime.mjs';
import { DEMO_INPUTS, generateDemoInputs } from './lib/model3dDemo';
const source = process.argv[2]; if (!source) throw new Error('Pass the isolated scene3d fluxplot checkout');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-model3d-demo-fixtures-'));
Object.assign(process.env, isolatedEnv(path.join(scratch, 'env')), { FLUX_NO_MIGRATE: '1', XDG_DATA_HOME: path.join(scratch, 'env/data'), UV_CACHE_DIR: path.join(scratch, 'env/uv-cache') });
try {
  const output = path.join(scratch, 'inputs'); await generateDemoInputs(output, source);
  await fs.mkdir(DEMO_INPUTS, { recursive: true });
  for (const name of await fs.readdir(output)) await fs.copyFile(path.join(output, name), path.join(DEMO_INPUTS, name));
  console.log('Recorded public scene3d demo inputs and provenance');
} finally { await fs.rm(scratch, { recursive: true, force: true }); }
