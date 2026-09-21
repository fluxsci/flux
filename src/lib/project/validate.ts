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

import type { Project } from "../types";
// WS-9.1: PRE-GENERATED validators (Ajv standalone codegen — see
// scripts/gen-validators.mjs). Runtime Ajv compiles schemas via new Function,
// which the renderer CSP refuses (script-src has no 'unsafe-eval'); the
// generated module is plain functions with identical Ajv semantics + errors.
// Drift-gated: verify-loadgate.ts regenerates and diffs against the committed
// file, so a schemas.ts edit can't silently skew the shipped validators.
import * as gen from "./validators.gen.js";
import type { GenValidator } from "./validators.gen.js";

const VALIDATORS: Record<"model" | "canvas" | "figIndex" | "deck" | "project", GenValidator> = {
  model: gen.validate_model,
  canvas: gen.validate_canvas,
  figIndex: gen.validate_figIndex,
  deck: gen.validate_deck,
  project: gen.validate_project,
};

function errorsOf(v: GenValidator): string[] {
  return (v.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`);
}

/** Validate a value against one of the project-format schemas. [] = valid. */
function validateAgainst(key: "model" | "canvas" | "figIndex" | "deck" | "project", value: unknown): string[] {
  const v = VALIDATORS[key];
  return v(value) ? [] : errorsOf(v);
}

/** The assembled in-memory figure model (post-migration). */
export function validateModel(p: unknown): string[] {
  return [...validateAgainst("model", p), ...validateFigureIdentities(p), ...nonFinite(p)];
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

/** Identity is checked on complete arrays BEFORE migration/indexing. Figure and
 * element identities are project-wide; Slide has its own per-slide validator. */
export function validateFigureIdentities(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return [];
  const p = raw as Project, errors: string[] = [];
  const scopes = new Map<string, Map<string, string>>();
  const id = (scope: string, value: unknown, location: string) => {
    if (typeof value !== "string" || !value || ["__proto__", "constructor", "prototype"].includes(value)) { errors.push(`${location}: unsupported ${scope} id ${String(value)}`); return; }
    let seen = scopes.get(scope); if (!seen) scopes.set(scope, seen = new Map());
    if (seen.has(value)) errors.push(`${seen.get(value)} and ${location}: duplicate ${scope} id ${value}`);
    else seen.set(value, location);
  };
  if (Array.isArray(p.canvases)) p.canvases.forEach((c,i) => id("canvas", c?.id, `canvases[${i}]`));
  if (Array.isArray(p.assets)) p.assets.forEach((a,i) => id("asset", a?.id, `assets[${i}]`));
  if (!Array.isArray(p.figures)) return errors;
  p.figures.forEach((f,i) => {
    if (!f || typeof f !== "object") return;
    id("figure", f.id, `figures[${i}]`);
    if (f.referenceKey) id("reference key", f.referenceKey, `figures[${i}].referenceKey`);
    if (Array.isArray(f.elements)) f.elements.forEach((e,j) => id("element", e?.id, `figures[${i}].elements[${j}]`));
    if (f.groups && typeof f.groups === "object") for (const [key,g] of Object.entries(f.groups)) {
      if (!g || key !== g.id || ["__proto__", "constructor", "prototype"].includes(key)) { errors.push(`figures[${i}].groups.${key}: key/id mismatch or unsupported id`); continue; }
      const seen = new Set<string>(); let current: string | undefined = key;
      while (current && Object.hasOwn(f.groups, current)) {
        if (seen.has(current)) { errors.push(`figures[${i}].groups.${key}: cyclic parent chain at ${current}`); break; }
        seen.add(current); current = f.groups[current]?.parentId;
      }
    }
  });
  return errors;
}
function nonFinite(value: unknown, prefix = "", result: string[] = []): string[] {
  if (typeof value === "number" && !Number.isFinite(value)) result.push(`${prefix}: number must be finite`);
  else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) nonFinite(child, `${prefix}/${key}`, result);
  return result;
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
