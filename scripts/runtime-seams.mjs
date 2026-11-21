// The exported runtimes' build seams (stage 2, review B5). Shared by every builder of a document runtime
// (src/lib/slide/export/exportDeck.ts computeExportAssets, scripts/gen-slide-embed-assets.mjs) so they cannot drift.
//
// A document runtime is two IIFEs: the BASE (eager deck, video capture or Paper embed: the slide engine) and, only in a
// document whose payload holds an image, the IMAGE runtime (`FluxImageRuntime`, export/fluximgRuntime.ts: the image kit).
//   - The base reaches image code only through `slide/imageSeam.ts`, whose kit source (`slide/imageKitSource.ts`, a
//     static import in the app and Node) is swapped here for its runtime twin, which asks the image runtime. A base
//     bundle that still holds image code fails the build (`assertNoImageCode`).
//   - The image kit's modules call a few engine functions (a step's end state, a preset's parameter, the media fold...).
//     They are not bundled twice: the image runtime takes them from the base it runs beside. Its imports of engine
//     modules resolve to `globalThis.FluxSlideBase[<module>]`, which the base fills from the same list
//     (`imageHostNeeds`, read from the kit's own import lines at build time, so a new import needs no list edited).
//   - The image runtime is wrapped as a FACTORY (`imageRuntimeText`) the base calls once, on first use: it evaluates
//     after the base has published `FluxSlideBase`, whatever the order of the two scripts in the document.
import path from "node:path";
import { readFileSync } from "node:fs";

const KIT_SOURCE = /[\\/]slide[\\/]imageKitSource(\.ts)?$/;
const HOST_BASE = "flux:image-host-base";
export const IMAGE_RUNTIME_ENTRY = "src/lib/slide/export/fluximgRuntime.ts";

/** Image modules: the kit and everything only it reaches. */
export const isImageModule = (p) => !p.includes("node_modules") && (/(^|[\\/])src[\\/]lib[\\/]fluximg[\\/]/.test(p)
  || /[\\/]slide[\\/]player[\\/]fluximg(Media)?\.ts$/.test(p) || /[\\/]slide[\\/]export[\\/]fluximg(PayloadHost|Runtime)\.ts$/.test(p));
/** Image modules a base runtime may keep: constants only (`policy.ts`: the refusal texts compile.ts reports). */
export const BASE_IMAGE_ALLOWED = new Set(["src/lib/fluximg/policy.ts"]);

/** Pure engine helpers ONLY the image kit calls: bundled into the image runtime instead of published by every base (a
 *  deck without images would otherwise carry them). Stateless functions and constants only. */
export const IMAGE_ONLY_ENGINE = new Map([
  ["src/lib/slide/keyMatch.ts", new Set(["keyText", "sameKey"])],
]);
const imageOnly = (key, name) => IMAGE_ONLY_ENGINE.get(key)?.has(name) === true;
/** The names the base publishes (`FluxSlideBase`): every engine name the kit imports but the image-only helpers. */
const published = (needs) => [...needs].map(([key, names]) => [key, [...names].filter((n) => !imageOnly(key, n))]).filter(([, names]) => names.length);
/** `FluxSlideBase`'s key for a module: its path under src/lib, without extension. */
const shortKey = (key) => key.replace(/^src\/lib\//, "").replace(/\.[cm]?[jt]s$/, "");

const rel = (root, p) => path.relative(root, path.resolve(root, p)).split(path.sep).join("/");
const isEngineModule = (root, p) => { const r = rel(root, p); return r.startsWith("src/") && !r.includes("node_modules") && !isImageModule(r); };

/** The value names `importer` imports from `spec` (`import { a, b as c }` / `export { a } from`; never `type` ones). */
function importedNames(importer, spec) {
  const text = readFileSync(importer, "utf8"), names = new Set();
  const esc = spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(String.raw`(import|export)\s+(type\s+)?(\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s*["']${esc}["']`, "g");
  for (const m of text.matchAll(re)) {
    if (m[2]) continue;
    if (!m[3].startsWith("{")) throw new Error(`${importer}: \`${m[0]}\`: the image kit may import engine modules only by name (import { a } from "${spec}").`);
    for (const part of m[3].slice(1, -1).split(",")) {
      const item = part.trim();
      if (!item || item.startsWith("type ")) continue;
      names.add(item.split(/\s+as\s+/)[0].trim());
    }
  }
  return names;
}

/** Which engine modules the image kit imports, and which names of each: `Map<repo-relative path, Set<name>>`. */
export async function imageHostNeeds(esbuild, root) {
  const needs = new Map();
  await esbuild.build({
    absWorkingDir: root, entryPoints: [IMAGE_RUNTIME_ENTRY], bundle: true, write: false, format: "esm", platform: "browser", logLevel: "silent",
    external: ["*/colormapLuts.gen"],
    plugins: [{ name: "flux-image-host-needs", setup(build) {
      build.onResolve({ filter: /^\./ }, async (args) => {
        if (!args.importer || !isImageModule(args.importer) || args.pluginData?.inner) return undefined;
        const r = await build.resolve(args.path, { resolveDir: args.resolveDir, kind: args.kind, importer: args.importer, pluginData: { inner: true } });
        if (r.errors.length || !isEngineModule(root, r.path)) return undefined;
        const key = rel(root, r.path), set = needs.get(key) ?? new Set();
        for (const n of importedNames(args.importer, args.path)) set.add(n);
        needs.set(key, set);
        return { path: r.path, external: true };
      });
    } }],
  });
  return new Map([...needs].sort(([a], [b]) => a.localeCompare(b)));
}

/** The base runtimes' seams: the kit source swapped for its runtime twin, which publishes `FluxSlideBase`. */
export function baseRuntimeSeams(needs) {
  return {
    name: "flux-base-runtime-seams",
    setup(build) {
      build.onResolve({ filter: /imageKitSource$/ }, (args) => {
        const resolved = path.resolve(args.resolveDir, args.path);
        if (!KIT_SOURCE.test(resolved)) return undefined;
        return { path: `${resolved.replace(/\.ts$/, "")}.runtime.ts` };
      });
      build.onResolve({ filter: new RegExp(`^${HOST_BASE}$`) }, () => ({ path: HOST_BASE, namespace: "flux-seam" }));
      build.onLoad({ filter: /.*/, namespace: "flux-seam" }, () => {
        const root = build.initialOptions.absWorkingDir;
        const lines = [], entries = [];
        published(needs).forEach(([key, names], i) => {
          lines.push(`import { ${names.map((n) => `${n} as m${i}_${n}`).join(", ")} } from ${JSON.stringify(path.join(root, key))};`);
          entries.push(`${JSON.stringify(shortKey(key))}: { ${names.map((n) => `${n}: m${i}_${n}`).join(", ")} }`);
        });
        return { contents: `${lines.join("\n")}\nglobalThis.FluxSlideBase = { ${entries.join(", ")} };\n`, loader: "js", resolveDir: root };
      });
    },
  };
}

/** The image runtime's seam: its imports of engine modules read the base's `FluxSlideBase` (no second copy). */
export function imageRuntimeSeams(needs) {
  return {
    name: "flux-image-runtime-seams",
    setup(build) {
      const root = build.initialOptions.absWorkingDir;
      build.onResolve({ filter: /^\./ }, async (args) => {
        if (!args.importer || !isImageModule(args.importer) || args.pluginData?.inner) return undefined;
        const r = await build.resolve(args.path, { resolveDir: args.resolveDir, kind: args.kind, importer: args.importer, pluginData: { inner: true } });
        if (r.errors.length || !isEngineModule(root, r.path)) return undefined;
        const key = rel(root, r.path);
        for (const n of importedNames(args.importer, args.path)) if (!needs.get(key)?.has(n)) throw new Error(`image runtime: ${key} → ${n} is not in the base's FluxSlideBase (rebuild every runtime together)`);
        return { path: key, namespace: "flux-host" };
      });
      build.onLoad({ filter: /.*/, namespace: "flux-host" }, (args) => {
        const names = [...(needs.get(args.path) ?? [])], own = names.filter((n) => imageOnly(args.path, n)), base = names.filter((n) => !imageOnly(args.path, n));
        const lines = [
          ...(own.length ? [`export { ${own.join(", ")} } from ${JSON.stringify(path.join(root, args.path))};`] : []),
          ...(base.length ? [`const B = globalThis.FluxSlideBase[${JSON.stringify(shortKey(args.path))}];`, ...base.map((n) => `export const ${n} = B.${n};`)] : []),
        ];
        return { contents: `${lines.join("\n")}\n`, loader: "js", resolveDir: root };
      });
    },
  };
}

/** The image runtime's script text: a factory the base calls once (`export/imageRuntime.ts`), so the kit evaluates
 *  after the base published `FluxSlideBase` whatever the order of the scripts. `iife` defines `var FluxImageRuntime`. */
export const imageRuntimeText = (iife) => `var FluxImageRuntimeFactory=function(){${iife};return FluxImageRuntime};`;

/** Throw when a base runtime's metafile holds image code beyond the allowed constants. */
export function assertNoImageCode(metafile, label, root) {
  const out = Object.values(metafile.outputs)[0];
  const bad = Object.entries(out.inputs)
    .filter(([p, v]) => v.bytesInOutput > 0 && isImageModule(p) && !BASE_IMAGE_ALLOWED.has(rel(root, p)))
    .map(([p, v]) => `${p} (${v.bytesInOutput} B)`);
  if (bad.length) throw new Error(`${label} runtime holds image code (import it through src/lib/slide/imageSeam.ts): ${bad.join(", ")}`);
}

/** Throw when the image runtime bundles an engine module (it must take it from the base). */
export function assertNoEngineCode(metafile, root) {
  const out = Object.values(metafile.outputs)[0];
  const bad = Object.entries(out.inputs).filter(([p, v]) => v.bytesInOutput > 0 && isEngineModule(root, p) && !IMAGE_ONLY_ENGINE.has(rel(root, p))).map(([p, v]) => `${p} (${v.bytesInOutput} B)`);
  if (bad.length) throw new Error(`image runtime bundles engine code it should take from the base: ${bad.join(", ")}`);
}
