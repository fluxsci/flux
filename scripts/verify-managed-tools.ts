// "Set up Flux…" tools (electron/managedTools.cjs, 2026-10-03): the ONE quarto resolver every
// spawn site uses, the no-admin Quarto installer, TeX detection, the TinyTeX runner, the shell
// profile line shared with install.sh, and the update spawn the "Update now" toast runs.
// Hermetic: a local HTTP server serves fake Quarto tarballs; HOME and FluxConfig are scratch dirs.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { harness } from "./lib/harness.mjs";

const require = createRequire(import.meta.url);
const tools = require("../electron/managedTools.cjs");
const update = require("../electron/updateCheck.cjs");
const h = harness("verify-managed-tools");
const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "flux-managed-tools-"));
const home = path.join(scratch, "home"), cfg = path.join(scratch, "FluxConfig");
await fsp.mkdir(home, { recursive: true });

const exe = (file: string, body = "#!/bin/sh\necho 1.7.32\n") => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body, { mode: 0o755 }); return file; };

try {
  h.section("quarto resolution: env → PATH → common install folders → Flux-managed → none");
  const none = tools.resolveQuartoSync({ env: { PATH: path.join(scratch, "empty") }, platform: "linux", home, fluxConfigPath: cfg, isExecutable: (f: string) => f.startsWith(scratch) && fs.existsSync(f) });
  h.eq(none, { command: null, origin: null }, "nothing installed → no command (callers keep the bare-name ENOENT shape)");
  h.eq(tools.quartoCommandSync({ env: { PATH: "" }, platform: "linux", home, fluxConfigPath: cfg, isExecutable: () => false }), "quarto", "quartoCommandSync falls back to the bare name");
  const managed = exe(tools.managedQuartoBin(cfg, "linux"));
  const onlyScratch = (f: string) => f.startsWith(scratch) && fs.existsSync(f);
  h.eq(tools.resolveQuartoSync({ env: { PATH: "" }, platform: "linux", home, fluxConfigPath: cfg, isExecutable: onlyScratch }), { command: managed, origin: "managed" }, "the managed copy is used when the user has none");
  const localBin = exe(path.join(home, ".local", "bin", "quarto"));
  h.eq(tools.resolveQuartoSync({ env: { PATH: "" }, platform: "linux", home, fluxConfigPath: cfg, isExecutable: onlyScratch }), { command: localBin, origin: "system" },
    "a quarto in a common install folder (~/.local/bin) beats the managed copy, even off PATH — a Finder-launched app's PATH is launchd's");
  const onPath = exe(path.join(scratch, "pathbin", "quarto"));
  h.eq(tools.resolveQuartoSync({ env: { PATH: path.dirname(onPath) }, platform: "linux", home, fluxConfigPath: cfg, isExecutable: onlyScratch }), { command: onPath, origin: "path" }, "PATH wins over the common folders");
  const pinned = exe(path.join(scratch, "pinned", "quarto"));
  h.eq(tools.resolveQuartoSync({ env: { PATH: path.dirname(onPath), FLUX_QUARTO: pinned }, platform: "linux", home, fluxConfigPath: cfg, isExecutable: onlyScratch }), { command: pinned, origin: "env" }, "FLUX_QUARTO wins over everything");
  h.ok(tools.commonToolDirs("darwin", home).includes("/opt/homebrew/bin") && tools.commonToolDirs("darwin", home).includes("/Applications/quarto/bin"), "macOS searches Homebrew and the Quarto .pkg's folder");
  h.eq(tools.quartoAsset("darwin", "arm64")?.file, "quarto-1.7.32-macos.tar.gz", "macOS (either arch) gets the one universal tarball");
  h.eq(tools.quartoAsset("linux", "arm64")?.file, "quarto-1.7.32-linux-arm64.tar.gz", "Linux arm64 gets its own tarball");
  h.eq(tools.quartoAsset("win32", "x64"), null, "Windows is not managed (install from quarto.org)");
  h.ok(Object.values(tools.QUARTO.assets).every((a: any) => /^[0-9a-f]{64}$/.test(a.sha256) && a.bytes > 1e8), "every pinned asset carries a sha256 and its byte size");
  await fsp.rm(path.join(cfg, "tools"), { recursive: true, force: true });

  h.section("installer: download → verify → extract → publish with one rename");
  // Two fake upstream layouts: macOS (flat ./bin/quarto) and Linux (nested quarto-<v>/bin/quarto).
  const makeTar = (name: string, nested: boolean) => {
    const src = path.join(scratch, `src-${name}`), top = nested ? path.join(src, "quarto-1.7.32") : src;
    exe(path.join(top, "bin", "quarto"), "#!/bin/sh\necho 1.7.32\n");
    fs.mkdirSync(path.join(top, "share"), { recursive: true });
    fs.writeFileSync(path.join(top, "share", "marker.txt"), name);
    const tar = path.join(scratch, `${name}.tar.gz`);
    execFileSync("tar", ["-czf", tar, "-C", src, "."]);
    const bytes = fs.readFileSync(tar);
    return { file: `${name}.tar.gz`, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), body: bytes };
  };
  const flat = makeTar("flat", false), nested = makeTar("nested", true);
  let slow = false, served = 0;
  const server = http.createServer((req, res) => {
    served++;
    const asset = [flat, nested].find(a => req.url?.endsWith(`/${a.file}`));
    if (!asset) { res.statusCode = 404; res.end(); return; }
    res.setHeader("content-length", String(asset.body.length));
    if (!slow) { res.end(asset.body); return; }
    res.write(asset.body.subarray(0, 64)); // then stall until the client aborts
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/releases`;
  try {
    const phases: string[] = [];
    const r1 = await tools.installManagedQuarto({ fluxConfigPath: cfg, platform: "linux", asset: nested, baseUrl, onProgress: (p: { phase: string }) => { if (!phases.includes(p.phase)) phases.push(p.phase); } });
    const final = tools.managedQuartoDir(cfg);
    h.eq(r1.command, path.join(final, "bin", "quarto"), "the nested Linux layout is flattened into <FluxConfig>/tools/quarto/<version>/bin/quarto");
    h.eq(fs.readFileSync(path.join(final, "share", "marker.txt"), "utf8"), "nested", "…with its share/ beside bin/");
    h.ok(fs.statSync(r1.command).mode & 0o111, "…and the binary stays executable");
    h.eq(phases.filter(p => p !== "download"), ["verify", "extract", "done"], "progress reports verify → extract → done after the download");
    h.eq(fs.readdirSync(tools.managedQuartoRoot(cfg)), ["1.7.32"], "no scratch directory is left behind");
    h.eq(tools.resolveQuartoSync({ env: { PATH: "" }, platform: "linux", home: path.join(scratch, "nohome"), fluxConfigPath: cfg, isExecutable: onlyScratch }).origin, "managed", "the resolver now finds the installed copy");

    await tools.installManagedQuarto({ fluxConfigPath: cfg, platform: "darwin", asset: flat, baseUrl });
    h.eq(fs.readFileSync(path.join(final, "share", "marker.txt"), "utf8"), "flat", "reinstalling replaces the previous copy (flat macOS layout)");
    h.eq(fs.readdirSync(tools.managedQuartoRoot(cfg)), ["1.7.32"], "…publishing with one rename, nothing else left");

    let refused = "";
    try { await tools.installManagedQuarto({ fluxConfigPath: cfg, platform: "linux", asset: { ...nested, sha256: "0".repeat(64) }, baseUrl }); }
    catch (e) { refused = (e as Error).message; }
    h.ok(/checksum/.test(refused), `a checksum mismatch is refused (${refused.slice(0, 60)}…)`);
    h.eq(fs.readFileSync(path.join(final, "share", "marker.txt"), "utf8"), "flat", "…and the installed copy is untouched");
    h.eq(fs.readdirSync(tools.managedQuartoRoot(cfg)), ["1.7.32"], "…with no scratch left");

    let missing = "";
    try { await tools.installManagedQuarto({ fluxConfigPath: path.join(scratch, "cfg404"), platform: "linux", asset: { ...nested, file: "absent.tar.gz" }, baseUrl }); }
    catch (e) { missing = (e as Error).message; }
    h.ok(/HTTP 404/.test(missing) && !fs.existsSync(tools.managedQuartoDir(path.join(scratch, "cfg404"))), "an HTTP failure publishes nothing");

    slow = true;
    const controller = new AbortController(), cfg2 = path.join(scratch, "cfg-cancel");
    const started = tools.installManagedQuarto({ fluxConfigPath: cfg2, platform: "linux", asset: nested, baseUrl, signal: controller.signal });
    await new Promise(r => setTimeout(r, 150)); // let the first bytes arrive, then cancel mid-download
    controller.abort();
    let cancelError = "";
    try { await started; } catch (e) { cancelError = (e as Error).name + ": " + (e as Error).message; }
    h.ok(/Abort/i.test(cancelError), `cancel rejects the install (${cancelError.slice(0, 50)})`);
    h.eq(fs.existsSync(tools.managedQuartoDir(cfg2)) ? "published" : fs.readdirSync(tools.managedQuartoRoot(cfg2)).join(","), "", "cancel leaves nothing: no final dir, no scratch");
    let winError = "";
    try { await tools.installManagedQuarto({ platform: "win32", arch: "x64", fluxConfigPath: cfg2 }); } catch (e) { winError = (e as Error).message; }
    h.ok(/quarto\.org/.test(winError), "…with a pointer to quarto.org");
    h.ok(served >= 5, `the fake upstream served every request (${served})`);
  } finally { server.closeAllConnections?.(); server.close(); }

  h.section("TeX for Quarto PDF");
  const texHome = path.join(scratch, "texhome");
  h.eq(tools.detectTexSync({ env: { PATH: "" }, platform: "linux", home: texHome, isExecutable: onlyScratch }).installed, false, "no TinyTeX and no LaTeX → not installed");
  const tiny = exe(path.join(texHome, ".TinyTeX", "bin", "x86_64-linux", "lualatex"));
  h.eq(tools.detectTexSync({ env: { PATH: "" }, platform: "linux", home: texHome, isExecutable: onlyScratch }), { installed: true, kind: "tinytex", path: tiny }, "Linux TinyTeX (~/.TinyTeX) is found");
  const macTiny = exe(path.join(texHome, "Library", "TinyTeX", "bin", "universal-darwin", "pdflatex"));
  h.eq(tools.detectTexSync({ env: { PATH: "" }, platform: "darwin", home: texHome, isExecutable: onlyScratch }).path, macTiny, "macOS TinyTeX (~/Library/TinyTeX) is found");
  const sysTex = exe(path.join(scratch, "texbin", "xelatex"));
  h.eq(tools.detectTexSync({ env: { PATH: path.dirname(sysTex) }, platform: "linux", home: path.join(scratch, "nohome"), isExecutable: onlyScratch }), { installed: true, kind: "system", path: sysTex }, "a system LaTeX on PATH counts");
  const argsLog = path.join(scratch, "tinytex-args.txt");
  const fakeQuarto = exe(path.join(scratch, "fq", "quarto"), `#!/bin/sh\necho "$@" > '${argsLog}'\necho "Installing TinyTeX"\necho "done"\n`);
  const lines: string[] = [];
  const tt = await tools.installTinytex({ quarto: fakeQuarto, onLog: (c: string) => lines.push(c) });
  h.ok(tt.ok && fs.readFileSync(argsLog, "utf8").trim() === "install tinytex --no-prompt", "installTinytex runs `quarto install tinytex --no-prompt`");
  h.ok(lines.join("").includes("Installing TinyTeX"), "…streaming its output for the progress line");
  h.eq((await tools.installTinytex({ quarto: null })).ok, false, "no quarto → a clear failure, nothing spawned");

  h.section("the `flux` command on PATH (the line install.sh writes too)");
  const shellHome = path.join(scratch, "shellhome");
  await fsp.mkdir(shellHome, { recursive: true });
  h.eq(tools.shellProfile("darwin", shellHome), path.join(shellHome, ".zshrc"), "macOS edits ~/.zshrc");
  h.eq(tools.shellProfile("linux", shellHome), path.join(shellHome, ".bashrc"), "Linux edits ~/.bashrc");
  fs.writeFileSync(path.join(shellHome, ".bashrc"), "alias ll='ls -l'"); // no trailing newline
  h.eq(tools.ensurePathLine({ platform: "linux", home: shellHome }).changed, true, "the first call adds the line");
  h.eq(tools.ensurePathLine({ platform: "linux", home: shellHome }).changed, false, "the second is a no-op");
  const rc = fs.readFileSync(path.join(shellHome, ".bashrc"), "utf8");
  h.eq(rc, `alias ll='ls -l'\n\n${tools.PATH_MARKER}\n${tools.PATH_LINE}\n`, "the user's last line keeps its own line; marker + export appended exactly once");
  h.eq(tools.PATH_MARKER, "# Added by Flux: put the flux command on PATH", "the marker text is the install.sh contract, verbatim");
  h.eq(tools.PATH_LINE, 'export PATH="$HOME/.local/bin:$PATH"', "…and so is the export line");
  const zsh = path.join(shellHome, ".zshrc");
  fs.writeFileSync(zsh, `# mine\n${tools.PATH_MARKER}\n${tools.PATH_LINE}\n`); // as if install.sh ran first
  h.eq(tools.ensurePathLine({ platform: "darwin", home: shellHome }).changed, false, "a line install.sh already wrote is recognised (no duplicate)");
  const before = tools.launcherStatusSync({ env: { PATH: "/usr/bin" }, platform: "linux", home: path.join(scratch, "nolauncher") });
  h.eq([before.installed, before.onPath], [false, false], "launcher status: not installed, not on PATH");
  exe(path.join(shellHome, ".local", "bin", "flux"));
  const after = tools.launcherStatusSync({ env: { PATH: "/usr/bin" }, platform: "linux", home: shellHome });
  h.eq([after.installed, after.onPath], [true, true], "launcher status: installed, and on PATH via the profile line (for new terminals)");

  h.section("update: the install line and the macOS in-place spawn");
  h.eq(update.INSTALL_SCRIPT_URL, "https://fluxsci.github.io/install.sh", "one install-script URL");
  h.eq(update.installLine(), "curl -fsSL https://fluxsci.github.io/install.sh | bash", "the install line");
  h.eq(update.installLine({ update: true }), "curl -fsSL https://fluxsci.github.io/install.sh | bash -s -- --update", "the Linux update line");
  h.eq(update.updateSpawn({ pid: 4242 }), { command: "/bin/bash", args: ["-c", "curl -fsSL 'https://fluxsci.github.io/install.sh' | bash -s -- --update --wait-pid 4242 --relaunch"] },
    "macOS 'Update now' runs the script with --update --wait-pid <pid> --relaunch");
  for (const pid of [0, -1, 1.5, NaN, "12; rm -rf ~" as unknown as number]) {
    let threw = false; try { update.updateSpawn({ pid }); } catch { threw = true; }
    h.ok(threw, `a non-integer or non-positive pid is refused (${String(pid)})`);
  }
  let badUrl = false; try { update.updateSpawn({ pid: 1, url: "https://x.example/a'; touch /tmp/p; '" }); } catch { badUrl = true; }
  h.ok(badUrl, "a URL carrying shell syntax is refused");
} catch (e) {
  h.fail(String((e as Error).stack ?? e));
} finally {
  await fsp.rm(scratch, { recursive: true, force: true });
}
await h.done();
