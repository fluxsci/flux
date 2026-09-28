/** Bounded Node IO shared by model inspection, import and poster resolution. */
import * as fs from 'node:fs/promises';
import { constants, type Stats } from 'node:fs';
import path from 'node:path';
import { projectAssetPath } from './model';
import { confinedRecoveryPath } from './recovery';
import { tmpPathFor, fsyncDir } from './fsx';
import { shareRetry } from '../electron/fsRetry.cjs';

/** Bound allocation against the opened regular file, rechecking confinement
 * after open so a delayed provider cannot follow a substituted symlink. */
export async function boundedModelFile(file: string, limit: number, root?: string, signal?: AbortSignal): Promise<Buffer> {
  const resolve = () => root ? projectAssetPath(root, path.relative(root, file)) : fs.realpath(file);
  signal?.throwIfAborted();
  const real = await resolve(), beforePath = await fs.lstat(real);
  if (!beforePath.isFile()) throw new Error('3D input must be a regular file');
  const handle = await fs.open(real, constants.O_RDONLY | (constants.O_NONBLOCK || 0) | (constants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== beforePath.dev || before.ino !== beforePath.ino || await resolve() !== real) throw new Error('3D input changed before reading');
    if (before.size > limit) throw new Error(`3D input exceeds ${limit / 1024 / 1024} MiB`);
    signal?.throwIfAborted();
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, offset, Math.min(1024 * 1024, bytes.length - offset), offset);
      if (!bytesRead) throw new Error('3D input changed while reading'); offset += bytesRead;
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || await resolve() !== real) throw new Error('3D input changed while reading');
    signal?.throwIfAborted(); return bytes;
  } finally { await handle.close(); }
}

/** Publish a model or derived poster through an opened regular temporary file.
 * Recheck the original alias and resolved directory around asynchronous work;
 * refuse changed parents before writing bytes or publishing an image. */
export async function publishModelFile(root: string, file: string, bytes: Uint8Array, createOnly = false, retry: typeof shareRetry = shareRetry): Promise<void> {
  const parent = path.dirname(file);
  await confinedRecoveryPath(root, file);
  await fs.mkdir(parent, { recursive: true });
  await confinedRecoveryPath(root, file);
  const directory = await fs.realpath(parent), directoryStat = await fs.stat(directory);
  const destination = path.join(directory, path.basename(file)), temporary = tmpPathFor(destination);
  const same = (a: { dev: number; ino: number }, b: { dev: number; ino: number }) => a.dev === b.dev && a.ino === b.ino;
  const checkDirectory = async () => {
    await confinedRecoveryPath(root, file);
    if (await fs.realpath(parent) !== directory || !same(await fs.stat(directory), directoryStat)) throw new Error('3D output directory changed during publication');
  };
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined, identity: Stats | undefined, published = false;
  const checkTemporary = async () => {
    await checkDirectory();
    if (await fs.realpath(temporary) !== temporary || !same(await fs.lstat(temporary), identity!)) throw new Error('3D output temporary file changed during publication');
  };
  // Cleanup only the exclusive inode created by this call, including when the
  // parent alias was substituted at open. Never remove a replacement file.
  const removeOwned = async (name: string) => {
    await retry(async () => {
      try { if (identity && same(await fs.lstat(name), identity)) await fs.unlink(name); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    });
  };
  try {
    await checkDirectory();
    handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o666);
    identity = await handle.stat();
    if (!identity.isFile()) throw new Error('3D output temporary file must be regular');
    await checkTemporary();
    await handle.writeFile(bytes); await handle.sync();
    await checkTemporary();
    await handle.close(); handle = undefined;
    await retry(async () => {
      await checkTemporary();
      if (createOnly) await fs.link(temporary, destination); else await fs.rename(temporary, destination);
      published = true;
    });
    await checkDirectory();
    if (!same(await fs.lstat(destination), identity)) throw new Error('3D output changed after publication');
    if (createOnly) await removeOwned(temporary);
    await fsyncDir(directory);
  } catch (error) {
    if (published) await removeOwned(destination).catch(() => {});
    throw error;
  } finally {
    await handle?.close().catch(() => {});
    await removeOwned(temporary).catch(() => {});
  }
}
