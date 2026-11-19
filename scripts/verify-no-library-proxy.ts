// The university-library sign-in is gone, and stays gone (owner decision 2026-11-18).
//
// Flux used to sign in to a library's EZProxy, keep a saved password and session, and download
// paywalled PDFs through it. It was removed completely; nothing replaced it. Users get PDFs
// from open access, the browser extension, or a file they already have. This gate holds that:
//
//   1. A census over current source and user/agent docs fails on any identifier or string of
//      the removed feature. The only files allowed to name it are the upgrade-cleanup module
//      and this gate (plus two comment lines inside the SIGNED extension, listed below, which
//      can only change with a re-sign).
//   2. The IPC contract and the preload expose none of the seven retired channels.
//   3. The upgrade cleanup, against temporary libraries: credentials removed, the retired key
//      removed while every other key survives, an untouched library stays byte-identical,
//      a second run is a no-op, a symlinked credential file is unlinked without touching its
//      target, a malformed keys.json is left alone, and the session partition directory goes
//      while the open-access cookie jar stays. It also runs through the REAL CLI in a scratch
//      home, so a CLI-only user is cleaned too.
//   4. Both engines refuse to store the retired key: a write that includes it leaves it out of
//      the file and out of the returned map.
//   5. `flux missing-pdfs` no longer has the sign-in column.
// The Electron half of (3) — that the app deletes the partition at startup — is
// verify-retired-session-electron.cjs.
//
// Hermetic: HOME/XDG point at a scratch dir before flux-core loads, and every library is a
// temporary directory. Never run any of this against a real FluxConfig.
//   node scripts/run-verifies.mjs --tier pure --only verify-no-library-proxy.ts
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-no-library-proxy");
const repo = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "flux-noproxy-"));
const scratchHome = path.join(scratch, "home");
await fs.mkdir(scratchHome, { recursive: true });
const scratchEnv: Record<string, string> = {
  HOME: scratchHome,
  USERPROFILE: scratchHome,
  XDG_CONFIG_HOME: path.join(scratch, "config"),
  XDG_DATA_HOME: path.join(scratch, "data"),
  XDG_CACHE_HOME: path.join(scratch, "cache"),
  APPDATA: path.join(scratch, "config"),
  LOCALAPPDATA: path.join(scratch, "cache"),
};
Object.assign(process.env, scratchEnv);

// The tokens of the removed feature (plan §8). Case-sensitive unless flagged.
const TOKENS: [string, RegExp][] = [
  ["ezproxy", /ezproxy/i],
  ["proxyFetch", /proxyFetch/],
  ["createProxyEngine", /createProxyEngine/],
  ["fluxproxy", /fluxproxy/],
  [".proxy.json", /\.proxy\.json/],
  ["fetchViaProxy", /fetchViaProxy/],
  ["proxy:<channel>", /proxy:(login|status|cancel|setCredentials|hasCredentials|clearCredentials)\b/],
  ["proxy<Method>", /\bproxy(Login|Status|Cancel|SetCredentials|HasCredentials|ClearCredentials)\b/],
  ["proxy<State>", /\bproxy(Configured|SignedIn|Got)\b/],
  ["needSignIn", /\bneedSignIn\b/],
  ["blockedSkipped", /\bblockedSkipped\b/],
  ["allowProxy", /\ballowProxy\b/],
  ["proxy_reason", /proxy_reason/],
  ["institutional-proxy", /institutional-proxy/],
  ["NetID", /NetID/],
  ["via library", /via library/i],
  ["library proxy", /[Ll]ibrary proxy/],
  ["paywall", /(?<![Uu]n)paywall/i],
  ["login.wisc", /login\.wisc/],
  ["Duo", /\bDuo\b/],
  ["cf_clearance", /cf_clearance/],
  ["PerimeterX", /PerimeterX/],
  ["publisher-blocked", /publisher-blocked/],
  ["session-expired", /session-expired/],
];

// The files that may name the feature, each for a stated reason. Nothing else.
const ALLOWED_FILES = new Set([
  "electron/retiredLibraryProxy.cjs", // the upgrade cleanup: it has to name what it deletes
  "scripts/verify-no-library-proxy.ts", // this gate (not inside the scanned roots anyway)
]);
// Exact lines inside the signed Firefox add-on payload. scripts/verify-extension-build.ts
// requires electron/supplementRules.js and extension/background.js to be byte-identical to the
// committed signed .xpi, so even a comment edit needs the maintainer to re-sign. When they are
// re-signed with the wording fixed, delete the matching entry here (the gate fails on an
// allowance that no longer matches anything, so it cannot go stale).
const ALLOWED_LINES: { file: string; line: string; why: string }[] = [
  {
    file: "electron/supplementRules.js",
    line: "// electron/proxyFetch.cjs (CommonJS) therefore reaches it via dynamic import().",
    why: "stale comment inside the signed .xpi payload",
  },
  {
    file: "extension/background.js",
    line: "// user's cookies, so it walks through paywalls and the Cloudflare/PerimeterX walls that defeat",
    why: "comment inside the signed .xpi payload",
  },
];
// `paywall` may survive where it describes rejecting an HTML page served in place of a PDF.
const PAYWALL_OK = [/HTML paywall\/login pages served as 200/, /paywalled main\s*$/];

const SKIP_DIRS = new Set(["node_modules", "dist", "signed", ".git"]);
const BINARY = /\.(png|jpe?g|gif|webp|ico|icns|svgz|pdf|xpi|zip|woff2?|ttf|otf|glb|gltf|bin|wasm|mp4|mov|webm|gz|tar|node)$/i;
async function walk(rel: string): Promise<string[]> {
  const abs = path.join(repo, rel);
  let entries: fsSync.Dirent[];
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const child = `${rel}/${e.name}`;
    if (e.isDirectory()) {
      // extension/dist and electron/generated are build outputs of sources scanned here
      // (the generated bundles carry a copy of the cleanup module).
      if (SKIP_DIRS.has(e.name) || child === "extension/dist" || child === "electron/generated") continue;
      out.push(...(await walk(child)));
    } else if (e.isFile() && !BINARY.test(e.name)) out.push(child);
  }
  return out;
}

type Hit = { file: string; line: number; token: string; text: string };
function scanText(file: string, text: string, used: Set<string>): Hit[] {
  const hits: Hit[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((ln, i) => {
    for (const [token, re] of TOKENS) {
      if (!re.test(ln)) continue;
      const allowance = ALLOWED_LINES.find((a) => a.file === file && a.line === ln);
      if (allowance) {
        used.add(`${allowance.file}\0${allowance.line}`);
        continue;
      }
      if (token === "paywall" && PAYWALL_OK.some((ok) => ok.test(ln))) continue;
      hits.push({ file, line: i + 1, token, text: ln.trim().slice(0, 140) });
    }
  });
  return hits;
}

try {
  // --- 0: the scanner itself --------------------------------------------------------------
  h.section("scanner controls");
  const none = new Set<string>();
  h.eq(scanText("x.ts", "Unpaywall · unpaywall API · zoom proxy · new Proxy(target) · proxy capture of the canvas", none), [], "Unpaywall and the graphics/JS senses of 'proxy' are not the feature");
  h.eq(
    scanText("x.ts", 'fb.fetchViaProxy(t)\n"Get via library ⚿"\nconst k = "ezproxyPrefix"\nipc.handle("proxy:login")', none).map((x) => x.token),
    ["fetchViaProxy", "via library", "ezproxy", "proxy:<channel>"],
    "the feature's identifiers and strings are caught",
  );

  // --- 1: the census ----------------------------------------------------------------------
  h.section("census: current source and docs");
  const roots = ["electron", "src", "flux-core", "extension", "resources"];
  const files = [
    "flux-cli.ts",
    "flux-mcp.ts",
    ...(await Promise.all(roots.map(walk))).flat(),
    ...(await walk("docs")).filter((f) => f.endsWith(".qmd")),
  ]
    .filter((f) => !ALLOWED_FILES.has(f))
    .sort();
  const used = new Set<string>();
  const hits: Hit[] = [];
  for (const f of files) {
    let text: string;
    try {
      text = await fs.readFile(path.join(repo, f), "utf8");
    } catch {
      continue;
    }
    if (text.includes("\u0000")) continue; // binary
    hits.push(...scanText(f, text, used));
  }
  h.ok(files.length > 500, `scanned ${files.length} files`);
  h.ok(files.includes("electron/fluxContextDocs.gen.cjs") && files.includes("docs/modes/library.qmd"), "the generated agent docs and the Library user doc are in scope");
  for (const hit of hits) console.error(`  ${hit.file}:${hit.line}: [${hit.token}] ${hit.text}`);
  h.eq(hits.length, 0, "no identifier or string of the removed feature outside the cleanup module");
  for (const a of ALLOWED_LINES) h.ok(used.has(`${a.file}\0${a.line}`), `allowance still matches (${a.file}: ${a.why})`);

  // --- 2: the bridge ----------------------------------------------------------------------
  h.section("IPC contract and preload");
  const RETIRED_CHANNELS = ["pdf:fetchViaProxy", "proxy:login", "proxy:status", "proxy:cancel", "proxy:hasCredentials", "proxy:setCredentials", "proxy:clearCredentials"];
  const { CHANNELS } = require("../electron/ipc/contract.cjs") as { CHANNELS: { channel: string }[] };
  const declared = new Set(CHANNELS.map((c) => c.channel));
  h.ok(CHANNELS.length > 100, `contract loaded (${CHANNELS.length} channels)`);
  h.eq(RETIRED_CHANNELS.filter((c) => declared.has(c)), [], "the contract declares none of the seven retired channels");
  const preload = await fs.readFile(path.join(repo, "electron/preload.cjs"), "utf8");
  h.eq(RETIRED_CHANNELS.filter((c) => preload.includes(`"${c}"`)), [], "the preload invokes none of them");
  h.ok(!/\bproxy[A-Z]\w*\s*:/.test(preload) && !/fetchViaProxy/.test(preload), "the preload exposes no proxy* method");
  h.ok(!fsSync.existsSync(path.join(repo, "electron/proxyFetch.cjs")), "the capture engine module is deleted");

  // --- 3: the upgrade cleanup ---------------------------------------------------------------
  h.section("upgrade cleanup (temporary libraries)");
  const { cleanupRetiredLibraryProxy, removeRetiredSessionPartition, withoutRetiredKeys, RETIRED_KEYS } = require("../electron/retiredLibraryProxy.cjs");
  h.eq([...RETIRED_KEYS], ["ezproxyPrefix"], "one retired key");
  const snapshot = async (dir: string): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    const rec = async (d: string) => {
      for (const e of await fs.readdir(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        const rel = path.relative(dir, p);
        if (e.isDirectory()) {
          out[rel + "/"] = "dir";
          await rec(p);
        } else if (e.isSymbolicLink()) out[rel] = "link:" + (await fs.readlink(p));
        else out[rel] = (await fs.readFile(p)).toString("base64");
      }
    };
    await rec(dir);
    return out;
  };
  const newLib = async (name: string) => {
    const lib = path.join(scratch, name, "FluxLib");
    await fs.mkdir(path.join(lib, "items", "smith2020"), { recursive: true });
    await fs.writeFile(path.join(lib, "library.bib"), "@article{smith2020, title={T}}\n");
    return lib;
  };
  const quiet = async <T,>(fn: () => Promise<T>): Promise<{ value: T; logged: string[] }> => {
    const logged: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
    try {
      return { value: await fn(), logged };
    } finally {
      console.error = orig;
    }
  };

  {
    const lib = await newLib("full");
    await fs.writeFile(path.join(lib, ".proxy.json"), JSON.stringify({ username: "someone", passwordEnc: "c2VjcmV0", allowedOrigins: ["https://login.example"] }), { mode: 0o600 });
    const keys = { mailto: "me@example.org", openAlexKey: "oa-123", ezproxyPrefix: "https://proxy.example/login?url=", s2Key: "s2-456", extraKey: { nested: [1, 2] } };
    await fs.writeFile(path.join(lib, "keys.json"), JSON.stringify(keys, null, 2) + "\n", { mode: 0o600 });
    const { value: r, logged } = await quiet(() => cleanupRetiredLibraryProxy({ fluxLibDir: lib }));
    h.eq(r, { credentials: "removed", keys: "removed" }, "both pieces removed");
    h.ok(!fsSync.existsSync(path.join(lib, ".proxy.json")), ".proxy.json is gone");
    const after = JSON.parse(await fs.readFile(path.join(lib, "keys.json"), "utf8"));
    h.eq(after, { mailto: "me@example.org", openAlexKey: "oa-123", s2Key: "s2-456", extraKey: { nested: [1, 2] } }, "ezproxyPrefix removed; mailto, openAlexKey, s2Key and an unknown key keep their values and order");
    if (process.platform !== "win32") h.eq((await fs.stat(path.join(lib, "keys.json"))).mode & 0o777, 0o600, "keys.json is written back 0600");
    h.eq(logged, [], "a successful cleanup logs nothing");
    const before2 = await snapshot(lib);
    const { value: r2 } = await quiet(() => cleanupRetiredLibraryProxy({ fluxLibDir: lib }));
    h.eq(r2, { credentials: "absent", keys: "clean" }, "second run finds nothing to do");
    h.eq(await snapshot(lib), before2, "second run is a no-op (library byte-identical)");
  }
  {
    const lib = await newLib("untouched");
    const before = await snapshot(lib);
    const { value: r } = await quiet(() => cleanupRetiredLibraryProxy({ fluxLibDir: lib }));
    h.eq(r, { credentials: "absent", keys: "absent" }, "a library with neither file reports nothing to do");
    h.eq(await snapshot(lib), before, "and is left byte-identical (no keys.json, no lock dir created)");
    const clean = await newLib("clean-keys");
    await fs.writeFile(path.join(clean, "keys.json"), '{"mailto":"x@y.z"}');
    const beforeClean = await snapshot(clean);
    await quiet(() => cleanupRetiredLibraryProxy({ fluxLibDir: clean }));
    h.eq(await snapshot(clean), beforeClean, "a keys.json without the retired key is not rewritten (not even reformatted)");
  }
  {
    const lib = await newLib("symlink");
    const canary = path.join(scratch, "canary.txt");
    await fs.writeFile(canary, "do not delete");
    let linked = true;
    try {
      await fs.symlink(canary, path.join(lib, ".proxy.json"));
    } catch {
      linked = false; // Windows without symlink rights
    }
    if (linked) {
      const { value: r } = await quiet(() => cleanupRetiredLibraryProxy({ fluxLibDir: lib }));
      h.eq(r.credentials, "removed", "a symlinked .proxy.json is removed");
      h.ok(!fsSync.existsSync(path.join(lib, ".proxy.json")) && !(await fs.lstat(path.join(lib, ".proxy.json")).then(() => true, () => false)), "the link itself is gone");
      h.eq(await fs.readFile(canary, "utf8"), "do not delete", "its target (the canary) is untouched");
    } else h.ok(true, "symlink case skipped: this host cannot create symlinks");
  }
  {
    const lib = await newLib("malformed");
    const bad = '{"mailto": "x@y.z", "ezproxyPrefix": "https://p.example/login?url=",';
    await fs.writeFile(path.join(lib, "keys.json"), bad);
    const { value: r, logged } = await quiet(() => cleanupRetiredLibraryProxy({ fluxLibDir: lib }));
    h.eq(r.keys, "malformed", "malformed keys.json is reported by category");
    h.eq(await fs.readFile(path.join(lib, "keys.json"), "utf8"), bad, "and left exactly as it was");
    h.ok(logged.length === 1 && /keys\.json is not valid JSON/.test(logged[0]) && !logged[0].includes(lib) && !logged[0].includes("p.example"), "the log line names the category, not the path or the contents");
  }
  {
    h.eq(withoutRetiredKeys({ a: 1 }), { a: 1 }, "withoutRetiredKeys leaves a clean map alone");
    const m = { a: 1, ezproxyPrefix: "x" };
    h.eq(withoutRetiredKeys(m), { a: 1 }, "withoutRetiredKeys drops the retired key");
    h.eq(m, { a: 1, ezproxyPrefix: "x" }, "without mutating its input");
  }
  {
    const userData = path.join(scratch, "userdata");
    const parts = path.join(userData, "Partitions");
    await fs.mkdir(path.join(parts, "fluxproxy", "Cache"), { recursive: true });
    await fs.writeFile(path.join(parts, "fluxproxy", "Cookies"), "session");
    await fs.mkdir(path.join(parts, "fluxnet"), { recursive: true });
    await fs.writeFile(path.join(parts, "fluxnet", "Cookies"), "oa jar");
    h.eq(await removeRetiredSessionPartition({ userDataDir: userData }), "removed", "the saved sign-in session directory is removed");
    h.ok(!fsSync.existsSync(path.join(parts, "fluxproxy")), "Partitions/fluxproxy is gone");
    h.eq(await fs.readFile(path.join(parts, "fluxnet", "Cookies"), "utf8"), "oa jar", "Partitions/fluxnet (the open-access cookie jar) is untouched");
    h.eq(await removeRetiredSessionPartition({ userDataDir: userData }), "absent", "second run: nothing to do");
    const target = path.join(scratch, "elsewhere");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "keep"), "keep");
    let linked = true;
    try {
      await fs.symlink(target, path.join(parts, "fluxproxy"), "dir");
    } catch {
      linked = false;
    }
    if (linked) {
      h.eq(await removeRetiredSessionPartition({ userDataDir: userData }), "removed", "a symlinked partition entry is removed");
      h.eq(await fs.readFile(path.join(target, "keep"), "utf8"), "keep", "without following it");
    }
  }

  h.section("upgrade cleanup through the real CLI (scratch home)");
  {
    // A CLI-only user: the headless engine's machine initialisation (fluxPaths.ensureFluxConfig)
    // must clean the active FluxLib. FLUX_NO_MIGRATE is cleared ONLY for this child, whose HOME
    // and config dirs are the scratch ones above.
    const lib = path.join(scratchHome, "FluxConfig", "FluxLib");
    await fs.mkdir(lib, { recursive: true });
    await fs.writeFile(path.join(lib, ".proxy.json"), '{"username":"someone","passwordEnc":"c2VjcmV0"}');
    await fs.writeFile(path.join(lib, "keys.json"), JSON.stringify({ mailto: "cli@example.org", ezproxyPrefix: "https://p.example/login?url=" }, null, 2) + "\n");
    const env: Record<string, string | undefined> = { ...process.env, ...scratchEnv };
    delete env.FLUX_NO_MIGRATE;
    for (const k of ["FLUX_PROJECT", "FLUX_MAILTO", "OPENALEX_API_KEY", "S2_API_KEY"]) delete env[k];
    const r = spawnSync(process.execPath, ["--import", "tsx", path.join(repo, "flux-cli.ts"), "keys"], { cwd: repo, env, encoding: "utf8", timeout: 120_000 });
    h.eq(r.status, 0, `flux keys exits cleanly${r.status ? `: ${r.stderr}` : ""}`);
    h.ok(fsSync.realpathSync(path.dirname(lib)).startsWith(fsSync.realpathSync(scratch)), "the cleaned library is inside the scratch dir");
    h.ok(!fsSync.existsSync(path.join(lib, ".proxy.json")), "the CLI removed .proxy.json");
    h.eq(JSON.parse(await fs.readFile(path.join(lib, "keys.json"), "utf8")), { mailto: "cli@example.org" }, "the CLI removed the retired key and kept mailto");
    h.ok(/cli@example\.org/.test(r.stdout) && !/ezproxy/i.test(r.stdout + r.stderr), "keys output shows the remaining key and never the retired one");
  }

  // --- 4: both engines refuse the retired key ------------------------------------------------
  h.section("both engines drop the retired key on write and read");
  {
    const lib = path.join(scratch, "keys-core", "FluxLib");
    await fs.mkdir(lib, { recursive: true });
    const core = await import("../flux-core/fluxlib");
    const back = await core.saveKeys({ mailto: "a@b.c", ezproxyPrefix: "https://p.example/login?url=" }, lib);
    h.eq(back, { mailto: "a@b.c" }, "headless saveKeys: the returned map lacks it");
    h.eq(JSON.parse(await fs.readFile(path.join(lib, "keys.json"), "utf8")), { mailto: "a@b.c" }, "headless saveKeys: the file lacks it");
    await fs.writeFile(path.join(lib, "keys.json"), JSON.stringify({ mailto: "a@b.c", ezproxyPrefix: "old" }));
    h.eq(await core.loadKeys(lib), { mailto: "a@b.c" }, "headless loadKeys never returns it");
    h.eq(await core.saveKeys({ s2Key: "s" }, lib), { mailto: "a@b.c", s2Key: "s" }, "an unrelated headless save also clears one left on disk");
    h.eq(JSON.parse(await fs.readFile(path.join(lib, "keys.json"), "utf8")), { mailto: "a@b.c", s2Key: "s" }, "…in the file too");
  }
  {
    const lib = path.join(scratch, "keys-desktop", "FluxLib");
    await fs.mkdir(lib, { recursive: true });
    const { createNetworkFamily } = require("../electron/ipc/network.cjs");
    const atomicWriteMain = async (p: string, text: string, _createOnly: boolean, mode: number) => {
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p + ".tmp", text, { mode });
      await fs.rename(p + ".tmp", p);
    };
    const fam = createNetworkFamily({
      session: {},
      fluxLibDir: () => lib,
      resolveToDoi: async () => null,
      locks: { lockDirFor: () => path.join(lib, ".fluxlib", "locks") },
      files: { atomicWriteMain },
    });
    const handlers = new Map<string, (...a: unknown[]) => unknown>();
    fam.registerHandlers({ handle: (name: string, fn: (...a: unknown[]) => unknown) => handlers.set(name, fn) });
    h.eq([...handlers.keys()].filter((n) => /^proxy:|ViaProxy/.test(n)), [], "the network family registers no retired channel");
    const set = await handlers.get("keys:set")!({}, { mailto: "d@e.f", ezproxyPrefix: "https://p.example/login?url=" });
    h.eq(set, { mailto: "d@e.f" }, "desktop keys:set: the returned map lacks it");
    h.eq(JSON.parse(await fs.readFile(path.join(lib, "keys.json"), "utf8")), { mailto: "d@e.f" }, "desktop keys:set: the file lacks it");
    await fs.writeFile(path.join(lib, "keys.json"), JSON.stringify({ mailto: "d@e.f", ezproxyPrefix: "old" }));
    h.eq(await handlers.get("keys:get")!({}), { mailto: "d@e.f" }, "desktop keys:get never returns it");
    h.eq(await handlers.get("keys:set")!({}, { openAlexKey: "o" }), { mailto: "d@e.f", openAlexKey: "o" }, "an unrelated desktop save also clears one left on disk");
    h.eq(fam.getKey("mailto"), "d@e.f", "getKey still reads the remaining keys");
  }

  // --- 5: missing-pdfs ------------------------------------------------------------------------
  h.section("flux missing-pdfs columns");
  {
    const { toCsv, missingPdfs } = await import("../flux-core/acquire");
    const header = toCsv([]).split("\n")[0].split(",");
    h.eq(header, ["citekey", "title", "doi", "status", "year", "journal", "publisher_group", "is_oa", "oa_url", "pmid", "pmcid", "attempts", "last_attempt"], "the CSV has no sign-in or failure-record columns");
    const lib = path.join(scratch, "missing", "FluxLib");
    await fs.mkdir(path.join(lib, "items", "jones2019"), { recursive: true });
    await fs.writeFile(path.join(lib, "library.bib"), "@article{jones2019, title={No OA}, doi={10.1016/j.cell.7}, year={2019}}\n");
    // An old record from an earlier version: left on disk, never read.
    await fs.writeFile(path.join(lib, "items", "jones2019", "fetch-failure.json"), JSON.stringify({ key: "jones2019", attempts: 4, oa: "no-oa" }));
    const rows = await missingPdfs({ libPath: lib });
    h.eq(rows.map((r) => [r.citekey, r.status, r.attempts]), [["jones2019", "never-tried", ""]], "an old fetch-failure.json no longer makes a paper 'failed'");
    h.ok(!("proxy_reason" in rows[0]) && !("landed_host" in rows[0]) && !("oa_error" in rows[0]), "rows carry no sign-in fields");
  }
} catch (e) {
  h.fail(e instanceof Error ? e.stack ?? e.message : String(e));
}
await h.done(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});
