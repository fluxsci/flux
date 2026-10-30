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
import ts from "typescript";
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
  // The bundled core can launch an image-policy 3D poster through this entry.
  "electron/generated/figureRasterWorker.bundle.mjs": ["electron/entry.cjs"],
  // The Plots rail's thumbnail worker loads the font resolver through FLUX_FONTFILES_MODULE.
  "electron/plotThumbWorker.mjs": ["src/lib/text/fontFiles.mjs"],
};
/** Relative requires that only run in Electron mode (asar is readable there). */
const ELECTRON_ONLY: Record<string, string> = {
  "electron/entry.cjs→electron/main.cjs": "entry.cjs requires main.cjs only when it IS the Electron main process; its Node-mode branches load only the workers.",
};

// Parse executable imports: bundled stock documentation also contains example
// import('./flux-core/...') strings, which are data, not worker dependencies.
function staticDeps(text: string): string[] {
  const result = new Set<string>();
  const source = ts.createSourceFile("worker.mjs", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const add = (node: ts.Node | undefined) => { if (node && ts.isStringLiteral(node) && /^\.{1,2}\//.test(node.text)) result.add(node.text); };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && /^(?:require|__require)$/.test(node.expression.text))) add(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(source); return [...result];
}
function deps(rel: string): string[] {
  const out = new Set(staticDeps(readFileSync(join(repo, rel), "utf8")).map(spec => posix.normalize(posix.join(posix.dirname(rel), spec))));
  for (const r of RUNTIME[rel] ?? []) out.add(r);
  return [...out];
}
h.eq(staticDeps(`import x from './one.mjs'; require('../two.cjs'); import('./three.mjs'); const docs = "import('./example.ts')";`), ['./one.mjs', '../two.cjs', './three.mjs'], "dependency graph follows executable imports, not examples inside strings");
h.ok(existsSync(join(repo, "electron/generated/figureRasterWorker.bundle.mjs")) && unpacked("electron/generated/figureRasterWorker.bundle.mjs"), "the dedicated figure worker bundle is built and unpacked");

h.eq(staticDeps(readFileSync(join(repo, "electron/generated/figureRasterWorker.bundle.mjs"), "utf8")), ["../sceneRasterEngine.mjs"], "figure worker has no runtime TypeScript or CLI-bundle dependency");
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
