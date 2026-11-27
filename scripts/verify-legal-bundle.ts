// The packaged app carries its notices: Flux's LICENSE, THIRD_PARTY_NOTICES.md and the licence
// texts of everything compiled in (scripts/build-legal.mjs → <resources>/legal/).
//
// Until 0.4.1 the installers shipped none of them. The bundlers strip licence comments, so
// these three files are the only way the notices travel with a copy of the app. This gate
// holds the three places that can silently drop them: the generator's coverage (a package
// imported by shipped code but absent from the list), the build chain (the generator not
// run), and electron-builder.yml (a platform block REPLACES the top-level extraResources, so
// the entry must be repeated in each). verify-packaged-app.mjs checks the real packages.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { load as loadYaml } from "js-yaml";
import { harness } from "./lib/harness.mjs";
import { buildLegal } from "./build-legal.mjs";

const h = harness("verify-legal-bundle");
const out = mkdtempSync(path.join(tmpdir(), "flux-legal-"));
try {
  const result = await buildLegal(out);
  const text = readFileSync(result.file, "utf8");
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));

  h.section("the three files");
  h.ok(readFileSync(path.join(out, "LICENSE")).equals(readFileSync("LICENSE")), "LICENSE is Flux's own, byte for byte");
  h.ok(readFileSync(path.join(out, "THIRD_PARTY_NOTICES.md")).equals(readFileSync("THIRD_PARTY_NOTICES.md")), "THIRD_PARTY_NOTICES.md is the repository's, byte for byte");
  h.ok(text.startsWith(`Third-party licences for Flux ${pkg.version}\n`), "the licence texts name the version they were built for");

  h.section("work that npm does not deliver");
  const extras = readdirSync("resources/legal").filter((name) => name.endsWith(".txt")).sort();
  h.ok(extras.length >= 6, `resources/legal holds the hand-kept texts (${extras.length})`);
  for (const name of extras) {
    const body = readFileSync(path.join("resources/legal", name), "utf8").trim();
    h.ok(body.length > 200 && text.includes(body), `${name} is in the bundle whole`);
  }
  for (const [what, needle] of [
    ["Flexoki", "Steph Ango"], ["matplotlib", "Matplotlib Development Team"], ["ColorBrewer", "Cynthia Brewer"],
    ["Scientific colour maps", "Fabio Crameri"], ["Paul Tol's schemes", "Paul Tol"], ["CMasher", "Ellert van der Velden"],
    ["Lucide", "Lucide Icons and Contributors"], ["Pandoc's reference document", "John MacFarlane"],
    ["citeproc-js", "Frank Bennett"], ["the CSL styles", "creativecommons.org/licenses/by-sa/3.0"],
  ] as const) h.ok(text.includes(needle), `${what}: the notice names ${needle}`);

  h.section("npm packages");
  const byName = new Map(result.packages.map((p) => [p.name, p]));
  const direct = Object.keys(pkg.dependencies ?? {});
  for (const name of direct) h.ok(byName.has(name), `${name} (a runtime dependency) has its section`);
  for (const name of ["svelte", "tslib"]) h.ok(byName.has(name), `${name} (a devDependency compiled into the app) has its section`);
  const undeclared = result.packages.filter((p) => !p.hasText && !/^[A-Za-z0-9 .()+-]+$/.test(p.licence));
  h.eq(undeclared.map((p) => p.name), [], "every package without a licence file at least declares its licence");
  const bare = result.packages.filter((p) => !p.hasText);
  h.ok(bare.length <= result.packages.length / 10, `nearly every package brings its licence text (${result.packages.length - bare.length}/${result.packages.length})`);

  // Coverage: any package that shipped code imports by name must be in the list. This is what
  // catches a devDependency that the bundler compiles in (Svelte's runtime is the standing case).
  const builtin = new Set(builtinModules);
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.name === "node_modules" || e.name === "generated" ? []
      : e.isDirectory() ? walk(path.join(dir, e.name))
      : /\.(c?js|mjs|ts|svelte)$/.test(e.name) && !/\.d\.ts$/.test(e.name) ? [path.join(dir, e.name)] : []);
  const shipped = [...walk("src"), ...walk("electron"), ...walk("flux-core"), "flux-cli.ts", "flux-mcp.ts"];
  const imported = new Map<string, string>();
  for (const file of shipped) {
    const source = readFileSync(file, "utf8");
    const specs = [
      ...source.matchAll(/^\s*import\s+(?!type\b)[^"'()]*?\bfrom\s*["']([^"']+)["']/gm),
      ...source.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
      ...source.matchAll(/^\s*export\s+(?!type\b)[^"'()]*?\bfrom\s*["']([^"']+)["']/gm),
      ...source.matchAll(/(?:\brequire|\bimport)\(\s*["']([^"']+)["']\s*\)/g),
    ];
    for (const m of specs) {
      const spec = m[1];
      if (/^[./$~#]/.test(spec) || spec.includes(":")) continue; // relative, aliased, or a scheme (node:, virtual:, flux:)
      const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      if (builtin.has(name) || name === "electron") continue;
      if (!imported.has(name)) imported.set(name, file);
    }
  }
  h.ok(imported.size >= 20, `the scan finds the packages that shipped code imports (${imported.size})`);
  // Build-time or test-only tools that a file under these roots names without shipping them.
  const NOT_SHIPPED = new Set(["vite", "puppeteer-core", "typescript", "esbuild", "tsx"]);
  for (const [name, file] of [...imported].sort()) {
    if (NOT_SHIPPED.has(name)) continue;
    h.ok(byName.has(name), `${name} (imported by ${file}) has its section`);
  }

  h.section("the build and the installers");
  h.ok(/node scripts\/build-legal\.mjs/.test(pkg.scripts.build), "npm run build writes build/legal");
  const config = loadYaml(readFileSync("electron-builder.yml", "utf8")) as Record<string, any>;
  const carries = (list: unknown) => Array.isArray(list) && list.some((e) => e?.from === "build/legal" && e?.to === "legal");
  h.ok(carries(config.extraResources), "electron-builder.yml: the top-level extraResources carry build/legal → legal");
  for (const platform of ["mac", "linux", "win"]) {
    if (config[platform]?.extraResources) h.ok(carries(config[platform].extraResources), `electron-builder.yml: ${platform}.extraResources repeat it (a platform block replaces the top-level list)`);
  }
  h.ok(/^build\/legal\/$/m.test(readFileSync(".gitignore", "utf8")), "build/legal is generated, not committed");
} finally {
  rmSync(out, { recursive: true, force: true });
}
await h.done();
