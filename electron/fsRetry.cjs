// Windows sharing violations, in one place for both module systems.
//
// A file another process merely has OPEN cannot be replaced or unlinked there:
// the scanner that reads every freshly written file takes handles without
// FILE_SHARE_DELETE, and the call comes back EPERM/EBUSY/EACCES. It is not a
// permissions problem and it is not the caller's fault — it is a moment to wait
// out. Losing that race reached the owner as "Couldn't save figures" and
// "Couldn't open project: EPERM: operation not permitted" (2026-09-22).
//
// CJS so the Electron main process can `require` it and flux-core can import
// it (the same seam `flux-core/locks.ts` already uses for the lease module).
// No retry at all off win32, where these codes mean what they say.
const SHARING_VIOLATIONS = new Set(["EPERM", "EBUSY", "EACCES"]);
const BUDGET_MS = process.platform === "win32" ? 2500 : 0;
/** @param {number} ms */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `operation`, retrying a Windows sharing violation to a deadline.
 * @template T
 * @param {() => Promise<T>} operation
 * @param {number} [budgetMs]
 * @returns {Promise<T>}
 */
async function shareRetry(operation, budgetMs = BUDGET_MS) {
  if (!budgetMs) return operation();
  const deadline = Date.now() + budgetMs;
  for (let wait = 4; ; wait = Math.min(wait * 2, 120)) {
    try {
      return await operation();
    } catch (caught) {
      const error = /** @type {NodeJS.ErrnoException} */ (caught);
      if (!isSharingViolation(error) || Date.now() >= deadline) throw error;
      // Jitter: contenders that poll in lockstep must not retry in lockstep.
      await delay(wait + Math.floor(Math.random() * wait));
    }
  }
}

/**
 * True when this error is a Windows sharing violation rather than a refusal.
 * @param {unknown} error
 * @returns {boolean}
 */
function isSharingViolation(error) {
  const code = /** @type {NodeJS.ErrnoException | null | undefined} */ (error)?.code;
  return typeof code === "string" && SHARING_VIOLATIONS.has(code);
}

module.exports = { shareRetry, isSharingViolation };
