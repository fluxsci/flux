// Tiny check harness shared by the verify scripts. Prints the ##VERIFY##
// sentinel line and exits non-zero on any failure (same convention as Flux's
// gates, independently owned).
let checks = 0;
let failed = 0;

export function check(name, cond, detail = "") {
  checks += 1;
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

export async function checkAsync(name, fn) {
  try {
    const r = await fn();
    check(name, r !== false);
  } catch (e) {
    checks += 1;
    failed += 1;
    console.log(`  ✗ ${name} — ${e && e.message ? e.message : e}`);
  }
}

export function section(title) {
  console.log(`\n== ${title}`);
}

export function finish(label) {
  console.log(`\n##VERIFY## ${JSON.stringify({ label, checks, failed })}`);
  process.exit(failed ? 1 : 0);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Condition-based wait (never bare-sleep for something observable).
export async function waitFor(fn, { timeout = 8000, interval = 50, desc = "condition" } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${desc}`);
    await sleep(interval);
  }
}
