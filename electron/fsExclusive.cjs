// Create-only publication of a fully written temp file, in one place for both
// module systems (the seam fsRetry.cjs already uses).
//
// The publish is a hard link: it lands every byte at once and refuses an
// existing destination. exFAT and FAT volumes have no hard links at all — the
// call comes back ENOTSUP (EPERM from Linux vfat) — and since the lease bakery
// creates its registers this way, NO project on such a drive could open:
// "Couldn't open project: … lock:acquire': Error: ENOTSUP: operation not
// supported on socket, link" (2026-10-07, a demo project on an external exFAT
// SSD). There the fallback is an exclusive create (O_EXCL), which keeps the
// refusal but not the all-at-once landing: a reader can briefly see a short
// file. Lease registers already read a short file as a contender in an unknown
// state, and document creates are a new file nobody else is reading yet.
const fs = require("node:fs/promises");
const { shareRetry } = require("./fsRetry.cjs");

const NO_HARD_LINKS = new Set(["ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);

/**
 * True when this error means the filesystem has no hard links (not a refusal).
 * @param {unknown} error
 * @returns {boolean}
 */
function isNoHardLinks(error) {
  const code = /** @type {NodeJS.ErrnoException | null | undefined} */ (error)?.code;
  if (typeof code !== "string") return false;
  return NO_HARD_LINKS.has(code) || (code === "EPERM" && process.platform === "linux");
}

/**
 * Publish `tmp` at `dest`, failing EEXIST if `dest` exists. `tmp` is left in
 * place for the caller to remove. Resolves "linked" when `dest` is `tmp`'s
 * inode, "copied" when the filesystem forced a fresh exclusive file (streamed,
 * so a video costs a buffer, not its size, and fsynced like the temp was).
 * @param {string} tmp
 * @param {string} dest
 * @param {{ mode?: number, retry?: typeof shareRetry, fsp?: typeof fs }} [options]
 * @returns {Promise<"linked" | "copied">}
 */
async function publishExclusive(tmp, dest, { mode = 0o666, retry = shareRetry, fsp = fs } = {}) {
  try {
    await retry(() => fsp.link(tmp, dest));
    return "linked";
  } catch (error) {
    if (!isNoHardLinks(error)) throw error;
  }
  const source = await fsp.open(tmp, "r");
  try {
    // "wx" is the refusal; from here on the file is ours to remove on failure.
    const target = await fsp.open(dest, "wx", mode);
    try {
      const buffer = Buffer.allocUnsafe(1 << 20);
      for (let read; (read = (await source.read(buffer, 0, buffer.length, null)).bytesRead) > 0; ) {
        for (let at = 0; at < read; ) at += (await target.write(buffer, at, read - at)).bytesWritten;
      }
      await target.sync();
    } catch (error) {
      await target.close().catch(() => {});
      await retry(() => fsp.rm(dest, { force: true })).catch(() => {});
      throw error;
    }
    await target.close();
  } finally {
    await source.close().catch(() => {});
  }
  return "copied";
}

module.exports = { publishExclusive, isNoHardLinks };
