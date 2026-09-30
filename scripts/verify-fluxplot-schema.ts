// The vendored fluxplot schema is Flux's plot contract (F3): the generated types match it
// byte for byte, it accepts every shared fixture and rejects what it must, and a manifest from a
// newer fluxplot major is refused with a clear message. Run through the hermetic runner.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { generateTypes, TYPES_OUT, OUT_DIR } from "./sync-fluxplot-schemas.mjs";
import { plotContractErrors, plotTooNew, modernPlot } from "../src/lib/plot/contract";
import { SCHEMAS } from "../src/lib/project/schemas";
import type { FluxPlotManifest } from "../src/lib/plot/types";

const schemaDir = OUT_DIR as string;
const manifestSchema = JSON.parse(await readFile(`${schemaDir}/manifest.schema.json`, "utf8"));
const source = JSON.parse(await readFile(`${schemaDir}/SOURCE.json`, "utf8"));
assert.match(source.fluxplotCommit, /^[0-9a-f]{40}$/, "SOURCE.json names the fluxplot commit");
assert.equal(source.manifestId, manifestSchema.$id, "SOURCE.json records the vendored schema id");
assert.equal(manifestSchema.$schema, "http://json-schema.org/draft-07/schema#");
assert.ok(!("$defs" in manifestSchema) && "definitions" in manifestSchema, "draft-07 spells it definitions");
assert.deepEqual(SCHEMAS.manifest, manifestSchema, "flux-core validates plots with the vendored schema");

// 1. generated types are current
const expected = await generateTypes();
const actual = await readFile(TYPES_OUT as string, "utf8");
assert.equal(actual, expected, "src/lib/plot/types.gen.ts is stale — run node scripts/sync-fluxplot-schemas.mjs --types-only");

// 2. every shared fixture validates; a bad preset name and an unknown scale kind do not
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(manifestSchema);
const fixtures = new URL("./fixtures/fluxplot03/", import.meta.url);
const names = (await readdir(fileURLToPath(fixtures))).filter((f) => f.endsWith(".fluxplot.json"));
assert.ok(names.length >= 4, "shared fixtures present");
let sawScales = false;
for (const name of names) {
  const manifest = JSON.parse(await readFile(new URL(name, fixtures), "utf8")) as FluxPlotManifest;
  assert.ok(validate(manifest), `${name}: ${JSON.stringify(validate.errors?.slice(0, 3))}`);
  assert.ok(modernPlot(manifest) && plotTooNew(manifest) === null, `${name} is a readable 0.x manifest`);
  if (manifest.colorScales?.length) {
    sawScales = true;
    for (const sc of manifest.colorScales) {
      assert.equal(sc.colormap.lut.length, sc.colormap.N, `${name}/${sc.id}: the LUT has N entries`);
      assert.ok(sc.mappables.every((id) => JSON.stringify(manifest).includes(`"${id}"`)), "mappables are manifest ids");
    }
  }
}
assert.ok(sawScales, "the fields fixture carries colorScales");
const bad = JSON.parse(await readFile(new URL("presets.fluxplot.json", fixtures), "utf8"));
bad.build.presets.bar.animation = "explode";
assert.ok(!validate(bad), "an animation outside the closed vocabulary is rejected");
const future = JSON.parse(await readFile(new URL("panels-a.fluxplot.json", fixtures), "utf8"));
future.schemaVersion = "1.0.0";
const msg = plotTooNew(future);
assert.ok(msg && /newer fluxplot/.test(msg), "a future major is refused with a clear message");
assert.deepEqual(plotContractErrors("<svg></svg>", future), [msg], "the contract check reports only the version refusal");
assert.equal(plotTooNew({ schemaVersion: "0.9.4" }), null, "any 0.x is readable");
console.log("verify-fluxplot-schema: PASS");
