// electron/execResolve.cjs — Windows-aware resolution for spawning EXTERNAL
// commands by bare name ("quarto", a recipe's "python", an agent roster's
// "claude"). Shared by the Electron main process (require) and flux-core
// (ESM import of CJS), like fluxPaths.cjs; must run under plain Node.
//
// The problem (win32 only): npm/installer shims are .cmd/.bat batch files.
// libuv's PATH search only launches real executables, and since Node's
// CVE-2024-27980 fix child_process.spawn throws EINVAL for batch files unless
// they go through cmd.exe. So on win32 we resolve the name over PATH × PATHEXT
// ourselves — preferring a real .exe/.com in ANY PATH dir (no shell involved
// at all) — and only when the best match is a batch file wrap it in
// `ComSpec /d /s /c "…"` with per-token cmd quoting.
//
// On every other platform resolveSpawn/resolvePtySpawn return their inputs
// UNCHANGED (identity) — POSIX behavior cannot drift through this module.
//
// The optional {platform, env, exists} params exist for the pure gate
// (scripts/verify-win-spawn.ts), same pattern as fluxPaths.userDataDir.
"use strict";
const path = require("node:path");
const fsSync = require("node:fs");

function pathextList(env) {
  const raw =
    typeof env.PATHEXT === "string" && env.PATHEXT.trim() ? env.PATHEXT : ".COM;.EXE;.BAT;.CMD";
  return raw
    .split(";")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.startsWith("."));
}

const isExe = (ext) => ext === ".exe" || ext === ".com";
const isBatch = (ext) => ext === ".cmd" || ext === ".bat";

/** cmd.exe token quoting: quote when whitespace/metachars appear, escaping
 *  embedded `"` as `""`. (A literal `%NAME%` inside an arg can still expand —
 *  cmd has no reliable command-line escape for `%`; our args are paths and
 *  flags, where that cannot occur.) */
function quoteForCmd(token) {
  if (token !== "" && !/[\s"&<>|^%()!]/.test(token)) return token;
  return `"${token.replaceAll('"', '""')}"`;
}

/** win32 PATH search. Only .exe/.com can be CreateProcess'd directly and only
 *  .cmd/.bat can ride the cmd.exe wrap — other PATHEXT entries (.ps1, .js…)
 *  are skipped. A real executable in ANY PATH dir beats an earlier batch shim
 *  (deliberate deviation from strict dir-major order: no shell beats shell). */
function findOnPath(cmd, env, exists) {
  const dirs = String(env.Path || env.PATH || "")
    .split(";")
    .filter(Boolean);
  const ownExt = path.win32.extname(cmd).toLowerCase();
  const exts = pathextList(env);
  let batch = null;
  for (const dir of dirs) {
    const names = ownExt ? [cmd] : exts.filter((e) => isExe(e) || isBatch(e)).map((e) => cmd + e);
    for (const name of names) {
      const p = path.win32.join(dir, name);
      if (!exists(p)) continue;
      const ext = path.win32.extname(name).toLowerCase();
      if (isBatch(ext)) {
        batch = batch ?? p;
        continue;
      }
      if (isExe(ext)) return p;
    }
  }
  return batch;
}

/** null off-win32 (caller returns identity); else {kind:"direct",file} or
 *  {kind:"batch",comspec,line}. */
function resolveCore(command, args, o) {
  const platform = o.platform || process.platform;
  if (platform !== "win32") return null;
  const env = o.env || process.env;
  const exists = o.exists || fsSync.existsSync;
  let file = command;
  if (/[\\/]/.test(command)) {
    // Explicit path: complete a missing extension via PATHEXT (spawnable exts only).
    if (!path.win32.extname(command)) {
      for (const e of pathextList(env)) {
        if (!isExe(e) && !isBatch(e)) continue;
        if (exists(command + e)) {
          file = command + e;
          break;
        }
      }
    }
  } else {
    file = findOnPath(command, env, exists) || command;
  }
  if (!isBatch(path.win32.extname(file).toLowerCase())) return { kind: "direct", file };
  const comspec = env.ComSpec || env.COMSPEC || "cmd.exe";
  const line = [`"${file}"`, ...args.map(quoteForCmd)].join(" ");
  return { kind: "batch", comspec, line };
}

/** For child_process.spawn: `{command, args, windowsVerbatimArguments?}`.
 *  Spread the third field into the spawn options — it is set (true) only for a
 *  win32 batch wrap, where Node must pass our pre-quoted cmd line verbatim;
 *  everywhere else it is undefined and Node ignores it. */
function resolveSpawn(command, args = [], o = {}) {
  const r = resolveCore(command, args, o);
  if (!r) return { command, args };
  if (r.kind === "direct") return { command: r.file, args };
  return {
    command: r.comspec,
    args: ["/d", "/s", "/c", `"${r.line}"`],
    windowsVerbatimArguments: true,
  };
}

/** For node-pty: same resolution, but a batch wrap returns `args` as ONE
 *  command-line string — node-pty on Windows passes a string through verbatim,
 *  while an array would be re-quoted around our quoting. */
function resolvePtySpawn(command, args = [], o = {}) {
  const r = resolveCore(command, args, o);
  if (!r) return { command, args };
  if (r.kind === "direct") return { command: r.file, args };
  return { command: r.comspec, args: `/d /s /c "${r.line}"` };
}

module.exports = { resolveSpawn, resolvePtySpawn };
