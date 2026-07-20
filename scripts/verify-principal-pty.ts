#!/usr/bin/env -S npx tsx
// `flux principal` — the PTY transcript interposer (pure tier — hermetic:
// scratch $HOME, a stub node "principal", node-pty as the OUTER terminal so
// the wrapper sees a real TTY on both ends; no display needed).
//   npx tsx scripts/verify-principal-pty.ts
// Covers: family-template launch via the CLI, byte passthrough (outer terminal
// sees the child), interactive stdin forwarding, the rendered-buffer transcript
// landing in Context/Transcripts/ (header + content, no TUI noise), last-used
// persistence, exit-code propagation, and --no-transcript.
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const { harness } = await import("./lib/harness.mjs");
const h = harness("verify-principal-pty");
const ok = (c: unknown, m: string) => h.ok(!!c, m);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireRuntime = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pty: any = requireRuntime("@lydell/node-pty");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "verify-ppty-"));
const realHome = process.env.HOME;
const realXdg = process.env.XDG_CONFIG_HOME;

const waitFor = async (cond: () => boolean, ms: number): Promise<boolean> => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return cond();
};

try {
  const home = path.join(scratch, "home");
  const cfg = path.join(home, "FluxConfig");
  fs.mkdirSync(cfg, { recursive: true });

  const stubPrincipal = path.join(scratch, "stub-principal.mjs");
  fs.writeFileSync(
    stubPrincipal,
    `import * as readline from "node:readline";
console.log("STUB-PRINCIPAL model=" + (process.argv[3] ?? "?") + " effort=" + (process.argv[4] ?? "?"));
console.log("PROMPT-HEAD: " + (process.argv[2] ?? "").slice(0, 40));
console.log("READY");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (l) => { console.log("GOT " + l); process.exit(0); });
`,
  );
  fs.writeFileSync(
    path.join(cfg, "agents.json"),
    JSON.stringify({
      families: {
        stub: {
          models: ["m9"],
          efforts: ["e9"],
          interactive: ["node", stubPrincipal, "{prompt}", "{model}", "{effort}"],
          cwd: "project",
        },
      },
      defaults: {
        principal: { family: "stub", model: "m9", effort: "e9" },
        worker: { family: "stub", model: "principal-decides", effort: "principal-decides" },
        pass: { family: "stub", model: "m9", effort: "e9" },
      },
    }),
  );

  // Scaffold the project with the real engine (scratch env applied per-call).
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(scratch, "xdg");
  process.env.FLUX_NO_MIGRATE = "1";
  const core = await import("../flux-core/index");
  const root = path.join(scratch, "proj");
  await core.scaffold(root, { title: "PTY Gate" });

  const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
  const runOnce = async (extra: string[], interact?: (write: (s: string) => void, peek: () => string) => Promise<void>): Promise<{ out: string; exit: number }> => {
    let out = "";
    const child = pty.spawn(tsxBin, [path.join(repoRoot, "flux-cli.ts"), "principal", root, ...extra], {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd: root,
      env: { ...process.env },
    });
    child.onData((d: string) => (out += d));
    // Register exit capture BEFORE any interaction — an early quit (picker `q`)
    // exits before later handlers would attach, and node-pty does not replay.
    let exited: number | null = null;
    const exitPromise: Promise<number> = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(exited ?? -1), 60_000);
      child.onExit(({ exitCode }: { exitCode: number }) => {
        clearTimeout(timer);
        exited = exitCode ?? 0;
        resolve(exited);
      });
    });
    if (interact) await interact((s) => child.write(s), () => out);
    const ready = await waitFor(() => out.includes("READY") || exited !== null, 30_000);
    if (ready && exited === null && out.includes("READY")) child.write("hello-from-the-user\r");
    const exit = await exitPromise;
    return { out, exit };
  };

  // --- run 1: transcripts on, --no-picker ------------------------------------
  const r1 = await runOnce(["--no-picker"]);
  ok(r1.exit === 0, `wrapper propagates the child's exit code (${r1.exit})`);
  ok(/STUB-PRINCIPAL model=m9 effort=e9/.test(r1.out), "family template resolved {model}/{effort} through the CLI");
  ok(/PROMPT-HEAD: You are the Principal/.test(r1.out), "boot prompt reached the principal");
  ok(/GOT hello-from-the-user/.test(r1.out), "stdin forwards through the interposer (interactive round-trip)");
  ok(/\[flux\] transcript →/.test(r1.out), "wrapper announces the transcript path");

  const tDir = path.join(root, "Context", "Transcripts");
  const transcripts = fs.readdirSync(tDir).filter((n) => n.endsWith(".md"));
  ok(transcripts.length === 1, `exactly one transcript captured (${transcripts.length})`);
  const doc = fs.readFileSync(path.join(tDir, transcripts[0]), "utf8");
  ok(/^# Principal session — \d{4}-/.test(doc), "transcript carries the session header");
  ok(doc.includes("READY") && doc.includes("GOT hello-from-the-user"), "transcript holds the RENDERED conversation (both directions)");
  ok(!doc.includes("["), "transcript is plain text (no raw ANSI escapes)");

  ok(fs.existsSync(path.join(cfg, ".agents-last.json")), "launch persisted the selection as last-used");
  const journal = fs.readFileSync(path.join(root, ".meta", "journal.ndjson"), "utf8");
  ok(/"action":"principal_launch"/.test(journal) && /stub · m9 · e9/.test(journal), "launch journaled with the selection");

  // --- run 2: --no-transcript ------------------------------------------------
  const r2 = await runOnce(["--no-picker", "--no-transcript"]);
  ok(r2.exit === 0 && /GOT hello-from-the-user/.test(r2.out), "--no-transcript still runs interactively");
  ok(fs.readdirSync(tDir).filter((n) => n.endsWith(".md")).length === 1, "--no-transcript adds no transcript file");

  // --- run 3: THE PICKER — Enter-through launches the standing selection ------
  const r3 = await runOnce(["--no-transcript"], async (write, peek) => {
    await waitFor(() => /\[Enter\] launch/.test(peek()), 20_000);
    write("\r"); // Enter-through: keep the standing selection, launch
  });
  ok(/Principal: {2}stub · m9 · e9/.test(r3.out), "picker shows the standing selection");
  ok(/Workers: {4}stub · principal decides · principal decides/.test(r3.out), "picker shows the worker policy row");
  ok(r3.exit === 0 && /GOT hello-from-the-user/.test(r3.out), "Enter-through launches into the session");

  // --- run 4: picker customization (p → family/model/effort by number) --------
  const r4 = await runOnce(["--no-transcript"], async (write, peek) => {
    await waitFor(() => /\[Enter\] launch/.test(peek()), 20_000);
    write("p\r"); // customize principal
    await waitFor(() => /family:/.test(peek()), 10_000);
    write("\r"); // keep family (only "stub")
    await waitFor(() => /model:/.test(peek()), 10_000);
    write("\r"); // keep model
    await waitFor(() => /effort:/.test(peek()), 10_000);
    write("\r"); // keep effort
    await waitFor(() => (peek().match(/\[Enter\] launch/g) ?? []).length >= 2, 10_000);
    write("q\r"); // quit without launching
  });
  ok(r4.exit === 0 && !/READY/.test(r4.out), "picker q quits without launching the principal");
} finally {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  if (realXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = realXdg;
  fs.rmSync(scratch, { recursive: true, force: true });
}

await h.done();
