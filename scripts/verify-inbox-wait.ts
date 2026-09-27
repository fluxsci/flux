// Waits and writers synchronize at ready barriers, never guessed process start times.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { harness } from "./lib/harness.mjs";
import { scratchProject } from "./lib/mcpFixture";
import { TestProcessScope, worker, note, writePresence } from "./lib/inboxFixture";
import { waitForInbox } from "../flux-core/inboxWait";
import { appendAnnotationEvent, claimItem, listInbox, replyItem } from "../flux-core/annotations";
import { makeNote, makeRelease, makeReleaseSession, makeAssign, makeReply } from "../src/lib/project/annotations";
import { addComment } from "../flux-core/comments";
const h = harness("verify-inbox-wait"), temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "inbox-wait-")));
const scope = new TestProcessScope();
const heron = { id: "heron-session", name: "heron", client: "test" }, wren = { id: "wren-session", name: "wren", client: "test" };
const resultOf = async c => { const exit = await c.closed; if (exit.code) throw new Error(c.stderr); return JSON.parse(c.stdout.trim().split("\n").at(-1)!); };
let count = 0;
const project = async () => scratchProject(path.join(temp, `p${++count}`), "Wait gate");
try {
  {
    const root = await project();
    const waiter = worker(scope, root, "wait", { session: heron, timeoutMs: 5000 }); await waiter.ready;
    const event = makeNote("Immediate append", { surface: "figure" }, "human", "any");
    const writer = worker(scope, root, "append", { event }); await writer.ready;
    const start = Date.now(); writer.child.stdin.write("GO\n");
    const [r] = await Promise.all([resultOf(waiter), resultOf(writer)]);
    h.eq(r.items.map(i => i.id), [event.id], "wait resolves on another process's append");
    h.ok(Date.now() - start <= 1500, `barrier-to-delivery is ≤1.5 s (${Date.now() - start} ms)`);
    const empty = await waitForInbox(root, { cursor: r.cursor, timeoutMs: 50 }, { session: heron });
    h.eq(empty.items, [], "same cursor does not redeliver an unchanged any item");
    h.eq(empty.stopped, false, "timeout is empty, not stopped");
    // Same timestamp, different ledger bytes: timestamp cursors used to miss this.
    const sameTs = { ...makeReply(event.id, { kind: "human", name: "You" }, "A same-millisecond change", "human"), ts: event.ts };
    await appendAnnotationEvent(root, sameTs);
    const changed = await waitForInbox(root, { cursor: empty.cursor, timeoutMs: 50 }, { session: heron });
    h.eq(changed.items.map(i => i.id), [event.id], "cursor notices equal-timestamp ledger changes");
    h.eq((await waitForInbox(root, { timeoutMs: 30 }, { session: heron })).items.length, 0, "session cursor is remembered between calls");
  }
  {
    const root = await project(); await writePresence(root, heron); await writePresence(root, wren);
    const a = worker(scope, root, "wait", { session: heron, timeoutMs: 1000 });
    const b = worker(scope, root, "wait", { session: wren, timeoutMs: 1000 });
    await Promise.all([a.ready, b.ready]);
    const event = await note(root, "Named route", { session: heron });
    const [ra, rb] = await Promise.all([resultOf(a), resultOf(b)]);
    h.eq(ra.items.map(i => i.id), [event.id], "named route wakes the assignee");
    h.eq(rb.items, [], "named route does not wake another watcher");
    const filtered = await waitForInbox(root, { mode: "filter", filter: { kind: "comment", surface: "slide", tag: ["absent"], text: "absent" }, timeoutMs: 30 }, { session: heron });
    h.eq(filtered.items.map(i => i.id), [event.id], "named route bypasses the assignee's kind, surface, tag and text filters");
    h.eq((await claimItem(root, event.id, {}, { session: wren })).claimed, false, "another session cannot claim the named queue");
    const queued = await waitForInbox(root, { cursor: ra.cursor, mode: "queue", timeoutMs: 30 }, { session: heron });
    h.eq(queued.items.map(i => i.id), [event.id], "assigned queue returns immediately even at the same cursor");
    const later = await note(root, "Queued before watching", { session: wren });
    h.eq((await waitForInbox(root, { mode: "queue", timeoutMs: 20 }, { session: wren })).items.map(i => i.id), [later.id], "not-watching assignee receives its queued item on next wait");
    await writePresence(root, wren, 61000);
    const stale = (await listInbox(root)).items.find(i => i.id === later.id)!;
    h.eq([stale.status, stale.assignedTo, stale.lastHolder?.id], ["open", null, wren.id], "stale assignee returns to Open with last holder");
    h.eq(stale.chip, "wren disconnected — reassign?", "stale route tells the user to reassign");
    h.ok((await claimItem(root, later.id, {}, { session: heron })).claimed, "an explicitly addressed stale queue can be claimed");
  }
  {
    const root = await project();
    const a = worker(scope, root, "wait", { session: heron, timeoutMs: 2000, filter: { tag: ["wanted"] } });
    const b = worker(scope, root, "wait", { session: wren, timeoutMs: 2000, filter: { surface: "figure" } });
    const c = worker(scope, root, "wait", { session: { id: "excluded", name: "excluded" }, timeoutMs: 800, filter: { surface: "slide" } });
    await Promise.all([a.ready, b.ready, c.ready]);
    const event = await note(root, "Any matching watcher #wanted");
    const [ra, rb, rc] = await Promise.all([resultOf(a), resultOf(b), resultOf(c)]);
    h.eq([ra.items[0]?.id, rb.items[0]?.id], [event.id, event.id], "any wakes every matching watcher");
    h.eq(rc.items, [], "any still respects the watch filter");
    const claims = [heron, wren].map(session => worker(scope, root, "claim", { session, id: event.id }));
    await Promise.all(claims.map(c => c.ready)); for (const c of claims) c.child.stdin.write("GO\n");
    const results = await Promise.all(claims.map(resultOf));
    h.eq(results.filter(r => r.claimed).length, 1, "after broadcast, exactly one claim wins");
  }
  {
    const root = await project();
    const waits = [heron, wren].map(session => worker(scope, root, "wait", { session, timeoutMs: 400 }));
    await Promise.all(waits.map(c => c.ready)); await note(root, "Keep in inbox", "none");
    h.ok((await Promise.all(waits.map(resultOf))).every(r => r.items.length === 0), "nobody route wakes no watcher");
  }
  {
    const root = await project();
    const event = await note(root, "My claimed item");
    await claimItem(root, event.id, {}, { session: heron });
    await note(root, "Unclaimed item");
    const mine = await waitForInbox(root, { mine: true, timeoutMs: 0 }, { session: heron });
    h.eq(mine.items.map(i => i.id), [event.id], "mine includes claimed items even without a named assignment");
  }
  {
    const root = await project(); const event = await note(root, "Human can pull this back");
    await claimItem(root, event.id, {}, { session: heron });
    const initial = await waitForInbox(root, { timeoutMs: 0 }, { session: heron });
    const waiter = worker(scope, root, "wait", { session: heron, cursor: initial.cursor, timeoutMs: 2000 }); await waiter.ready;
    const nextHolder = worker(scope, root, "wait", { session: wren, timeoutMs: 2000 }); await nextHolder.ready;
    await appendAnnotationEvent(root, makeRelease(event.id, "human", "human"));
    const [revoked, delivered] = await Promise.all([resultOf(waiter), resultOf(nextHolder)]);
    h.eq(revoked.revoked, [{ id: event.id, reason: "released by the user" }], "human release wakes with revoked notice");
    h.eq(delivered.items.map(i => i.id), [event.id], "release of Any wakes the other eligible watcher");
    h.eq(revoked.items, [], "revocation does not redeliver the item to its released session");
    h.eq((await waitForInbox(root, { cursor: revoked.cursor, timeoutMs: 20 }, { session: heron })).revoked, [], "revocation cursor is idempotent");
    const stopping = worker(scope, root, "wait", { session: heron, cursor: revoked.cursor, timeoutMs: 2000 }); await stopping.ready;
    await appendAnnotationEvent(root, makeReleaseSession(heron, "human"));
    h.eq((await resultOf(stopping)).stopped, true, "release-session stops the pending wait");
  }
  for (const route of ["none", { session: wren }] as const) {
    const root = await project(); await writePresence(root, heron); await writePresence(root, wren);
    const event = await note(root, "Change who gets this");
    await claimItem(root, event.id, {}, { session: heron });
    const initial = await waitForInbox(root, { timeoutMs: 0 }, { session: heron });
    const old = worker(scope, root, "wait", { session: heron, cursor: initial.cursor, timeoutMs: 2000 });
    const next = worker(scope, root, "wait", { session: wren, mode: "filter", filter: { surface: "slide" }, timeoutMs: 700 });
    await Promise.all([old.ready, next.ready]);
    await appendAnnotationEvent(root, makeAssign(event.id, route, "human"));
    const [revoked, delivered] = await Promise.all([resultOf(old), resultOf(next)]);
    h.eq(revoked.revoked, [{ id: event.id, reason: "released by the user" }], `${route === "none" ? "Unassign" : "Reassign"} wakes the revoked holder`);
    h.eq(delivered.items.map(i => i.id), route === "none" ? [] : [event.id], "Unassign wakes nobody else; Reassign bypasses the new assignee's filter");
    let reason = "";
    try { await replyItem(root, event.id, "Late work", {}, { session: heron }); } catch (e) { reason = (e as Error).message; }
    h.ok(reason.includes("released by the user"), "the revoked writer cannot post a late reply");
  }
  {
    const root = await project(); const event = await note(root, "Assign Any later", "none");
    const waiter = worker(scope, root, "wait", { session: heron, timeoutMs: 2000 }); await waiter.ready;
    await appendAnnotationEvent(root, makeAssign(event.id, "any", "human"));
    h.eq((await resultOf(waiter)).items.map(i => i.id), [event.id], "Assign Any wakes an already pending watcher");
  }
  {
    const root = await project();
    await fs.writeFile(path.join(root, "paper/notes.qmd"), "# Comment target\n\nThe quoted sentence.\n");
    const comment = await addComment(root, { docRel: "paper/notes.qmd", quote: "quoted sentence", body: "Reply to this", author: "You" });
    await writePresence(root, heron);
    await appendAnnotationEvent(root, makeAssign(comment.id, heron, "human"));
    const initial = await waitForInbox(root, { timeoutMs: 0 }, { session: heron });
    h.eq(initial.items[0]?.kind, "comment", "comments share the routed queue");
    await replyItem(root, comment.id, "Sidecar reply", {}, { session: heron });
    const next = await waitForInbox(root, { cursor: initial.cursor, timeoutMs: 50 }, { session: heron });
    h.ok(next.items[0].thread.some(m => m.text === "Sidecar reply"), "sidecar reply is delivered in the current packet model");
    const stopping = worker(scope, root, "wait", { session: wren, timeoutMs: 2000 }); await stopping.ready;
    await fs.rm(path.join(root, "project.json"));
    h.eq((await resultOf(stopping)).stopped, true, "project deletion stops its waits");
  }
  {
    const root = await project(), controller = new AbortController();
    const waiting = waitForInbox(root, { timeoutMs: 5000, signal: controller.signal, onReady: () => controller.abort() }, { session: heron });
    h.eq((await waiting).stopped, true, "server cancellation drains watches promptly");
    const saved = process.env.FLUX_WAIT_MAX_MS; process.env.FLUX_WAIT_MAX_MS = "20";
    try { h.eq((await waitForInbox(root, {}, { session: wren })).items, [], "default timeout reads FLUX_WAIT_MAX_MS"); }
    finally { if (saved === undefined) delete process.env.FLUX_WAIT_MAX_MS; else process.env.FLUX_WAIT_MAX_MS = saved; }
  }
} finally { await scope.dispose(); await fs.rm(temp, { recursive: true, force: true }); }
await h.done();
