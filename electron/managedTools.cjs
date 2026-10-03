"use strict";
// electron/managedTools.cjs — the external tools Flux can set up for the user, without admin
// rights or a terminal (the "Set up Flux…" window, 2026-10-03). Shared by the Electron main
// process (require) and flux-core (ESM import of CJS), like fluxPaths.cjs and execResolve.cjs;
// must run under plain Node.
//
//   · Quarto: ONE resolver for every place Flux spawns it (GUI Word export, `flux compile`,
//     flux-connect's machine facts). A quarto the user installed wins; otherwise the copy Flux
//     downloaded into <FluxConfig>/tools/quarto/<version>/. A packaged macOS app launched from
//     Finder inherits launchd's PATH (/usr/bin:/bin:/usr/sbin:/sbin), so the usual install
//     folders (Homebrew, the Quarto .pkg's /Applications/quarto/bin, /usr/local/bin) are
//     searched as well — without them an installed Quarto read as "not installed".
//   · installManagedQuarto: the pinned upstream tarball, sha256-verified, extracted into a
//     scratch directory and published with ONE rename (a cancelled or failed install leaves
//     nothing behind and never a half-extracted tree under the final name).
//   · TeX for Quarto PDF: detection (TinyTeX or a system LaTeX) and `quarto install tinytex`.
//   · The `flux` command on PATH: the shell-profile line the install script writes too. The
//     marker text is the contract with install.sh — both sides check for it, so either may run
//     first and neither duplicates the line.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

// Pinned to the CI's Quarto (ci.yml / release.yml `quarto-actions/setup` version). Digests are
// Quarto's own published quarto-<v>-checksums.txt, cross-checked against GitHub's asset digests.
const QUARTO = Object.freeze({
  version: "1.7.32",
  baseUrl: "https://github.com/quarto-dev/quarto-cli/releases/download",
  assets: Object.freeze({
    darwin: { file: "quarto-1.7.32-macos.tar.gz", bytes: 216505140, sha256: "b49912bbe2b507f03d0bac9089f0e97437a87226c59a371e4eff8712557b16e8" },
    "linux-x64": { file: "quarto-1.7.32-linux-amd64.tar.gz", bytes: 132145241, sha256: "262505e3d26459c64e66efefd4b9240eb755ea20dd6fe876d6aa64c7a7b13d27" },
    "linux-arm64": { file: "quarto-1.7.32-linux-arm64.tar.gz", bytes: 136089660, sha256: "87835e6ed965d865ee1cda367ff0316c7d52104c114f5f1962fdc9fe5da46cd0" },
  }),
});

/** The pinned asset for this machine, or null where Flux cannot manage Quarto (Windows). */
function quartoAsset(platform = process.platform, arch = process.arch) {
  if (platform === "darwin") return QUARTO.assets.darwin; // one universal macOS build
  if (platform === "linux") return QUARTO.assets[`linux-${arch}`] || null;
  return null;
}

function defaultFluxConfigPath() {
  try { return require("./fluxPaths.cjs").resolveFluxConfigPathSync(); } catch { return path.join(os.homedir(), "FluxConfig"); }
}
const managedQuartoRoot = (fluxConfigPath = defaultFluxConfigPath()) => path.join(fluxConfigPath, "tools", "quarto");
const managedQuartoDir = (fluxConfigPath = defaultFluxConfigPath(), version = QUARTO.version) => path.join(managedQuartoRoot(fluxConfigPath), version);
const managedQuartoBin = (fluxConfigPath = defaultFluxConfigPath(), platform = process.platform) =>
  path.join(managedQuartoDir(fluxConfigPath), "bin", platform === "win32" ? "quarto.exe" : "quarto");

function isExecutableFile(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (process.platform !== "win32") fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

/** Where people install command-line tools, beyond whatever PATH this process inherited. */
function commonToolDirs(platform = process.platform, home = os.homedir()) {
  if (platform === "darwin") return ["/opt/homebrew/bin", "/usr/local/bin", path.join(home, ".local", "bin"), "/Applications/quarto/bin", "/Library/TeX/texbin"];
  if (platform === "linux") return ["/usr/local/bin", "/usr/bin", path.join(home, ".local", "bin"), "/opt/quarto/bin"];
  return [];
}

/** First executable `name` on PATH, then in the common install folders. Win32 tries PATHEXT. */
function findExecutableSync(name, { env = process.env, platform = process.platform, home = os.homedir(), extraDirs = [], isExecutable = isExecutableFile } = {}) {
  const exts = platform === "win32" ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").map(e => e.toLowerCase()).filter(Boolean) : [""];
  const sep = platform === "win32" ? ";" : ":";
  const fromPath = String(env.Path || env.PATH || "").split(sep).filter(Boolean);
  const seen = new Set();
  for (const [dirs, origin] of [[fromPath, "path"], [[...commonToolDirs(platform, home), ...extraDirs], "system"]]) {
    for (const dir of dirs) {
      if (seen.has(dir)) continue;
      seen.add(dir);
      for (const ext of exts) {
        const file = path.join(dir, name + ext);
        if (isExecutable(file)) return { file, origin };
      }
    }
  }
  return null;
}

/** The quarto Flux should run: FLUX_QUARTO, then the user's own (PATH, then the common install
 *  folders), then the Flux-managed copy. `command` is null when there is none. */
function resolveQuartoSync({ env = process.env, platform = process.platform, home = os.homedir(), fluxConfigPath, isExecutable = isExecutableFile } = {}) {
  if (env.FLUX_QUARTO && isExecutable(env.FLUX_QUARTO)) return { command: env.FLUX_QUARTO, origin: "env" };
  const own = findExecutableSync("quarto", { env, platform, home, isExecutable });
  if (own) return { command: own.file, origin: own.origin };
  const managed = managedQuartoBin(fluxConfigPath ?? defaultFluxConfigPath(), platform);
  if (isExecutable(managed)) return { command: managed, origin: "managed" };
  return { command: null, origin: null };
}

/** For spawn sites: the resolved quarto, else the bare name (so a missing tool keeps the
 *  ENOENT shape every caller already diagnoses). */
function quartoCommandSync(options) { return resolveQuartoSync(options).command || "quarto"; }

/** `quarto --version` of a resolved binary ("" when it will not run). */
function quartoVersion(command, { spawnImpl = spawn, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    let out = "", done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const child = spawnImpl(command, ["--version"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
      const timer = setTimeout(() => { try { child.kill(); } catch {} finish(""); }, timeoutMs);
      child.stdout?.on("data", (d) => (out += d));
      child.once("error", () => { clearTimeout(timer); finish(""); });
      child.once("close", (code) => { clearTimeout(timer); finish(code === 0 ? out.trim() : ""); });
    } catch { finish(""); }
  });
}

/** Download, verify and publish the pinned Quarto into <FluxConfig>/tools/quarto/<version>.
 *  onProgress({phase: "download"|"verify"|"extract"|"done", done, total}). Cancellable via
 *  `signal`; on any failure the scratch directory is removed and nothing is published. */
async function installManagedQuarto({
  fluxConfigPath = defaultFluxConfigPath(), platform = process.platform, arch = process.arch,
  asset = quartoAsset(platform, arch), baseUrl = QUARTO.baseUrl, version = QUARTO.version,
  fetchImpl = fetch, spawnImpl = spawn, signal, onProgress = () => {},
} = {}) {
  if (!asset) throw new Error(`Flux cannot install Quarto on ${platform}-${arch}; install it from quarto.org`);
  const root = managedQuartoRoot(fluxConfigPath), final = managedQuartoDir(fluxConfigPath, version);
  await fsp.mkdir(root, { recursive: true });
  const work = await fsp.mkdtemp(path.join(root, ".install-"));
  const aborted = () => signal?.aborted;
  const cancelled = () => Object.assign(new Error("Quarto installation cancelled"), { name: "AbortError" });
  try {
    if (aborted()) throw cancelled();
    const archive = path.join(work, asset.file);
    const response = await fetchImpl(`${baseUrl}/v${version}/${asset.file}`, { redirect: "follow", signal });
    if (!response.ok || !response.body) throw new Error(`Quarto download failed (HTTP ${response.status})`);
    const total = Number(response.headers.get("content-length")) || asset.bytes || 0;
    const hash = crypto.createHash("sha256");
    let done = 0, last = 0;
    const meter = new Transform({ transform(chunk, _enc, cb) {
      hash.update(chunk); done += chunk.length;
      const now = Date.now();
      if (now - last >= 100) { last = now; onProgress({ phase: "download", done, total }); }
      cb(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(archive), signal ? { signal } : {});
    onProgress({ phase: "verify", done, total });
    const digest = hash.digest("hex");
    if (digest !== asset.sha256) throw new Error(`Quarto download failed its checksum (expected ${asset.sha256.slice(0, 12)}…, got ${digest.slice(0, 12)}…)`);
    if (aborted()) throw cancelled();
    onProgress({ phase: "extract", done, total });
    const staging = path.join(work, "x");
    await fsp.mkdir(staging);
    await new Promise((resolve, reject) => {
      const child = spawnImpl("tar", ["-xzf", archive, "-C", staging], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
      let err = "";
      const onAbort = () => { try { child.kill("SIGKILL"); } catch {} };
      signal?.addEventListener("abort", onAbort, { once: true });
      child.stderr?.on("data", (d) => (err = (err + d).slice(-2000)));
      child.once("error", (e) => { signal?.removeEventListener("abort", onAbort); reject(e); });
      child.once("close", (code) => {
        signal?.removeEventListener("abort", onAbort);
        if (aborted()) reject(cancelled());
        else if (code === 0) resolve();
        else reject(new Error(`Could not unpack Quarto (tar exited ${code}): ${err.trim()}`));
      });
    });
    // macOS ships ./bin/quarto at the top; Linux nests everything under quarto-<v>/.
    const exe = platform === "win32" ? "quarto.exe" : "quarto";
    let home = staging;
    if (!isExecutableFile(path.join(home, "bin", exe))) {
      const entries = (await fsp.readdir(staging, { withFileTypes: true })).filter(e => e.isDirectory());
      home = entries.length === 1 ? path.join(staging, entries[0].name) : staging;
    }
    if (!isExecutableFile(path.join(home, "bin", exe))) throw new Error("The Quarto archive has no bin/quarto");
    if (aborted()) throw cancelled();
    // Publish with one rename; a previous copy of the same version is moved aside first.
    if (fs.existsSync(final)) await fsp.rename(final, path.join(work, "previous"));
    await fsp.rename(home, final);
    onProgress({ phase: "done", done, total });
    return { command: path.join(final, "bin", exe), version, origin: "managed" };
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}

/** A LaTeX Quarto can use for PDF: TinyTeX (Quarto's own) or a system TeX on PATH. */
function detectTexSync({ env = process.env, platform = process.platform, home = os.homedir(), isExecutable = isExecutableFile } = {}) {
  const engines = ["lualatex", "xelatex", "pdflatex"];
  const tinyRoots = platform === "darwin" ? [path.join(home, "Library", "TinyTeX")] : platform === "win32" ? [path.join(env.APPDATA || home, "TinyTeX")] : [path.join(home, ".TinyTeX")];
  for (const root of tinyRoots) {
    let arches = [];
    try { arches = fs.readdirSync(path.join(root, "bin")); } catch { continue; }
    for (const a of arches) for (const e of engines) {
      const file = path.join(root, "bin", a, platform === "win32" ? `${e}.exe` : e);
      if (isExecutable(file)) return { installed: true, kind: "tinytex", path: file };
    }
  }
  for (const e of engines) {
    const hit = findExecutableSync(e, { env, platform, home, isExecutable });
    if (hit) return { installed: true, kind: "system", path: hit.file };
  }
  return { installed: false, kind: null, path: null };
}

/** `quarto install tinytex --no-prompt` (user-level, no admin). Resolves {ok, code, log}. */
function installTinytex({ quarto, spawnImpl = spawn, signal, onLog = () => {} } = {}) {
  return new Promise((resolve) => {
    if (!quarto) { resolve({ ok: false, code: -1, log: "Quarto is not installed" }); return; }
    let log = "";
    const child = spawnImpl(quarto, ["install", "tinytex", "--no-prompt"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const onAbort = () => { try { child.kill(); } catch {} };
    signal?.addEventListener("abort", onAbort, { once: true });
    const take = (d) => { const s = String(d); log = (log + s).slice(-20000); onLog(s); };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.once("error", (e) => { signal?.removeEventListener("abort", onAbort); resolve({ ok: false, code: -1, log: `${log}\n${e.message}` }); });
    child.once("close", (code) => { signal?.removeEventListener("abort", onAbort); resolve({ ok: code === 0 && !signal?.aborted, code, log }); });
  });
}

// --- the `flux` command on PATH --------------------------------------------------------------
const PATH_MARKER = "# Added by Flux: put the flux command on PATH";
const PATH_LINE = 'export PATH="$HOME/.local/bin:$PATH"';

/** The shell profile both Flux and install.sh edit: ~/.zshrc on macOS, ~/.bashrc on Linux. */
function shellProfile(platform = process.platform, home = os.homedir()) {
  return path.join(home, platform === "darwin" ? ".zshrc" : ".bashrc");
}
function pathLinePresent(file) {
  try { return fs.readFileSync(file, "utf8").includes(PATH_MARKER); } catch { return false; }
}
/** Append the marker + export line once. Returns {file, changed}. */
function ensurePathLine({ platform = process.platform, home = os.homedir(), file = shellProfile(platform, home) } = {}) {
  if (pathLinePresent(file)) return { file, changed: false };
  let current = "";
  try { current = fs.readFileSync(file, "utf8"); } catch { /* a new profile */ }
  const sep = current && !current.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(file, `${sep}\n${PATH_MARKER}\n${PATH_LINE}\n`);
  return { file, changed: true };
}
/** Whether a NEW terminal will find ~/.local/bin/flux. */
function launcherStatusSync({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const bin = path.join(home, ".local", "bin");
  const launcher = path.join(bin, platform === "win32" ? "flux.cmd" : "flux");
  const installed = isExecutableFile(launcher);
  const onPath = String(env.PATH || "").split(platform === "win32" ? ";" : ":").some(d => path.resolve(d) === bin) || pathLinePresent(shellProfile(platform, home));
  return { installed, onPath, launcher, profile: shellProfile(platform, home) };
}

module.exports = {
  QUARTO, quartoAsset, managedQuartoRoot, managedQuartoDir, managedQuartoBin, commonToolDirs,
  findExecutableSync, resolveQuartoSync, quartoCommandSync, quartoVersion, installManagedQuarto,
  detectTexSync, installTinytex, PATH_MARKER, PATH_LINE, shellProfile, pathLinePresent, ensurePathLine, launcherStatusSync,
};
