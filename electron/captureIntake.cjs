// Web-capture intake (main-process side).
//
// Extracted from main.cjs so scripts/verify-capture-e2e.cjs can require() it under `electron`
// without booting the app — the same seam proxyFetch.cjs uses, and for the same reason: this
// is the code that MOVES FILES OUT OF THE USER'S DOWNLOAD FOLDER, so it deserves a real test
// rather than a mirror of its logic.
//
// It lives in main rather than the renderer because fsGuard deliberately refuses $HOME
// (W12/SHL-6): a renderer-side move out of Downloads would be refused, and widening the guard
// to cover the whole download folder would trade a real security boundary for convenience.
// So main does one tightly-scoped job — move `flux-*.pdf` into pdfs_to_assign/, hand back the
// `.fluxcap` sidecars — and nothing that fails the shared capture-filename rule is ever read,
// moved, or deleted.

/** Smallest plausible PDF. Below this it's a stub or still arriving; leave it for next pass. */
const MIN_PDF_BYTES = 1024;

/**
 * @param {object} deps
 * @param {() => string|null} deps.captureDir   the browser's download folder
 * @param {() => string} deps.fluxLibDir        FluxLib root (pdfs_to_assign lives under it)
 * @param {any} deps.path @param {any} deps.fs @param {any} deps.fsp
 * @param {() => Promise<any>} deps.loadRules   dynamic import of ./captureRules.js (ESM)
 */
function createCaptureIntake({ captureDir, fluxLibDir, path, fs, fsp, loadRules }) {
  let rules = null;
  const ready = async () => (rules ??= await loadRules().catch(() => null));

  /** Move captured PDFs into the assign inbox; return sidecars for the caller to resolve. */
  async function intake() {
    const dir = captureDir();
    await ready();
    if (!dir || !rules) return { pdfs: [], sidecars: [], supplements: [] };
    // Two drop points — see captureSubsystemFor in main.cjs. Each entry keeps the subdir it
    // came from so the file can be found again.
    const dirs = [dir, path.join(dir, rules.CAPTURE_SUBDIR)];
    const found = [];
    for (const d of dirs) {
      try {
        for (const n of (await fsp.readdir(d)).sort()) if (rules.isCaptureFile(n)) found.push({ dir: d, name: n });
      } catch {
        /* that drop point doesn't exist yet */
      }
    }
    if (!found.length) return { pdfs: [], sidecars: [], supplements: [] };
    const inbox = path.join(fluxLibDir(), "pdfs_to_assign");
    // Captured SUPPLEMENTS can't be filed yet: they belong to a paper that may not have been
    // identified (or even added) until the article PDF goes through the assign scan. So they
    // are staged inside FluxLib — which the renderer CAN reach, unlike the download folder —
    // and filed against their citekey on a later pass.
    const staging = path.join(inbox, "_captured_supplements");
    const pdfs = [];
    const sidecars = [];
    const supplements = [];
    for (const { dir: from, name } of found) {
      const src = path.join(from, name);
      try {
        if (rules.isSupplementCapture(name)) {
          await fsp.mkdir(staging, { recursive: true });
          let dst = path.join(staging, name);
          for (let i = 2; fs.existsSync(dst); i++) dst = path.join(staging, `${i}-${name}`);
          await fsp.rename(src, dst).catch(async () => {
            await fsp.copyFile(src, dst);
            await fsp.rm(src, { force: true });
          });
          supplements.push(path.basename(dst));
          continue;
        }
        if (/\.fluxcap$/i.test(name)) {
          sidecars.push({ name, json: await fsp.readFile(src, "utf8") });
          continue;
        }
        const st = await fsp.stat(src);
        if (!st.isFile() || st.size < MIN_PDF_BYTES) continue;
        await fsp.mkdir(inbox, { recursive: true });
        let dst = path.join(inbox, name);
        const base = name.replace(/\.pdf$/i, "");
        for (let i = 2; fs.existsSync(dst); i++) dst = path.join(inbox, `${base}-${i}.pdf`);
        // Downloads and FluxLib can live on different filesystems, where rename() fails.
        await fsp.rename(src, dst).catch(async () => {
          await fsp.copyFile(src, dst);
          await fsp.rm(src, { force: true });
        });
        pdfs.push(path.basename(dst));
      } catch {
        /* leave it in place; the next pass retries */
      }
    }
    return { pdfs, sidecars, supplements };
  }

  /** Delete one sidecar, once the caller has resolved it. Name-only, and it must satisfy the
   *  shared capture rule — so this can never be aimed at an arbitrary file. */
  async function discard(name) {
    const dir = captureDir();
    await ready();
    if (!dir || !rules) return { error: "capture unavailable" };
    if (typeof name !== "string" || path.basename(name) !== name) return { error: "bad name" };
    if (!rules.isCaptureFile(name)) return { error: "not a capture" };
    try {
      await fsp.rm(path.join(dir, name), { force: true });
      return { ok: true };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  }

  return { intake, discard };
}

module.exports = { createCaptureIntake, MIN_PDF_BYTES };
