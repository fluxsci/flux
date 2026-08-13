#!/usr/bin/env -S npx tsx
// `flux note` — the locked notebook session-log appender (pure tier — hermetic:
// scratch $HOME, no network).
//   npx tsx scripts/verify-note.ts
// The contract under test: multiple agents (and the app) share one
// Context/NOTEBOOK.md, and the notebook law's high-frequency write — the
// session-log entry — must serialize instead of clobbering. Covers: the pure
// insertion helper (section located, newest-last, restructure/missing-heading
// paths), addNote end-to-end (stamp/title/author, --file, empty rejection),
// the manuscript-lock discipline (a fresh human lock DEFERS the write — the
// check with teeth: an addNote that skips or renames the lock fails here
// deterministically), and a real two-process contention run where every entry
// from both writers must land exactly once.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const { harness } = await import("./lib/harness.mjs");
const h = harness("verify-note");
const ok = (c: unknown, m: string) => h.ok(!!c, m);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "verify-note-"));
const realHome = process.env.HOME;
const realXdg = process.env.XDG_CONFIG_HOME;
process.env.FLUX_NO_MIGRATE = "1";
process.env.HOME = path.join(scratch, "home");
process.env.XDG_CONFIG_HOME = path.join(scratch, "xdg");
fs.mkdirSync(process.env.HOME, { recursive: true });

try {
  h.section("appendSessionLogEntry (pure)");
  const { appendSessionLogEntry, notebookTemplate, SESSION_LOG_HEADING } = await import(
    "../src/lib/project/contextTemplates"
  );
  {
    const r1 = appendSessionLogEntry(notebookTemplate(), "### 2026-01-01 09:00 — a\n\nfirst\n");
    ok(!r1.createdSection, "template notebook: section found, not created");
    ok(/## Session log[\s\S]*### 2026-01-01 09:00 — a\n\nfirst\n$/.test(r1.text), "entry lands at EOF inside the log");
    const r2 = appendSessionLogEntry(r1.text, "### 2026-01-01 10:00 — b\n\nsecond\n");
    ok(r2.text.indexOf("— a") < r2.text.indexOf("— b"), "second entry appends AFTER the first (newest last)");
    ok(r2.text.endsWith("second\n") && !r2.text.endsWith("\n\n"), "file ends with exactly one newline");
    // A restructured notebook: a section AFTER the session log must stay below the entries.
    const restructured = r2.text + "\n## Scratch\n\nkept below\n";
    const r3 = appendSessionLogEntry(restructured, "### 2026-01-01 11:00 — c\n\nthird\n");
    ok(!r3.createdSection && r3.text.indexOf("— c") < r3.text.indexOf("## Scratch"), "entry inserts INSIDE the section when the log is not last");
    ok(/### 2026-01-01 11:00 — c/.test(r3.text) && r3.text.indexOf("— b") < r3.text.indexOf("— c"), "…and still newest-last within the section");
    // H3 entries never terminate the section; H1/H2 do — and a hand-written
    // notebook with no heading at all gets the section appended.
    const r4 = appendSessionLogEntry("# My notebook\n\nfree-form notes\n", "### 2026-01-01 12:00 — d\n\nbody\n");
    ok(r4.createdSection && r4.text.includes(`${SESSION_LOG_HEADING}\n\n### 2026-01-01 12:00 — d`), "missing heading: section created at EOF, entry under it");
    const r5 = appendSessionLogEntry("", "### x — e\n\nbody\n");
    ok(r5.createdSection && r5.text.startsWith(SESSION_LOG_HEADING), "empty doc: heading + entry only");
  }

  const core = await import("../flux-core/index");
  const root = path.join(scratch, "proj");
  await core.scaffold(root, { title: "Note Gate" });
  const notebook = path.join(root, "Context", "NOTEBOOK.md");
  const read = () => fs.readFileSync(notebook, "utf8");

  h.section("addNote end-to-end");
  {
    const r1 = await core.addNote(root, { text: "did the first thing", title: "First" });
    ok(/^### \d{4}-\d{2}-\d{2} \d{2}:\d{2} — First$/.test(r1.heading), `stamped heading: ${r1.heading}`);
    ok(read().includes(`${r1.heading}\n\ndid the first thing\n`), "entry text lands under its heading");
    ok(read().includes("*(Append-only, newest last:"), "template placeholder line preserved");
    const r2 = await core.addNote(root, { text: "second", author: "principal-a" });
    ok(r2.heading.endsWith("— principal-a"), "no title → author names the entry");
    ok(read().indexOf("— First") < read().indexOf("— principal-a"), "entries append newest-last");
    const briefFile = path.join(scratch, "note-body.md");
    fs.writeFileSync(briefFile, "body from a file\nwith two lines\n");
    await core.addNote(root, { file: briefFile, title: "From file" });
    ok(read().includes("— From file\n\nbody from a file\nwith two lines\n"), "--file reads the entry body from disk");
    let emptyErr = "";
    await core.addNote(root, { text: "   " }).catch((e) => (emptyErr = String(e)));
    ok(/needs text/.test(emptyErr), "blank note is rejected");
    const journal = fs.readFileSync(path.join(root, ".meta", "journal.ndjson"), "utf8");
    ok(journal.split("\n").filter((l) => l.includes('"action":"note"')).length === 3, "every note journals");
  }

  h.section("manuscript-lock discipline");
  {
    const lockDir = path.join(root, ".meta", "locks");
    fs.mkdirSync(lockDir, { recursive: true });
    const lockFile = path.join(lockDir, "manuscript.json");
    // A FRESH human lock (the GUI's activity lock while the user edits any
    // paper-surfaced doc — the notebook included) must DEFER the append.
    fs.writeFileSync(lockFile, JSON.stringify({ client: "human", pid: 0, ts: new Date().toISOString() }));
    let lockedErr = "";
    await core.addNote(root, { text: "should defer" }).catch((e) => (lockedErr = String(e)));
    ok(/deferred: .* is locked/.test(lockedErr), "fresh human manuscript lock defers the note");
    ok(!read().includes("should defer"), "…and nothing was written");
    // A STALE lock (crashed holder) is cleared and the note proceeds.
    fs.writeFileSync(lockFile, JSON.stringify({ client: "human", pid: 0, ts: new Date(Date.now() - 60_000).toISOString() }));
    await core.addNote(root, { text: "after stale lock", title: "Recovered" });
    ok(read().includes("after stale lock"), "stale lock is cleared, note lands");
    ok(!fs.existsSync(lockFile), "lock released after the write");
  }

  h.section("two processes, one notebook — every entry lands");
  {
    const N = 8;
    const child = path.join(scratch, "note-child.mjs");
    fs.writeFileSync(
      child,
      `import * as fs from "node:fs";
const [root, tag, n, readyFile, goFile] = process.argv.slice(2);
const core = await import(${JSON.stringify("file://" + path.join(repoRoot, "flux-core", "index.ts"))});
fs.writeFileSync(readyFile, "ready");
while (!fs.existsSync(goFile)) await new Promise((r) => setTimeout(r, 10));
for (let i = 0; i < Number(n); i++) {
  await core.addNote(root, { text: "entry body " + tag + "-" + i, title: tag + "-" + i, author: tag });
  await new Promise((r) => setTimeout(r, 5)); // annotated: interleave the two writers, not a wait-for-condition
}
`,
    );
    const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
    const goFile = path.join(scratch, "go");
    const run = (tag: string) => {
      const ready = path.join(scratch, `ready-${tag}`);
      const p = spawn(process.execPath, [tsxCli, child, root, tag, String(N), ready, goFile], {
        env: { ...process.env, FLUX_CLIENT: "cli" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let err = "";
      p.stderr.on("data", (b: Buffer) => (err += b.toString()));
      const done = new Promise<number>((resolve) => p.on("close", (c) => resolve(c ?? 1)));
      return { ready, done, errOf: () => err };
    };
    const a = run("alpha");
    const b = run("beta");
    const t0 = Date.now();
    while ((!fs.existsSync(a.ready) || !fs.existsSync(b.ready)) && Date.now() - t0 < 30_000)
      await new Promise((r) => setTimeout(r, 50));
    fs.writeFileSync(goFile, "go"); // barrier: both children loop concurrently from here
    const [ca, cb] = await Promise.all([a.done, b.done]);
    ok(ca === 0 && cb === 0, `both writers exit 0 (alpha=${ca} beta=${cb})${ca && a.errOf() ? ` — ${a.errOf().slice(0, 200)}` : ""}${cb && b.errOf() ? ` — ${b.errOf().slice(0, 200)}` : ""}`);
    const doc = read();
    let missing = 0;
    for (const tag of ["alpha", "beta"])
      for (let i = 0; i < N; i++) {
        const hits = doc.split(`entry body ${tag}-${i}`).length - 1;
        if (hits !== 1) {
          missing++;
          h.fail(`entry ${tag}-${i} present ${hits}× (lost update or duplicate)`);
        }
      }
    ok(missing === 0, `all ${2 * N} concurrent entries landed exactly once`);
    ok(doc.match(/^## Session log$/gm)?.length === 1, "exactly one Session log heading survives contention");
  }
} finally {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  if (realXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = realXdg;
  fs.rmSync(scratch, { recursive: true, force: true });
}

await h.done();
