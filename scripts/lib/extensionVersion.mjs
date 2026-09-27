// The extension's version line, and the one rule about it: a bump that nothing signed
// does not survive.
//
// AMO refuses a version it has already seen, so every signing attempt must carry a new one,
// and the version lives in the COMMITTED source manifest so a signed build is identifiable in
// history. That combination had a trap: sign-extension bumped the source manifest before it
// uploaded, and a failed upload (wrong key, a "Forbidden" from an account that does not own
// the add-on id, no network) left the bump behind. The manifest then claimed a version no
// signed file had, verify-extension-build went red for a DIFFERENT reason than the real one,
// and the next attempt bumped again from the wrong base (2026-09-22 Windows report, §1).
//
// `withVersionBump` owns the whole lifetime: it writes the bump, runs the work, and on ANY
// failure restores the manifest byte-for-byte before rethrowing. Only a completed run keeps
// the new number. Gated by verify-extension.ts (§2d) on a scratch manifest.
import { readFileSync, writeFileSync } from "node:fs";

/** 0.1.1 → 0.1.2; tolerates short or malformed input the way the signer always has. */
export function bumpPatch(version) {
  const p = String(version || "0.1.0").split(".").map((n) => parseInt(n, 10) || 0);
  while (p.length < 3) p.push(0);
  p[2] += 1;
  return p.join(".");
}

/**
 * Write `next` into the manifest at `manifestPath`, run `work(next, previous)`, and keep the
 * bump only if `work` resolves. Rejection or a thrown error restores the ORIGINAL file text
 * (not a re-serialization — byte-identical) and rethrows. `onRestore(previous)` runs after a
 * restore so the caller can put derived outputs (a built dist/) back in step.
 *
 * Returns `work`'s result. The manifest is read and written as text here so the restore is
 * exact; `work` receives the version strings, never the parsed object.
 */
export async function withVersionBump(manifestPath, next, work, { onRestore } = {}) {
  const originalText = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(originalText);
  const previous = manifest.version;
  manifest.version = next;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  try {
    return await work(next, previous);
  } catch (error) {
    writeFileSync(manifestPath, originalText);
    if (onRestore) await onRestore(previous);
    throw error;
  }
}

/** Synchronous restore for a signal handler: the original text goes back, nothing else runs. */
export function restoreManifestSync(manifestPath, originalText) {
  writeFileSync(manifestPath, originalText);
}
