// WS-9.1: pre-generate the project-format validators (Ajv standalone codegen)
// into a committed module. Ajv compiles schemas via `new Function` at runtime —
// string-eval the renderer CSP rightly refuses (script-src has no 'unsafe-eval',
// and adding it would gut the policy). The generated module is pure functions:
// CSP-clean, byte-stable for a fixed schema + Ajv version, and drift-gated by
// verify-loadgate.ts (same pattern as the buildInfo gate).
//
//   Regenerate:  node --import tsx scripts/gen-validators.mjs
//   Check only:  node --import tsx scripts/gen-validators.mjs --check
import { Ajv } from "ajv";
import { build } from "esbuild";
import standaloneCode from "ajv/dist/standalone/index.js";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMAS } from "../src/lib/project/schemas.ts";

export const OUT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "lib",
  "project",
  "validators.gen.js",
);

export const KEYS = ["model", "canvas", "figIndex", "deck", "project"];

// ---------------------------------------------------------------------------
// Every repeated piece of the schemas is compiled ONCE.
//
// The five schemas are built from the same parts (the element union, a figure,
// an image's view, a stagger, a curve ...), and Ajv writes a part's code out at
// every place it is used: the element union alone was written three times, at
// about 340 KB each. Compiled that way the validators were 1.63 MB, a quarter of
// the CLI bundle (verify-w13-cli's budget) and the largest module the renderer
// parses at startup. `shareRepeats` gives every part that occurs more than once
// its own schema, referenced by `$ref`, so its code exists once and the others
// call it: 0.52 MB, the same documents accepted, the same errors in the same
// order (verify-validators-shared.ts compares against the plain compilation).
//
// This is a property of the GENERATED code only. `SCHEMAS` (what `flux schema`
// publishes, what agents read) stays self-contained: nothing here changes it.
// ---------------------------------------------------------------------------

/** A part smaller than this (its JSON, in bytes) is written in place: below it a call costs about what the code does. */
export const SHARE_MIN_BYTES = 200;
const ONE_SCHEMA = new Set(["additionalProperties", "additionalItems", "contains", "propertyNames", "not", "if", "then", "else"]);
const SCHEMA_MAP = new Set(["properties", "patternProperties"]);
const SCHEMA_LIST = new Set(["oneOf", "anyOf", "allOf"]);
/** Keywords whose values are plain data. A keyword in none of the four lists stops the generator: a new one is sorted
 *  into the right list by a person, never guessed (a schema taken for data would be compiled as written, which is
 *  only larger; data taken for a schema would be rewritten, which is wrong). */
const DATA = new Set(["$schema", "$id", "title", "description", "type", "required", "enum", "const", "pattern", "minimum", "maximum",
  "exclusiveMinimum", "exclusiveMaximum", "minItems", "maxItems", "minLength", "maxLength", "minProperties", "maxProperties",
  "multipleOf", "uniqueItems", "format", "default", "examples", "$comment"]);
const isSchema = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** `s` with every sub-schema replaced by `visit(sub)`; everything that is data is kept as it is. */
function mapSubSchemas(s, visit) {
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === "items") out[k] = Array.isArray(v) ? v.map((c) => (isSchema(c) ? visit(c) : c)) : isSchema(v) ? visit(v) : v;
    else if (ONE_SCHEMA.has(k)) out[k] = isSchema(v) ? visit(v) : v;
    else if (SCHEMA_MAP.has(k)) out[k] = Object.fromEntries(Object.entries(v).map(([name, c]) => [name, isSchema(c) ? visit(c) : c]));
    else if (SCHEMA_LIST.has(k)) out[k] = v.map((c) => (isSchema(c) ? visit(c) : c));
    else if (DATA.has(k)) out[k] = v;
    else throw new Error(`gen-validators: schema keyword "${k}" is not sorted yet (see DATA in scripts/gen-validators.mjs)`);
  }
  return out;
}

/** A root schema with its own `#/definitions/<name>` references written out in place (they are found again, as
 *  repeats, below). A definition that contains itself cannot be written out and stops the generator. */
function writeOutDefinitions(root) {
  const { definitions = {}, ...rest } = root;
  const open = new Set();
  const go = (s) => {
    if (s.$ref === undefined) return mapSubSchemas(s, go);
    const name = /^#\/definitions\/([^/]+)$/.exec(String(s.$ref))?.[1];
    if (name === undefined || !isSchema(definitions[name]) || Object.keys(s).length !== 1) throw new Error(`gen-validators: unsupported $ref ${JSON.stringify(s)}`);
    if (open.has(name)) throw new Error(`gen-validators: definition "${name}" contains itself`);
    open.add(name);
    const out = go(definitions[name]);
    open.delete(name);
    return out;
  };
  return go(rest);
}

/**
 * The schemas with every part that occurs more than once (the same JSON, at least `minBytes` of it) moved into a
 * schema of its own and referenced. Parts nest: a shared part references the shared parts inside it.
 * Returns the rewritten roots (same keys, same order) and the shared schemas in the order they were first met, so
 * the output is a function of the schemas alone.
 */
export function shareRepeats(schemas, minBytes = SHARE_MIN_BYTES) {
  const text = new Map(), uses = new Map();
  const tally = (s) => {
    const copy = mapSubSchemas(s, tally), t = JSON.stringify(copy);
    text.set(copy, t);
    uses.set(t, (uses.get(t) ?? 0) + 1);
    return copy;
  };
  const whole = Object.entries(schemas).map(([key, s]) => [key, tally(writeOutDefinitions(s))]);
  // A part that repeats only INSIDE a larger repeated part is written once already, with it: count the places a
  // part is reached when every repeat is entered once, and share what is still reached from two.
  const reached = new Map(), entered = new Set();
  const reach = (s) => {
    const t = text.get(s);
    if (t.length >= minBytes && uses.get(t) > 1) {
      reached.set(t, (reached.get(t) ?? 0) + 1);
      if (entered.has(t)) return s;
      entered.add(t);
    }
    mapSubSchemas(s, reach);
    return s;
  };
  for (const [, s] of whole) mapSubSchemas(s, reach);
  const idOf = new Map(), shared = [];
  const rewrite = (s) => {
    const t = text.get(s);
    if ((reached.get(t) ?? 0) < 2) return mapSubSchemas(s, rewrite);
    let id = idOf.get(t);
    if (id === undefined) {
      // An absolute id: a relative one would be resolved against the id of whichever schema refers to it.
      idOf.set(t, id = `urn:flux:shared:${idOf.size}`);
      const part = { $id: id };
      shared.push(part);
      Object.assign(part, mapSubSchemas(s, rewrite));
    }
    return { $ref: id };
  };
  // A root is never replaced by a reference itself: it keeps its own $id and title.
  return { roots: Object.fromEntries(whole.map(([key, s]) => [key, mapSubSchemas(s, rewrite)])), shared };
}

/** The Ajv options of the project-format validators; `verify-validators-shared.ts` compiles the plain schemas with the same. */
export const AJV_OPTIONS = { strict: false, strictNumbers: true, allErrors: true };

export function generate() {
  // inlineRefs off: Ajv would otherwise write a referenced schema that holds no reference of its own back in place.
  const ajv = new Ajv({ ...AJV_OPTIONS, inlineRefs: false, code: { source: true, esm: true } });
  const { roots, shared } = shareRepeats(Object.fromEntries(KEYS.map((key) => [key, SCHEMAS[key]])));
  // Each shared part is a schema of its own (not a definition inside one holder): Ajv compiles a schema it was given
  // once, whoever refers to it, but a pointer INTO a schema once per schema that refers to it.
  for (const part of shared) ajv.addSchema(part);
  const mapping = {};
  for (const key of KEYS) {
    ajv.addSchema(roots[key], key);
    mapping[`validate_${key}`] = key;
  }
  const code = standaloneCode(ajv, mapping);
  return (
    "// GENERATED — do not edit. Ajv standalone codegen over src/lib/project/schemas.ts.\n" +
    "// Regenerate with `node --import tsx scripts/gen-validators.mjs` (drift-gated by\n" +
    "// verify-loadgate.ts). Generated so the renderer never string-evals (CSP, WS-9.1).\n" +
    "/* eslint-disable */\n" +
    code +
    "\n"
  );
}

export const SCENE3D_OUT = path.resolve(path.dirname(OUT), "../model3d/scene3dValidator.gen.mjs");
export function generateScene3d() {
  // unicode:false avoids Ajv's CommonJS length helper in the standalone ESM.
  const ajv = new Ajv({ strict: false, strictNumbers: true, unicode: false, allErrors: true, code: { source: true, esm: true } });
  ajv.addSchema(SCHEMAS.scene3d, "scene3d");
  return "// GENERATED by scripts/gen-validators.mjs; do not edit.\n/* eslint-disable */\n" + standaloneCode(ajv, { validateScene3d: "scene3d" }) + "\n";
}
export const SCENE3D_NATIVE_OUT = path.resolve(path.dirname(OUT), "../model3d/scene3d.native.gen.mjs");
export async function generateScene3dNative() {
  const root = path.resolve(path.dirname(OUT), "../../..");
  const result = await build({ absWorkingDir: root, entryPoints: ["src/lib/model3d/scene3d.ts"], bundle: true, write: false, platform: "node", format: "esm", target: "node22", banner: { js: "// GENERATED by scripts/gen-validators.mjs; do not edit." } });
  return result.outputFiles[0].text;
}
export const MODEL3D_IMPORT_OUT = path.resolve(path.dirname(OUT), "../model3d/importData.native.gen.mjs");
export async function generateModel3dImportNative() {
  const root = path.resolve(path.dirname(OUT), "../../..");
  const result = await build({ absWorkingDir: root, entryPoints: ["src/lib/model3d/importData.ts"], bundle: true, write: false, platform: "node", format: "esm", target: "node22", banner: { js: "// GENERATED by scripts/gen-validators.mjs; do not edit." } });
  return result.outputFiles[0].text;
}
export async function generateFiles(check = false) {
  for (const [out, next] of [[OUT, generate()], [SCENE3D_OUT, generateScene3d()]]) {
    const prev = await fs.readFile(out, "utf8").catch(() => null);
    if (check && prev !== next) throw new Error(`${path.basename(out)} is STALE — run: node --import tsx scripts/gen-validators.mjs`);
    if (!check && prev !== next) await fs.writeFile(out, next);
    console.log(`${path.basename(out)} ${check ? "is fresh" : prev === next ? "unchanged" : "generated"}`);
  }
  const native = await generateScene3dNative();
  const prev = await fs.readFile(SCENE3D_NATIVE_OUT, "utf8").catch(() => null);
  if (check && prev !== native) throw new Error("scene3d.native.gen.mjs is STALE — run canonical generator");
  if (!check && prev !== native) await fs.writeFile(SCENE3D_NATIVE_OUT, native);
  console.log(`scene3d.native.gen.mjs ${check ? "is fresh" : "generated"}`);
  const importNative = await generateModel3dImportNative();
  const importPrev = await fs.readFile(MODEL3D_IMPORT_OUT, "utf8").catch(() => null);
  if (check && importPrev !== importNative) throw new Error("importData.native.gen.mjs is STALE — run canonical generator");
  if (!check && importPrev !== importNative) await fs.writeFile(MODEL3D_IMPORT_OUT, importNative);
  console.log(`importData.native.gen.mjs ${check ? "is fresh" : "generated"}`);
}
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await generateFiles(process.argv.includes("--check"));
