import { recoverProjectForAuthoring } from "./recovery";
// WS-6.3 (fortify plan) — the ONE verb registry behind the CLI and the MCP
// server. Both surfaces used to wrap the same core.* functions independently
// (a 116-case CLI switch + 107 hand-rolled registerTool blocks) — capability
// drift like restyle's 5-vs-16 props was structural. A VerbDef declares the
// name(s), summary, zod params (the MCP inputSchema — the single schema
// source), how CLI argv maps onto those params, the core handler, and how to
// RENDER the result per surface. flux-cli dispatches registered verbs through
// runCliVerb (unregistered fall through to the old switch — both mechanisms
// coexist during the batch migration); flux-mcp calls registerMcpVerbs.
//
// The LIVE BRIDGE stays out BY DESIGN: its 38 verbs execute against the live
// GUI store, and its switch IS the allow-list.

import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { classifyError, ExternalToolError, LockedError, ValidationError } from "./errors";

// --- surface result shapes ---------------------------------------------------
export interface CliRender {
  /** stdout payload (data) — printed WITHOUT decoration. */
  out?: string;
  /** stdout payload written RAW (no trailing newline) — byte-exact document
   *  output (`flux manuscript > file` must not grow a newline). */
  outRaw?: string;
  /** stderr status line (human feedback) — printed as-is. */
  err?: string;
  exit?: number;
}
export type McpContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export interface McpRender {
  [key: string]: unknown;
  content: McpContent[];
  isError?: boolean;
}

export interface CliArgSpec {
  /** Where the value comes from: positional index, the argv rest (empty rest =
   *  missing), --flag, or "flagRest" (every flag no other spec consumes, minus
   *  --root — rerun-plot's open-ended param overrides). */
  kind: "pos" | "rest" | "flag" | "flagRest";
  /** Parameter name in `params` this feeds. A dotted path ("crop.x") builds a
   *  nested object — how flat CLI flags feed a nested MCP schema. */
  into: string;
  /** positional index (kind:"pos") or flag name (kind:"flag", without --). */
  at?: number | string;
  required?: boolean;
  /** Coercions (CLI side only — MCP args arrive typed):
   *  string   String(raw) — a bare flag becomes "true" (matches String(flags.x))
   *  trim     String(raw).trim(); an all-space value counts as missing
   *  number   Number(raw); a BARE flag counts as missing (the CLI's num())
   *  boolean  raw !== "false" (bare flag → true)
   *  csv      "a,b,c" → ["a","b","c"] (string values only, like the old guards)
   *  csvNum   "1,2" → [1,2] with NaN entries dropped (set-guides' nums())
   *  json     JSON.parse(String(raw))
   *  path     path.resolve(raw) — also maps over a rest array
   *  joined   rest array → join(" ")
   *  ptToPx   Number(raw) × 4/3 (text sizes are edited in POINTS on the CLI)
   *  fileText read the flag's value as a utf8 file path (--file f → contents) */
  as?:
    | "string"
    | "trim"
    | "number"
    | "boolean"
    | "csv"
    | "csvNum"
    | "json"
    | "path"
    | "joined"
    | "ptToPx"
    | "fileText";
  /** Fixed value when the flag is PRESENT (--no-label → label:false,
   *  --hide → hidden:true) — presence-selected values `as` can't express. */
  const?: unknown;
  /** Value when the source is ABSENT (instead of omitting the param) — keeps
   *  CLI-side defaults the legacy switch applied before calling core. */
  default?: unknown;
}

export interface VerbCtx {
  root: string;
}

export interface VerbDef {
  /** Canonical (MCP) name, e.g. "set_caption". */
  name: string;
  /** CLI verb, e.g. "set-caption". */
  cli: string;
  aliases?: string[];
  /** One description → the MCP description AND the CLI help line. */
  summary: string;
  /** The single schema source (== MCP inputSchema). */
  params: z.ZodRawShape;
  cliArgs: CliArgSpec[];
  /** How the CLI resolves the project root (the two historical contracts):
   *  "positional" (default) — old-style `verb [root] …`: a plainly-root first
   *  positional wins, and is stripped from the verb's own args;
   *  "flags" — new-style: --root/$FLUX_PROJECT/cwd only, every positional is
   *  the verb's own (variadic plot paths would otherwise be eaten as roots). */
  cliRoot?: "positional" | "flags";
  handler: (ctx: VerbCtx, args: Record<string, unknown>) => unknown | Promise<unknown>;
  render?: {
    human?: (r: unknown, a: Record<string, unknown>) => CliRender;
    mcp?: (r: unknown, a: Record<string, unknown>) => McpRender;
  };
}

/** One text-content MCP result — the shape every ok(...) wrapper produced. */
export const text = (t: string): McpRender => ({ content: [{ type: "text", text: t }] });

// --- default renders -----------------------------------------------------------
function defaultHuman(r: unknown): CliRender {
  if (r === undefined || r === null) return { err: "✓ done" };
  if (typeof r === "string") return { err: `✓ ${r}` };
  return { out: JSON.stringify(r, null, 2) };
}
function defaultMcp(r: unknown): McpRender {
  if (r === undefined || r === null) return text("done");
  if (typeof r === "string") return text(r);
  return text(JSON.stringify(r, null, 2));
}

// --- error mapping (the taxonomy's surface contract) -----------------------------
export function errorToCli(e: unknown): CliRender {
  const fe = classifyError(e);
  if (fe instanceof ExternalToolError) return { err: fe.message + (fe.log ? `\n${fe.log}` : ""), exit: fe.exitCode || 1 };
  if (fe instanceof LockedError) return { err: fe.message, exit: 75 }; // EX_TEMPFAIL — script-retryable
  return { err: fe.message, exit: 1 };
}
export function errorToMcp(e: unknown): McpRender {
  const fe = classifyError(e);
  const body = fe instanceof ExternalToolError && fe.log ? `${fe.message}\n${fe.log.slice(-2000)}` : fe.message;
  return { content: [{ type: "text", text: body }], isError: true };
}

// --- the registry ---------------------------------------------------------------
import { VERBS } from "./verbs";
export { VERBS };

const byCli = new Map<string, VerbDef>();
for (const v of VERBS) {
  byCli.set(v.cli, v);
  for (const a of v.aliases ?? []) byCli.set(a, v);
}
export const registeredCliVerbs = (): string[] => [...byCli.keys()];
export const registeredMcpNames = (): string[] => VERBS.map((v) => v.name);

/** Apply a spec's `as` coercion. Returns undefined when the raw value doesn't
 *  qualify (bare flag where a string/number is needed) — the legacy switch's
 *  typeof guards, so misuse skips instead of feeding `true` into core. */
async function coerce(spec: CliArgSpec, raw: unknown): Promise<unknown> {
  switch (spec.as) {
    case undefined:
      return raw;
    case "string":
      return String(raw);
    case "trim": {
      const s = String(raw).trim();
      return s === "" ? undefined : s;
    }
    case "number":
      return raw === true ? undefined : Number(raw);
    case "boolean":
      return raw !== "false" && raw !== false;
    case "csv":
      return typeof raw === "string" ? raw.split(",") : undefined;
    case "csvNum":
      return typeof raw === "string" ? raw.split(",").map(Number).filter((n) => !Number.isNaN(n)) : undefined;
    case "json":
      return JSON.parse(String(raw));
    case "path":
      return Array.isArray(raw) ? raw.map((p) => path.resolve(String(p))) : path.resolve(String(raw));
    case "joined":
      return Array.isArray(raw) ? raw.join(" ") : String(raw);
    case "ptToPx":
      return raw === true ? undefined : Number(raw) * (4 / 3);
    case "fileText":
      return await fs.readFile(String(raw), "utf8");
    default: {
      const exhaustive: never = spec.as;
      throw new ValidationError(`Unsupported CLI coercion: ${String(exhaustive)}`);
    }
  }
}

/** Assign into `out`, honoring dotted paths ("crop.x" builds {crop:{x}}). */
function assign(out: Record<string, unknown>, into: string, value: unknown): void {
  const dot = into.indexOf(".");
  if (dot === -1) {
    out[into] = value;
    return;
  }
  const head = into.slice(0, dot);
  const nested = (out[head] ??= {}) as Record<string, unknown>;
  nested[into.slice(dot + 1)] = value;
}

/** Extract + validate a registered verb's args from parsed CLI argv. */
async function argsFromCli(v: VerbDef, cli: { pos: string[]; flags: Record<string, unknown> }): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const supplied = new Set<string>();
  const namedFlags = new Set(v.cliArgs.filter((s) => s.kind === "flag").map((s) => String(s.at)));
  for (const spec of v.cliArgs) {
    let raw: unknown;
    if (spec.kind === "pos") raw = cli.pos[spec.at as number];
    else if (spec.kind === "rest") {
      const rest = cli.pos.slice((spec.at as number) ?? 0);
      raw = rest.length ? rest : undefined;
    } else if (spec.kind === "flagRest") {
      raw = Object.fromEntries(Object.entries(cli.flags).filter(([k]) => !namedFlags.has(k) && k !== "root"));
    } else raw = cli.flags[spec.at as string];
    // Coerce a present value; a coercion may REJECT it (bare flag where a
    // string is needed) — that counts as missing, like the old typeof guards.
    // A coerced boolean false is a real value, never "missing".
    if (raw !== undefined) {
      if (supplied.has(spec.into)) throw new ValidationError(`${v.cli}: contradictory inputs for ${spec.into}`);
      supplied.add(spec.into);
      raw = spec.const !== undefined ? spec.const : await coerce(spec, raw);
    }
    if (raw === undefined) {
      if (spec.default !== undefined) assign(out, spec.into, spec.default);
      else if (spec.required)
        throw new ValidationError(`${v.cli}: missing ${spec.kind === "flag" ? `--${spec.at}` : `<${spec.into}>`}`);
      continue;
    }
    assign(out, spec.into, raw);
  }
  // Validate against the SAME schema MCP enforces — one contract. A ZodError's
  // raw issue JSON is unusable on stderr; compact it.
  const parsed = z.object(v.params).safeParse(out);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "(args)"}: ${i.message}`).join("; ");
    throw new ValidationError(`${v.cli}: ${msg}`);
  }
  return parsed.data;
}

export interface CliIo {
  log: (s: string) => void; // stdout (data)
  err: (s: string) => void; // stderr (status)
  raw?: (s: string) => void; // stdout, no added newline (outRaw)
  setExit: (code: number) => void;
}

/** One parsed CLI invocation, carrying BOTH historical root contracts so each
 *  VerbDef picks its own (see VerbDef.cliRoot). */
export interface CliInvocation {
  /** every positional (new-style verbs own them all) */
  pos: string[];
  /** positionals with a plainly-root first arg stripped (old-style verbs) */
  posRooted: string[];
  flags: Record<string, unknown>;
  /** resolution where a plainly-root leading positional wins (old-style) */
  rootPositional: string;
  /** --root → $FLUX_PROJECT → cwd only (new-style) */
  rootFlags: string;
}

/** Dispatch a CLI invocation through the registry. Returns false when the verb
 *  is not registered (the caller falls through to the legacy switch). */
export async function runCliVerb(verb: string, inv: CliInvocation, io: CliIo): Promise<boolean> {
  const v = byCli.get(verb);
  if (!v) return false;
  const newStyle = v.cliRoot === "flags";
  try {
    const args = await argsFromCli(v, { pos: newStyle ? inv.pos : inv.posRooted, flags: inv.flags });
    const root = newStyle ? inv.rootFlags : inv.rootPositional;
    await recoverProjectForAuthoring(root);
    const r = await v.handler({ root }, args);
    const h = (v.render?.human ?? defaultHuman)(r, args);
    if (h.outRaw !== undefined) (io.raw ?? io.log)(h.outRaw);
    if (h.out !== undefined) io.log(h.out);
    if (h.err !== undefined) io.err(h.err);
    if (h.exit) io.setExit(h.exit);
  } catch (e) {
    const h = errorToCli(e);
    if (h.err) io.err(h.err);
    io.setExit(h.exit ?? 1);
  }
  return true;
}

/** Register every verb on the MCP server (same shape registerTool expects). */
export function registerMcpVerbs(
  server: { registerTool: (name: string, meta: { description: string; inputSchema: z.ZodRawShape }, fn: (a: Record<string, unknown>) => Promise<McpRender>) => void },
  root: string,
): void {
  for (const v of VERBS) {
    server.registerTool(v.name, { description: v.summary, inputSchema: v.params }, async (a) => {
      try {
        const args = z.object(v.params).parse(a ?? {});
        await recoverProjectForAuthoring(root);
        const r = await v.handler({ root }, args);
        return (v.render?.mcp ?? defaultMcp)(r, args);
      } catch (e) {
        return errorToMcp(e);
      }
    });
  }
}

/** Declaration-driven flag grammar. Values beginning '-' are valid values;
 * booleans never steal the next positional. '--' ends option parsing. */
export function parseCliFlags(verb: string | undefined, argv: string[]): { _: string[]; flags: Record<string, string | boolean> } {
  const definition = verb ? byCli.get(verb) : undefined;
  const specs = definition?.cliArgs.filter(s => s.kind === 'flag') ?? [];
  const declared = new Map(specs.map(s => [String(s.at), s]));
  const rest = definition?.cliArgs.some(s => s.kind === 'flagRest');
  const legacyBooleans = new Set(['print','no-picker','no-transcript','echo','png','bibtex','attach-files','semantic','all','refresh','force','json','help','global','append','dry-run','recursive','no-oa','exit','remove','md',...(['citing','similar'].includes(verb??'')?['s2']:[])]);
  const flags: Record<string, string | boolean> = {}, pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith('--')) { pos.push(arg); continue; }
    const equal = arg.indexOf('=');
    const key = arg.slice(2, equal < 0 ? undefined : equal);
    if (!key || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new ValidationError('Invalid option name');
    const spec = declared.get(key);
    if (definition && !spec && !['root','help'].includes(key) && !rest) throw new ValidationError(`${verb}: unknown flag --${key}`);
    if (Object.hasOwn(flags, key)) throw new ValidationError(`${verb}: repeated flag --${key}`);
    const boolean = spec ? spec.as === 'boolean' || spec.const !== undefined : legacyBooleans.has(key);
    if (equal >= 0) { flags[key] = arg.slice(equal + 1); continue; }
    if (boolean) {
      const next = argv[i + 1];
      if (next === 'true' || next === 'false') { flags[key] = next; i++; } else flags[key] = true;
    } else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[key] = argv[++i];
    else throw new ValidationError(`${verb}: --${key} requires a value`);
  }
  return { _: pos, flags };
}
export function registryHelp(verb?: string): string {
  const definitions = verb ? [byCli.get(verb)].filter((v): v is VerbDef => !!v) : VERBS;
  return definitions.map(v => {
    const args = v.cliArgs.filter(s => s.kind !== 'flagRest').map(s => s.kind === 'flag'
      ? `[--${s.at}${s.as === 'boolean' || s.const !== undefined ? '' : ' <value>'}]`
      : `<${s.into}${s.kind === 'rest' ? '…' : ''}>`).join(' ');
    return `  ${v.cli} ${v.cliRoot === 'flags' ? '' : '[root] '}${args} [--root R]\n      ${v.summary}${v.aliases?.length ? ` (aliases: ${v.aliases.join(', ')})` : ''}`;
  }).join('\n');
}
