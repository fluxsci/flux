#!/usr/bin/env -S npx tsx
// The principal/worker runtime (principal-agent scheme, pure tier — hermetic:
// scratch $HOME, stub node workers, no network).
//   npx tsx scripts/verify-dispatch.ts
// Covers: roster resolution against a scratch FluxConfig, dispatch end-to-end
// (record dir: brief.md/log.txt/result.md; env identity; report tail; failure
// exit propagation; unknown-role error), runPass, and the attend loop's
// send-trigger discipline (state survives, only NEW sends fire).
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const { harness } = await import("./lib/harness.mjs");
const h = harness("verify-dispatch");
const ok = (c: unknown, m: string) => h.ok(!!c, m);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "verify-dispatch-"));
const realHome = process.env.HOME;
const realXdg = process.env.XDG_CONFIG_HOME;
process.env.FLUX_NO_MIGRATE = "1";
process.env.HOME = path.join(scratch, "home");
process.env.XDG_CONFIG_HOME = path.join(scratch, "xdg");
fs.mkdirSync(process.env.HOME, { recursive: true });

const waitFor = async (cond: () => boolean, ms: number): Promise<boolean> => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return cond();
};

try {
  // Scratch FluxConfig with stub node workers (vendor-agnostic by construction:
  // the "agents" here are 5-line node scripts).
  const cfg = path.join(process.env.HOME, "FluxConfig");
  fs.mkdirSync(cfg, { recursive: true });
  const stubWorker = path.join(scratch, "stub-worker.mjs");
  fs.writeFileSync(
    stubWorker,
    `const prompt = process.argv[2] ?? "";
console.log("WORKER client=" + process.env.FLUX_CLIENT + " project=" + (process.env.FLUX_PROJECT ? "set" : "unset"));
console.log("BRIEF: " + prompt.slice(0, 60));
if (prompt.includes("PLEASE FAIL")) process.exit(3);
console.log("REPORT: analysis complete, 2 plots written");
`,
  );
  const stubPass = path.join(scratch, "stub-pass.mjs");
  fs.writeFileSync(
    stubPass,
    `import * as fs from "node:fs";
fs.appendFileSync(process.env.PASS_MARKER, "pass\\n");
console.log("PASS OK");
`,
  );
  const passMarker = path.join(scratch, "pass-marker.txt");
  fs.writeFileSync(
    path.join(cfg, "agents.json"),
    JSON.stringify({
      principal: { command: ["node", stubWorker, "{prompt}"] },
      principalPass: { command: ["node", stubPass], env: { PASS_MARKER: passMarker }, cwd: "project" },
      workers: {
        analysis: { command: ["node", stubWorker, "{prompt}"], cwd: "project" },
      },
    }),
  );

  const core = await import("../flux-core/index");
  const root = path.join(scratch, "proj");
  await core.scaffold(root, { title: "Dispatch Gate" });

  // --- roster ---------------------------------------------------------------
  const roster = core.readRoster();
  ok(roster.path === path.join(cfg, "agents.json") && !roster.warning, "roster resolves from scratch FluxConfig");

  // --- dispatch happy path ---------------------------------------------------
  const briefFile = path.join(scratch, "brief.md");
  fs.writeFileSync(briefFile, "# Task\n\nAnalyze the new dataset and report.\n");
  const r1 = await core.dispatch(root, { role: "analysis", briefFile, name: "New Dataset" });
  ok(r1.exitCode === 0, "dispatch: stub worker succeeded");
  ok(/^Context\/Dispatches\/\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-new-dataset$/.test(r1.dir), `dispatch: record dir named + slugged (${r1.dir})`);
  const dirAbs = path.join(root, r1.dir);
  ok(fs.readFileSync(path.join(dirAbs, "brief.md"), "utf8").includes("Analyze the new dataset"), "dispatch: brief.md recorded verbatim");
  const log = fs.readFileSync(path.join(dirAbs, "log.txt"), "utf8");
  ok(/client=worker project=set/.test(log), "dispatch: worker got FLUX_CLIENT=worker + FLUX_PROJECT");
  ok(/BRIEF: # Task/.test(log), "dispatch: {prompt} carried the brief text");
  ok(/REPORT: analysis complete/.test(r1.report), "dispatch: report tail returned to the caller");
  ok(fs.readFileSync(path.join(dirAbs, "result.md"), "utf8").includes("- exit: 0"), "dispatch: result.md records the outcome");
  const journal = fs.readFileSync(path.join(root, ".meta", "journal.ndjson"), "utf8");
  ok(/"action":"dispatch"/.test(journal) && /"action":"dispatch_done"/.test(journal), "dispatch: journaled start + done");

  // --- dispatch failure + unknown role ---------------------------------------
  const r2 = await core.dispatch(root, { role: "analysis", brief: "PLEASE FAIL now", name: "boom" });
  ok(r2.exitCode === 3, "dispatch: worker exit code propagates");
  ok(fs.existsSync(path.join(root, r2.dir, "result.md")), "dispatch: failure still records result.md");
  let unknown = "";
  try {
    await core.dispatch(root, { role: "nope", brief: "x" });
  } catch (e) {
    unknown = String(e);
  }
  ok(/no worker role "nope"/.test(unknown) && /analysis/.test(unknown), "dispatch: unknown role lists available roles");

  // --- runPass ----------------------------------------------------------------
  const passCode = await core.runPass(root);
  ok(passCode === 0 && fs.existsSync(passMarker), "runPass: principalPass ran (marker written)");
  const passLogs = fs.readdirSync(path.join(root, ".meta", "agent", "passes"));
  ok(passLogs.length === 1, "runPass: pass log recorded");

  // --- attend loop: only NEW sends trigger ------------------------------------
  fs.rmSync(passMarker, { force: true });
  const cliEntry = path.join(repoRoot, "flux-cli.ts");
  const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
  const attendChild = spawn(tsxBin, [cliEntry, "attend", root, "--interval", "200"], {
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let attendErr = "";
  attendChild.stderr.on("data", (b: Buffer) => (attendErr += b.toString()));
  try {
    ok(await waitFor(() => fs.existsSync(path.join(root, ".meta", "agent", "status.json")), 15000), "attend: boots + writes status.json");
    // A note + a send → exactly one pass.
    const note = { kind: "note", id: "fbtest1", ts: new Date().toISOString(), client: "human", text: "fix the axis", context: null };
    const send = { kind: "send", id: "fbsend1", ts: new Date().toISOString(), client: "human" };
    fs.appendFileSync(path.join(root, ".meta", "feedback.ndjson"), JSON.stringify(note) + "\n" + JSON.stringify(send) + "\n");
    ok(await waitFor(() => fs.existsSync(passMarker), 15000), "attend: send triggered a principal pass");
    ok(
      await waitFor(() => {
        try {
          return JSON.parse(fs.readFileSync(path.join(root, ".meta", "agent", "attend-state.json"), "utf8")).processedSendId === "fbsend1";
        } catch {
          return false;
        }
      }, 10000),
      "attend: state records the processed send",
    );
    // Ledger churn WITHOUT a new send must not re-trigger.
    const marks = () => fs.readFileSync(passMarker, "utf8").trim().split("\n").length;
    const before = marks();
    fs.appendFileSync(
      path.join(root, ".meta", "feedback.ndjson"),
      JSON.stringify({ kind: "resolve", target: "fbtest1", ts: new Date().toISOString(), client: "agent" }) + "\n",
    );
    await new Promise((r) => setTimeout(r, 1200)); // two poll intervals — a re-trigger would land here
    ok(marks() === before, "attend: resolves (no new send) do not re-trigger a pass");
  } finally {
    attendChild.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
    attendChild.kill("SIGKILL");
  }
  if (attendErr && !/attending|pass finished|send fb/.test(attendErr)) console.error("[attend stderr]", attendErr.slice(0, 400));
} finally {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  if (realXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = realXdg;
  fs.rmSync(scratch, { recursive: true, force: true });
}

await h.done();
