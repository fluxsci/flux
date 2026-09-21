import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { withLock } from './locks';
import { CLIENT } from './journal';
import { atomicWrite } from './fsx';
import { applyManifestIntent } from '../src/lib/project/manifestTransaction';
import type { ProjectManifest } from '../src/lib/project/types';
export async function updateManifest(root: string, intent: (fresh: ProjectManifest) => void | Promise<void>): Promise<ProjectManifest> {
  return withLock(root, 'manifest', CLIENT, () => applyManifestIntent({
    read: () => fs.readFile(path.join(root, 'project.json'), 'utf8'),
    write: text => atomicWrite(path.join(root, 'project.json'), text),
  }, intent));
}
