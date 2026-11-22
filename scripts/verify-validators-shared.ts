#!/usr/bin/env -S npx tsx
// The project-format validators are generated with every repeated part of the schemas compiled ONCE
// (scripts/gen-validators.mjs `shareRepeats`): a third of the code they were. This gate holds that to its promise:
// the shared form is the SAME schema, and the generated validators answer exactly as the published schemas compiled
// plainly do.
//   1. Structure: the rewrite is lossless (every reference written back out gives the original schema, definitions
//      written out), deterministic, leaves SCHEMAS untouched, and shares only parts used more than once.
//   2. Behaviour: for thousands of documents drawn from the schemas themselves (faithful ones and damaged ones, a
//      fixed seed), the generated validator and Ajv's plain compilation of SCHEMAS[key] agree on valid / invalid
//      and report the same errors in the same order (instance path, keyword, message, params). `schemaPath` is
//      not compared: it names where in the schema a rule sits, the shared form moves rules, and nothing reads it
//      (project/validate.ts reports `instancePath message`).
//   3. Size: the generated module stays under its budget, so losing the sharing (1.63 MB before it) cannot pass.
//   npx tsx scripts/verify-validators-shared.ts
import { Ajv } from "ajv";
import { statSync } from "node:fs";
import { SCHEMAS } from "../src/lib/project/schemas";
import * as generated from "../src/lib/project/validators.gen.js";
import type { GenValidator } from "../src/lib/project/validators.gen.js";
import { KEYS, AJV_OPTIONS, SHARE_MIN_BYTES, OUT, shareRepeats } from "./gen-validators.mjs";

type Schema = Record<string, unknown>;
type Key = "model" | "canvas" | "figIndex" | "deck" | "project";

let failures = 0, checks = 0;
const ok = (m: string) => { checks++; console.log("  ok:", m); };
const fail = (m: string) => { checks++; failures++; console.error("  ✗ FAIL:", m); };
const assert = (c: unknown, m: string) => (c ? ok(m) : fail(m));

const isSchema = (v: unknown): v is Schema => v !== null && typeof v === "object" && !Array.isArray(v);
const ONE = ["additionalProperties", "additionalItems", "contains", "propertyNames", "not", "if", "then", "else"];
const MAPS = ["properties", "patternProperties"];
const LISTS = ["oneOf", "anyOf", "allOf"];
/** This gate's own walk over a schema's sub-schemas (written apart from the generator's, on purpose). */
function mapSubs(s: Schema, visit: (c: Schema) => unknown): Schema {
  const out: Schema = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === "items") out[k] = Array.isArray(v) ? v.map((c) => (isSchema(c) ? visit(c) : c)) : isSchema(v) ? visit(v) : v;
    else if (ONE.includes(k)) out[k] = isSchema(v) ? visit(v) : v;
    else if (MAPS.includes(k)) out[k] = Object.fromEntries(Object.entries(v as Schema).map(([n, c]) => [n, isSchema(c) ? visit(c) : c]));
    else if (LISTS.includes(k)) out[k] = (v as unknown[]).map((c) => (isSchema(c) ? visit(c) : c));
    else out[k] = v;
  }
  return out;
}
/** A schema with every reference written out: its own definitions, or the shared parts by id. */
function writtenOut(root: Schema, parts: Map<string, Schema> = new Map()): Schema {
  const { definitions, ...rest } = root as { definitions?: Record<string, Schema> };
  const go = (s: Schema): Schema => {
    if (typeof s.$ref !== "string") return mapSubs(s, go);
    const local = /^#\/definitions\/([^/]+)$/.exec(s.$ref)?.[1];
    const target = local !== undefined ? definitions?.[local] : parts.get(s.$ref);
    if (!target) throw new Error(`unresolved $ref ${s.$ref}`);
    const { $id: _id, ...body } = target;
    return go(local !== undefined ? target : body);
  };
  return go(rest);
}

const published = JSON.stringify(SCHEMAS);
const source = Object.fromEntries((KEYS as Key[]).map((key) => [key, SCHEMAS[key]])) as Record<Key, Schema>;
const { roots, shared } = shareRepeats(source) as { roots: Record<Key, Schema>; shared: Schema[] };

// ---- 1. structure ---------------------------------------------------------------------------------------------
console.log("structure");
{
  assert(JSON.stringify(SCHEMAS) === published, "sharing leaves the published SCHEMAS untouched");
  assert(JSON.stringify(shareRepeats(source)) === JSON.stringify({ roots, shared }), "the shared form is a function of the schemas alone (two runs, the same bytes)");
  const parts = new Map(shared.map((p) => [p.$id as string, p]));
  assert(parts.size === shared.length && shared.every((p, i) => p.$id === `urn:flux:shared:${i}`), `${shared.length} shared parts, each with its own id, numbered in the order met`);
  let lossless = true;
  for (const key of KEYS as Key[]) if (JSON.stringify(writtenOut(roots[key], parts)) !== JSON.stringify(writtenOut(source[key]))) { lossless = false; fail(`${key}: the shared form written back out differs from the schema`); }
  if (lossless) ok("every schema: the shared form, written back out, is the schema itself (definitions written out)");
  // Every reference lands on a part; every part is used at least twice (or it would not be shared) and is large enough.
  const uses = new Map<string, number>();
  let dangling = 0, localRefs = 0, sawDefinitions = 0;
  const count = (s: Schema): Schema => {
    if ("definitions" in s) sawDefinitions++;
    if (typeof s.$ref === "string") { if (s.$ref.startsWith("#")) localRefs++; else if (!parts.has(s.$ref)) dangling++; else uses.set(s.$ref, (uses.get(s.$ref) ?? 0) + 1); }
    return mapSubs(s, count);
  };
  for (const key of KEYS as Key[]) count(roots[key]);
  for (const p of shared) count(p);
  assert(dangling === 0 && localRefs === 0 && sawDefinitions === 0, "every reference names a shared part: none dangling, none local, no definitions left behind");
  const once = shared.filter((p) => (uses.get(p.$id as string) ?? 0) < 2).length;
  assert(once === 0, "every shared part is referenced at least twice");
  const small = shared.filter((p) => { const { $id: _id, ...body } = writtenOut(p, parts); return JSON.stringify(body).length < SHARE_MIN_BYTES; }).length;
  assert(small === 0, `no shared part is smaller than the ${SHARE_MIN_BYTES}-byte floor`);
  // The same part is never held twice (two ids for one JSON would be code written twice again).
  const bodies = new Set(shared.map((p) => { const { $id: _id, ...body } = p; return JSON.stringify(body); }));
  assert(bodies.size === shared.length, "no two shared parts are the same schema");
  for (const key of KEYS as Key[]) if (roots[key].$id !== source[key].$id || roots[key].title !== source[key].title) fail(`${key}: the root lost its $id or title`);
}

// ---- 2. behaviour ---------------------------------------------------------------------------------------------
// Documents are drawn from the schema itself, so every branch of every union is reached without a fixture having to
// exist for it; a share of them is damaged on purpose (a wrong type, a missing key, a number out of range).
function mulberry32(seed: number) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const JUNK: unknown[] = [null, 0, -1, 1.5, 1e9, "", "x", "fig-1", true, false, [], {}, [1, "a"], { a: 1 }, Number.NaN, Number.POSITIVE_INFINITY];
const STRINGS = ["a", "fig-1", "#a1b2c3", "#FFF", "", "id_1", "0.8.0", "1.2.3", "abc def", "linear", "x", "C0", "value", "2026-01-01T00:00:00Z", " ", "\n", "plots/a.svg", "é"];
function drawer(root: Schema, rnd: () => number, damage: number) {
  const defs = (root.definitions ?? {}) as Record<string, Schema>;
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)];
  const resolve = (s: Schema): Schema => (typeof s.$ref === "string" ? resolve(defs[s.$ref.replace("#/definitions/", "")]) : s);
  /** The node with one branch of each union folded in: enough to draw a document that mostly fits. */
  const folded = (node: Schema): Schema => {
    let s = resolve(node);
    const merge = (a: Schema, bIn: Schema): Schema => {
      const b = folded(bIn);
      return { ...a, ...b, properties: { ...(a.properties as Schema), ...(b.properties as Schema) }, required: [...new Set([...((a.required as string[]) ?? []), ...((b.required as string[]) ?? [])])] };
    };
    for (const k of ["oneOf", "anyOf"]) if (Array.isArray(s[k])) { const { [k]: list, ...rest } = s; s = merge(rest, pick(list as Schema[])); }
    if (Array.isArray(s.allOf)) { const { allOf, ...rest } = s; s = (allOf as Schema[]).reduce(merge, rest); }
    if (isSchema(s.if) && isSchema(s.then) && rnd() < 0.5) { const { if: cond, then, ...rest } = s; s = merge(merge(rest, cond as Schema), then as Schema); }
    return s;
  };
  const draw = (node: Schema, depth: number): unknown => {
    if (rnd() < damage) return pick(JUNK);
    const s = folded(node);
    if ("const" in s) return s.const;
    if (Array.isArray(s.enum)) return pick(s.enum);
    const types = Array.isArray(s.type) ? (s.type as string[]) : typeof s.type === "string" ? [s.type] : [];
    const props = isSchema(s.properties) && Object.keys(s.properties).length ? (s.properties as Record<string, Schema>) : null;
    const type = types.length ? pick(types) : props || s.required || isSchema(s.additionalProperties) ? "object" : s.items ? "array" : pick(["object", "string", "number", "boolean", "null"]);
    if (type === "object") {
      const out: Record<string, unknown> = {};
      const required = new Set((s.required as string[]) ?? []);
      const keep = depth > 9 ? 0.15 : 0.55;
      for (const [name, child] of Object.entries(props ?? {})) if (required.has(name) ? rnd() >= damage : rnd() < keep) out[name] = isSchema(child) ? draw(child, depth + 1) : pick(JUNK);
      for (const name of required) if (!(name in out) && !props?.[name] && rnd() >= damage) out[name] = pick(JUNK);
      if (isSchema(s.additionalProperties) && depth < 12) for (let i = Math.floor(rnd() * 3); i > 0; i--) out[pick(["k1", "k2", "el-1", "series/a"])] = draw(s.additionalProperties, depth + 1);
      else if (rnd() < 0.08) out[pick(["extra", "note"])] = pick(JUNK);
      return out;
    }
    if (type === "array") {
      const min = (s.minItems as number) ?? 0, max = (s.maxItems as number) ?? min + 3;
      let n = min + Math.floor(rnd() * (Math.max(min, Math.min(max, min + 3)) - min + 1));
      if (depth > 10) n = min;
      if (rnd() < damage) n = Math.max(0, n + pick([-1, 1, 2]));
      const items = s.items;
      return Array.from({ length: n }, (_, i) => (Array.isArray(items) ? (isSchema(items[i]) ? draw(items[i], depth + 1) : pick(JUNK)) : isSchema(items) ? draw(items, depth + 1) : pick(JUNK)));
    }
    if (type === "number" || type === "integer") {
      const lo = (s.minimum as number) ?? (s.exclusiveMinimum as number) ?? -50, hi = (s.maximum as number) ?? (s.exclusiveMaximum as number) ?? lo + 100;
      // The ends themselves are drawn often: an inclusive bound accepts them, an exclusive one refuses them.
      let n = rnd() < 0.2 ? pick([lo, hi]) : lo + rnd() * (hi - lo);
      if (rnd() < damage) n = pick([lo - 1, hi + 1, -1e6, 1e6]);
      return type === "integer" || rnd() < 0.5 ? Math.round(n) : n;
    }
    if (type === "string") {
      if (typeof s.pattern === "string" && rnd() >= damage) { const re = new RegExp(s.pattern, "u"); const fits = STRINGS.filter((t) => re.test(t)); if (fits.length) return pick(fits); }
      return pick(STRINGS);
    }
    if (type === "boolean") return rnd() < 0.5;
    return null;
  };
  return () => draw(root, 0);
}

console.log("behaviour");
const plainAjv = new Ajv({ ...AJV_OPTIONS });
const told = (v: { errors?: unknown[] | null }) => JSON.stringify(((v.errors ?? []) as { instancePath: string; keyword: string; message?: string; params: unknown }[]).map((e) => [e.instancePath, e.keyword, e.message, e.params]));
const PER_SCHEMA = 2500;
for (const key of KEYS as Key[]) {
  const plain = plainAjv.compile(SCHEMAS[key]);
  const gen = (generated as unknown as Record<string, GenValidator>)[`validate_${key}`];
  let valid = 0, invalid = 0, differ = 0, errorsSeen = 0, first = "";
  const keywords = new Set<string>();
  for (let i = 0; i < PER_SCHEMA; i++) {
    // Four in ten faithful to the schema, the rest damaged lightly to heavily.
    const damage = [0, 0, 0.004, 0.02, 0.08][i % 5];
    const doc = drawer(SCHEMAS[key], mulberry32(0x5eed + i * 7919 + key.length * 104729), damage)();
    const a = plain(doc), b = gen(doc);
    const ea = told(plain), eb = told(gen);
    if (a) valid++; else invalid++;
    for (const e of (plain.errors ?? [])) { errorsSeen++; keywords.add(e.keyword); }
    if (a !== b || ea !== eb) { differ++; if (!first) first = `document ${i}: plain ${a} ${ea.slice(0, 300)} | generated ${b} ${eb.slice(0, 300)}`; }
  }
  assert(differ === 0, `${key}: ${PER_SCHEMA} documents, the generated validator answers as the plain schema does (${valid} valid, ${invalid} invalid, ${errorsSeen} errors compared, ${keywords.size} kinds of rule)${first ? ` — ${first}` : ""}`);
  // The comparison means something only if both answers occur, and often.
  assert(valid >= PER_SCHEMA * 0.05 && invalid >= PER_SCHEMA * 0.2, `${key}: the documents reach both answers (${valid} valid, ${invalid} invalid)`);
}

// ---- 3. size --------------------------------------------------------------------------------------------------
console.log("size");
{
  const bytes = statSync(OUT).size;
  // 520 KB on 2026-11-21 with ${shared.length} shared parts; 1,634 KB the day before, every part written out where used.
  // Growth comes with new schema; a jump past the budget is sharing lost (a part that no longer repeats byte for byte).
  const BUDGET = 700_000;
  assert(bytes < BUDGET, `validators.gen.js is ${(bytes / 1000).toFixed(0)} KB (budget ${BUDGET / 1000} KB; ${shared.length} shared parts)`);
}

console.log(failures ? `\nVALIDATORS-SHARED: FAIL (${failures} of ${checks})` : `\nVALIDATORS-SHARED: PASS (${checks} checks)`);
process.exit(failures ? 1 : 0);
