// A hermetic stand-in for fluxplot in verify-colorscale-verb: `set-plot-color-scale --regenerate`
// runs the plot's recipe with FLUX_PARAMS carrying the complete v2 `__fluxplot__` control; this
// stub records what it received and "regenerates" by copying the fixture that a real fluxplot
// produced for exactly that control (hexmatrix-edited = {cmap: magma, vmax: 20} over the log
// scale), so the gate proves the wiring without a Python toolchain.
//   argv: [node, stub_recipe.mjs, <targetDir>, <fixturesDir>]
import { copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [, , targetDir, fixturesDir] = process.argv;
const params = JSON.parse(process.env.FLUX_PARAMS ?? "{}");
const rates = params.__fluxplot__?.rates;
if (!rates) { console.error("stub recipe: FLUX_PARAMS carries no __fluxplot__.rates control"); process.exit(3); }
const edited = rates.cmap === "magma" && rates.vmax === 20;
const src = edited ? "hexmatrix-edited" : "hexmatrix";
copyFileSync(join(fixturesDir, `${src}.svg`), join(targetDir, "hexmatrix.svg"));
copyFileSync(join(fixturesDir, `${src}.fluxplot.json`), join(targetDir, "hexmatrix.fluxplot.json"));
writeFileSync(join(targetDir, "hexmatrix.stub-params.json"), JSON.stringify(params, null, 2) + "\n");
console.log(`stub recipe: wrote ${src} for ${JSON.stringify(rates)}`);
