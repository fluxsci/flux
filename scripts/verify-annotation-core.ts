#!/usr/bin/env -S npx tsx
// 2026-09-27 — the pure cores of the review loop (plan §7.3a, §7.4, §7.6, §7.6a, §7.9):
// targets (what "this" is), presence (who is connected, and their names), the
// annotation ledger v2 (claims, routes, replies, needs-input, archive, reopen,
// release-session; deterministic in LEDGER order) and the inbox model (one view
// over annotations + margin comments, filters, the plain-language query, the ONE
// delivery rule, packets). Hermetic: no filesystem, no network.
//   Run: node scripts/run-verifies.mjs --tier pure --only annotation-core
import { harness } from "./lib/harness.mjs";
import {
  describeTarget, formatTarget, parseTarget, sameTarget, widenTarget, uniqueTargets, TARGET_KINDS, type TargetRef,
} from "../src/lib/project/targets";
import {
  PRESENCE_WORDS, presenceName, presenceWord, isPresenceStale, parsePresence, liveSessions, vendorShort, surfaceShort, type PresenceSession,
} from "../src/lib/project/presence";
import {
  CLAIM_TTL_MS, foldAnnotations, parseLedger, serializeEvent, parseTags, parseRoute, describeRoute, statusOf, statusChip,
  writeAllowed, findAnnotation, describeStamp, annotationThread, makeNote, makeClaim, makeRelease, makeReply, makeState,
  makeResolve, makeWithdraw, makeReopen, makeArchive, makeAssign, makeReleaseSession, type AnnotationEvent, type SessionRef,
} from "../src/lib/project/annotations";
import {
  buildInbox, filterInbox, matchesFilter, parseInboxQuery, describeFilter, deliverableTo, toPacket, sortForInbox, docCandidates, type InboxComment,
} from "../src/lib/project/inbox";

const h = harness("verify-annotation-core");

// Deterministic event times: builders stamp "now", so re-stamp in sequence.
let clock = Date.parse("2026-09-27T10:00:00.000Z");
const at = (ev: AnnotationEvent, stepMs = 1000): AnnotationEvent => ({ ...ev, ts: new Date((clock += stepMs)).toISOString() });
const iso = (t: number) => new Date(t).toISOString();

// ---------------------------------------------------------------------------
h.section("targets");
const samples: TargetRef[] = [
  { kind: "figure", figureId: "fig-2", name: "Figure 2" },
  { kind: "element", figureId: "fig-2", elementId: "el-9", type: "text", name: "n = 12" },
  { kind: "part", figureId: "fig-2", elementId: "el-3", partId: "series-control", role: "series", label: "control", elementName: "density" },
  { kind: "caption", figureId: "fig-2", panel: "b" },
  { kind: "doc", path: "paper/drafts/draft_1.qmd", from: 120, to: 180, quote: "synaptic density" },
  { kind: "slide", deckId: "talk", slideId: "s3", index: 2, name: "Results" },
  { kind: "beat", deckId: "talk", slideId: "s3", beat: 2 },
  { kind: "track", deckId: "talk", slideId: "s3", trackId: "t12", family: "appearance", beat: 2 },
  { kind: "passage", citekey: "smith2020", page: 4, quote: "we find" },
  { kind: "library-item", citekey: "smith2020" },
  { kind: "region", surface: "figure", rect: { x: 10, y: 20, w: 300, h: 200 } },
];
h.eq(new Set(samples.map((s) => s.kind)).size, TARGET_KINDS.length, "every target kind has a sample");
for (const t of samples) {
  const s = formatTarget(t);
  const back = parseTarget(s);
  h.ok(sameTarget(t, back) && formatTarget(back) === s, `shorthand round-trips: ${s}`);
  h.ok(describeTarget(t).length > 0, `describes ${t.kind}: ${describeTarget(t)}`);
}
h.eq(describeTarget(samples[2]), 'plot "density" (fig-2) › series "control"', "a plot part reads like the user sees it");
h.eq(parseTarget("doc:paper/a@b/c.qmd@5-9"), { kind: "doc", path: "paper/a@b/c.qmd", from: 5, to: 9 }, "doc paths may contain @ and /; the LAST @ splits the range");
for (const bad of ["fig-2", "part:fig-2/el-9", "element:fig-2", "doc:x.qmd@9-5", "beat:d/s/x", "bogus:x"]) {
  let threw = "";
  try { parseTarget(bad); } catch (e) { threw = (e as Error).message; }
  h.ok(!!threw, `rejects "${bad}" (${threw.slice(0, 60)})`);
}
h.eq(widenTarget(samples[2])?.kind, "element", "part widens to its plot element");
h.eq(widenTarget(widenTarget(samples[2])!)?.kind, "figure", "…and the element to its figure");
h.eq(widenTarget(samples[7])?.kind, "beat", "a clip at a step widens to that step");
h.eq(widenTarget(samples[6])?.kind, "slide", "a step widens to its slide");
h.eq(widenTarget(samples[0]), null, "a figure is the widest");
h.eq(uniqueTargets([samples[0], { kind: "figure", figureId: "fig-2" }, samples[1]]).length, 2, "uniqueTargets de-duplicates by identity, not names");

// ---------------------------------------------------------------------------
h.section("presence");
h.eq(PRESENCE_WORDS.length, 256, "exactly 256 handles");
h.eq(new Set(PRESENCE_WORDS).size, 256, "handles are unique");
h.ok(PRESENCE_WORDS.every((w) => /^[a-z]+$/.test(w)), "handles are lowercase letters only (safe as @mentions)");
h.eq(presenceWord("session-abc"), presenceWord("session-abc"), "naming is deterministic");
const nA = presenceName({ id: "s-1", product: "Claude Code", surface: "CLI" }, new Set());
h.eq(nA.display, `claude · cli · ${nA.name}`, "display form: vendor · surface · handle");
const nB = presenceName({ id: "s-1", product: "Codex", surface: "VS Code" }, new Set([nA.name]));
h.eq(nB.name, `${nA.name}-2`, "a live collision appends -2");
h.eq(presenceName({ id: "bg-1", product: "Claude Code", surface: "headless", background: true }, new Set()).display.startsWith("bg · claude · "), true, "background sessions carry the bg prefix");
h.eq([vendorShort("Codex"), vendorShort("gemini cli"), vendorShort(null)], ["codex", "gemini", "agent"], "vendor short names");
h.eq([surfaceShort("VS Code"), surfaceShort("desktop app"), surfaceShort("headless"), surfaceShort("CLI"), surfaceShort("MCP")], ["vscode", "desktop", "headless", "cli", "mcp"], "surface short names");
const now0 = Date.parse("2026-09-27T12:00:00Z");
const pFresh = { heartbeatAt: iso(now0 - 10_000), pid: 42, host: "lab" };
h.ok(!isPresenceStale(pFresh, now0), "a 10 s old heartbeat is live");
h.ok(isPresenceStale({ ...pFresh, heartbeatAt: iso(now0 - 61_000) }, now0), "a 61 s old heartbeat is stale");
h.ok(isPresenceStale(pFresh, now0, { host: "lab", pidAlive: () => false }), "a dead writer on the same host is stale at once");
h.ok(!isPresenceStale(pFresh, now0, { host: "other", pidAlive: () => false }), "…but pids are only trusted on the same host");
h.eq(parsePresence("{torn"), null, "a torn presence file is not a session");
const sess = (id: string, name: string, beatAgo: number): PresenceSession => ({ v: 1, id, name, display: name, product: "Claude Code", surface: "CLI", client: "claude-code", pid: 1, host: "lab", startedAt: iso(now0 - 1e6), heartbeatAt: iso(now0 - beatAgo), watching: true, live: false });
h.eq([...liveSessions([sess("a", "heron", 5_000), sess("b", "wren", 120_000)], now0).keys()], ["a"], "liveSessions drops stale sessions");

// ---------------------------------------------------------------------------
h.section("tags and routes");
h.eq(parseTags("fix legend #claude, (#Stats-v2) and email a@b.c #claude"), ["claude", "stats-v2"], "tags: lowercased, de-duplicated, not inside words");
const heron: SessionRef = { id: "sess-heron", name: "heron", client: "claude-code" };
const wren: SessionRef = { id: "sess-wren", name: "wren", client: "codex" };
h.eq(parseRoute("@heron move this below the axis", [heron, wren]), { route: { session: heron }, text: "move this below the axis" }, "@name routes to that session and leaves the text clean");
h.eq(parseRoute("tidy @any please", []).route, "any", "@any");
h.eq(parseRoute("@new redo panel b", []).route, { background: "claude" }, "@new = a Claude background agent");
h.eq(parseRoute("@new-codex redo panel b", []).route, { background: "codex" }, "@new-codex");
h.eq(parseRoute("ping @someone about @property decorators", [heron]), { route: null, text: "ping @someone about @property decorators" }, "unknown @words are left alone");
h.eq(parseRoute("mail kd@wisc.edu", [heron]).route, null, "an email is not a mention");
h.eq(parseRoute("@wren @heron first wins", [heron, wren]).route, { session: wren }, "the first route mention wins");
h.eq([describeRoute("none"), describeRoute("any"), describeRoute({ session: heron }), describeRoute({ background: "codex" })], ["Inbox", "Any watching agent", "heron", "New background agent (Codex)"], "route labels");

// ---------------------------------------------------------------------------
h.section("ledger fold: claims, routes, states");
const n1 = at(makeNote("move this legend #claude", { surface: "figure", activeFigureId: "fig-2", targets: [samples[2]] }, "human", "any"));
const n2 = at(makeNote("@wren fix the caption", { surface: "figure", activeFigureId: "fig-3" }, "human", { session: wren }));
const n3 = at(makeNote("check this paragraph", { surface: "paper", doc: { path: "paper/drafts/draft_1.qmd", from: 10, to: 40, quote: "some text" } }, "human"));
const cH = at(makeClaim(n1.id, heron, "claude-code"));
const cW = at(makeClaim(n1.id, wren, "codex"));           // loses: heron's claim is live
const cH2 = at(makeClaim(n2.id, heron, "claude-code"));   // loses: n2 is wren's queue
const cW2 = at(makeClaim(n2.id, wren, "codex"));
const r1 = at(makeReply(n2.id, { kind: "agent", name: "wren", client: "codex" }, "Left or right?", "codex", { state: "needs-input", session: wren }));
const r2 = at(makeReply(n2.id, { kind: "human", name: "You" }, "Left #urgent", "human"));
const text = [n1, n2, n3, cH, cW, cH2, cW2, r1, r2].map(serializeEvent).join("") + '{"kind":"send","id":"x","ts":"t","client":"human"}\n{"torn';
const st = foldAnnotations(parseLedger(text));
h.eq(st.items.map((a) => a.note.id), [n1.id, n2.id, n3.id], "notes in creation order; the old send line and the torn tail are skipped");
const a1 = st.byId.get(n1.id)!, a2 = st.byId.get(n2.id)!, a3 = st.byId.get(n3.id)!;
h.eq(a1.claim?.session.id, heron.id, "first claim in ledger order wins");
h.eq(a1.lostClaims.map((l) => l.session.id), [wren.id], "the losing claim is recorded (the verb reports it)");
h.eq(a2.assignedTo?.id, wren.id, "a named route assigns at creation");
h.eq(a2.lostClaims[0]?.session.id, heron.id, "a non-assignee cannot claim a named queue item");
h.eq(a2.claim?.session.id, wren.id, "the assignee can");
h.eq(statusOf(a2), "claimed", "a human reply clears needs-input");
h.eq(a2.tags, ["urgent"], "tags from human replies join the item");
h.eq(annotationThread(a2).map((m) => `${m.kind}:${m.text}`), ["human:@wren fix the caption", "agent:Left or right?", "human:Left #urgent"], "the thread: note, agent question, human answer");
h.eq(statusOf(a3), "open", "an unrouted note is open");
h.eq(a3.route, "none", "…with route none (inbox)");

// liveness: a stale holder can be taken over; a live one cannot
const late = clock + CLAIM_TTL_MS + 60_000;
const take = { ...makeClaim(n1.id, wren, "codex", { takeover: "stale" }), ts: iso(late) };
const st2 = foldAnnotations([...parseLedger(text), take]);
h.eq(st2.byId.get(n1.id)!.claim?.session.id, wren.id, "a takeover:stale claim replaces a dead holder");
h.eq(st2.byId.get(n1.id)!.lastHolder?.id, heron.id, "…and remembers who held it");
const early = { ...makeClaim(n1.id, wren, "codex"), ts: iso(clock + 60_000) };
h.eq(foldAnnotations([...parseLedger(text), early]).byId.get(n1.id)!.claim?.session.id, heron.id, "a plain claim within the TTL loses");
const forced = { ...makeClaim(n1.id, wren, "codex", { force: true }), ts: iso(clock + 60_000) };
h.eq(foldAnnotations([...parseLedger(text), forced]).byId.get(n1.id)!.claim?.session.id, wren.id, "force (the user's explicit instruction) wins");
const liveCtx = { now: late, liveSessionIds: new Set([heron.id]) };
h.eq(writeAllowed(a1, wren, liveCtx), { ok: false, reason: "claimed by heron" }, "a non-holder may not write while the holder is live (by presence)");
h.eq(writeAllowed(a1, wren, { now: late }), { ok: true }, "…but may once the holder is stale and silent");

// human release revokes; release-session stops a watcher
const rel = at(makeRelease(n1.id, "human", "human"));
const st3 = foldAnnotations([...parseLedger(text), rel]);
h.eq(st3.byId.get(n1.id)!.claim, null, "a human release ends the claim");
h.eq(writeAllowed(st3.byId.get(n1.id)!, heron, { now: clock }), { ok: false, reason: "released by the user" }, "…and the holder's next write is refused");
const reclaim = at(makeClaim(n1.id, heron, "claude-code"));
h.eq(foldAnnotations([...parseLedger(text), rel, reclaim]).byId.get(n1.id)!.revokedSession, null, "re-claiming lifts the revocation");
const stop = at(makeReleaseSession(wren, "human"));
const st4 = foldAnnotations([...parseLedger(text), stop]);
h.eq(st4.byId.get(n2.id)!.claim, null, "release-session drops every claim the session held");
h.ok(st4.stoppedSessions.has(wren.id), "…and records the stop (its wait returns stopped:true)");

// resolve / reopen / withdraw / archive / assign
const res = at(makeResolve(n2.id, "codex", { note: "Moved left.", author: { kind: "agent", name: "wren" }, session: wren }));
const st5 = foldAnnotations([...parseLedger(text), res]);
const a5 = st5.byId.get(n2.id)!;
h.eq([statusOf(a5), a5.resolvedBy, a5.claim], ["resolved", "wren", null], "resolve names the agent and ends the claim");
h.eq(statusChip(a5), "Resolved by wren", "chip: Resolved by wren");
const st6 = foldAnnotations([...parseLedger(text), res, at(makeReopen(n2.id, "human"))]);
h.eq(statusOf(st6.byId.get(n2.id)!), "queued", "reopen returns an assigned item to its queue");
const st7 = foldAnnotations([...parseLedger(text), at(makeWithdraw(n3.id, "human", "never mind")), at(makeResolve(n3.id, "claude-code"))]);
h.eq([statusOf(st7.byId.get(n3.id)!), st7.byId.get(n3.id)!.resolved], ["withdrawn", false], "a withdrawn note cannot be resolved later");
const st8 = foldAnnotations([...parseLedger(text), at(makeArchive(n3.id, true, "human")), at(makeAssign(n3.id, heron, "human"))]);
h.eq([st8.byId.get(n3.id)!.archived, statusOf(st8.byId.get(n3.id)!)], [true, "queued"], "archive is orthogonal; assign queues");
h.eq(statusChip(st8.byId.get(n3.id)!, { now: clock, watchingSessionIds: new Set() }), "Queued → heron (not watching)", "chip says when the assignee is not watching");
const st9 = foldAnnotations([...parseLedger(text), at(makeAssign(n3.id, heron, "human")), at(makeAssign(n3.id, null, "human"))]);
h.eq([statusOf(st9.byId.get(n3.id)!), st9.byId.get(n3.id)!.route], ["open", "none"], "unassign returns the item to the inbox");
const stN = foldAnnotations([...parseLedger(text), at(makeState(n1.id, "needs-input", "claude-code", heron))]);
h.eq(statusChip(stN.byId.get(n1.id)!), "heron needs your input", "chip: heron needs your input");
h.eq(statusChip(a1, { now: late }), "heron disconnected — reassign?", "chip: a silent holder shows as disconnected");
h.eq(findAnnotation(st, "paragraph").note.id, n3.id, "findAnnotation by unique text");
let amb = "";
try { findAnnotation(st, "t"); } catch (e) { amb = (e as Error).message; }
h.ok(/open annotations match/.test(amb), "…ambiguous text names the ids");
h.ok(describeStamp(n1.context).includes('plot "density"'), "describeStamp prefers the resolved target");
h.ok(describeStamp({ surface: "reader", reader: { citekey: "smith2020", page: 4, selection: "we find" } }).includes("smith2020 p.4"), "describeStamp covers the reader");

// comment overlays live in the same ledger
const cid = "c-abc";
const stC = foldAnnotations([...parseLedger(text), at(makeClaim(cid, heron, "claude-code")), at(makeState(cid, "needs-input", "claude-code", heron))]);
h.eq(stC.overlays.get(cid)?.claim?.session.id, heron.id, "a claim on a comment id creates its overlay");

// ---------------------------------------------------------------------------
h.section("inbox model");
const comments: InboxComment[] = [
  { id: cid, doc: "paper/drafts/draft_1.qmd", anchor: { start: 5, end: 25, quote: "the density drops" }, resolved: false, messages: [{ author: "Kort Driessen", body: "Cite Smith 2020 here #claude", createdAt: iso(clock - 5000) }, { author: "heron", body: "Which Smith?", createdAt: iso(clock) }] },
  { id: "c-old", doc: "Context/NOTEBOOK.md", anchor: { start: 0, end: 4, quote: "Log" }, resolved: true, messages: [{ author: "You", body: "typo", createdAt: iso(clock - 9000) }] },
];
const items = buildInbox({ state: stC, comments, liveness: { now: clock, liveSessionIds: new Set([heron.id]), watchingSessionIds: new Set([heron.id]) }, humanAuthors: ["Kort Driessen"] });
h.eq(items.map((i) => i.id), [n1.id, n2.id, n3.id, cid, "c-old"], "annotations then comments");
const ci = items.find((i) => i.id === cid)!;
h.eq([ci.kind, ci.surface, ci.status, ci.chip], ["comment", "paper", "needs-input", "heron needs your input"], "a comment carries the ledger overlay's status");
h.eq(ci.thread.map((m) => m.kind), ["human", "agent"], "comment authors: the project author is human, others are agents");
h.eq(ci.tags, ["claude"], "comment tags come from human messages");
h.eq(items.find((i) => i.id === "c-old")!.status, "resolved", "a resolved comment");
h.eq(filterInbox(items, {}).map((i) => i.id), [n1.id, n2.id, n3.id, cid], "default: open/queued/claimed/needs-input, resolved hidden");
h.eq(filterInbox(items, { doc: "draft_1" }).map((i) => i.id), [n3.id, cid], "doc by basename without extension spans annotations and comments");
h.eq(filterInbox(items, { tag: ["claude"] }).map((i) => i.id), [n1.id, cid], "#claude across kinds");
h.eq(filterInbox(items, { surface: "figure" }).map((i) => i.id), [n1.id, n2.id], "surface:figure");
h.eq(filterInbox(items, { figure: "Figure 3" }, { figureAliases: new Map([["fig-3", ["Figure 3", "Caption fig"]]]) }).map((i) => i.id), [n2.id], "figure by alias");
h.eq(filterInbox(items, { kind: "comment", status: "all" }).map((i) => i.id), [cid, "c-old"], "kind:comment status:all");
h.eq(filterInbox(items, { holder: "wren" }).map((i) => i.id), [n2.id], "@wren: assigned to or claimed by wren");
h.eq(filterInbox(items, { text: "paragraph" }).map((i) => i.id), [n3.id], "free text");
h.eq(docCandidates(["paper/a/notes.qmd", "paper/b/notes.qmd", "paper/x.qmd"], "notes"), ["paper/a/notes.qmd", "paper/b/notes.qmd"], "an ambiguous doc name lists its candidates");
const qf = parseInboxQuery('draft_1 #claude figure open "exact phrase" @heron', { docs: ["paper/drafts/draft_1.qmd"] });
h.eq(qf, { doc: "draft_1", tag: ["claude"], surface: "figure", status: ["open"], holder: "heron", text: "exact phrase" }, "plain-language query → filter");
h.eq(describeFilter(qf), ["surface:figure", "doc:draft_1", "#claude", "@heron", "status:open", '"exact phrase"'], "…and back to chips");
h.eq(parseInboxQuery("kind:comment fig:fig-2 since:2026-09-01 archived"), { kind: "comment", figure: "fig-2", since: "2026-09-01", archived: true }, "key:value tokens");
h.eq(sortForInbox(items).map((i) => i.status)[0], "needs-input", "needs-input sorts first");

h.section("delivery (the one routing rule)");
const byId = new Map(items.map((i) => [i.id, i]));
const pending = buildInbox({ state: foldAnnotations([n1, n2, n3].map((e) => e)), comments: [], liveness: { now: clock } });
const p1 = pending[0], p2 = pending[1], p3 = pending[2];
h.ok(deliverableTo(p1, heron, { mode: "annotations" }), "an @any item reaches a watcher of annotations");
h.ok(!deliverableTo(p1, heron, { mode: "queue" }), "…not a watcher of its queue only");
h.ok(!deliverableTo(p1, heron, { mode: "filter", filter: { surface: "slide" } }), "…nor one whose filter excludes it");
h.ok(deliverableTo(p2, wren, { mode: "queue" }), "a named item reaches its assignee even in queue mode");
h.ok(!deliverableTo(p2, heron, { mode: "annotations" }), "…and nobody else");
h.ok(!deliverableTo(p3, heron, { mode: "annotations" }), "an inbox-only item reaches no watcher");
h.ok(!deliverableTo(byId.get(n1.id)!, wren, { mode: "annotations" }), "an item held by a live session is not delivered to others");
const pk = toPacket(byId.get(n1.id)!, { element: { id: "el-3", type: "plot" } });
h.eq([pk.route, pk.claimedBy, pk.targets[0].ref], ["any", "heron", "part:fig-2/el-3#series-control"], "packet: route, holder, target shorthand");
h.ok(matchesFilter(byId.get(n1.id)!, { status: "all" }), "matchesFilter with status all");

await h.done();
