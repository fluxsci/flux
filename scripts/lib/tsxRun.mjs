// How a gate runs a TypeScript entry point in a CHILD process.
//
// Never `npx`: win32 has no bare `npx` executable (only `npx.cmd`), so an
// unshelled spawn dies with ENOENT and takes the gate with it — the same trap
// `run-verifies.mjs` hit with `npm`. Thirteen gates spawned `npx tsx …` and all
// of them were unrunnable on Windows (2026-09-22), which is most of what made
// the pure tier look broken there. Going straight to the installed CLI with
// THIS node also skips a resolution step and honours the running runtime.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The tsx CLI this checkout installed. */
export function tsxCli() {
  try {
    return createRequire(import.meta.url).resolve("tsx/cli");
  } catch {
    return path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  }
}

/** `[file, args]` for execFile/spawn: run `entry` under tsx with `rest`. */
export function tsxRun(entry, rest = []) {
  return [process.execPath, [tsxCli(), entry, ...rest]];
}
