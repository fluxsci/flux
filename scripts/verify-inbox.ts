// Hermetic runner only. Replaces feedback/withdraw gates: v2 has no send boundary.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { harness } from "./lib/harness.mjs";
import { fixture, repo, cli, worker, cleanEnv, writePresence, TestProcessScope, installTestLauncher, rawMcp, dataOf } from "./lib/inboxFixture";
import { listInbox, claimItem, releaseItem, replyItem, resolveItem, archiveItem, readAnnotationState, appendAnnotationEvent, readInbox } from "../flux-core/annotations";
import { inspectTarget } from "../flux-core/inspect";
import { makeNote, makeWithdraw, makeResolve, makeClaim, makeRelease, makeAssign, makeReply, CLAIM_TTL_MS, foldAnnotations, parseLedger, serializeEvent } from "../src/lib/project/annotations";
import { appendCommentMessage } from "../src/lib/project/comments";
import { addComment, listProjectComments } from "../flux-core/comments";
import { resolveFluxLibPath, addToFluxLib } from "../flux-core/fluxlib";
import { writeFulltext } from "../flux-core/items";
import { addAnnotation } from "../flux-core/annotate";
import { rasterizeSvgToPng } from "../flux-core/render";
import type { InboxFilter } from "../src/lib/project/inbox";
const h = harness("verify-inbox"), temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "flux-inbox-")));
const scope = new TestProcessScope();
let mcp: Awaited<ReturnType<typeof rawMcp>> | undefined;
const rows = (items: any[]) => items.map(i => [i.id, i.status]).sort((a, b) => a[0].localeCompare(b[0]));
async function refuses(action: () => Promise<unknown>, pattern: RegExp, label: string) {
  let message = ""; try { await action(); } catch (e) { message = (e as Error).message; }
  h.ok(pattern.test(message), `${label}: ${message}`);
}
try {
  const f = await fixture(path.join(temp, "project")), { root } = f;
  const env = cleanEnv({ CODEX_THREAD_ID: "inbox-agent" });
  const launcher = await installTestLauncher(repo, path.join(temp, "bin"));
  mcp = await rawMcp(launcher, temp, [], env); await mcp.initialize("codex");
  h.ok(!(await mcp.call("connect", { target: root })).isError, "explicit MCP connect succeeds");
  const sessions = [...(await readAnnotationState(root)).presence.values()];
  const caller = { session: sessions.find(s => s.id === "inbox-agent")! };
  h.ok(!!caller.session, "MCP presence supplies the write identity");
  await claimItem(root, f.notes[0].id, {}, caller);
  await replyItem(root, f.notes[0].id, "Which units?", { needsInput: true }, caller);
  await resolveItem(root, f.comments[1].id, { note: "Fixed prose" }, caller);
  await archiveItem(root, f.notes[3].id, true, caller);
  const gone = makeNote("Ignore this mistake", { surface: "figure" }, "human");
  await appendAnnotationEvent(root, gone); await appendAnnotationEvent(root, makeWithdraw(gone.id, "human", "edited"));
  const base = await listInbox(root);
  h.eq(base.items.length, 5, "default hides resolved, withdrawn and archived items across both stores");
  h.eq((await listInbox(root, { filter: { kind: "comment", status: "all" } })).items.map(i => i.doc), f.docs, "all three comment documents include Context");
  const tests: { filter?: InboxFilter; query?: string; mine?: boolean; flags: string[] }[] = [
    { flags: [] }, { filter: { kind: "comment" }, flags: ["--kind", "comment"] },
    { filter: { surface: "figure" }, flags: ["--surface", "figure"] },
    { filter: { doc: "draft_1" }, flags: ["--doc", "draft_1"] },
    { filter: { doc: "draft_1.qmd" }, flags: ["--doc", "draft_1.qmd"] },
    { filter: { doc: f.docs[2] }, flags: ["--doc", f.docs[2]] },
    { filter: { figure: "Density" }, flags: ["--figure", "Density"] },
    { filter: { figure: f.figure.referenceKey }, flags: ["--figure", f.figure.referenceKey!] },
    { filter: { deck: "talk" }, flags: ["--deck", "talk"] },
    { filter: { tag: ["stats"] }, flags: ["--tag", "stats"] },
    { filter: { status: ["needs-input"] }, flags: ["--status", "needs-input"] },
    { filter: { status: ["open", "needs-input"] }, flags: ["--status", "open,needs-input"] },
    { filter: { status: "all", archived: true }, flags: ["--status", "all", "--archived"] },
    { filter: { since: "2000-01-01T00:00:00Z" }, flags: ["--since", "2000-01-01T00:00:00Z"] },
    { filter: { text: "Which units" }, flags: ["--text", "Which units"] },
    { filter: { holder: caller.session.name }, flags: ["--holder", caller.session.name] },
    ...(["me", "others", "none", "any"] as const).map(claimed => ({ filter: { claimed }, flags: ["--claimed", claimed] })),
    { mine: true, flags: ["--mine"] },
    { query: "draft_1 #stats comments", flags: ["draft_1 #stats comments"] },
  ];
  for (const test of tests) {
    const expected = rows((await listInbox(root, test, caller)).items);
    const child = cli(scope, root, ["inbox", ...test.flags, "--json"], env); const exit = await child.closed;
    h.ok(exit.code === 0, `CLI inbox ${test.flags.join(" ")}: ${child.stderr}`);
    h.eq(rows(JSON.parse(child.stdout).items), expected, "CLI executes the shared filtered model");
    const actual = dataOf(await mcp.call("list_inbox", { filter: test.filter, query: test.query, mine: test.mine }));
    h.eq(rows(actual.items), expected, "MCP and CLI have identical ids/statuses on the same fixture");
  }
  await fs.mkdir(path.join(root, "paper/nested"));
  await fs.writeFile(path.join(root, "paper/nested/draft_1.qmd"), "# Other\n");
  await refuses(() => listInbox(root, { filter: { doc: "draft_1" } }), /ambiguous.*paper\/draft_1.qmd.*paper\/nested\/draft_1.qmd/, "ambiguous basename lists candidates even if one has no comments");
  h.ok((await listInbox(root, { filter: { doc: f.docs[0] } })).items.length > 0, "full path disambiguates");

  const ledger = path.join(root, ".meta/feedback.ndjson");
  const before = await fs.readFile(ledger, "utf8");
  await refuses(() => resolveItem(root, gone.id, {}, caller), /withdrawn/, "withdrawn resolve refused");
  await refuses(() => resolveItem(root, f.comments[1].id, {}, caller), /resolved/, "resolved comment refused");
  h.eq(await fs.readFile(ledger, "utf8"), before, "refused resolutions append no bytes");
  await resolveItem(root, "Check paragraph", { note: "Read current prose" }, caller);
  h.ok((await fs.readFile(ledger, "utf8")).startsWith(before), "resolve appends without rewriting earlier bytes");
  await refuses(() => resolveItem(root, "missing quote", {}, caller), /no open/, "missing text refuses");
  await refuses(() => resolveItem(root, "Review document", {}, caller), /ambiguous/, "ambiguous open text refuses");
  await fs.appendFile(ledger, '{"kind":"send"}\n{"torn');
  h.ok((await listInbox(root)).items.length > 0, "old send lines and torn lines cannot break discovery");
  await appendAnnotationEvent(root, makeReply(f.notes[0].id, { kind: "human", name: "You" }, "Use percent #urgent", "human"));
  const answered = (await listInbox(root)).items.find(i => i.id === f.notes[0].id)!;
  h.eq([answered.status, answered.tags.includes("urgent")], ["claimed", true], "append after an unterminated torn line recovers; human reply clears needs-input and derives tags");

  const sidePath = path.join(root, "paper/draft_1.comments.json");
  const side = JSON.parse(await fs.readFile(sidePath, "utf8"));
  side.extension = { preserved: true };
  await fs.writeFile(sidePath, JSON.stringify(side));
  await replyItem(root, f.comments[0].id, "Please choose a citation", { needsInput: true }, caller);
  const replied = JSON.parse(await fs.readFile(sidePath, "utf8"));
  const msg = replied.threads.find(t => t.id === f.comments[0].id).messages.at(-1);
  h.eq(replied, appendCommentMessage(side, f.comments[0].id, msg), "sidecar bytes equal the shared immutable append helper's result");
  h.eq(side.threads[0].messages.length, 1, "shared helper does not mutate input");
  h.eq([msg.author, msg.session.id, msg.client], [caller.session.name, caller.session.id, "codex"], "comment message carries bound author/session/client");
  h.eq((await listInbox(root)).items.find(i => i.id === f.comments[0].id)?.status, "needs-input", "comment reply writes ledger state");
  replied.threads[0].messages.push({ author: "You", kind: "human", body: "Use the recent study", createdAt: new Date(Date.now() + 1).toISOString() });
  await fs.writeFile(sidePath, JSON.stringify(replied));
  h.eq((await listInbox(root)).items.find(i => i.id === f.comments[0].id)?.status, "open", "human sidecar reply clears needs-input in the shared view");
  const twins = ["parallel A", "parallel B"].map(text => cli(scope, root, ["reply", f.comments[0].id, text], env));
  await Promise.all(twins.map(c => c.closed));
  const messages = JSON.parse(await fs.readFile(sidePath, "utf8")).threads[0].messages;
  h.ok(messages.some(m => m.body === "parallel A") && messages.some(m => m.body === "parallel B"), "concurrent sidecar replies retain both messages");
  await refuses(() => addComment(root, { docRel: f.docs[0], quote: "The density", body: "ambiguous" }), /occurs 2/, "add-comment rejects ambiguous quote");
  const second = await addComment(root, { docRel: f.docs[0], quote: "The density", body: "second", at: 2 });
  const anchored = (await listProjectComments(root)).find(c => c.id === second.id)!;
  h.eq(anchored.anchor.start, (await fs.readFile(path.join(root, f.docs[0]), "utf8")).lastIndexOf("The density"), "add-comment occurrence 2 has exact offset");
  h.ok(!!anchored.anchor.prefix && !!anchored.anchor.suffix, "comment anchor retains context");

  const other = { session: { id: "other", name: "wren", client: "test" } };
  await writePresence(root, other.session);
  const busy = await claimItem(root, f.notes[0].id, {}, other);
  h.eq([busy.claimed, busy.holder?.name], [false, caller.session.name], "loser reports the live holder");
  for (const [name, write] of [
    ["reply", () => replyItem(root, f.notes[0].id, "no", {}, other)],
    ["resolve", () => resolveItem(root, f.notes[0].id, {}, other)],
    ["release", () => releaseItem(root, f.notes[0].id, other)],
    ["archive", () => archiveItem(root, f.notes[0].id, true, other)],
    ["unarchive", () => archiveItem(root, f.notes[0].id, false, other)],
  ] as const) await refuses(write, /claimed by/, `${name}: another live claim refuses`);
  await appendAnnotationEvent(root, makeRelease(f.notes[0].id, "human", "human"));
  await refuses(() => replyItem(root, f.notes[0].id, "no", {}, caller), /released by the user/, "human release revokes next write");
  await refuses(() => claimItem(root, f.notes[0].id, {}, caller), /released by the user/, "claim cannot silently undo a human release");
  await claimItem(root, f.notes[2].id, { note: "Working now" }, other);
  h.eq((await listInbox(root)).items.find(i => i.id === f.notes[2].id)?.thread.at(-1)?.state, "working", "claim note is a working reply");
  await claimItem(root, f.notes[2].id, { force: true }, caller);
  h.eq((await readAnnotationState(root)).state.byId.get(f.notes[2].id)?.claim?.session.id, caller.session.id, "explicit force transfers a live claim");
  await releaseItem(root, f.notes[2].id, caller);
  await archiveItem(root, f.notes[3].id, false, caller);
  h.ok((await listInbox(root)).items.some(i => i.id === f.notes[3].id), "unarchive restores default visibility");

  const stale = makeNote("Stale claim", { surface: "figure" }, "human"); await appendAnnotationEvent(root, stale);
  const old = { ...makeClaim(stale.id, { id: "gone", name: "gone" }, "test"), ts: new Date(Date.now() - CLAIM_TTL_MS - 10000).toISOString() };
  await appendAnnotationEvent(root, old);
  h.ok((await claimItem(root, stale.id, {}, other)).claimed, "stale activity without presence can be taken");
  h.eq((await readAnnotationState(root)).events.at(-1)?.kind, "claim", "takeover is ledgered");
  h.eq((await readAnnotationState(root)).events.at(-1)?.['takeover'], "stale", "stale takeover is explicit");
  const liveOld = makeNote("Presence protects old claim", null, "human"); await appendAnnotationEvent(root, liveOld);
  await appendAnnotationEvent(root, { ...old, target: liveOld.id, session: caller.session });
  h.eq((await claimItem(root, liveOld.id, {}, other)).claimed, false, "fresh presence protects activity older than 30 minutes");
  h.eq(foldAnnotations((await readAnnotationState(root)).events, { now: Date.now(), liveSessionIds: new Set() }).byId.get(liveOld.id)?.claim?.session.id, caller.session.id, "a rejected presence-protected claim stays rejected on later replay without presence");
  const model = foldAnnotations([stale, old, { ...makeClaim(stale.id, other.session, "test", { takeover: "stale", previousClaim: { id: old.session.id, since: old.ts } }) }, { ...makeClaim(stale.id, caller.session, "codex", { takeover: "stale", previousClaim: { id: old.session.id, since: old.ts } }) }]);
  h.eq(model.byId.get(stale.id)?.claim?.session.id, other.session.id, "two stale takeovers cannot replace the same predecessor twice");

  for (let n = 0; n < 6; n++) {
    const race = makeNote(`Race ${n}`, null, "human"); await appendAnnotationEvent(root, race);
    const children = ["A", "B"].map(name => worker(scope, root, "claim", { id: race.id, session: { id: `race-${n}-${name}`, name } }));
    await Promise.all(children.map(c => c.ready)); // both processes stopped at the same start barrier
    for (const c of children) c.child.stdin.write("GO\n");
    await Promise.all(children.map(c => c.closed));
    const results = children.map(c => JSON.parse(c.stdout.trim().split("\n").at(-1)!));
    h.eq(results.filter(r => r.claimed).length, 1, `claim race ${n}: exactly one winner`);
  }

  // All eleven target kinds, with current state from actual persisted files.
  const libPath = await resolveFluxLibPath();
  await addToFluxLib('@article{fixture2026, title={Fixture result}, author={Tester, A}, year={2026}}', { libPath });
  await writeFulltext("fixture2026", "First page.\n\f\nSecond page: the measured result.", libPath);
  const highlight = await addAnnotation("fixture2026", { page: 2, anchor: { quote: "measured result", prefix: "the ", suffix: "." }, color: "yellow" }, libPath);
  const passage = await inspectTarget(root, { kind: "passage", citekey: "fixture2026", page: 2, highlightId: highlight.id });
  h.eq([passage.text, passage.quote], ["Second page: the measured result.", "measured result"], "Reader inspect reads the saved page and highlight quote without rendering");
  const targets = [
    `figure:review`, `element:review/${f.plot.elementId}`, `part:review/${f.plot.elementId}#${f.partId}`, `caption:review`,
    `doc:${f.docs[0]}@13-33`, "slide:talk/s1", "beat:talk/s1/1", "track:talk/s1/t1", "passage:fixture2026@2", "library:fixture2026", "region:figure@1,2,300,200",
  ];
  for (const target of targets) {
    const result = await inspectTarget(root, target);
    h.ok(!!result.target && !!result.description, `inspect ${target}`);
    const fromMcp = dataOf(await mcp.call("flux_verb", { verb: "get_target", args: { target } }));
    h.eq(fromMcp, result, "MCP inspect executes the same current-state reader");
  }
  const doc = await inspectTarget(root, { kind: "doc", path: f.docs[0], from: 13, to: 33 });
  h.eq(doc.heading, "Heading 0", "doc inspect finds the current heading");
  h.ok(String(doc.around).includes("changed again"), "doc inspect includes surrounding text");
  h.eq((await inspectTarget(root, "track:talk/s1/t1")).timing, { start: 20, duration: 320, end: 340 }, "track timing uses the shared duration core");
  await refuses(() => inspectTarget(root, "doc:../secret@0-2"), /escapes|invalid|path/, "inspect cannot read outside the project");

  const png = await rasterizeSvgToPng('<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="900"><rect width="1800" height="900" fill="red"/></svg>', 1800);
  await fs.mkdir(path.join(root, ".meta/feedback"), { recursive: true });
  await fs.writeFile(path.join(root, ".meta/feedback/snapshot.png"), png);
  const pictures = [];
  for (let n = 0; n < 8; n++) {
    const image = makeNote(`Picture ${n} #pictures`, { surface: "figure", targets: [{ kind: "element", figureId: "review", elementId: f.plot.elementId }], snapshot: { image: ".meta/feedback/snapshot.png", rect: { x: 0, y: 0, w: 1800, h: 900 }, window: { w: 1800, h: 900, dpr: 1 }, marks: [] } }, "human");
    await appendAnnotationEvent(root, image); pictures.push(image);
  }
  const packet = await mcp.call("list_inbox", { filter: { tag: ["pictures"] }, packets: true });
  const contents = packet.content.filter(c => c.type === "image");
  h.eq(contents.length, 6, "packet response has a hard six-image cap");
  h.eq(dataOf(packet).items.length, 8, "image cap does not drop packets");
  h.ok(dataOf(packet).items.every(i => i.current.targets[0].element.id === f.plot.elementId), "packets inline exact current target state");
  h.ok(packet.content.some(c => c.type === "text" && c.text.includes("get_inbox_image")), "beyond-cap images have paths and a fetch hint");
  for (const image of contents) {
    const bytes = Buffer.from(image.data, "base64"); h.ok(Math.max(bytes.readUInt32BE(16), bytes.readUInt32BE(20)) <= 1600, "inline snapshot long edge is bounded");
  }
  h.eq((await mcp.call("flux_verb", { verb: "get_inbox_image", args: { id: pictures[7].id } })).content[0].type, "image", "the snapshot tool fetches beyond the cap (through flux_verb, as the hint says)");
  const meta = await mcp.call("flux_verb", { verb: "get_inbox_image", args: { id: pictures[7].id } });
  h.eq(meta.content[0].type, "image", "manual image tool is reachable through flux_verb");
  h.ok((await fs.readFile(path.join(root, ".meta/journal.ndjson"), "utf8")).includes('"action":"annotation_resolve"'), "annotation writes are journaled");
} finally { await mcp?.close(); await scope.dispose(); await fs.rm(temp, { recursive: true, force: true }); }
await h.done();
