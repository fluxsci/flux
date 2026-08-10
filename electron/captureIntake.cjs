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
//
// `intake()` runs only when the user asks: at startup, or from the Library's Assign button.
// `count()` is the read-only half that lets the button say how many are waiting WITHOUT
// moving anything, so the download folder is never rearranged behind the user's back.

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

  /** Both drop points, in order — see captureSubsystemFor in main.cjs. Each entry keeps the
   *  subdir it came from so the file can be found again. */
  async function scan() {
    const dir = captureDir();
    await ready();
    if (!dir || !rules) return null;
    const found = [];
    for (const d of [dir, path.join(dir, rules.CAPTURE_SUBDIR)]) {
      try {
        for (const n of (await fsp.readdir(d)).sort()) if (rules.isCaptureFile(n)) found.push({ dir: d, name: n });
      } catch {
        /* that drop point doesn't exist yet */
      }
    }
    return found;
  }

  /**
   * How many captures are WAITING, without touching one of them.
   *
   * Intake is user-initiated — startup or the Library's Assign button — so the button needs a
   * number BEFORE anything moves. This is that number and nothing else: readdir plus a stat,
   * no mkdir, no rename, no delete. It applies the same size floor intake() does, so the count
   * never promises a half-downloaded file that intake would then skip.
   */
  async function count() {
    const found = await scan();
    if (!found?.length) return 0;
    let n = 0;
    for (const { dir: from, name } of found) {
      if (rules.isSupplementCapture(name) || /\.fluxcap$/i.test(name)) {
        n++;
        continue;
      }
      try {
        const st = await fsp.stat(path.join(from, name));
        if (st.isFile() && st.size >= MIN_PDF_BYTES) n++;
      } catch {
        /* vanished mid-scan */
      }
    }
    return n;
  }

  /** Move captured PDFs into the assign inbox; return sidecars for the caller to resolve. */
  async function intake() {
    const found = await scan();
    if (!found?.length) return { pdfs: [], sidecars: [], supplements: [] };
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

  /**
   * Set a capture aside that cannot be resolved — DEFINITIVELY, not because the network
   * blinked. It moves into FluxLib's `_unresolved/` beside a note, the same place the assign
   * flow parks a PDF it refuses to guess at. Nothing the user captured is ever deleted, and
   * nothing unresolvable is retried forever (a permanently-403 sidecar otherwise re-failed on
   * every startup and every window focus, toasting each time).
   */
  async function park(name, note) {
    const dir = captureDir();
    await ready();
    if (!dir || !rules) return { error: "capture unavailable" };
    if (typeof name !== "string" || path.basename(name) !== name || !rules.isCaptureFile(name)) return { error: "not a capture" };
    const src = [path.join(dir, name), path.join(dir, rules.CAPTURE_SUBDIR, name)].find((p) => fs.existsSync(p));
    if (!src) return { error: "gone" };
    try {
      const out = path.join(fluxLibDir(), "pdfs_to_assign", "_unresolved");
      await fsp.mkdir(out, { recursive: true });
      let dst = path.join(out, name);
      for (let i = 2; fs.existsSync(dst); i++) dst = path.join(out, `${i}-${name}`);
      await fsp.rename(src, dst).catch(async () => {
        await fsp.copyFile(src, dst);
        await fsp.rm(src, { force: true });
      });
      await fsp.writeFile(`${dst}.txt`, `Could not add "${name}" to FluxLib.\nReason: ${String(note || "unknown")}\n\nThe capture itself is intact next to this note. If the paper is reachable in your\nbrowser, capturing it again is usually the quickest fix.\n`, "utf8");
      return { ok: true, path: dst };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
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

  return { count, intake, discard, park };
}

/**
 * Pick the newest signed add-on from a list of `.xpi` filenames (`<hash>-<version>.xpi`).
 *
 * Every `npm run sign:extension` BUMPS the version and leaves the previous artifact in place, so
 * this directory accumulates. Taking the first `.xpi` readdir happens to return offered the user
 * a STALE build — a signed 0.1.0 sitting next to the 0.1.1 that dist/ was just built from, which
 * is the worst possible moment to hand back the old bytes: right after someone signs a fix.
 * Lives here rather than in main.cjs so a gate can call the real function.
 */
function newestXpi(names) {
  const parts = (f) => (/-(\d+(?:\.\d+)*)\.xpi$/.exec(f)?.[1] ?? "0").split(".").map(Number);
  let best = null;
  for (const f of names) {
    if (!/\.xpi$/i.test(f)) continue;
    if (!best) {
      best = f;
      continue;
    }
    const a = parts(best);
    const b = parts(f);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i] ?? 0;
      const y = b[i] ?? 0;
      if (x !== y) {
        if (y > x) best = f;
        break;
      }
    }
  }
  return best;
}

module.exports = { createCaptureIntake, MIN_PDF_BYTES, newestXpi };
