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

const KEYS = ["model", "canvas", "figIndex", "deck", "project"];

export function generate() {
  const ajv = new Ajv({ strict: false, allErrors: true, code: { source: true, esm: true } });
  const mapping = {};
  for (const key of KEYS) {
    ajv.addSchema(SCHEMAS[key], key);
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

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const next = generate();
  const prev = await fs.readFile(OUT, "utf8").catch(() => null);
  if (process.argv.includes("--check")) {
    if (prev === next) {
      console.log("validators.gen.js is fresh");
    } else {
      console.error("validators.gen.js is STALE — run: node --import tsx scripts/gen-validators.mjs");
      process.exit(1);
    }
  } else if (prev === next) {
    console.log("validators.gen.js unchanged");
  } else {
    await fs.writeFile(OUT, next);
    console.log(`wrote ${OUT} (${next.length} bytes)`);
  }
}
