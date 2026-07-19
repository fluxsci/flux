#!/usr/bin/env -S npx tsx
// The feedback ledger + add-comment (principal-agent scheme, pure tier).
//   npx tsx scripts/verify-feedback.ts
// Covers: shared-core fold/find semantics, the flux-core engine (append/list/
// resolve/send + journaling), event-sourced append-only discipline (torn lines
// tolerated, resolves never rewrite), and add_comment anchoring (unique quote,
// ambiguity, --at, prefix/suffix, GUI-shape sidecar).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

process.env.FLUX_NO_MIGRATE = process.env.FLUX_NO_MIGRATE ?? "1";

const { harness } = await import("./lib/harness.mjs");
const h = harness("verify-feedback");
const ok = (c: unknown, m: string) => h.ok(!!c, m);

const core = await import("../flux-core/index");
const shared = await import("../src/lib/project/feedback");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "verify-feedback-"));
try {
  await core.scaffold(root, { title: "Feedback Gate" });

  // --- shared core: fold/find ------------------------------------------------
  {
    const ev = [
      shared.makeNote("legend overlaps", { surface: "figure", activeFigureId: "growth" }, "human"),
      shared.makeNote("tighten intro", { surface: "paper", doc: { path: "manuscript/main.qmd", from: 4, to: 9, quote: "intro" } }, "human"),
    ];
    const st = shared.foldLedger([...ev, shared.makeResolve(ev[0].id, "agent", "moved it")]);
    ok(st.notes.length === 2 && st.open.length === 1, "fold: resolve closes exactly its target");
    ok(st.notes[0].resolveNote === "moved it", "fold: resolve note carried");
    ok(shared.findNote(st, "tighten").id === ev[1].id, "find: unique substring resolves");
    let threw = "";
    try {
      shared.findNote(st, "nope");
    } catch (e) {
      threw = String(e);
    }
    ok(/no open feedback note/.test(threw), "find: zero matches throws");
    ok(/paper.*manuscript\/main\.qmd.*"intro"/.test(shared.describeStamp(ev[1].context)), "describeStamp: paper stamp reads humanly");
  }

  // --- engine: append → list → resolve → send -------------------------------
  const stamp1 = {
    surface: "figure",
    activeFigureId: "fig-1",
    selection: ["el_a"],
    partSelection: { elementId: "el_a", partId: "control.line" },
  };
  const n1 = shared.makeNote("recolor the control line", stamp1, "human");
  await core.appendFeedbackEvent(root, n1);
  let list = await core.listFeedback(root);
  ok(list.open === 1 && list.notes[0].id === n1.id, "engine: appended note lists as open");
  ok(/part:control\.line/.test(list.notes[0].where), "engine: where-line surfaces the part stamp");

  const r = await core.resolveFeedback(root, "recolor", { note: "done — teal now" });
  ok(r.id === n1.id && r.open === 0, "engine: resolve by substring");
  list = await core.listFeedback(root, { all: true });
  ok(list.notes[0].status === "resolved" && list.notes[0].resolveNote === "done — teal now", "engine: resolution folded into listing");
  let dup = "";
  try {
    await core.resolveFeedback(root, n1.id);
  } catch (e) {
    dup = String(e);
  }
  ok(/already resolved|no open/.test(dup), "engine: double-resolve rejected");

  const n2 = shared.makeNote("axis label clipped", { surface: "slide", slide: { deckId: "d", slideIndex: 2, beat: 1 } }, "human");
  await core.appendFeedbackEvent(root, n2);
  await core.sendFeedback(root, { note: "one more round" });
  const n3 = shared.makeNote("after the send", null, "human");
  await core.appendFeedbackEvent(root, n3);
  list = await core.listFeedback(root);
  ok(list.open === 2 && list.sentPending === 1 && list.lastSend !== null, "engine: send boundary — only pre-send notes are the work order");

  // --- append-only discipline -----------------------------------------------
  const ledger = path.join(root, ".meta", "feedback.ndjson");
  const lines = fs.readFileSync(ledger, "utf8").trim().split("\n");
  ok(lines.length === 5, `ledger is event-sourced (5 events on 5 writes, got ${lines.length})`);
  fs.appendFileSync(ledger, '{"kind":"note","id":"torn'); // simulated crash mid-append
  list = await core.listFeedback(root);
  ok(list.open === 2, "torn trailing line tolerated (crash-safe parse)");
  const journal = fs.readFileSync(path.join(root, ".meta", "journal.ndjson"), "utf8");
  ok(/resolve_feedback/.test(journal) && /send_feedback/.test(journal), "resolve + send journaled");

  // --- add_comment -----------------------------------------------------------
  const qmd = path.join(root, "manuscript", "main.qmd");
  fs.writeFileSync(qmd, "# Intro\n\nThe growth rate doubled. The growth rate doubled again.\n");
  const c1 = await core.addComment(root, { quote: "doubled again", body: "cite the source?" });
  ok(!!c1.id && c1.total === 1, "add_comment: unique quote anchors");
  let amb = "";
  try {
    await core.addComment(root, { quote: "The growth rate", body: "x" });
  } catch (e) {
    amb = String(e);
  }
  ok(/occurs 2×|occurs 2x/.test(amb.replace("×", "×")), "add_comment: ambiguous quote rejected with count");
  const c2 = await core.addComment(root, { quote: "The growth rate", body: "second one", at: 2 });
  ok(c2.total === 2, "add_comment: --at picks the occurrence");
  const sidecar = JSON.parse(fs.readFileSync(path.join(root, "manuscript", "comments.json"), "utf8"));
  const t = sidecar.threads.find((x: { id: string }) => x.id === c2.id);
  ok(sidecar.version === 1 && t.anchor.prefix.length > 0 && t.anchor.quote === "The growth rate", "add_comment: GUI-shape sidecar with prefix/suffix anchor");
  ok(t.anchor.start === "# Intro\n\nThe growth rate doubled. ".length, "add_comment: at=2 anchored to the SECOND occurrence");
  const threads = await core.listComments(root);
  ok(threads.length === 2 && threads.every((x) => !x.resolved), "add_comment: listComments sees both open");
  const res = await core.resolveComment(root, c1.id, { note: "cited" });
  ok(res.resolved === 1 && res.total === 2, "add_comment: agent-created thread resolves normally");

  // --- ensure_context heal ---------------------------------------------------
  fs.rmSync(path.join(root, "Context"), { recursive: true, force: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Feedback Gate — agent guide\n\nThe file *is* the API...\n");
  const healed = await core.ensureProjectContext(root);
  ok(healed.created.includes("Context/NOTEBOOK.md"), "heal: Context tree recreated");
  ok(healed.created.some((c) => c.startsWith("AGENTS.md")), "heal: retired generated guide replaced with stub");
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# my own notes\n");
  const healed2 = await core.ensureProjectContext(root);
  ok(healed2.created.length === 0, "heal: idempotent + user-authored AGENTS.md untouched");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

await h.done();
