// F2 file-level reproducibility: runRecipe re-executes a plot's recipe with
// overridden params, captures the emitted SVG, persists the merged params, and
// journals it. (Combined with F1 file-watch, this is the live "regenerate" loop.)
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as core from "../flux-core/index";

const pexec = promisify(execFile);
const REPO = path.resolve(import.meta.dirname, "..");
const TMP = path.join(REPO, "scratch-f2proj");

await fs.rm(TMP, { recursive: true, force: true });
await core.scaffold(TMP, { title: "F2 Test" });

const recipePath = path.join(TMP, "plots", "fig6.recipe.json");
await fs.writeFile(
  recipePath,
  JSON.stringify(
    {
      command: "bash",
      args: [
        "-c",
        'printf \'<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><!-- %s --><rect width="40" height="40" fill="red"/></svg>\' "$FLUX_PARAMS" > out.svg',
      ],
      params: { test: "t-test" },
      output: "out.svg",
    },
    null,
    2,
  ),
);

const results: Record<string, unknown> = {};

// Re-run with an overridden param ("rerun 6d with Mann-Whitney").
const r1 = await core.runRecipe(recipePath, { test: "mann-whitney" });
const svg1 = await fs.readFile(path.join(TMP, "plots", "out.svg"), "utf8");
const recipeAfter = JSON.parse(await fs.readFile(recipePath, "utf8"));
results.run1 = {
  code: r1.code,
  svgReflectsParam: svg1.includes("mann-whitney"),
  paramsPersisted: recipeAfter.params.test === "mann-whitney",
  lastRunStamped: typeof recipeAfter.lastRun === "string",
};

// Journal entry recorded.
const jrnl = await fs.readFile(path.join(TMP, ".meta", "journal.ndjson"), "utf8");
results.journal = jrnl.includes('"action":"rerun-plot"') && jrnl.includes("mann-whitney");

// The actual CLI path: rerun-plot with a different param.
await pexec("npx", ["tsx", "flux-cli.ts", "rerun-plot", recipePath, "--test", "wilcoxon"], { cwd: REPO, env: { ...process.env, FLUX_NO_MIGRATE: "1" } });
const svg2 = await fs.readFile(path.join(TMP, "plots", "out.svg"), "utf8");
results.cliRerun = { svgReflectsParam: svg2.includes("wilcoxon") };

await fs.rm(TMP, { recursive: true, force: true });
console.log(JSON.stringify(results, null, 2));
