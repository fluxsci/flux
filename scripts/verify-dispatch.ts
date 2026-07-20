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
  // Scratch FluxConfig with a stub FAMILY (vendor-agnostic by construction:
  // the "agents" here are 5-line node scripts; the exec template records the
  // substituted {model}/{effort} so resolution is assertable).
  const cfg = path.join(process.env.HOME, "FluxConfig");
  fs.mkdirSync(cfg, { recursive: true });
  const stubWorker = path.join(scratch, "stub-worker.mjs");
  fs.writeFileSync(
    stubWorker,
    `const prompt = process.argv[2] ?? "";
console.log("WORKER client=" + process.env.FLUX_CLIENT + " project=" + (process.env.FLUX_PROJECT ? "set" : "unset"));
console.log("AGENT model=" + (process.argv[3] ?? "?") + " effort=" + (process.argv[4] ?? "?"));
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
  const newRoster = {
    families: {
      stubw: {
        models: ["m1", "m2"],
        efforts: ["low", "medium", "high"],
        exec: ["node", stubWorker, "{prompt}", "{model}", "{effort}"],
        cwd: "project",
      },
      stubp: {
        models: ["pm"],
        efforts: ["pe"],
        exec: ["node", stubPass],
        env: { PASS_MARKER: passMarker },
        cwd: "project",
      },
    },
    defaults: {
      principal: { family: "stubw", model: "m1", effort: "high" },
      worker: { family: "stubw", model: "principal-decides", effort: "principal-decides" },
      pass: { family: "stubp", model: "pm", effort: "pe" },
    },
  };
  fs.writeFileSync(path.join(cfg, "agents.json"), JSON.stringify(newRoster));

  const core = await import("../flux-core/index");
  const root = path.join(scratch, "proj");
  await core.scaffold(root, { title: "Dispatch Gate" });

  // --- roster ---------------------------------------------------------------
  const roster = core.readRoster();
  ok(roster.path === path.join(cfg, "agents.json") && !roster.warning && !roster.legacy, "family roster resolves from scratch FluxConfig");

  // --- principal-decides discipline ------------------------------------------
  const briefFile = path.join(scratch, "brief.md");
  fs.writeFileSync(briefFile, "# Task\n\nAnalyze the new dataset and report.\n");
  let undecided = "";
  try {
    await core.dispatch(root, { role: "analysis", briefFile });
  } catch (e) {
    undecided = String(e);
  }
  ok(/--model \+ --effort unset/.test(undecided) && /models m1, m2/.test(undecided), "dispatch: principal-decides policy demands flags, with the menu in the error");

  // --- env policy (the picker's worker row) ----------------------------------
  process.env.FLUX_WORKER_POLICY = JSON.stringify({ family: "stubw", model: "m2", effort: "low" });
  const rEnv = await core.dispatch(root, { role: "analysis", briefFile, name: "env-policy" });
  delete process.env.FLUX_WORKER_POLICY;
  ok(rEnv.exitCode === 0 && rEnv.agent === "stubw/m2/low", `dispatch: FLUX_WORKER_POLICY resolves the worker (${rEnv.agent})`);
  ok(/AGENT model=m2 effort=low/.test(fs.readFileSync(path.join(root, rEnv.dir, "log.txt"), "utf8")), "dispatch: policy values reached the worker argv");

  // --- explicit flags beat everything ----------------------------------------
  const r1 = await core.dispatch(root, { role: "analysis", briefFile, name: "New Dataset", model: "m1", effort: "medium" });
  ok(r1.exitCode === 0 && r1.agent === "stubw/m1/medium", "dispatch: explicit --model/--effort resolve the worker");
  ok(/^Context\/Dispatches\/\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-new-dataset$/.test(r1.dir), `dispatch: record dir named + slugged (${r1.dir})`);
  const dirAbs = path.join(root, r1.dir);
  ok(fs.readFileSync(path.join(dirAbs, "brief.md"), "utf8").includes("Analyze the new dataset"), "dispatch: brief.md recorded verbatim");
  const log = fs.readFileSync(path.join(dirAbs, "log.txt"), "utf8");
  ok(/client=worker project=set/.test(log), "dispatch: worker got FLUX_CLIENT=worker + FLUX_PROJECT");
  ok(/BRIEF: # Task/.test(log), "dispatch: {prompt} carried the brief text");
  ok(/REPORT: analysis complete/.test(r1.report), "dispatch: report tail returned to the caller");
  const resultMd = fs.readFileSync(path.join(dirAbs, "result.md"), "utf8");
  ok(resultMd.includes("- exit: 0") && resultMd.includes("- agent: stubw/m1/medium"), "dispatch: result.md records outcome + the agent used");
  const journal = fs.readFileSync(path.join(root, ".meta", "journal.ndjson"), "utf8");
  ok(/"action":"dispatch"/.test(journal) && /"action":"dispatch_done"/.test(journal), "dispatch: journaled start + done");

  // --- dispatch failure + unknown family --------------------------------------
  const r2 = await core.dispatch(root, { role: "analysis", brief: "PLEASE FAIL now", name: "boom", model: "m1", effort: "low" });
  ok(r2.exitCode === 3, "dispatch: worker exit code propagates");
  ok(fs.existsSync(path.join(root, r2.dir, "result.md")), "dispatch: failure still records result.md");
  let unknown = "";
  try {
    await core.dispatch(root, { role: "x", brief: "x", family: "nope", model: "m", effort: "e" });
  } catch (e) {
    unknown = String(e);
  }
  ok(/no agent family "nope"/.test(unknown) && /stubw/.test(unknown), "dispatch: unknown family lists available families");

  // --- legacy fixed-command rosters still dispatch by role --------------------
  fs.writeFileSync(
    path.join(cfg, "agents.json"),
    JSON.stringify({
      principal: { command: ["node", stubWorker, "{prompt}"] },
      workers: { analysis: { command: ["node", stubWorker, "{prompt}", "legacy-m", "legacy-e"], cwd: "project" } },
    }),
  );
  const rLegacy = await core.dispatch(root, { role: "analysis", briefFile, name: "legacy" });
  ok(rLegacy.exitCode === 0 && rLegacy.agent === "legacy:analysis", "dispatch: legacy roster resolves by role");
  let legacyUnknown = "";
  try {
    await core.dispatch(root, { role: "nope", brief: "x" });
  } catch (e) {
    legacyUnknown = String(e);
  }
  ok(/no worker role "nope"/.test(legacyUnknown), "dispatch: legacy unknown role lists roles");
  fs.writeFileSync(path.join(cfg, "agents.json"), JSON.stringify(newRoster)); // restore family schema

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
