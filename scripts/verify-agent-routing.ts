import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { harness } from "./lib/harness.mjs";
import { scratchProject } from "./lib/mcpFixture";
import { writePresence } from "./lib/inboxFixture";
import { recipientOptions, sessionWork, sessionInboxQuery, visibleSessions } from "../src/lib/project/agentRouting";
import { makeNote, makeAssign, makeClaim, makeRelease, makeReleaseSession, makeResolve, foldAnnotations, parseLedger, serializeEvent, CLAIM_TTL_MS } from "../src/lib/project/annotations";
import { buildInbox, filterInbox, parseInboxQuery, deliverableTo } from "../src/lib/project/inbox";
import { appendAnnotationEvents, readInbox } from "../flux-core/annotations";
import type { PresenceSession } from "../src/lib/project/presence";

const h = harness("verify-agent-routing"), temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-routing-")));
try {
  const root = await scratchProject(path.join(temp, "project"), "Routing gate");
  const heron = await writePresence(root, { id: "h", name: "heron" }, 0, { watching: true, watchMode: "annotations", live: true }) as PresenceSession;
  const wren = await writePresence(root, { id: "w", name: "wren" }) as PresenceSession;
  const options = recipientOptions([wren, heron]);
  h.eq(options.map(o => o.key), ["none", "any", "h", "w"], "Inbox, Any, watching sessions, then non-watching sessions");
  h.eq(options.map(o => o.label), ["Inbox", "Any watching agent", "heron", "wren"], "recipient wording is shared by To and Assign");
  h.eq([options[2].muted, options[2].live, options[3].muted, options[3].detail], [false, true, true, "queued until it watches"], "non-watching is muted but stays selectable; live has Pairing");
  h.eq(recipientOptions([wren, heron], true).at(-1)?.label, "New background agent", "F5 alone enables the final recipient slot");
  h.eq(recipientOptions([]).length, 2, "no background recipient before F5 availability");
  h.eq(visibleSessions([wren, heron], new Map([[heron.id, "stopped"]])).map(s => s.watching), [false, false], "ledger Stop watching overrides the heartbeat grace period");
  h.eq(heron.watching, true, "presentation does not mutate presence records");

  const note = makeNote("@wren move this below the axis", { surface: "figure" }, "human", { session: wren });
  const other = makeNote("caption", { surface: "figure" }, "human", "any");
  const events = [note, makeAssign(note.id, wren, "human"), other, makeClaim(other.id, heron, "codex")];
  const liveness = { now: Date.now(), liveSessionIds: new Set([heron.id, wren.id]), watchingSessionIds: new Set([heron.id]) };
  const view = (more = []) => buildInbox({ state: foldAnnotations([...events, ...more]), comments: [], liveness });
  h.eq(view().map(i => i.chip), ["Queued → wren (not watching)", "Claimed by heron"], "worked example shows exact route and claim chips");
  h.eq(view()[0].text, "move this below the axis", "mention is removed from the packet");
  h.eq(sessionWork(view(), wren.id).queued.map(i => i.id), [note.id], "queue count includes pending assigned work");
  h.eq(sessionWork(view(), heron.id).claims.map(i => i.id), [other.id], "current claims include unassigned Any work");
  const claimed = view([makeClaim(note.id, wren, "codex")]);
  h.eq(sessionWork(claimed, wren.id).queued.length, 0, "a current claim is not double-counted as queued");
  h.eq(filterInbox(view(), parseInboxQuery(sessionInboxQuery(wren))).map(i => i.id), [note.id], "Show its items uses the existing @holder query");
  h.eq(filterInbox(view(), parseInboxQuery(sessionInboxQuery(heron))).map(i => i.id), [other.id], "Show its items also finds Any claims");

  const rerouted = makeAssign(note.id, "any", "human");
  h.eq(view([rerouted])[0].route, "any", "Assign Any replaces a named route");
  h.eq(view([rerouted])[0].text, "move this below the axis", "rerouting never resurrects the old mention in displayed text");
  h.ok(deliverableTo(view([rerouted])[0], heron, { mode: "annotations" }), "rerouted Any is deliverable to a watcher");
  const unassign = makeAssign(other.id, "none", "human"), unassigned = view([unassign])[1];
  h.eq([unassigned.route, unassigned.status, unassigned.claimedBy, unassigned.revokedSession], ["none", "open", null, heron.id], "Unassign retires Any and revokes the current holder");
  h.ok(!deliverableTo(unassigned, wren, { mode: "annotations" }), "Inbox after Unassign wakes no watcher");
  const released = view([makeRelease(other.id, "human", "human")])[1];
  h.eq([released.route, released.revokedSession], ["any", heron.id], "Release claim preserves its routing but revokes the holder");
  const reassigned = view([makeAssign(other.id, { session: wren }, "human")])[1];
  h.eq([reassigned.assignedTo?.id, reassigned.revokedSession, reassigned.claimedBy], [wren.id, heron.id, null], "reassignment revokes the former claim");
  h.eq(view([makeRelease(other.id, "human", "human"), makeAssign(other.id, { session: heron }, "human")])[1].revokedSession, null, "explicit assignment back restores authorization");
  h.eq(sessionWork(view([makeResolve(other.id, "codex", { session: heron })]), heron.id).claims.length, 0, "resolved work leaves current claims");
  const stale = buildInbox({ state: foldAnnotations([note]), comments: [], liveness: { now: Date.now(), liveSessionIds: new Set() } })[0];
  h.eq([stale.status, stale.chip, stale.lastHolder?.id], ["open", "wren disconnected — reassign?", wren.id], "stale assignment returns Open with reassign prompt and prior holder");
  const oldClaim = { ...makeClaim(other.id, heron, "codex"), ts: new Date(Date.now() - CLAIM_TTL_MS - 1000).toISOString() };
  const expired = buildInbox({ state: foldAnnotations([other, oldClaim]), comments: [], liveness: { now: Date.now(), liveSessionIds: new Set() } })[0];
  h.eq([expired.status, expired.chip], ["open", "heron disconnected — reassign?"], "expired claim preserves the reassign wording");

  // One builder and persisted bytes, interpreted by both engines.
  const parityEvents = [...events, rerouted, unassign, makeReleaseSession(wren, "human")];
  await appendAnnotationEvents(root, parityEvents);
  const disk = await readInbox(root);
  const gui = buildInbox({ state: foldAnnotations(parseLedger(parityEvents.map(serializeEvent).join(""))), comments: [], liveness: disk.liveness });
  h.eq(disk.items, gui, "Node append/read and renderer fold agree on the same route events");
  const comments = [{ id: "c1", doc: "paper/notes.qmd", anchor: { start: 0, end: 1, quote: "x" }, resolved: false, messages: [{ author: "You", body: "review", createdAt: note.ts }] }];
  const comment = buildInbox({ state: foldAnnotations([makeAssign("c1", "any", "human")]), comments, liveness })[0];
  h.eq(comment.route, "any", "margin comment overlay carries Any routing too");
  h.ok(deliverableTo(comment, heron, { mode: "annotations" }), "assigned Any comment uses the same delivery law");
} finally { await fs.rm(temp, { recursive: true, force: true }); }
await h.done();
