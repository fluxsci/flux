#!/usr/bin/env -S npx tsx
// WS-5.1 (fortify plan) — the load-gate validator contract:
//   · the element schema is a discriminated oneOf (legacy "svg" kind REMOVED —
//     validation runs post-migration, and the drift test pins the branch list
//     against the Element union);
//   · NaN geometry (JSON null) is REJECTED at load and REPAIRED at save
//     (sanitizeProjectGeometry);
//   · a legacy doc fails RAW but passes after migrateProject (the
//     parse → migrate → validate ordering contract);
//   · flux-core resolves the same validators (one compile, GUI + CLI).
//   npx tsx scripts/verify-loadgate.ts

import { validateModel, validateCanvasFile, validateDeckFile, sanitizeProjectGeometry } from "../src/lib/project/validate";
import { validateModel as coreValidateModel } from "../flux-core/validate";
import { SCHEMAS } from "../src/lib/project/schemas";
import { migrateProject } from "../src/lib/migrate";
import type { Element, Project } from "../src/lib/types";

let failures = 0;
const ok = (m: string) => console.log("  ok:", m);
const fail = (m: string) => {
  console.error("  ✗ FAIL:", m);
  failures++;
};
const assert = (c: unknown, m: string) => (c ? ok(m) : fail(m));

// ---- drift gate: the schema's discriminant branches === Element["type"] ------
// The literal is pinned to the union at COMPILE time (satisfies + exhaustive
// check under svelte-check/tsc); the runtime half pins the schema against it.
const ALL_TYPES = ["image", "text", "rect", "ellipse", "line", "path", "plot"] as const satisfies readonly Element["type"][];
type _Missing = Exclude<Element["type"], (typeof ALL_TYPES)[number]>;
const _exhaustive: _Missing extends never ? true : never = true;
void _exhaustive;
{
  const oneOf = (SCHEMAS.canvas as { definitions: { element: { oneOf: { properties: { type: { const: string } } }[] } } })
    .definitions.element.oneOf;
  const branchTypes = oneOf.map((b) => b.properties.type.const).sort();
  assert(
    JSON.stringify(branchTypes) === JSON.stringify([...ALL_TYPES].sort()),
    `schema element branches === Element union (${branchTypes.join(",")})`,
  );
  assert(!branchTypes.includes("svg"), 'legacy "svg" kind removed from the schema');
}

const rect = (over: Record<string, unknown> = {}) => ({
  type: "rect", id: "r1", x: 0, y: 0, width: 10, height: 10, rotation: 0, fill: "#000", stroke: "#000", strokeWidth: 1, cornerRadius: 0, ...over,
});
const model = (elements: unknown[]): unknown => ({
  version: 2,
  name: "t",
  canvases: [{ id: "c1", name: "C" }],
  figures: [{ id: "f1", canvasId: "c1", x: 0, y: 0, width: 100, height: 100, elements }],
  assets: [],
  palette: [],
});

// ---- happy paths ------------------------------------------------------------
assert(validateModel(model([rect()])).length === 0, "valid rect model passes");
assert(
  validateModel(
    model([
      { type: "line", id: "l1", x: 0, y: 0, x1: 0, y1: 0, x2: 5, y2: 5, width: 0, height: 0, rotation: 0, stroke: "#000", strokeWidth: 1 },
      { type: "text", id: "t1", x: 0, y: 0, width: 20, height: 10, rotation: 0, text: "hi", fontFamily: "Inter", fontSize: 10, fontWeight: 400, fontStyle: "normal", align: "left", color: "#111", sizing: "auto" },
      { type: "plot", id: "p1", assetId: "a1", x: 0, y: 0, width: 50, height: 40, rotation: 0, overrides: {} },
      { type: "path", id: "pa1", x: 0, y: 0, width: 10, height: 10, rotation: 0, d: "M0 0 L1 1" },
    ]),
  ).length === 0,
  "every element kind validates",
);
assert(validateModel(model([rect({ futureExtraKey: { nested: true } })])).length === 0, "extra keys stay permissive (agent files load)");

// ---- rejections ----------------------------------------------------------------
assert(validateModel(model([rect({ x: null })])).length > 0, "NaN-as-null geometry REJECTED");
assert(validateModel(model([rect({ width: "12" })])).length > 0, "string geometry rejected");
assert(validateModel(model([{ type: "plot", id: "p", x: 0, y: 0, width: 1, height: 1, rotation: 0 }])).length > 0, "plot without assetId rejected");
assert(validateModel(model([{ id: "e", x: 0, y: 0 }])).length > 0, "element without a type rejected");
assert(validateModel(model([rect({ type: "svg", assetId: "a" })])).length > 0, 'RAW legacy "svg" element rejected (pre-migration)');

// ---- parse → migrate → validate ordering ------------------------------------------
{
  const legacy = model([
    { type: "svg", id: "s1", assetId: "a1", x: 0, y: 0, width: 40, height: 30, rotation: 0 },
    rect({ autoWidth: true, type: "text", text: "x", fontFamily: "F", fontSize: 10, fontWeight: 400, fontStyle: "normal", align: "left", color: "#000", id: "t9" }),
  ]) as Project;
  assert(validateModel(legacy).length > 0, "legacy doc FAILS raw validation");
  migrateProject(legacy);
  const errs = validateModel(legacy);
  assert(errs.length === 0, `legacy doc PASSES post-migration (${errs.slice(0, 2).join("; ") || "clean"})`);
}

// ---- canvas + deck file validators -----------------------------------------------
assert(validateCanvasFile({ id: "c1", figures: [] }).length === 0, "minimal canvas file passes");
assert(validateCanvasFile({ figures: [] }).length > 0, "canvas file without id rejected");
assert(validateDeckFile({ schemaVersion: "0.2.0", id: "d", title: "T", theme: "flux-dark", stage: { width: 640, height: 360 }, slides: [] }).length === 0, "minimal deck passes");
assert(validateDeckFile({ schemaVersion: "0.1.0", id: "d", title: "T", theme: "flux-dark", stage: { width: 640, height: 360 }, slides: [] }).length > 0, "a 0.1.x deck fails (clean break — quarantined at the read seam, never migrated)");
assert(validateDeckFile({ id: "d" }).length > 0, "structurally-broken deck rejected");

// ---- one compile, both engines ------------------------------------------------------
assert(coreValidateModel === validateModel, "flux-core re-exports the SAME validator instance (one compile)");

// ---- sanitizeProjectGeometry ---------------------------------------------------------
{
  const p = model([
    rect({ x: NaN, width: Infinity }),
    { type: "line", id: "l", x: 0, y: NaN, x1: 0, y1: 0, x2: NaN, y2: 1, width: 0, height: 0, rotation: 0, stroke: "#000", strokeWidth: 1 },
  ]) as Project;
  (p.figures[0] as { y: number }).y = -Infinity;
  const fixed = sanitizeProjectGeometry(p);
  assert(fixed === 5, `sanitize repaired exactly the 5 non-finite fields (${fixed})`);
  assert(validateModel(JSON.parse(JSON.stringify(p))).length === 0, "sanitized model survives a JSON round-trip + validation");
  const again = sanitizeProjectGeometry(p);
  assert(again === 0, "sanitize is idempotent");
}

// ---- WS-9.1: the committed pre-generated validators must match schemas.ts ------
// (Ajv standalone codegen replaced runtime compilation — the renderer CSP has no
// 'unsafe-eval'. A schemas.ts edit without regeneration would silently ship
// validators that disagree with the schema; this is the buildInfo-style drift gate.)
{
  const { generate, OUT } = await import("./gen-validators.mjs");
  const disk = await (await import("node:fs/promises")).readFile(OUT, "utf8").catch(() => "");
  assert(
    disk === generate(),
    "validators.gen.js is FRESH (regen: node --import tsx scripts/gen-validators.mjs)",
  );
}

console.log(failures ? `\nLOADGATE: FAIL (${failures})` : "\nLOADGATE: PASS");
process.exit(failures ? 1 : 0);
