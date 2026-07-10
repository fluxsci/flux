// Build identity for the headless entry points (moma feedback #2/#3): the
// installed dist/flux-cli.mjs had silently drifted behind the source CLI —
// documented verbs were missing and nothing could say WHICH revision either
// entry point was. Bundles get { version, commit, builtAt } baked in by
// esbuild `define` (scripts/build-cli.mjs); source runs (tsx) resolve the
// same fields live from package.json + git. `flux version`, `flux config`,
// and the MCP config_paths tool all surface it, and release-check fails when
// the bundle's commit is not the working tree's HEAD.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

declare const __FLUX_BUILD__: { version: string; commit: string; builtAt: string } | undefined;

export interface BuildInfo {
  version: string;
  commit: string;
  builtAt: string;
  /** "bundle" = dist/*.mjs (stamped at build time); "source" = tsx over the repo. */
  entry: "bundle" | "source";
}

export function buildInfo(): BuildInfo {
  if (typeof __FLUX_BUILD__ !== "undefined" && __FLUX_BUILD__) {
    return { ...__FLUX_BUILD__, entry: "bundle" };
  }
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  let version = "0.0.0";
  try {
    version = (JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { version?: string }).version ?? version;
  } catch {
    /* packaged without package.json — version stays unknown */
  }
  let commit = "unknown";
  try {
    commit = execSync("git rev-parse --short HEAD", { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    const dirty = execSync("git status --porcelain", { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    if (dirty) commit += "-dirty";
  } catch {
    /* not a git checkout */
  }
  return { version, commit, builtAt: "(live source)", entry: "source" };
}
