// ---------------------------------------------------------------------------
// WS-5.1 (fortify plan): THE load-gate validator. Every GUI load path used to
// bare-cast JSON.parse output (`as Project`, `as CanvasFile`, …) — Ajv ran
// only in the CLI `validate` verb and the PlotImporter. This module compiles
// the project-format schemas ONCE and exposes typed validators the load seams
// call in the order  parse → migrate → validate  ("legacy-lenient,
// post-migration-strict": migrate.ts heals legacy shapes a strict schema must
// reject, so validation always runs on the migrated value).
//
// Failure policy (the callers'): derived/leaf files (canvas, deck) are
// QUARANTINED (bytes preserved as .corrupt-<ts>) + toasted + skipped; the
// entry manifest (project.json) refuses to open. flux-core re-exports this
// module (schemas.ts precedent) so CLI/MCP validate the same way.
//
// Also here: sanitizeProjectGeometry — JSON.stringify(NaN) === "null", so a
// NaN width silently persists as null and fails the next load. Save paths
// clamp non-finite numerics before writing (ops stay pure; this is the write
// seam, not the mutation seam).
// ---------------------------------------------------------------------------

import { Ajv, type ValidateFunction } from "ajv";
import { SCHEMAS } from "./schemas";
import type { Project } from "../types";

let ajv: Ajv | null = null;
const compiled = new Map<string, ValidateFunction>();

function validatorFor(key: "model" | "canvas" | "figIndex" | "deck" | "project"): ValidateFunction {
  if (!ajv) ajv = new Ajv({ strict: false, allErrors: true });
  let v = compiled.get(key);
  if (!v) {
    v = ajv.compile(SCHEMAS[key] as object);
    compiled.set(key, v);
  }
  return v;
}

function errorsOf(v: ValidateFunction): string[] {
  return (v.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`);
}

/** Validate a value against one of the project-format schemas. [] = valid. */
function validateAgainst(key: "model" | "canvas" | "figIndex" | "deck" | "project", value: unknown): string[] {
  const v = validatorFor(key);
  return v(value) ? [] : errorsOf(v);
}

/** The assembled in-memory figure model (post-migration). */
export function validateModel(p: unknown): string[] {
  return validateAgainst("model", p);
}
export function validateCanvasFile(raw: unknown): string[] {
  return validateAgainst("canvas", raw);
}
export function validateFigIndexFile(raw: unknown): string[] {
  return validateAgainst("figIndex", raw);
}
export function validateDeckFile(raw: unknown): string[] {
  return validateAgainst("deck", raw);
}
export function validateProjectManifest(raw: unknown): string[] {
  return validateAgainst("project", raw);
}

/** Clamp non-finite element/figure numerics (NaN/±Infinity) before a write —
 *  JSON would persist them as null and poison the next load. Returns how many
 *  fields were clamped (callers may surface a warning when > 0). */
export function sanitizeProjectGeometry(p: Project): number {
  let fixed = 0;
  const fix = (obj: Record<string, unknown>, key: string, fallback: number) => {
    const v = obj[key];
    if (typeof v === "number" && !Number.isFinite(v)) {
      obj[key] = fallback;
      fixed++;
    }
  };
  for (const f of p.figures ?? []) {
    const fr = f as unknown as Record<string, unknown>;
    fix(fr, "x", 0);
    fix(fr, "y", 0);
    fix(fr, "width", 1);
    fix(fr, "height", 1);
    for (const e of f.elements ?? []) {
      const er = e as unknown as Record<string, unknown>;
      fix(er, "x", 0);
      fix(er, "y", 0);
      fix(er, "width", 1);
      fix(er, "height", 1);
      fix(er, "rotation", 0);
      fix(er, "opacity", 1);
      fix(er, "x1", 0);
      fix(er, "y1", 0);
      fix(er, "x2", 0);
      fix(er, "y2", 0);
      fix(er, "fontSize", 10);
      fix(er, "strokeWidth", 1);
      fix(er, "contentScale", 1);
      fix(er, "cornerRadius", 0);
    }
  }
  return fixed;
}
