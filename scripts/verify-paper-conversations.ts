#!/usr/bin/env -S npx tsx
// Conversations about a paper live WITH the paper (2026-11-19, owner: "AI conversations about
// papers should be global … tied to the highlight"): items/<citekey>/conversations.json in
// FluxLib, so the same paper shows them from every project. This gate holds the pure model
// (src/lib/references/conversations.ts) and the agent side (flux-core/conversations.ts): an
// agent's claim, reply and resolve on an item made while reading reach the paper's own file.
// Hermetic: HOME points at a scratch folder before flux-core loads, so the library it writes is
// never the developer's.
//   Run: node scripts/run-verifies.mjs --tier pure --only paper-conversations
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { harness } from "./lib/harness.mjs";
import {
  validateConversations, emptyConversationFile, paperRef, threadFromItem, threadFromAsk, threadSignature, upsertThread, removeThread,
  highlightFor, wantsHighlight, groupThreads, threadQuestion, threadState, earlierThreads, type ConversationFile, type PaperThread,
} from "../src/lib/references/conversations";
import type { Annotation } from "../src/lib/references/annotations";
import { foldAnnotations, makeNote, makeReply, makeResolve, makeWithdraw, type AnnotationEvent, type ContextStamp } from "../src/lib/project/annotations";
import { buildInbox, type InboxItem } from "../src/lib/project/inbox";
import { askPacket } from "../src/lib/project/ask";

const h = harness("verify-paper-conversations");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "flux-paper-talk-"));
const home = path.join(scratch, "home");
fs.mkdirSync(path.join(home, ".config"), { recursive: true });
process.env.HOME = home; process.env.USERPROFILE = home;
process.env.XDG_CONFIG_HOME = path.join(home, ".config"); process.env.APPDATA = path.join(home, ".config");
process.env.FLUX_NO_MIGRATE = "1";

const KEY = "aru2020cellular";
const QUOTE = "pyramidal cells act as gates";
const reading = (extra: Partial<NonNullable<ContextStamp["reader"]>> = {}, targets?: ContextStamp["targets"]): ContextStamp =>
  ({ surface: "reader", reader: { citekey: KEY, title: "Cellular mechanisms", page: 3, ...extra }, ...(targets ? { targets } : {}) });
const items = (events: AnnotationEvent[]): InboxItem[] =>
  buildInbox({ state: foldAnnotations(events), comments: [], liveness: { now: Date.now(), liveSessionIds: new Set() } });
const origin = { project: { id: "proj_a", title: "Project A" }, root: "/work/a" };
const hl = (id: string, quote: string, page = 3): Annotation => ({ id, page, anchor: { quote, prefix: "", suffix: "" }, color: "yellow", createdAt: "2026-11-01T00:00:00.000Z" });

// ---------------------------------------------------------------------------
h.section("which items are about a paper");
const selected = makeNote("What does this mean?", reading({ selection: QUOTE }, [{ kind: "passage", citekey: KEY, page: 3, quote: QUOTE, prefix: "that ", suffix: " for" }]), "human", "none");
const [selItem] = items([selected]);
h.eq(paperRef(selItem), { citekey: KEY, page: 3, anchor: { quote: QUOTE, prefix: "that ", suffix: " for" } }, "a selected passage carries its words and the words around them");
const onHighlight = items([makeNote("And this?", reading({ selection: QUOTE, highlightId: "h1" }, [{ kind: "passage", citekey: KEY, page: 3, quote: QUOTE, highlightId: "h1" }]), "human", "none")])[0];
h.eq(paperRef(onHighlight)?.highlightId, "h1", "a highlight's own Annotate names the highlight");
const stampOnly = items([makeNote("Explain this figure", reading({ page: 5 }), "human", "none")])[0];
h.eq(paperRef(stampOnly), { citekey: KEY, page: 5 }, "a note on a page (no selected words) hangs on the page");
h.ok(!wantsHighlight(threadFromItem(stampOnly, origin)!.thread), "…and never asks for a highlight");
const supp = items([makeNote("In the supplement", reading({ selection: "a table row", source: { supplement: "S1.pdf" } }, [{ kind: "passage", citekey: KEY, page: 2, quote: "a table row", prefix: "", suffix: "" }]), "human", "none")])[0];
h.eq(paperRef(supp)?.source, { supplement: "S1.pdf" }, "a passage of a supplement says so");
h.ok(!wantsHighlight(threadFromItem(supp, origin)!.thread), "…and gets no highlight (highlights anchor to the main text)");
const row = items([makeNote("Fetch the PDF", { surface: "library", library: { selectedKeys: [KEY] }, targets: [{ kind: "library-item", citekey: KEY }] }, "human", "none")])[0];
h.eq(paperRef(row), null, "a Library row is a task about the reference, not a conversation about the paper");
h.eq(paperRef(items([makeNote("Fix the axis", { surface: "figure", activeFigureId: "fig-1" }, "human", "none")])[0]), null, "a figure note is not about a paper");
h.eq(paperRef({ ...selItem, kind: "comment" }), null, "a margin comment is not about a paper");

// ---------------------------------------------------------------------------
h.section("an Inbox item as the paper's thread");
const reply = makeReply(selected.id, { kind: "agent", name: "heron" }, "It says cells gate the flow.", "claude");
const resolved = makeResolve(selected.id, "claude", { note: "Answered.", author: { kind: "agent", name: "heron" } });
const made = threadFromItem(items([selected, reply, resolved])[0], origin)!;
h.eq(made.citekey, KEY, "the thread names its paper");
h.eq([made.thread.id, made.thread.origin.kind, made.thread.origin.project?.title, made.thread.status], [selected.id, "item", "Project A", "resolved"], "it carries the item's id, its project and its status");
h.eq(made.thread.messages.map(m => [m.kind, m.author]), [["human", "You"], ["agent", "heron"], ["agent", "heron"]], "the question, the reply and the closing note, in order");
h.ok(wantsHighlight(made.thread), "selected words on the main PDF want a highlight of their own");
h.eq(threadQuestion(made.thread), "What does this mean?", "the row's line is the question");
h.eq(threadState(made.thread), "", "an answered thread says nothing more");
h.eq(threadState({ status: "open", messages: [made.thread.messages[0]] }), "Waiting for an agent", "an unanswered one says it is waiting");
h.eq(threadState({ status: "needs-input", agent: "heron", messages: made.thread.messages }), "heron asks you", "a question back names who asks");
const later = { ...made.thread, updatedAt: "2030-01-01T00:00:00.000Z" };
h.eq(threadSignature(later), threadSignature(made.thread), "a later timestamp alone is not a change worth writing");
h.ok(threadSignature({ ...made.thread, status: "open" }) !== threadSignature(made.thread), "a status change is");

// ---------------------------------------------------------------------------
h.section("the paper's file");
const file: ConversationFile = emptyConversationFile();
h.eq(upsertThread(file, structuredClone(made.thread)), { changed: true, added: true }, "a new thread is added");
h.eq(upsertThread(file, structuredClone(made.thread)), { changed: false, added: false }, "the same thread again changes nothing");
(file.threads[0] as PaperThread & { starred?: boolean }).starred = true;
file.threads[0].highlightId = "h9";
const again = structuredClone(made.thread); again.messages.push({ kind: "human", author: "You", text: "Thanks.", ts: "2026-11-19T01:00:00.000Z" });
h.eq(upsertThread(file, again), { changed: true, added: false }, "a new message updates the thread in place");
h.eq([file.threads[0].highlightId, (file.threads[0] as { starred?: boolean }).starred, file.threads[0].messages.length], ["h9", true, 4], "…keeping its highlight link and any field Flux does not know");
h.eq(file.threads[0].anchor, { quote: QUOTE, prefix: "that ", suffix: " for" }, "…and its exact anchor");
h.ok(validateConversations(JSON.parse(JSON.stringify(file))).threads.length === 1, "the file validates after a round trip");
h.ok(removeThread(file, made.thread.id, true, "2026-11-19T02:00:00.000Z") && !file.threads.length, "Remove takes the thread off the paper");
h.eq(upsertThread(file, structuredClone(made.thread)), { changed: false, added: false }, "…and a mirror never brings it back");
h.eq(file.removed, { [made.thread.id]: "2026-11-19T02:00:00.000Z" }, "the removal is on record");
const withdrawn = threadFromItem(items([selected, makeWithdraw(selected.id, "human")])[0], origin)!.thread;
const f2 = emptyConversationFile(); upsertThread(f2, structuredClone(made.thread));
h.ok(upsertThread(f2, withdrawn).changed && !f2.threads.length, "a withdrawn item leaves the paper");
for (const [bad, why] of [[{ version: 2, threads: [] }, "a future version"], [{ version: 1, threads: [{ id: "x" }] }, "a thread with no messages"],
  [{ version: 1, threads: [made.thread, made.thread] }, "a repeated id"], [{ version: 1, threads: [], removed: ["x"] }, "a removed list that is not a map"]] as const) {
  let threw = false; try { validateConversations(bad); } catch { threw = true; }
  h.ok(threw, `refuses ${why}`);
}

// ---------------------------------------------------------------------------
h.section("threads and highlights");
const marks = [hl("h1", QUOTE), hl("h2", "something else")];
h.eq(highlightFor({ highlightId: "h2", page: 3, anchor: { quote: QUOTE } }, marks)?.id, "h2", "a thread hangs on the highlight it names");
h.eq(highlightFor({ page: 3, anchor: { quote: "pyramidal  cells act\nas gates" } }, marks)?.id, "h1", "with no link, on a highlight of the same words (white space aside)");
h.eq(highlightFor({ page: 4, anchor: { quote: QUOTE } }, marks), null, "…on the same page only");
h.eq(highlightFor({ highlightId: "gone", page: 3, anchor: { quote: QUOTE } }, marks), null, "a thread whose highlight was deleted stays loose: it does not move to a neighbour");
h.eq(highlightFor({ page: 3, anchor: { quote: QUOTE }, source: { supplement: "S1.pdf" } }, marks), null, "a supplement's thread never hangs on a main-text highlight");
const t = (id: string, extra: Partial<PaperThread>): PaperThread => ({ ...structuredClone(made.thread), id, ...extra });
const groups = groupThreads([t("b", { createdAt: "2026-11-02T00:00:00.000Z", highlightId: "h1" }), t("a", { createdAt: "2026-11-01T00:00:00.000Z", highlightId: undefined }), t("c", { highlightId: "gone" }), t("d", { anchor: undefined, highlightId: undefined, page: 7 })], marks);
h.eq(groups.byHighlight.get("h1")?.map(x => x.id), ["a", "b"], "several threads may hang on one highlight, oldest first");
h.eq(groups.loose.map(x => x.id).sort(), ["c", "d"], "a deleted highlight's thread and a page note are loose");

// ---------------------------------------------------------------------------
h.section("Ask");
const ref = paperRef(selItem)!;
h.eq(threadFromAsk("ask1", ref, origin, [{ role: "human", text: "Why?" }], "Claude Code", ["2026-11-19T00:00:00.000Z"]), null, "an unanswered Ask is not kept");
const ask = threadFromAsk("ask1", ref, origin, [{ role: "human", text: "Why?" }, { role: "agent", text: " Because. " }, { role: "agent", text: "  " }], "Claude Code", ["2026-11-19T00:00:00.000Z", "2026-11-19T00:00:09.000Z"])!;
h.eq([ask.origin.kind, ask.status, ask.messages.length, ask.messages[1].author, ask.messages[1].text, ask.createdAt, ask.updatedAt],
  ["ask", "resolved", 2, "Claude Code", "Because.", "2026-11-19T00:00:00.000Z", "2026-11-19T00:00:09.000Z"], "an answered Ask is a resolved thread of its own, on the same words");
const prior = [t("x1", { origin: { kind: "item", project: { title: "Project B" } } }), t("x2", { anchor: { quote: "other words" }, highlightId: undefined }), t("x3", { messages: [made.thread.messages[0]] })];
const earlier = earlierThreads(prior, { page: 3, anchor: { quote: QUOTE } }, "none");
h.eq(earlier.map(e => [e.id, e.from]), [["x1", "Project B"]], "an agent asked again sees the answered exchanges on the same words, and where they were asked");
h.eq(earlierThreads(prior, { page: 3, anchor: { quote: QUOTE } }, "x1").length, 0, "…never the conversation it is part of");
const packet = askPacket("And now?", reading({ selection: QUOTE }), earlier);
h.ok(packet.includes("earlierConversations") && packet.includes("It says cells gate the flow."), "the Ask packet carries them");
h.ok(!askPacket("And now?", reading({ selection: QUOTE })).includes("earlierConversations"), "…and says nothing when there are none");

// ---------------------------------------------------------------------------
h.section("an agent's writes reach the paper (flux-core)");
const core = await import("../flux-core/index");
const { appendAnnotationEvent, claimItem, replyItem, resolveItem } = await import("../flux-core/annotations");
const { followPaperItem, loadConversations, earlierOnPassage } = await import("../flux-core/conversations");
const { inspectTarget } = await import("../flux-core/inspect");
const { resolveFluxLibPath } = await import("../flux-core/fluxlib");
const { itemDir, conversationsPath } = await import("../src/lib/references/items");
const lib = await resolveFluxLibPath();
h.ok(lib.startsWith(scratch), "the library under test is the scratch one");
const proj = path.join(scratch, "proj-a"), other = path.join(scratch, "proj-b");
await core.scaffold(proj, { title: "Project A", author: "Me" });
await core.scaffold(other, { title: "Project B", author: "Me" });
await core.addToLibrary(`@article{${KEY}, title={Cellular mechanisms}, author={Aru, J}, year={2020}}`, {});
fs.mkdirSync(itemDir(lib, KEY), { recursive: true });
fs.writeFileSync(path.join(itemDir(lib, KEY), "annotations.json"), JSON.stringify({ version: 1, annotations: [hl("h1", QUOTE)] }, null, 2));
const caller = { session: { id: "s-heron", name: "heron", client: "claude" } };
const note = makeNote("What does this mean?", reading({ selection: QUOTE }, [{ kind: "passage", citekey: KEY, page: 3, quote: QUOTE, prefix: "that ", suffix: " for" }]), "human", "none");
await appendAnnotationEvent(proj, note);
const onDisk = () => JSON.parse(fs.readFileSync(conversationsPath(lib, KEY), "utf8")) as ConversationFile;
h.ok(!fs.existsSync(conversationsPath(lib, KEY)), "writing the note alone touches no paper (the app mirrors it; an agent has done nothing yet)");
h.eq((await claimItem(proj, note.id, {}, caller)).claimed, true, "an agent claims the item");
h.eq([onDisk().threads[0]?.id, onDisk().threads[0]?.status, onDisk().threads[0]?.agent], [note.id, "claimed", "heron"], "the claim reaches the paper's file");
h.eq(onDisk().threads[0].highlightId, "h1", "the new thread is hung on the highlight already on those words");
h.eq(onDisk().threads[0].origin, { kind: "item", project: { id: JSON.parse(fs.readFileSync(path.join(proj, "project.json"), "utf8")).id, title: "Project A" }, root: proj }, "it says which project it was asked in");
await replyItem(proj, note.id, "Cells gate the flow of activity.", {}, caller);
h.eq(onDisk().threads[0].messages.map(m => m.text), ["What does this mean?", "Cells gate the flow of activity."], "the reply reaches the paper");
const kept = onDisk(); (kept.threads[0] as { starred?: boolean }).starred = true; fs.writeFileSync(conversationsPath(lib, KEY), JSON.stringify(kept, null, 2) + "\n");
await resolveItem(proj, note.id, { note: "Answered." }, caller);
h.eq([onDisk().threads[0].status, onDisk().threads[0].agent, (onDisk().threads[0] as { starred?: boolean }).starred], ["resolved", undefined, true], "resolving reaches the paper, keeps fields Flux does not know, and drops the holder");

// The same words asked about from ANOTHER project: the agent's packet carries the earlier answer.
const second = makeNote("Is that the whole claim?", reading({ selection: QUOTE, highlightId: "h1" }, [{ kind: "passage", citekey: KEY, page: 3, quote: QUOTE, highlightId: "h1" }]), "human", "none");
await appendAnnotationEvent(other, second);
const seen = await inspectTarget(other, { kind: "passage", citekey: KEY, page: 3, quote: QUOTE, highlightId: "h1" }, second.id) as { earlierConversations?: { id: string; from: string | null; messages: { text: string }[] }[] };
h.eq(seen.earlierConversations?.map(e => [e.id, e.from]), [[note.id, "Project A"]], "from another project, the packet for the same words carries what was asked before");
h.ok(!!seen.earlierConversations?.[0].messages.some(m => m.text === "Cells gate the flow of activity."), "…with its answer");
await claimItem(other, second.id, {}, caller);
h.eq(onDisk().threads.map(x => [x.id, x.origin.project?.title, x.highlightId]), [[note.id, "Project A", "h1"], [second.id, "Project B", "h1"]], "two projects' threads hang on the one highlight");
h.eq((await earlierOnPassage({ citekey: KEY, page: 3, highlightId: "h1" }, second.id)).length, 1, "the second thread's own packet does not list itself");

// Removed by the reader: an agent's later write does not bring it back.
const cut = onDisk(); removeThread(cut, second.id, true); fs.writeFileSync(conversationsPath(lib, KEY), JSON.stringify(cut, null, 2) + "\n");
await replyItem(other, second.id, "Yes.", {}, caller);
h.eq(onDisk().threads.map(x => x.id), [note.id], "a thread the reader removed stays removed");

// A paper that is not in the library: nothing is created for it.
const stray = makeNote("About a paper I do not have", { surface: "reader", reader: { citekey: "nobody1999", page: 1, selection: "x" } }, "human", "none");
await appendAnnotationEvent(proj, stray);
await claimItem(proj, stray.id, {}, caller);
h.ok(!fs.existsSync(itemDir(lib, "nobody1999")), "a paper that is not in the library gets no folder and no file");
h.eq(await followPaperItem(proj, items([makeNote("Fix the axis", { surface: "figure", activeFigureId: "fig-1" }, "human", "none")])[0]), false, "an item that is not about a paper is left alone");

// A file Flux cannot read never costs the agent its reply (and is never overwritten).
fs.writeFileSync(conversationsPath(lib, KEY), "{ not json");
const third = makeNote("Once more", reading({ selection: QUOTE }, [{ kind: "passage", citekey: KEY, page: 3, quote: QUOTE }]), "human", "none");
await appendAnnotationEvent(proj, third);
h.eq((await claimItem(proj, third.id, {}, caller)).claimed, true, "with an unreadable conversations file, the claim still succeeds");
h.eq((await replyItem(proj, third.id, "Still here.", {}, caller)).replied, true, "…and so does the reply");
h.eq(fs.readFileSync(conversationsPath(lib, KEY), "utf8"), "{ not json", "the unreadable file is left exactly as it was");
let refused = false; try { await loadConversations(KEY); } catch { refused = true; }
h.ok(refused, "reading it reports the problem instead of pretending the paper has no conversations");

await h.done(async () => { fs.rmSync(scratch, { recursive: true, force: true }); });
