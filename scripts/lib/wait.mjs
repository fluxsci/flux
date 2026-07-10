// WS-7.3 (fortify plan): condition-based waiting for the puppeteer verify suite.
// Replaces sleep(N)-and-hope with polling the condition the next line was about
// to assert. Keep a literal sleep only for a genuine debounce/transition, and
// annotate it `// debounce: <ms>`.

/**
 * Poll `pred` (evaluated IN THE PAGE with `arg`) until truthy.
 * Throws with `label` after `timeout` ms.
 */
export async function waitFor(page, pred, arg, { timeout = 5000, interval = 50, label = "condition" } = {}) {
  const t0 = Date.now();
  let lastErr = null;
  for (;;) {
    try {
      const v = await page.evaluate(pred, arg);
      if (v) return v;
      lastErr = null;
    } catch (e) {
      lastErr = e; // page mid-navigation etc. — keep polling until timeout
    }
    if (Date.now() - t0 > timeout)
      throw new Error(`waitFor timed out after ${timeout}ms: ${label}${lastErr ? ` (last error: ${lastErr.message})` : ""}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

export const waitForSelector = (page, sel, o = {}) =>
  waitFor(page, (s) => !!document.querySelector(s), sel, { label: `selector ${sel}`, ...o });

export const waitForGone = (page, sel, o = {}) =>
  waitFor(page, (s) => !document.querySelector(s), sel, { label: `selector gone ${sel}`, ...o });

export const waitForText = (page, sel, text, o = {}) =>
  waitFor(page, ({ s, t }) => [...document.querySelectorAll(s)].some((el) => (el.textContent || "").includes(t)), { s: sel, t: text }, { label: `"${text}" in ${sel}`, ...o });

/** Double-rAF: the next frame has painted. The standard post-keystroke wait. */
export const waitForFrame = (page) =>
  page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
