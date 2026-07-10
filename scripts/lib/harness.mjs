// WS-7.4 (fortify plan): shared assert/report lib for verify scripts.
//
// Adoption rule (incremental only): every NEW script uses it; an EXISTING script
// converts when touched for another reason. done() prints a machine-parseable
// sentinel line the runner (run-verifies.mjs) folds into test-results/summary.json:
//
//   ##VERIFY## {"script":"verify-x","ok":true,"checks":12,"failed":0,"ms":345}
//
// Usage:
//   import { harness } from "./lib/harness.mjs";
//   const h = harness("verify-thing");
//   h.section("part one");
//   h.ok(cond, "message");
//   h.eq(actual, expected, "message");
//   await h.done();   // prints sentinel, exits (0 iff no failures)

export function harness(name) {
  const t0 = Date.now();
  let checks = 0;
  let failed = 0;

  const ok = (cond, msg) => {
    checks++;
    if (cond) console.log(`✓ ${msg}`);
    else {
      failed++;
      console.error(`✗ ${msg}`);
    }
    return !!cond;
  };

  const eq = (actual, expected, msg) => {
    const same =
      typeof actual === "object" && actual !== null
        ? JSON.stringify(actual) === JSON.stringify(expected)
        : Object.is(actual, expected);
    return ok(same, same ? msg : `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };

  const fail = (msg) => ok(false, msg);

  const section = (title) => console.log(`\n── ${title} ──`);

  /** Print the sentinel + summary and exit. `cleanup` (optional async) always runs first. */
  const done = async (cleanup) => {
    if (cleanup) {
      try {
        await cleanup();
      } catch (e) {
        fail(`cleanup failed: ${e}`);
      }
    }
    const ms = Date.now() - t0;
    const okAll = failed === 0;
    console.log(
      `##VERIFY## ${JSON.stringify({ script: name, ok: okAll, checks, failed, ms })}`,
    );
    console.log(okAll ? `${name}: PASS (${checks} checks, ${(ms / 1000).toFixed(1)}s)` : `${name}: FAIL (${failed}/${checks} checks failed)`);
    process.exit(okAll ? 0 : 1);
  };

  return { ok, eq, fail, section, done, get failed() { return failed; }, get checks() { return checks; } };
}
