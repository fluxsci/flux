#!/usr/bin/env -S npx tsx
// Windows spawn-portability gate: electron/execResolve.cjs is the ONE seam
// through which Flux launches external commands by bare name (quarto, recipe
// commands, the agent roster). Two contracts pinned here:
//   1. Off win32 the resolvers are a strict IDENTITY — POSIX/macOS behavior
//      cannot drift through this module (same command, same args reference).
//   2. On win32 (simulated via the injectable {platform, env, exists}, the
//      fluxPaths.userDataDir precedent) a bare name resolves over
//      PATH × PATHEXT: real executables spawn directly (an .exe in any PATH
//      dir beats an earlier batch shim), and .cmd/.bat shims — npm installs
//      `claude`/`codex`/`tsx` as exactly these — wrap in ComSpec /d /s /c
//      with per-token quoting (Node's post-CVE-2024-27980 spawn refuses batch
//      files without a shell).
//   npx tsx scripts/verify-win-spawn.ts

import { resolveSpawn, resolvePtySpawn } from "../electron/execResolve.cjs";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-win-spawn");

// A fake win32 filesystem: existence = set membership (paths built with
// path.win32 semantics, matching what the resolver constructs).
const files = new Set([
  "C:\\tools\\quarto.exe",
  "C:\\shims\\quarto.cmd",
  "C:\\shims\\claude.cmd",
  "C:\\tools\\mytool.exe",
  "C:\\shims\\shim.cmd",
  "C:\\ps\\tool.ps1",
]);
const win = (env: Record<string, string> = {}) => ({
  platform: "win32" as const,
  env: {
    Path: "C:\\shims;C:\\tools;C:\\ps",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    ComSpec: "C:\\WINDOWS\\system32\\cmd.exe",
    ...env,
  },
  exists: (p: string) => files.has(p),
});

h.section("identity off win32 (contract 1)");
for (const platform of ["linux", "darwin"] as const) {
  const args = ["render", "my doc.qmd", "--to", "pdf"];
  const r = resolveSpawn("quarto", args, { platform });
  h.eq(r.command, "quarto", `${platform}: command untouched`);
  h.ok(r.args === args, `${platform}: args are the SAME array (no copy, no rewrite)`);
  h.ok(!("windowsVerbatimArguments" in r) || r.windowsVerbatimArguments === undefined,
    `${platform}: no verbatim flag`);
  const p = resolvePtySpawn("claude", args, { platform });
  h.ok(p.command === "claude" && p.args === args, `${platform}: pty resolver is identity too`);
}

h.section("win32: real executables spawn directly, no shell");
{
  const r = resolveSpawn("mytool", ["--x"], win());
  h.eq(r.command, "C:\\tools\\mytool.exe", "bare name → absolute .exe from PATH");
  h.eq(r.args, ["--x"], "args pass through untouched for a direct executable");
  h.ok(!r.windowsVerbatimArguments, "no verbatim flag for a direct executable");
}
{
  const r = resolveSpawn("quarto", [], win());
  h.eq(r.command, "C:\\tools\\quarto.exe",
    "an .exe in a LATER PATH dir beats an earlier .cmd shim (no shell beats shell)");
}
{
  const r = resolveSpawn("C:\\tools\\quarto.exe", ["--version"], win());
  h.eq(r.command, "C:\\tools\\quarto.exe", "explicit .exe path is untouched");
}
{
  const r = resolveSpawn("C:\\tools\\mytool", [], win());
  h.eq(r.command, "C:\\tools\\mytool.exe", "extension-less explicit path completes via PATHEXT");
}

h.section("win32: batch shims wrap in ComSpec /d /s /c");
{
  const r = resolveSpawn("claude", ["chat", "two words", 'has"quote', "--flag"], win());
  h.eq(r.command, "C:\\WINDOWS\\system32\\cmd.exe", "batch → ComSpec");
  h.eq(
    r.args,
    ["/d", "/s", "/c", '""C:\\shims\\claude.cmd" chat "two words" "has""quote" --flag"'],
    "one fully-quoted /s /c line: file always quoted, tokens quoted on demand, \" doubled",
  );
  h.eq(r.windowsVerbatimArguments, true, "verbatim flag set so Node passes the line through");
}
{
  const r = resolveSpawn("claude", ["50%", "a(b)", ""], win());
  h.eq(
    r.args[3],
    '""C:\\shims\\claude.cmd" "50%" "a(b)" """',
    "%, parens, and empty-string args all get quoted",
  );
}
{
  const r = resolveSpawn("C:\\shims\\claude.cmd", ["x"], win());
  h.eq(r.command, "C:\\WINDOWS\\system32\\cmd.exe", "explicit .cmd path wraps too (no search)");
  h.eq(r.args[3], '""C:\\shims\\claude.cmd" x"', "explicit path lands in the quoted line");
}
{
  const env = { Path: "C:\\shims", PATHEXT: "" } as Record<string, string>;
  const r = resolveSpawn("quarto", [], { ...win(), env: { ...env, ComSpec: "cmd.exe" } });
  h.eq(r.command, "cmd.exe", "missing/empty PATHEXT falls back to the stock .COM;.EXE;.BAT;.CMD");
}
{
  const r = resolveSpawn("quarto", [], win({ Path: "", PATH: "C:\\shims" }));
  h.eq(r.command, "C:\\WINDOWS\\system32\\cmd.exe", "PATH honored when Path is empty");
}

h.section("win32: pty flavor and edge cases");
{
  const r = resolvePtySpawn("claude", ["two words"], win());
  h.eq(r.command, "C:\\WINDOWS\\system32\\cmd.exe", "pty batch → ComSpec");
  h.eq(
    r.args,
    '/d /s /c ""C:\\shims\\claude.cmd" "two words""',
    "pty batch wrap returns ONE verbatim command-line STRING (node-pty re-quotes arrays)",
  );
}
{
  const args = ["--x"];
  const r = resolvePtySpawn("mytool", args, win());
  h.ok(r.command === "C:\\tools\\mytool.exe" && r.args === args,
    "pty direct executable keeps the args array");
}
{
  const r = resolveSpawn("ghost", ["a"], win());
  h.ok(r.command === "ghost" && !r.windowsVerbatimArguments,
    "not found on PATH → unchanged (spawn ENOENTs exactly as today)");
}
{
  const r = resolveSpawn("tool", [], win({ Path: "C:\\ps", PATHEXT: ".PS1;.EXE" }));
  h.eq(r.command, "tool", "non-spawnable PATHEXT entries (.ps1) are never picked");
}

await h.done();
