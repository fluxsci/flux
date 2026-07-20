#!/usr/bin/env node
// The principal drawer's Electron plumbing, against the REAL app (electron
// tier — needs a display; --ozone-platform=x11 per §9, positive boot evidence).
//   node scripts/verify-principal-electron.cjs
// Hermetic: scratch $HOME/$XDG (the real ~/FluxConfig is never touched); the
// "principal" is a stub node script in a scratch agents.json. Verifies the
// full chain the drawer rides: roster → agent:principalSpec (boot prompt +
// cwd rule + placeholder resolution) → pty:create spawn → pty:data flow.
"use strict";
const { spawnSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
let checks = 0;
let failed = 0;
const ok = (c, m) => {
  checks++;
  if (c) console.log(`✓ ${m}`);
  else {
    failed++;
    console.error(`✗ ${m}`);
  }
};

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "verify-principal-el-"));
const home = path.join(scratch, "home");
const xdg = path.join(scratch, "xdg");
fs.mkdirSync(home, { recursive: true });
const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: xdg,
  FLUX_NO_MIGRATE: "", // scratch HOME — let ensureFluxConfig build the real layout
};

try {
  // 1. Scratch machine layout via the REAL built CLI (also exercises A-phase
  //    seeding on a virgin machine).
  const cli = path.join(repoRoot, "dist", "flux-cli.mjs");
  const cfgOut = spawnSync("node", [cli, "config"], { env, encoding: "utf8" });
  const cfg = JSON.parse((cfgOut.stdout || "{}").trim() || "{}");
  ok(cfg.fluxConfigPath === path.join(home, "FluxConfig"), "CLI ensured a scratch FluxConfig");
  ok(fs.existsSync(path.join(cfg.fluxContextPath ?? "", "PRINCIPAL.md")), "FluxContext synced on scratch machine");

  // 2. Stub principal into the scratch roster.
  const stub = path.join(scratch, "stub-principal.mjs");
  fs.writeFileSync(
    stub,
    `console.log("PRINCIPAL_BOOT cwd=" + process.cwd() + " client=" + process.env.FLUX_CLIENT);
console.log("PROMPT: " + (process.argv[2] ?? "").slice(0, 80));
setInterval(() => {}, 1000); // stay alive until reaped (a real TUI would)
`,
  );
  fs.writeFileSync(
    path.join(cfg.fluxConfigPath, "agents.json"),
    JSON.stringify({
      families: {
        stub: {
          models: ["probe-model"],
          efforts: ["probe-effort"],
          interactive: ["node", stub, "{prompt}"],
          cwd: "project",
        },
      },
      defaults: {
        principal: { family: "stub", model: "probe-model", effort: "probe-effort" },
        worker: { family: "stub", model: "principal-decides", effort: "principal-decides" },
        pass: { family: "stub", model: "probe-model", effort: "probe-effort" },
      },
    }),
  );

  // 3. Scratch project.
  const project = path.join(scratch, "probe-paper");
  const mk = spawnSync("node", [cli, "new", project, "--title", "Probe"], { env, encoding: "utf8" });
  ok(mk.status === 0 && fs.existsSync(path.join(project, "Context", "NOTEBOOK.md")), "scratch project scaffolded WITH Context/");

  // 4. Boot the real app + drive the preload chain.
  const electronBin = path.join(repoRoot, "node_modules", ".bin", "electron");
  const probe = spawnSync(
    electronBin,
    [path.join(__dirname, "lib", "principalProbeEntry.cjs"), "--ozone-platform=x11", "--no-sandbox"],
    { env: { ...env, PROBE_PROJECT: project, FLUX_NO_MIGRATE: "1" }, encoding: "utf8", timeout: 120_000 },
  );
  const out = (probe.stdout || "") + (probe.stderr || "");
  if (/Missing X server or \$DISPLAY/.test(out)) {
    // §9 environment class: agent shells run detached; a locked/greeter seat
    // refuses X connections. Name the cause instead of a bare boot failure.
    console.error("✗ ENVIRONMENT: no reachable display (X refused / seat locked?) — run from the desktop seat");
  }
  const bootLine = out.split("\n").find((l) => l.startsWith("PROBE windows="));
  ok(bootLine && /windows=[1-9]/.test(bootLine), `positive boot evidence (${bootLine || "NONE"})`);
  const resLine = out.split("\n").find((l) => l.startsWith("PROBE result="));
  let res = null;
  try {
    res = JSON.parse((resLine || "").slice("PROBE result=".length));
  } catch {
    /* fallthrough */
  }
  ok(res?.watched === true, "watchRoot registered the probe project");
  ok(res?.probe === true, "picker probe returns families + standing selection");
  ok(res?.spec?.ok === true, `agent:principalSpec resolved (${res?.spec?.error ?? "ok"})`);
  ok(res?.spec?.cwd === project, `cwd rule honored (${res?.spec?.cwd})`);
  ok(res?.spec?.promptArg === "yes", "boot prompt substituted into argv");
  ok(res?.create?.ok === true, `pty spawned the configured principal (${res?.create?.error ?? "ok"})`);
  ok(/PRINCIPAL_BOOT cwd=/.test(res?.output ?? ""), "principal output flowed back over pty:data");
  ok((res?.output ?? "").includes(`cwd=${project}`), "principal actually ran in the project cwd");
  ok((res?.output ?? "").includes("client=principal"), "FLUX_CLIENT=principal in the child env");
  ok(/PROMPT: You are the Principal/.test(res?.output ?? ""), "boot prompt reached the principal");
  const uncaughtLine = out.split("\n").find((l) => l.startsWith("PROBE uncaughtTotal="));
  ok(uncaughtLine === "PROBE uncaughtTotal=0", `no main-process uncaught exceptions (${uncaughtLine})`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log(
  `##VERIFY## ${JSON.stringify({ script: "verify-principal-electron", ok: failed === 0, checks, failed })}`,
);
console.log(failed ? `verify-principal-electron: FAIL (${failed}/${checks})` : `verify-principal-electron: PASS (${checks} checks)`);
process.exit(failed ? 1 : 0);
