// Every npm package the Electron main process require()s must ship in the packaged app.
// electron-builder's `files` patterns apply in order and later ones win: an include placed
// above the blanket "!**/node_modules/**/*" exclusion is silently undone. js-yaml sat there
// from 2026-09-27 to 10-04 and every packaged app died at launch ("Cannot find module
// 'js-yaml'"; on macOS a modal error with no output). Static, so it runs in the pure tier;
// verify-packaged-app.mjs proves the same on real packaged builds in release.yml.
import { readFileSync, readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import * as path from "node:path";
import { load as loadYaml } from "js-yaml";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-packaged-requires");
const config = loadYaml(readFileSync("electron-builder.yml", "utf8")) as { files: string[] };
const files = config.files;
const exclusion = files.lastIndexOf("!**/node_modules/**/*");
h.ok(exclusion >= 0, "the allowlist excludes node_modules wholesale, then re-includes runtime modules");

/** Packages the main process loads with a literal require("pkg") or import("pkg"). */
const builtin = new Set(builtinModules);
const wanted = new Map<string, Set<string>>();
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(c?js|mjs)$/.test(e.name) ? [path.join(dir, e.name)] : []);
for (const file of walk("electron")) {
  // require("pkg") and import("pkg") alike: main.cjs loads chokidar with a dynamic import.
  for (const m of readFileSync(file, "utf8").matchAll(/(?:require|import)\(\s*["']([^"'./][^"']*)["']\s*\)/g)) {
    const name = m[1];
    if (name.startsWith("node:") || builtin.has(name) || name === "electron") continue;
    const pkg = name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name.split("/")[0];
    if (!wanted.has(pkg)) wanted.set(pkg, new Set());
    wanted.get(pkg)!.add(path.relative("electron", file));
  }
}
h.ok(wanted.has("js-yaml"), `the scan finds the main process's runtime modules (${[...wanted.keys()].join(", ")})`);

// …and what those packages need at runtime, transitively (chokidar needs readdirp).
const queue = [...wanted.keys()];
while (queue.length) {
  const pkg = queue.shift()!;
  const deps = Object.keys(JSON.parse(readFileSync(path.join("node_modules", pkg, "package.json"), "utf8")).dependencies ?? {});
  for (const dep of deps) if (!wanted.has(dep)) { wanted.set(dep, new Set([`${pkg} (dependency)`])); queue.push(dep); }
}

for (const [pkg, from] of wanted) {
  // The package's own include (node_modules/pdf-lib/cjs/**/*) or a broader one covering it (node_modules/@pdf-lib/**/*).
  const covers = (pattern: string) => pattern.startsWith(`node_modules/${pkg}/`) || (pattern.endsWith("/**/*") && `node_modules/${pkg}/`.startsWith(pattern.slice(0, -4)));
  const at = files.findIndex((pattern, i) => i > exclusion && covers(pattern));
  h.ok(at > exclusion, `${pkg} (required by ${[...from].join(", ")}) is included AFTER the node_modules exclusion`);
}
await h.done();
