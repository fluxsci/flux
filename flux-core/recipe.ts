// flux-core/recipe.ts — F2 reproducibility: re-run a plot's recipe (the
// generating script + params) and capture the emitted SVG/manifest (split out
// of index.ts; WS-6.2).

import { spawn } from "node:child_process";
import * as path from "node:path";
import { stamp, journal } from "./journal";
import { readJSON, writeText, findProjectRoot } from "./model";

// --------------------------------------------------------------------------
// F2 reproducibility: re-run a plot's recipe (the generating script + params)
// and capture the emitted SVG/manifest. v0 recipe contract (spec §11.3):
//   { command, args?, cwd?, params?, output, lastRun? }
// The script receives params both as `--key value` flags and as FLUX_PARAMS
// (JSON) in the environment, and is expected to write `output` (an .svg, with an
// optional `<base>.fluxplot.json` sidecar) relative to the recipe's dir.
// --------------------------------------------------------------------------
export interface RecipeRunResult {
  code: number;
  svgPath: string;
  manifestPath: string;
  stdout: string;
  stderr: string;
}

export async function runRecipe(
  recipePath: string,
  paramOverrides: Record<string, string | number | boolean> = {},
  opts: { only?: string | true } = {},
): Promise<RecipeRunResult> {
  const recipe = await readJSON<{
    command: string;
    args?: string[];
    cwd?: string;
    params?: Record<string, unknown>;
    plot?: string;
    output: string;
    lastRun?: string;
  }>(recipePath);
  if (!recipe.command) throw new Error("recipe has no `command`");
  // Targeted rerun (moma feedback #9): a figure-level script that fp.save()s
  // several plots re-runs for ONE of them — FLUXPLOT_ONLY makes every
  // non-matching save a no-op, so sibling panels stay byte-identical on disk.
  // `--only` with no value targets this recipe's own plot name.
  const only = opts.only === true ? recipe.plot : opts.only;
  if (opts.only === true && !only)
    throw new Error("--only needs a plot name (this recipe has no `plot` field to default to)");
  const dir = path.dirname(recipePath);
  const params = { ...(recipe.params ?? {}), ...paramOverrides };
  const args = [...(recipe.args ?? [])];
  for (const [k, v] of Object.entries(params)) args.push(`--${k}`, String(v));
  const cwd = path.resolve(dir, recipe.cwd ?? ".");

  const { code, stdout, stderr } = await new Promise<{ code: number; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(recipe.command, args, {
        cwd,
        env: { ...process.env, FLUX_PARAMS: JSON.stringify(params), ...(only ? { FLUXPLOT_ONLY: only } : {}) },
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", reject);
      child.on("close", (c) => resolve({ code: c ?? 0, stdout: out, stderr: err }));
    },
  );

  // Persist the merged params + last-run time back to the recipe (provenance).
  recipe.params = params;
  recipe.lastRun = stamp();
  await writeText(recipePath, JSON.stringify(recipe, null, 2) + "\n");

  const out = recipe.output ? path.resolve(dir, recipe.output) : "";
  const root = await findProjectRoot(dir);
  if (root) await journal(root, { action: "rerun-plot", recipe: path.relative(root, recipePath), params, code });

  return {
    code,
    svgPath: out,
    manifestPath: out.replace(/\.svg$/, ".fluxplot.json"),
    stdout,
    stderr,
  };
}
