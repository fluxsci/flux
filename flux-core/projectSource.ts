/** Normalize CLI/MCP path resolution at the shared project-owned media boundary. */
import path from 'node:path';
import { safeJoin, projectAssetPath } from './model';
import { storedAssetPath } from '../src/lib/project/assetPath';
export async function projectSourceRelativePath(root: string, input: string): Promise<string> {
  if (typeof input !== 'string' || !input || /[\0\\]/.test(input)) throw new Error('Expected a project-relative media path');
  const absolute = safeJoin(root, input);
  const relative = storedAssetPath(path.relative(path.resolve(root), absolute).split(path.sep).join('/'));
  // Do not normalize an escaping symlink into a granted absolute file.
  await projectAssetPath(root, relative);
  return relative;
}
