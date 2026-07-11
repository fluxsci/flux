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
import { classifyError, ExternalToolError, LockedError } from "./errors";

// --- surface result shapes ---------------------------------------------------
export interface CliRender {
  /** stdout payload (data) — printed WITHOUT decoration. */
  out?: string;
  /** stderr status line (human feedback) — printed as-is. */
  err?: string;
  exit?: number;
}
export interface McpContent {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}
export interface McpRender {
  content: McpContent[];
  isError?: boolean;
}

export interface CliArgSpec {
  /** Where the value comes from: positional index, the argv rest, or --flag. */
  kind: "pos" | "rest" | "flag";
  /** Parameter name in `params` this feeds. */
  into: string;
  /** positional index (kind:"pos") or flag name (kind:"flag", without --). */
  at?: number | string;
  required?: boolean;
  /** Coerce "true"/numeric flag strings ("flag" kind only). */
  as?: "string" | "number" | "boolean";
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
  handler: (ctx: VerbCtx, args: Record<string, unknown>) => Promise<unknown>;
  render?: {
    human?: (r: unknown, a: Record<string, unknown>) => CliRender;
    mcp?: (r: unknown, a: Record<string, unknown>) => McpRender;
  };
}

const text = (t: string): McpRender => ({ content: [{ type: "text", text: t }] });

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

/** Extract + validate a registered verb's args from parsed CLI argv. */
function argsFromCli(v: VerbDef, cli: { pos: string[]; flags: Record<string, unknown> }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const spec of v.cliArgs) {
    let raw: unknown;
    if (spec.kind === "pos") raw = cli.pos[spec.at as number];
    else if (spec.kind === "rest") raw = cli.pos.slice((spec.at as number) ?? 0);
    else raw = cli.flags[spec.at as string];
    if (raw === undefined || raw === false) {
      if (spec.required) throw new Error(`${v.cli}: missing ${spec.kind === "flag" ? `--${spec.at}` : `<${spec.into}>`}`);
      continue;
    }
    if (spec.as === "number") raw = Number(raw);
    else if (spec.as === "boolean") raw = raw !== "false" && raw !== false;
    out[spec.into] = raw;
  }
  // Validate against the SAME schema MCP enforces — one contract.
  return z.object(v.params).parse(out);
}

export interface CliIo {
  log: (s: string) => void; // stdout (data)
  err: (s: string) => void; // stderr (status)
  setExit: (code: number) => void;
}

/** Dispatch a CLI invocation through the registry. Returns false when the verb
 *  is not registered (the caller falls through to the legacy switch). */
export async function runCliVerb(
  verb: string,
  cli: { pos: string[]; flags: Record<string, unknown>; root: string },
  io: CliIo,
): Promise<boolean> {
  const v = byCli.get(verb);
  if (!v) return false;
  try {
    const args = argsFromCli(v, cli);
    const r = await v.handler({ root: cli.root }, args);
    const h = (v.render?.human ?? defaultHuman)(r, args);
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
        const r = await v.handler({ root }, args);
        return (v.render?.mcp ?? defaultMcp)(r, args);
      } catch (e) {
        return errorToMcp(e);
      }
    });
  }
}
