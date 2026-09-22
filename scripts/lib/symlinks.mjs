// How a gate plants a symlink that the platform will actually let it create.
//
// Windows refuses `symlink()` outright (EPERM) unless the process holds
// SeCreateSymbolicLinkPrivilege — i.e. runs elevated or with Developer Mode on.
// That is not a product limit, but it killed every confinement gate on the
// owner's machine at the first `fs.symlink`, taking the rest of the script's
// checks with it.
//
// A DIRECTORY JUNCTION needs no privilege and is indistinguishable from a
// directory symlink to everything these gates exercise: `lstat().isSymbolicLink()`
// is true, `readlink()` returns the target, and `realpath()` resolves through it —
// which is what every escape check in flux-core is built on. So on win32 a
// directory link is planted as a junction and the contract is verified verbatim.
//
// FILE symlinks have no privilege-free equivalent. `fileLinksSupported()` probes
// once so a gate can say plainly that the platform refused, instead of dying.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DIR_TYPE = process.platform === "win32" ? "junction" : "dir";

/** Plant a link to a DIRECTORY (junction on win32 — same realpath/lstat semantics). */
export function linkDirSync(target, linkPath) {
  fs.symlinkSync(path.resolve(target), linkPath, DIR_TYPE);
}

/** Async twin of {@link linkDirSync}. */
export async function linkDir(target, linkPath) {
  await fs.promises.symlink(path.resolve(target), linkPath, DIR_TYPE);
}

let fileLinks = null;
/** Can this process create a FILE symlink? (false on win32 without Developer Mode.) */
export function fileLinksSupported() {
  if (fileLinks !== null) return fileLinks;
  const probe = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "flux-symlink-probe-"));
  try {
    fs.writeFileSync(path.join(probe, "target"), "probe");
    fs.symlinkSync(path.join(probe, "target"), path.join(probe, "link"), "file");
    fileLinks = true;
  } catch (error) {
    if (error.code !== "EPERM" && error.code !== "EACCES" && error.code !== "ENOSYS") throw error;
    fileLinks = false;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
  return fileLinks;
}

/** One line, printed once, naming the capability the platform withheld. */
export function fileLinkSkipNote(what) {
  return `SKIP (${process.platform}: creating a file symlink needs Developer Mode or elevation) — ${what}`;
}
