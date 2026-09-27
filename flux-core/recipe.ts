import { withRecipeLease, readRecipeText, snapshotRecipe, discardRecipeSnapshot } from "../electron/recipeJob.cjs";
// flux-core/recipe.ts — F2 reproducibility: re-run a plot's recipe (the
// generating script + params) and capture the emitted SVG/manifest (split out
// of index.ts; WS-6.2).

import { recipeInvocation, completedRecipe } from "../src/lib/plot/recipeContract.mjs";
import { runProcess } from "../electron/processRunner.cjs";
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

export async function runRecipe(recipePath: string, paramOverrides: Record<string, unknown> = {}, opts: {only?: string | true; signal?: AbortSignal; timeoutMs?: number} = {}): Promise<RecipeRunResult> {
  return withRecipeLease(recipePath, async assertOwned => runRecipeLocked(recipePath, paramOverrides, opts, assertOwned));
}
async function runRecipeLocked(
  recipePath: string,
  paramOverrides: Record<string, unknown> = {},
  opts: { only?: string | true; signal?: AbortSignal; timeoutMs?: number } = {},
  assertOwned: () => Promise<void>,
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
  const { params, args } = recipeInvocation(recipe, paramOverrides);
  const cwd = path.resolve(dir, recipe.cwd ?? ".");

  const snapshot = await snapshotRecipe(recipePath, await readRecipeText(recipePath));
  const { code, stdout, stderr, status } = await runProcess({ executable: recipe.command, argv: args, cwd,
    envDelta: { FLUX_PARAMS: JSON.stringify(params), ...(only ? { FLUXPLOT_ONLY: only } : {}) } }, opts);
  let completed = recipe;

  // Persist the merged params + last-run time back to the recipe (provenance).
  if (code === 0 && status === "exited") {
    // save() may have regenerated provenance, input hashes and output paths.
    // Preserve that new sidecar instead of writing the pre-run snapshot over it.
    let emitted: typeof recipe;
    try { emitted = JSON.parse(await readRecipeText(recipePath)); recipeInvocation(emitted, {}); }
    catch (error) { throw new Error(`The command emitted malformed recipe metadata. Previous good recipe: ${snapshot}`, {cause: error}); }
    recipeInvocation(emitted, {});
    completed = completedRecipe(emitted, params, paramOverrides, stamp());
    await assertOwned();
    await writeText(recipePath, JSON.stringify(completed, null, 2) + "\n");
    await discardRecipeSnapshot(snapshot);
  }

  const out = code === 0 && status === "exited" && completed.output ? path.resolve(dir, completed.output) : "";
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
