#!/usr/bin/env -S npx tsx
// 2026-09-15 — a queued note can be taken back: the append-only `withdraw` event
// (src/lib/project/feedback.ts) and its headless reading (flux-core/feedback.ts)
// gate hermetically in a scratch project root.
//   Run: npx tsx scripts/verify-feedback-withdraw.ts
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { foldLedger, makeNote, makeSend, makeWithdraw, parseLedger, serializeEvent, FEEDBACK_REL } from "../src/lib/project/feedback";
import { listFeedback, resolveFeedback } from "../flux-core/feedback";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

// (1) fold: a withdrawn note leaves open AND the work order; the line stays.
const a = makeNote("make 1 bigger", { surface: "figure" }, "human");
const b = makeNote("typo, ignore", { surface: "figure" }, "human");
const send = makeSend("human");
const w = makeWithdraw(b.id, "human", "edited");
assert(w.kind === "withdraw" && w.target === b.id && w.note === "edited" && !!w.ts, "makeWithdraw shapes the event");
const text = [a, b, send, w].map(serializeEvent).join("");
const st = foldLedger(parseLedger(text));
assert(st.notes.length === 2 && st.notes[1].withdrawn && st.notes[1].withdrawnAt === w.ts && !st.notes[0].withdrawn, "the withdrawn note is marked, the other is not");
assert(st.open.length === 1 && st.open[0].id === a.id, "withdrawn notes are not open");
assert(st.sent.length === 1 && st.sent[0].id === a.id, "…and drop out of the work order even after a send");
assert(!st.notes[1].resolved, "withdrawn is not resolved (nobody did the work)");
assert(parseLedger('{"kind":"withdraw","target":"x","ts":"t","client":"human"}\n{"kind":"bogus"}\n').length === 1, "parseLedger admits withdraw lines and still drops unknown kinds");

// (2) the headless engine: `flux feedback` hides it, --all names it, resolve refuses it.
const root = mkdtempSync(path.join(tmpdir(), "flux-fb-"));
const ledger = path.join(root, FEEDBACK_REL);
mkdirSync(path.dirname(ledger), { recursive: true });
writeFileSync(ledger, text);
const open = await listFeedback(root);
assert(open.notes.length === 1 && open.notes[0].id === a.id && open.open === 1 && open.sentPending === 1, `flux feedback lists only the live note (${open.notes.length} listed, ${open.sentPending} sent)`);
const all = await listFeedback(root, { all: true });
assert(all.notes.length === 2 && all.notes[1].status === "withdrawn" && all.notes[0].status === "open", "--all shows the withdrawn note with its status");
let refused = "";
try { await resolveFeedback(root, b.id, { note: "done" }); } catch (e) { refused = (e as Error).message; }
assert(/withdrawn by the user/.test(refused), `resolving a withdrawn note is refused (${refused})`);
const after = readFileSync(ledger, "utf8");
assert(after === text, "a refused resolve appends nothing");
const ok = await resolveFeedback(root, a.id, { note: "bigger now" });
assert(ok.id === a.id && ok.open === 0, "the live note still resolves normally");
console.log("VERIFY-FEEDBACK-WITHDRAW PASS");
