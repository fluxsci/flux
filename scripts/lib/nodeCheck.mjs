// WS-0b (fortify plan): local verification must run the runtime CI runs.
// .nvmrc pins 22, CI pins 22, the README requires ≥22.12 — a verify run on an
// older Node produces baselines that are not comparable to the gates.

export const MIN_NODE = "22.12.0";

export function nodeVersionSatisfied(v = process.versions.node) {
  const [maj = 0, min = 0] = v.split(".").map(Number);
  const [wMaj, wMin] = MIN_NODE.split(".").map(Number);
  return maj > wMaj || (maj === wMaj && min >= wMin);
}

/** Fail fast below MIN_NODE. Escape hatch: FLUX_ALLOW_OLD_NODE=1 downgrades the
 *  failure to a loud warning (for machines that genuinely can't run 22). */
export function assertNodeVersion(context) {
  if (nodeVersionSatisfied()) return;
  const msg =
    `${context}: running Node ${process.versions.node}, need ≥ ${MIN_NODE} ` +
    `(.nvmrc and CI pin Node 22 — results on older runtimes are not comparable).`;
  if (process.env.FLUX_ALLOW_OLD_NODE === "1") {
    console.warn(`\n⚠⚠⚠ ${msg}\n⚠⚠⚠ FLUX_ALLOW_OLD_NODE=1 set — continuing on an UNSUPPORTED runtime.\n`);
    return;
  }
  console.error(`✗ ${msg}\n  Fix: \`nvm use\` (or install Node 22 LTS), or rerun with FLUX_ALLOW_OLD_NODE=1 to override.`);
  process.exit(2);
}
