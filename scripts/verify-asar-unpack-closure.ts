// asarUnpack closure (pure): every module electron-builder unpacks for a Node-mode child
// (ELECTRON_RUN_AS_NODE has NO asar support) must have its whole relative-import closure
// unpacked too. 2026-10-22 shipped a packaged app whose slide-video worker died on
// `Cannot find module './slideAudioGraph.cjs'` (fixed in 6b84e88a) — nothing checked this.
// Static relative require()/import specifiers are followed; imports a module resolves at RUN
// time (a URL handed in through the environment) are declared in RUNTIME below, so a new one
// fails closed until it is listed. Electron-mode-only requires are exempt by name, with why.
//   Run: node scripts/run-verifies.mjs --tier pure --only verify-asar-unpack-closure
import { readFileSync, existsSync } from "node:fs";
import { join, posix } from "node:path";
import { createRequire } from "node:module";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-asar-unpack-closure");
const repo = join(import.meta.dirname, "..");
const yaml = createRequire(import.meta.url)("js-yaml");
const cfg = yaml.load(readFileSync(join(repo, "electron-builder.yml"), "utf8"));
const patterns: string[] = cfg.asarUnpack ?? [];

/** electron-builder glob → RegExp (**, *, literal). */
const toRe = (g: string) => new RegExp("^" + g.split("**").map((part) => part.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*") + "$");
const unpacked = (rel: string) => patterns.some((p) => toRe(p).test(rel) || toRe(p.replace(/\/\*\*$/, "")).test(rel));

/** Imports resolved at run time (not static specifiers): module → files it loads. */
const RUNTIME: Record<string, string[]> = {
  // The Plots rail's thumbnail worker loads the font resolver through FLUX_FONTFILES_MODULE.
  "electron/plotThumbWorker.mjs": ["src/lib/text/fontFiles.mjs"],
};
/** Relative requires that only run in Electron mode (asar is readable there). */
const ELECTRON_ONLY: Record<string, string> = {
  "electron/entry.cjs→electron/main.cjs": "entry.cjs requires main.cjs only when it IS the Electron main process; its Node-mode branches load only the workers.",
};

const SPEC = /(?:require\(\s*|from\s+|import\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g;
function deps(rel: string): string[] {
  const text = readFileSync(join(repo, rel), "utf8").replace(/\/\/[^\n]*/g, "");
  const out = new Set<string>();
  for (const m of text.matchAll(SPEC)) out.add(posix.normalize(posix.join(posix.dirname(rel), m[1])));
  for (const r of RUNTIME[rel] ?? []) out.add(r);
  return [...out];
}

const roots = patterns.filter((p) => !p.includes("*") && /\.(c|m)?js$/.test(p) && existsSync(join(repo, p)) && !p.startsWith("dist/"));
h.ok(roots.includes("electron/plotThumbWorker.mjs"), "the Plots rail's thumbnail worker is unpacked");
const seen = new Set<string>();
const queue = [...roots];
while (queue.length) {
  const rel = queue.shift()!;
  if (seen.has(rel)) continue;
  seen.add(rel);
  for (const dep of deps(rel)) {
    if (ELECTRON_ONLY[`${rel}→${dep}`]) continue;
    const exists = existsSync(join(repo, dep));
    h.ok(exists && unpacked(dep), `${rel} → ${dep} is ${exists ? "unpacked" : "present"}`);
    if (exists && /\.(c|m)?js$/.test(dep)) queue.push(dep);
  }
}
for (const key of Object.keys(ELECTRON_ONLY)) h.ok(seen.has(key.split("→")[0]), `exemption ${key} still names an unpacked module`);
for (const [mod, list] of Object.entries(RUNTIME)) for (const dep of list) h.ok(unpacked(dep), `${mod} loads ${dep} at run time — unpacked`);


await h.done();
