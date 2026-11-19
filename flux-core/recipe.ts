import { withRecipeLease, readRecipeText, snapshotRecipe, discardRecipeSnapshot } from "../electron/recipeJob.cjs";
// flux-core/recipe.ts — F2 reproducibility: re-run a plot's recipe (the
// generating script + params) and capture the emitted SVG/manifest (split out
// of index.ts; WS-6.2).

import { recipeInvocation, completedRecipe, recipeOutput } from "../src/lib/plot/recipeContract.mjs";
import { runProcess } from "../electron/processRunner.cjs";
import * as path from "node:path";
import { stamp, journal } from "./journal";
import { readJSON, writeText, findProjectRoot } from "./model";
import { recipeTrustKey, isRecipeRootTrusted, withTrustedRecipeRoot, recipeCommandLine } from "../electron/recipeTrust.cjs";
import { getPreferences, setPreferences } from "./fluxlib";
import { ValidationError } from "./errors";

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
  glbPath?: string;
  manifestPath: string;
  stdout: string;
  stderr: string;
}

/** Options for a headless recipe run. `trust` is the caller saying "this project's recipes may
 *  run on this machine": it is needed once per project and remembered (see assertRecipeTrusted). */
export interface RecipeRunOptions { only?: string | true; signal?: AbortSignal; timeoutMs?: number; trust?: boolean }

/**
 * Recipe workspace trust, the headless half (the app's half is confirmRecipeTrust in
 * electron/main.cjs; both share electron/recipeTrust.cjs and the same preferences list).
 *
 * A recipe names the command a rerun executes, so a project from someone else can name any
 * command. Until the project is trusted on this machine the run is REFUSED, and the refusal
 * shows exactly what would have run. The caller (a person at the CLI, or an agent acting for
 * one) reads it and runs again with `trust`, which runs it and remembers the project.
 */
async function assertRecipeTrusted(recipePath: string, invocation: { executable: string; argv: string[]; cwd: string }, grant: boolean | undefined): Promise<void> {
  const key = recipeTrustKey(recipePath);
  const prefs = await getPreferences();
  if (isRecipeRootTrusted(prefs, key)) return;
  if (grant) {
    await setPreferences({ trustedRecipeRoots: withTrustedRecipeRoot(prefs, key).trustedRecipeRoots });
    return;
  }
  throw new ValidationError(
    `Nothing was run: this project's plot recipes are not trusted on this computer yet.\n` +
      `Project: ${key}\nCommand: ${recipeCommandLine(invocation)}\nWorking directory: ${invocation.cwd}\n` +
      `Re-running a plot runs that command. If the project and the command are the user's own, run it again with trust ` +
      `(CLI: add --trust; MCP: trust: true); Flux remembers the project from then on. ` +
      `If the project came from someone else, show the user the command before trusting it.`,
  );
}

export async function runRecipe(recipePath: string, paramOverrides: Record<string, unknown> = {}, opts: RecipeRunOptions = {}): Promise<RecipeRunResult> {
  return withRecipeLease(recipePath, async assertOwned => runRecipeLocked(recipePath, paramOverrides, opts, assertOwned));
}
async function runRecipeLocked(
  recipePath: string,
  paramOverrides: Record<string, unknown> = {},
  opts: RecipeRunOptions = {},
  assertOwned: () => Promise<void>,
): Promise<RecipeRunResult> {
  const recipe = await readJSON<{
    command: string;
    args?: string[];
    cwd?: string;
    params?: Record<string, unknown>;
    plot?: string;
    output?: string;
    outputs?: { glb?: string; svg?: string; manifest?: string };
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
  await assertRecipeTrusted(recipePath, { executable: recipe.command, argv: args, cwd }, opts.trust);

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

  const output = recipeOutput(completed);
  const out = code === 0 && status === "exited" && output.path ? path.resolve(dir, output.path) : "";
  const root = await findProjectRoot(dir);
  if (root) await journal(root, { action: "rerun-plot", recipe: path.relative(root, recipePath), params, code });

  return {
    code,
    svgPath: output.kind === "svg" ? out : "",
    ...(output.kind === "glb" && out ? { glbPath: out } : {}),
    manifestPath: out && output.manifest ? path.resolve(dir, output.manifest) : "",
    stdout,
    stderr,
  };
}
