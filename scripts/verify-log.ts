#!/usr/bin/env -S npx tsx
// `flux log` — the locked notebook Log appender (pure tier — hermetic:
// scratch $HOME, no network).
//   node scripts/run-verifies.mjs --tier pure --only log
// The contract under test: multiple agents (and the app) share one
// Context/NOTEBOOK.md, and the notebook law's high-frequency write — the
// Log entry — must serialize instead of clobbering. Covers: the pure
// insertion helper (section located, newest-last, restructure/missing-heading
// paths), writeLog end-to-end (stamp/title/byline, --file, empty rejection),
// the manuscript-lock discipline (a fresh human lock DEFERS the write — the
// check with teeth: an writeLog that skips or renames the lock fails here
// deterministically), and a real two-process contention run where every entry
// from both writers must land exactly once.
import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tsxCli } from "./lib/tsxRun.mjs";

const { harness } = await import("./lib/harness.mjs");
const h = harness("verify-log");
const ok = (c: unknown, m: string) => h.ok(!!c, m);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "verify-log-"));
const realHome = process.env.HOME;
const realXdg = process.env.XDG_CONFIG_HOME;
process.env.FLUX_NO_MIGRATE = "1";
process.env.HOME = path.join(scratch, "home");
process.env.XDG_CONFIG_HOME = path.join(scratch, "xdg");
fs.mkdirSync(process.env.HOME, { recursive: true });

try {
  h.section("appendLogEntry (pure)");
  const { appendLogEntry, notebookTemplate, LOG_HEADING, parseLog, logStamp } = await import(
    "../src/lib/project/contextTemplates"
  );
  {
    const r1 = appendLogEntry(notebookTemplate(), "### 2026-01-01 09:00 — a\n\nfirst\n");
    ok(!r1.createdSection, "template notebook: section found, not created");
    ok(/## Log[\s\S]*### 2026-01-01 09:00 — a\n\nfirst\n$/.test(r1.text), "entry lands at EOF inside the log");
    const r2 = appendLogEntry(r1.text, "### 2026-01-01 10:00 — b\n\nsecond\n");
    ok(r2.text.indexOf("— a") < r2.text.indexOf("— b"), "second entry appends AFTER the first (newest last)");
    ok(r2.text.endsWith("second\n") && !r2.text.endsWith("\n\n"), "file ends with exactly one newline");
    // H2s inside the Log remain above newly appended entries.
    const restructured = r2.text + "\n## Scratch\n\nkept below\n";
    const r3 = appendLogEntry(restructured, "### 2026-01-01 11:00 — c\n\nthird\n");
    ok(!r3.createdSection && r3.text.indexOf("— c") > r3.text.indexOf("## Scratch") && r3.text.endsWith("third\n"), "entry appends at EOF after internal H2s");
    ok(/### 2026-01-01 11:00 — c/.test(r3.text) && r3.text.indexOf("— b") < r3.text.indexOf("— c"), "…and still newest-last within the section");
    // A hand-written notebook with no Log heading gets the section appended.
    const r4 = appendLogEntry("# My notebook\n\nfree-form notes\n", "### 2026-01-01 12:00 — d\n\nbody\n");
    ok(r4.createdSection && r4.text.includes(`${LOG_HEADING}\n\n### 2026-01-01 12:00 — d`), "missing heading: section created at EOF, entry under it");
    const r5 = appendLogEntry("", "### x — e\n\nbody\n");
    ok(r5.createdSection && r5.text.startsWith(LOG_HEADING), "empty doc: heading + entry only");
  }

  h.section("parseLog (pure)");
  {
    const doc = "# Notebook\n\n### 2020-01-01 — outside\nIgnored\n\n## Log\n\n" +
      "### 2026-09-01 09:15 — First\n\n*Claude Opus · CLI · lab:/work*\n\nBody one\n\n## Detail\nKept\n\n" +
      "## 2026-09-02 — Older format\n\nNo byline\n\n" +
      "### 2026-09-03 — Checkpoint: Summary\n\n*Codex · VS Code · lab*\n\nAll so far\n\n" +
      "~~~md\n### 2026-09-04 — example\n## Log\n~~~\n\n<!--\n### 2026-09-05 — comment\n-->\n\n" +
      "### 2026-09-06 12:30 — Latest\n\nLatest body\n";
    const entries = parseLog(doc);
    ok(entries.length === 4, "dated headings outside Log, fenced examples and comments are not entries");
    ok(entries[0].stamp === "2026-09-01 09:15" && entries[0].byline === "Claude Opus · CLI · lab:/work", "timed entry and byline parsed");
    ok(entries[0].body === "Body one\n\n## Detail\nKept", "internal H2 headings remain in the body");
    ok(entries[1].stamp === "2026-09-02" && entries[1].byline === null && entries[1].body === "No byline", "legacy H2 date-only entry without a byline parsed");
    ok(entries[2].isCheckpoint && !entries[3].isCheckpoint, "checkpoint prefix is recognized");
    ok(JSON.stringify(parseLog(doc.replaceAll("\n", "\r\n"))) === JSON.stringify(entries), "CRLF parses identically");
    ok(parseLog(notebookTemplate()).length === 0 && parseLog("# Notes\n### 2026-09-01 — not a log").length === 0, "placeholder and non-Log documents have no entries");
    ok(logStamp(new Date(2026, 0, 2, 3, 4)) === "2026-01-02 03:04", "stamp uses padded local date and time");
    const tabs = appendLogEntry("# Notebook\n\n##\tLog  \nbody  \n\n", "entry  \n");
    ok(!tabs.createdSection && tabs.text === "# Notebook\n\n##\tLog  \nbody\n\nentry\n", "heading whitespace is accepted and trailing whitespace is normalized");
  }

  const core = await import("../flux-core/index");
  const root = path.join(scratch, "proj");
  await core.scaffold(root, { title: "Log Gate" });
  const notebook = path.join(root, "Context", "NOTEBOOK.md");
  const read = () => fs.readFileSync(notebook, "utf8");

  h.section("writeLog end-to-end");
  {
    const r1 = await core.writeLog(root, { text: "did the first thing", title: "First" });
    ok(/^### \d{4}-\d{2}-\d{2} \d{2}:\d{2} — First$/.test(r1.heading), `stamped heading: ${r1.heading}`);
    ok(parseLog(read())[0]?.body === "did the first thing", "entry text lands under its heading and byline");
    ok(!!parseLog(read())[0]?.byline, "a titled entry always has a byline");
    ok(read().includes("*(Append-only, newest last:"), "template placeholder line preserved");
    const r2 = await core.writeLog(root, { text: "second", agent: "agent-a" });
    ok(r2.heading.endsWith("— second"), "no title → body names the entry");
    ok(parseLog(read())[1]?.byline?.startsWith("agent-a · "), "an untitled entry always has its agent byline");
    ok(read().indexOf("— First") < read().indexOf("— second"), "entries append newest-last");
    const briefFile = path.join(scratch, "log-body.md");
    fs.writeFileSync(briefFile, "body from a file\nwith two lines\n");
    await core.writeLog(root, { file: briefFile, title: "From file" });
    ok(parseLog(read())[2]?.body === "body from a file\nwith two lines", "--file reads the entry body from disk");
    let emptyErr = "";
    await core.writeLog(root, { text: "   " }).catch((e) => (emptyErr = String(e)));
    ok(/needs text/.test(emptyErr), "blank note is rejected");
    const journal = fs.readFileSync(path.join(root, ".meta", "journal.ndjson"), "utf8");
    ok(journal.split("\n").filter((l) => l.includes('"action":"log"')).length === 3, "every note journals");
  }

  ok((await core.readLog(root, { sinceCheckpoint: true })).length === 3, "without a checkpoint the full Log is read");

  h.section("identity, checkpoints and read-log");
  {
    const { detectAgentIdentity } = await import("../flux-core/agentIdentity");
    const id = detectAgentIdentity({}, { name: "codex_vscode" });
    await core.writeLog(root, { text: "Summary", title: "So far", checkpoint: true, identity: id, cwd: null });
    const checkpoint = (await core.readLog(root, { tail: 1 }))[0];
    ok(checkpoint.title === "Checkpoint: So far" && checkpoint.isCheckpoint, "checkpoint title prefix");
    ok(checkpoint.byline === `Codex · VS Code · ${os.hostname().split(".")[0]}`, "MCP identity with unknown client cwd omits the server cwd");
    await core.writeLog(root, { text: "Next step", identity: id, cwd: "/client/work", agent: "Model name", surface: "desktop app" });
    const recent = await core.readLog(root, { sinceCheckpoint: true });
    ok(recent.length === 2 && recent[0].isCheckpoint, "sinceCheckpoint includes the latest checkpoint and everything after it");
    ok(recent[1].byline === `Model name · desktop app · ${os.hostname().split(".")[0]}:/client/work`, "explicit agent and surface override detection; client cwd is used");
    ok((await core.readLog(root, { sinceCheckpoint: true, tail: 1 }))[0].body === "Next step", "tail applies after the checkpoint filter");
    ok((await core.readLog(root, { tail: 0 })).length === 0, "tail zero is empty");
    const titles = await core.readLog(root, { titles: true });
    ok(titles.length === 5 && titles.every(e => e.body === "") && titles[0].title === "First", "titles returns the index with metadata, without bodies");
    let badTail = false;
    try { await core.readLog(root, { tail: -1 }); } catch { badTail = true; }
    ok(badTail, "invalid tail refused");
    await core.writeLog(root, { text: "A".repeat(80) });
    ok((await core.readLog(root, { tail: 1 }))[0].title === "A".repeat(60), "fallback title uses the first 60 body characters");
    const bare = detectAgentIdentity({});
    const priorClient = process.env.FLUX_CLIENT;
    try {
      delete process.env.FLUX_CLIENT;
      await core.writeLog(root, { text: "Unknown", identity: bare });
      const unknown = (await core.readLog(root, { tail: 1 }))[0];
      ok(unknown.byline === `unknown agent · unknown surface · ${os.hostname().split(".")[0]}:${process.cwd()}`, "unknown identity is explicit and CLI cwd is recorded");
      process.env.FLUX_CLIENT = "lab-agent";
      await core.writeLog(root, { text: "Fallback", identity: bare });
      ok((await core.readLog(root, { tail: 1 }))[0].byline?.startsWith("lab-agent · "), "FLUX_CLIENT is the product fallback");
    } finally {
      if (priorClient === undefined) delete process.env.FLUX_CLIENT; else process.env.FLUX_CLIENT = priorClient;
    }
  }

  h.section("registry and actual CLI");
  {
    const cli = (...args: string[]) => execFileSync(process.execPath, [tsxCli(), path.join(repoRoot, "flux-cli.ts"), ...args, "--root", root], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    cli("log", "plots/result.svg", "checked", "--agent", "CLI model", "--surface", "CLI", "--title", "CLI title", "--checkpoint");
    const entries = JSON.parse(cli("read-log", "--tail", "1"));
    ok(entries.length === 1 && entries[0].title === "Checkpoint: CLI title" && entries[0].body === "plots/result.svg checked", "CLI keeps slash-bearing free text and maps flags");
    ok(entries[0].byline.startsWith("CLI model · CLI · "), "CLI title preserves the byline");
    ok(JSON.parse(cli("read-log", "--since-checkpoint")).length === 1, "the latest checkpoint wins when several exist");
    const { VERBS } = await import("../flux-core/registry");
    ok(!VERBS.some(v => v.name === "note" || v.cli === "note"), "retired note verb has no alias");
    const writer = VERBS.find(v => v.name === "write_log")!;
    const { detectAgentIdentity } = await import("../flux-core/agentIdentity");
    await writer.handler({ root, identity: detectAgentIdentity({}, {name: "codex_vscode"}), cwd: null } as any, { text: "Registry MCP entry" });
    const reader = VERBS.find(v => v.name === "read_log")!;
    const parsed = await reader.handler({ root }, { tail: 1 }) as import("../src/lib/project/contextTemplates").LogEntry[];
    ok(parsed[0].body === "Registry MCP entry" && parsed[0].byline === `Codex · VS Code · ${os.hostname().split(".")[0]}`, "registry forwards the MCP caller identity and null cwd");
  }

  h.section("not-a-project and missing notebook");
  {
    const other = path.join(scratch, "not-project");
    fs.mkdirSync(other);
    let refused = 0;
    for (const op of [() => core.writeLog(other, { text: "no" }), () => core.readLog(other)]) {
      try { await op(); } catch (e) { if (String(e).includes("not a Flux project")) refused++; }
    }
    ok(refused === 2 && fs.readdirSync(other).length === 0, "read and write refuse a non-project without creating files");
    const empty = path.join(scratch, "empty-project");
    fs.mkdirSync(empty);
    fs.writeFileSync(path.join(empty, "project.json"), fs.readFileSync(path.join(root, "project.json")));
    ok((await core.readLog(empty)).length === 0 && !fs.existsSync(path.join(empty, "Context")), "reading a missing notebook is non-mutating");
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
    await core.writeLog(root, { text: "should defer" }).catch((e) => (lockedErr = String(e)));
    ok(/deferred: .* is locked/.test(lockedErr), "fresh human manuscript lock defers the note");
    ok(!read().includes("should defer"), "…and nothing was written");
    // A STALE lock (crashed holder) is cleared and the note proceeds.
    fs.writeFileSync(lockFile, JSON.stringify({ client: "human", pid: 0, ts: new Date(Date.now() - 60_000).toISOString() }));
    await core.writeLog(root, { text: "after stale lock", title: "Recovered" });
    ok(read().includes("after stale lock"), "stale lock is cleared, note lands");
    ok(!fs.existsSync(lockFile), "lock released after the write");
  }

  h.section("two processes, one notebook — every entry lands");
  {
    const N = 8;
    const child = path.join(scratch, "log-child.mjs");
    fs.writeFileSync(
      child,
      `import * as fs from "node:fs";
const [root, tag, n, readyFile, goFile] = process.argv.slice(2);
const core = await import(${JSON.stringify(pathToFileURL(path.join(repoRoot, "flux-core", "index.ts")).href)});
fs.writeFileSync(readyFile, "ready");
while (!fs.existsSync(goFile)) await new Promise((r) => setTimeout(r, 10));
for (let i = 0; i < Number(n); i++) {
  await core.writeLog(root, { text: "entry body " + tag + "-" + i, title: tag + "-" + i, agent: tag });
  await new Promise((r) => setTimeout(r, 5)); // annotated: interleave the two writers, not a wait-for-condition
}
`,
    );
    const goFile = path.join(scratch, "go");
    const run = (tag: string) => {
      const ready = path.join(scratch, `ready-${tag}`);
      const p = spawn(process.execPath, [tsxCli(), child, root, tag, String(N), ready, goFile], {
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
    ok(doc.match(/^## Log$/gm)?.length === 1, "exactly one Log heading survives contention");
  }
} finally {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  if (realXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = realXdg;
  fs.rmSync(scratch, { recursive: true, force: true });
}

await h.done();
