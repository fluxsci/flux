/** Normalize CLI/MCP path resolution at the shared project-owned media boundary. */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { projectAssetPath } from './model';
import { storedAssetPath } from '../src/lib/project/assetPath';

export type PathApi = Pick<typeof path, 'resolve' | 'relative' | 'isAbsolute' | 'sep'>;

/** Lexical half of the boundary: a file inside `root` (absolute, or relative
 * to the root) as its portable stored path. Platform separators become '/'
 * before storedAssetPath judges the result, so a win32 `C:\proj\plots\a.glb`
 * is the same `plots/a.glb` as on POSIX (where a backslash is a filename
 * character and stays refused). `api` is injectable for win32 tests. */
export function projectRelativePath(root: string, file: string, api: PathApi = path): string {
  const base = api.resolve(root), relative = api.relative(base, api.resolve(base, file));
  if (relative === '..' || relative.startsWith('..' + api.sep) || api.isAbsolute(relative)) throw new Error(`path escapes project root: ${file}`);
  return storedAssetPath(relative.split(api.sep).join('/'));
}

/** The same file seen through the other alias of a symlinked root (a
 * symlinked --root with a realpath shell cwd, or the reverse). Only the
 * directories are resolved; the final component stays for projectAssetPath's
 * own symlink-escape check. */
async function realProjectRelativePath(root: string, input: string): Promise<string> {
  const absolute = path.resolve(root, input);
  const [base, parent] = await Promise.all([fs.realpath(root), fs.realpath(path.dirname(absolute))]);
  return projectRelativePath(base, path.join(parent, path.basename(absolute)));
}

export async function projectSourceRelativePath(root: string, input: string): Promise<string> {
  // Separators are the platform's business (resolvePathParams hands win32
  // callers `C:\…`); only NUL is refused on the raw input.
  if (typeof input !== 'string' || !input || input.includes('\0')) throw new Error('Expected a project-relative media path');
  let relative: string;
  try { relative = projectRelativePath(root, input); }
  catch (lexical) { relative = await realProjectRelativePath(root, input).catch(() => { throw lexical; }); }
  // Do not normalize an escaping symlink into a granted absolute file.
  await projectAssetPath(root, relative);
  return relative;
}
