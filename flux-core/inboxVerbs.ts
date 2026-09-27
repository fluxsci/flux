import { z } from "zod";
import type { VerbDef, CliArgSpec, McpRender } from "./registry";
import { listInbox, claimItem, releaseItem, replyItem, resolveItem, archiveItem } from "./annotations";
import { waitForInbox, type WaitInboxResult } from "./inboxWait";
import { inspectTarget, packetResponse } from "./inspect";
import type { InboxItem } from "../src/lib/project/inbox";
import type { TargetRef } from "../src/lib/project/targets";

const statuses = z.enum(["open", "queued", "claimed", "needs-input", "resolved", "withdrawn", "all"]);
export const inboxFilterSchema = z.object({
  kind: z.enum(["annotation", "comment"]).optional(),
  surface: z.enum(["paper", "figure", "slide", "present", "reader", "library", "home", "unknown"]).optional(),
  doc: z.string().optional(), figure: z.string().optional(), deck: z.string().optional(),
  tag: z.array(z.string()).optional(),
  status: z.union([z.literal("all"), z.array(statuses)]).transform(s => s === "all" || s.includes("all") ? "all" as const : s as Exclude<z.infer<typeof statuses>, "all">[]).optional(),
  archived: z.boolean().optional(), since: z.string().datetime({ offset: true }).optional(),
  text: z.string().optional(), holder: z.string().optional(), claimed: z.enum(["me", "others", "none", "any"]).optional(),
});
const filterArgs: CliArgSpec[] = [
  ...["kind", "surface", "doc", "figure", "deck", "since", "text", "holder", "claimed"].map(at => ({ kind: "flag" as const, at, into: `filter.${at}` })),
  { kind: "flag", at: "tag", into: "filter.tag", as: "csv" },
  { kind: "flag", at: "status", into: "filter.status", as: "csv" },
  { kind: "flag", at: "archived", into: "filter.archived", as: "boolean" },
  { kind: "flag", at: "mine", into: "mine", as: "boolean" },
  { kind: "rest", at: 0, into: "query", as: "joined" },
];
const filterParams = { filter: inboxFilterSchema.optional(), query: z.string().optional(), mine: z.boolean().optional() };
const filterNotPaths = { "filter.doc": "Project document selector (path or basename), not an input file", "filter.figure": "Figure id or alias", "filter.deck": "Deck id" };
interface InboxResponse { items: InboxItem[]; mcp?: McpRender }
export const INBOX_VERBS: VerbDef[] = [
  {
    name: "list_inbox", readOnly: true, cli: "inbox", scope: "project", core: true, cliRoot: "flags", notAPath: filterNotPaths,
    summary: "List annotations and margin comments across every document. Filter by kind, surface, doc, figure, deck, tag, status, archive, time, text or holder; mine means assigned to or claimed by your session. packets includes current targets and up to six inline snapshots.",
    params: { ...filterParams, json: z.boolean().optional(), packets: z.boolean().optional() },
    cliArgs: [...filterArgs, { kind: "flag", at: "json", into: "json", as: "boolean" }, { kind: "flag", at: "packets", into: "packets", as: "boolean" }],
    handler: async (ctx, args) => {
      const result = await listInbox(ctx.root, args, ctx);
      return args.packets && ctx.transport === "mcp" ? { ...result, mcp: await packetResponse(ctx.root, result.items, { filter: result.filter }) } : result;
    },
    render: {
      human: (r, a) => {
        const result = r as InboxResponse;
        return { out: a.json ? JSON.stringify(r, null, 2) : result.items.length ? result.items.map(i => `${i.id}\t${i.chip}\t${i.where}\n  ${i.text.replace(/\s+/g, " ")}`).join("\n") : "No matching inbox items." };
      },
      mcp: r => (r as InboxResponse).mcp ?? { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] },
    },
  },
  {
    name: "wait_for_inbox", readOnly: true, cli: "wait-inbox", scope: "project", core: true, cliRoot: "flags", notAPath: filterNotPaths,
    summary: "Wait for new or changed routed inbox items, or your assigned queue. Opt-in only. Returns packets, cursor, stopped and revoked notices; pass cursor back on the CLI. Timeout returns an empty list. Inbox-only items never wake a watcher.",
    params: { ...filterParams, timeoutMs: z.number().nonnegative().optional(), timeout: z.number().nonnegative().optional(), cursor: z.string().optional(), mode: z.enum(["queue", "annotations", "filter"]).optional() },
    cliArgs: [...filterArgs, { kind: "flag", at: "timeout", into: "timeout", as: "number" }, { kind: "flag", at: "cursor", into: "cursor" }, { kind: "flag", at: "mode", into: "mode" }],
    handler: async (ctx, a) => {
      const result = await waitForInbox(ctx.root, { ...a, timeoutMs: a.timeoutMs as number | undefined ?? (a.timeout === undefined ? undefined : Number(a.timeout) * 1000), signal: ctx.signal, watching: ctx.watching }, ctx);
      return ctx.transport === "mcp" ? { ...result, mcp: await packetResponse(ctx.root, result.items, { cursor: result.cursor, stopped: result.stopped, revoked: result.revoked }) } : result;
    },
    render: { human: r => ({ out: JSON.stringify(r, null, 2) }), mcp: r => (r as WaitInboxResult & { mcp: McpRender }).mcp },
  },
  {
    name: "claim_item", cli: "claim", scope: "project", core: true, cliRoot: "flags",
    summary: "Claim an inbox item before working. First live claim wins; claimed:false names the holder. note posts a working reply. Use force only when the user explicitly asks to take over.",
    params: { id: z.string().min(1), note: z.string().optional(), force: z.boolean().optional() },
    cliArgs: [{ kind: "pos", at: 0, into: "id", required: true }, { kind: "flag", at: "note", into: "note" }, { kind: "flag", at: "force", into: "force", as: "boolean" }],
    handler: (ctx, a) => claimItem(ctx.root, a.id as string, a, ctx),
    render: { human: r => { const v = r as { id: string; claimed: boolean; holder: { name: string } | null }; return { out: JSON.stringify(r), err: v.claimed ? `Claimed ${v.id}` : `${v.id}: claimed:false; held by ${v.holder?.name ?? "another session"}. Do not proceed.` }; } },
  },
  {
    name: "release_item", cli: "release", scope: "project", cliRoot: "flags",
    summary: "Release your claim on an inbox item.", params: { id: z.string().min(1) },
    cliArgs: [{ kind: "pos", at: 0, into: "id", required: true }],
    handler: (ctx, a) => releaseItem(ctx.root, a.id as string, ctx),
  },
  {
    name: "reply_item", cli: "reply", scope: "project", core: true, cliRoot: "flags",
    summary: "Reply in an annotation or margin-comment thread without resolving it. needsInput marks the item as waiting for the user.",
    params: { id: z.string().min(1), text: z.string().min(1), needsInput: z.boolean().optional() },
    cliArgs: [{ kind: "pos", at: 0, into: "id", required: true }, { kind: "rest", at: 1, into: "text", as: "joined", required: true }, { kind: "flag", at: "needs-input", into: "needsInput", as: "boolean" }],
    handler: (ctx, a) => replyItem(ctx.root, a.id as string, a.text as string, a, ctx),
  },
  {
    name: "resolve_item", cli: "resolve", scope: "project", core: true, cliRoot: "flags",
    summary: "Resolve an annotation or comment after addressing it, by id or a unique quote/text. Optional note records what changed. Refuses withdrawn or resolved items and another live holder's claim.",
    params: { id: z.string().min(1), note: z.string().optional() },
    cliArgs: [{ kind: "pos", at: 0, into: "id", required: true }, { kind: "flag", at: "note", into: "note" }],
    handler: (ctx, a) => resolveItem(ctx.root, a.id as string, a, ctx),
  },
  ...([true, false] as const).map(archived => ({
    name: archived ? "archive_item" : "unarchive_item", cli: archived ? "archive" : "unarchive", scope: "project" as const, cliRoot: "flags" as const,
    summary: archived ? "Archive an inbox item when the user asks; hides it from default views without resolving it." : "Restore an archived inbox item to the default views.",
    params: { id: z.string().min(1) }, cliArgs: [{ kind: "pos" as const, at: 0, into: "id", required: true }],
    handler: (ctx, a) => archiveItem(ctx.root, a.id as string, archived, ctx),
  } satisfies VerbDef)),
  {
    name: "get_target", readOnly: true, cli: "inspect", scope: "project", core: true, cliRoot: "flags",
    notAPath: { target: "Structured TargetRef or kind-prefixed model shorthand, including project document ranges" },
    summary: "Current state of a target (figure, element, plot part, caption, document range, slide, beat, track, passage, reference), without rendering. TargetRef JSON or shorthand, e.g. part:fig-2/el-9#control, doc:paper/notes.qmd@120-180.",
    params: { target: z.union([z.string(), z.record(z.unknown())]) },
    cliArgs: [{ kind: "pos", at: 0, into: "target", required: true }],
    handler: (ctx, a) => inspectTarget(ctx.root, a.target as string | TargetRef),
  },
];
