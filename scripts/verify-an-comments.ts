#!/usr/bin/env -S npx tsx
// Review comments — flux-core list/resolve over the comments sidecar. Resolving
// flips resolved:true, appends an optional reply (stamped with client + time),
// journals (client + action + target), and holds the `manuscript` lock so it
// DEFERS to a live human edit instead of clobbering. Also confirms the written
// file validates against the bundled comments schema.
// Run: npx tsx scripts/verify-an-comments.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as core from "../flux-core/index";
import * as locks from "../flux-core/locks";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-comments-"));
const commentsPath = path.join(root, "manuscript", "comments.json");
let secondaryCommentsPath = "";
const readJournal = async () => {
  const txt = await fs.readFile(path.join(root, ".meta", "journal.ndjson"), "utf8").catch(() => "");
  return txt.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
};

try {
  core.setClient("cli");
  await core.scaffold(root, { title: "Comments" });
  await core.setManuscript(
    root,
    "# Title\n\nMycelial growth slowed under nutrient stress. The control group recovered.\n",
  );
  const secondary = await core.createDocument(root, "Secondary");
  await core.setManuscript(root, "# Secondary\n\nA cortical group reaches distal cortex.\n", secondary.path);
  secondaryCommentsPath = path.join(root, "manuscript", "secondary.comments.json");

  // Seed two open comment threads (the shape the GUI's writeComments emits).
  const seed = {
    version: 1,
    threads: [
      {
        id: "c_one",
        anchor: { start: 9, end: 22, quote: "growth slowed", prefix: "Mycelial ", suffix: " under nutr" },
        resolved: false,
        messages: [{ author: "Kort", body: "cite Smith 2020 here", createdAt: "2026-06-29T17:00:00.000Z" }],
      },
      {
        id: "c_two",
        anchor: { start: 60, end: 73, quote: "control group", prefix: "The ", suffix: " recovered" },
        resolved: false,
        messages: [{ author: "Kort", body: "define 'control'", createdAt: "2026-06-29T17:01:00.000Z" }],
      },
    ],
  };
  await fs.writeFile(commentsPath, JSON.stringify(seed, null, 2) + "\n");
  await fs.writeFile(
    secondaryCommentsPath,
    JSON.stringify(
      {
        version: 1,
        threads: [
          {
            id: "c_secondary",
            anchor: { start: 15, end: 29, quote: "cortical group", prefix: "A ", suffix: " reaches distal" },
            resolved: false,
            messages: [{ author: "Kort", body: "show this cohort", createdAt: "2026-06-29T17:02:00.000Z" }],
          },
        ],
      },
      null,
      2,
    ) + "\n",
  );

  // 1. listComments reads the threads; anchor.quote is the exact targeted text.
  let threads = await core.listComments(root);
  assert(threads.length === 2, "listComments returns both threads");
  assert(threads.every((t) => !t.resolved), "both threads start open");
  assert(threads[0].anchor.quote === "growth slowed", "anchor.quote is the exact targeted text");

  // 1b. Project-wide discovery includes every document and names its owner.
  let projectThreads = await core.listProjectComments(root);
  assert(projectThreads.length === 3, "project-wide listing returns main + secondary threads");
  assert(
    projectThreads.filter((t) => t.doc === "manuscript/main.qmd").length === 2 &&
      projectThreads.filter((t) => t.doc === secondary.path).length === 1,
    "project-wide threads carry the correct document paths",
  );
  const targeted = await core.listProjectComments(root, secondary.path);
  assert(targeted.length === 1 && targeted[0].id === "c_secondary", "targeted listing returns one document");

  // 1c. Project-wide resolution is unique-match safe, then reaches a secondary sidecar.
  let ambiguous = false;
  try {
    await core.resolveProjectComment(root, "group");
  } catch (e) {
    ambiguous = /matches 2 open comments across project documents/.test(String((e as Error).message));
  }
  assert(ambiguous, "ambiguous project-wide quote resolution fails safely");
  const rs = await core.resolveProjectComment(root, "c_secondary", { note: "secondary addressed" });
  assert(rs.id === "c_secondary" && rs.resolved === 1, "project-wide id resolves a secondary-document thread");
  projectThreads = await core.listProjectComments(root);
  assert(
    projectThreads.filter((t) => !t.resolved).length === 2,
    "project-wide open/resolved filtering sees only the two open main threads",
  );

  // 2. the seeded file is valid against the bundled comments schema.
  assert((await core.validate(root, "manuscript/comments.json")).ok, "comments.json validates against the bundled schema");

  // 3. resolveComment by id flips resolved + appends the reply note.
  const r1 = await core.resolveComment(root, "c_one", { note: "added the citation" });
  assert(r1.resolved === 1 && r1.total === 2, "resolve-by-id reports 1/2 resolved");
  threads = await core.listComments(root);
  const one = threads.find((t) => t.id === "c_one")!;
  assert(one.resolved === true, "thread c_one is now resolved on disk");
  assert(one.messages.length === 2 && one.messages[1].body === "added the citation", "reply note appended");
  assert(one.messages[1].author === "cli" && typeof one.messages[1].createdAt === "string", "appended message stamped (author=client, createdAt)");

  // 4. resolveComment by a unique quote substring resolves the other thread.
  const r2 = await core.resolveComment(root, "control group");
  assert(r2.id === "c_two" && r2.resolved === 2, "resolve-by-quote matched c_two (2/2 resolved)");

  // 5. a non-matching string is rejected (never silently mis-resolves).
  let threw = false;
  try {
    await core.resolveComment(root, "no such text anywhere");
  } catch {
    threw = true;
  }
  assert(threw, "resolving a non-matching string throws");

  // 6. every resolve journaled a resolve_comment line (client=cli, ts, target).
  const resolves = (await readJournal()).filter((e) => e.action === "resolve_comment");
  assert(resolves.length === 3 && resolves.every((e) => e.client === "cli" && e.ts), "three resolve_comment lines journaled (client=cli, ts)");
  assert(
    resolves.filter((e) => e.target === "manuscript/comments.json").length === 2 &&
      resolves.filter((e) => e.target === "manuscript/secondary.comments.json").length === 1,
    "journal records each resolved thread's owning sidecar",
  );

  // 7. resolve DEFERS while a human holds the manuscript lock (no clobber).
  const reopened = await core.listComments(root);
  reopened[0].resolved = false;
  await fs.writeFile(commentsPath, JSON.stringify({ version: 1, threads: reopened }, null, 2) + "\n");
  await locks.acquireLock(root, "manuscript", "human");
  let deferred = false;
  try {
    await core.resolveComment(root, reopened[0].id);
  } catch (e) {
    deferred = /deferred/i.test(String((e as Error).message));
  }
  assert(deferred, "resolve-comment defers while a human holds the manuscript lock");
  await locks.releaseLock(root, "manuscript", "human");
  await core.resolveComment(root, reopened[0].id);
  assert((await core.listComments(root)).every((t) => t.resolved), "resolve succeeds after lock release");

  console.log("\nALL COMMENTS TESTS PASSED");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
