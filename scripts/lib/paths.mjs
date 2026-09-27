// Comparing two paths that name the same file.
//
// Flux's shared cores join POSIX on every platform (src/lib/references/items.ts,
// src/lib/project/figfiles.ts …) while the Node side uses `path.join`, so the two
// engines legitimately reach one file by two spellings — identical on Linux and
// macOS, different on Windows. A gate that keys a fault injector or a lease steal
// on `p === path.join(root, rel)` therefore never fires there, and reports the
// product as missing a rejection it was simply never asked to make.
//
// Compare with `samePath`, which resolves both sides to the platform's own form
// first. (Case is left alone: NTFS is case-insensitive but case-preserving, and
// nothing in these gates depends on matching across a case difference.)
import * as path from "node:path";

/** Do these two paths name the same location, whatever separators they use? */
export function samePath(a, b) {
  return path.resolve(a) === path.resolve(b);
}
