// ---------------------------------------------------------------------------
// Flux Slide — the portable export (§7). Pure Node string-building (headless, no
// browser): esbuild-bundle the export runtime → one IIFE, inline the deck + all
// assets + fonts + KaTeX CSS, and emit a SINGLE self-contained `.html` that
// presents offline on any modern browser (the "flash-drive file", D8).
// ---------------------------------------------------------------------------

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import type { ExportPayload } from "./runtime";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const runtimeEntry = path.join(here, "runtime.ts");

// W13: the three deck-independent assets below (the runtime IIFE, the Gelasio
// @font-face CSS, and the inlined KaTeX CSS) used to be computed on every export
// — the runtime via esbuild-at-export-time, the fonts/KaTeX by reading `src/` and
// `node_modules/`. None of those exist in a packaged app (node_modules is dropped,
// `src/` is excluded, esbuild's native binary isn't shipped), so packaged slide
// export was broken outright. They're all static, so we now PREBAKE them at build
// time (scripts/gen-export-assets.ts → dist/slide-export-assets.json) and load the
// sidecar at export time. `computeExportAssets()` is the build-time producer; the
// fresh-compute path is still the dev fallback when no sidecar is present.

export interface ExportAssets {
  runtime: string;
  gelasio: string;
  /** Repo-relative source files the runtime bundle was built from (staleness guard). */
  sources?: string[];
  /** sha256 over the sorted (path, content) pairs of `sources` at bake time. */
  sourcesHash?: string;
  generatedAt?: string;
}

/** Bundle the export runtime (player + render + morph + presets + motion + KaTeX)
 *  into a single minified IIFE exposing `FluxSlideRuntime`. esbuild is imported
 *  dynamically so it stays out of the shipped CLI bundle (dev-only path). */
async function computeRuntime(): Promise<{ text: string; sources: string[] }> {
  const { build } = await import("esbuild");
  const out = await build({
    entryPoints: [runtimeEntry],
    bundle: true,
    format: "iife",
    globalName: "FluxSlideRuntime",
    platform: "browser",
    target: "es2020",
    minify: true,
    write: false,
    legalComments: "none",
    metafile: true,
  });
  const sources = Object.keys(out.metafile?.inputs ?? {})
    .map((p) => path.relative(repoRoot, path.resolve(p)))
    .filter((p) => !p.startsWith(".."))
    .sort();
  return { text: out.outputFiles[0].text, sources };
}

/** sha256 over the sorted (repo-relative path, content) pairs. */
async function hashSources(rels: string[]): Promise<string> {
  const h = createHash("sha256");
  for (const rel of [...rels].sort()) {
    h.update(rel);
    h.update("\0");
    h.update(await readFile(path.join(repoRoot, rel)));
    h.update("\0");
  }
  return h.digest("hex");
}

const b64 = (buf: Buffer) => buf.toString("base64");

async function computeGelasio(): Promise<string> {
  const faces: string[] = [];
  const fonts = [
    { file: "Gelasio.woff2", style: "normal" },
    { file: "Gelasio-italic.woff2", style: "italic" },
  ];
  for (const f of fonts) {
    try {
      const data = b64(await readFile(path.join(repoRoot, "src/styles/fonts", f.file)));
      faces.push(
        `@font-face{font-family:"Gelasio";font-style:${f.style};font-weight:400 700;font-display:swap;` +
          `src:url(data:font/woff2;base64,${data}) format("woff2")}`,
      );
    } catch {
      /* font missing — Georgia fallback still renders */
    }
  }
  return faces.join("\n");
}

/** Build-time producer: compute every deck-independent asset from source.
 *  Called by scripts/gen-export-assets.ts to write the shipped sidecar.
 *  (KaTeX inlining left with the math element — slide text is the figure
 *  text element now; a future math element re-adds its CSS here.) */
export async function computeExportAssets(): Promise<ExportAssets> {
  const [rt, gelasio] = await Promise.all([computeRuntime(), computeGelasio()]);
  let sourcesHash = "";
  try { sourcesHash = await hashSources(rt.sources); } catch { /* best-effort */ }
  return {
    runtime: rt.text, gelasio,
    sources: rt.sources, sourcesHash, generatedAt: new Date().toISOString(),
  };
}

/** Candidate locations for the prebuilt sidecar, most-specific first:
 *  0. an explicit `FLUX_EXPORT_SIDECAR` override (test seam — lets a hermetic gate
 *     point at its own temp sidecar instead of the shared `dist/` artifact),
 *  1. next to this module (packaged: the CLI bundle + sidecar are unpacked siblings),
 *  2. repoRoot/dist (dev, after `npm run build`). */
function sidecarCandidates(): string[] {
  const override = process.env.FLUX_EXPORT_SIDECAR;
  return [
    ...(override ? [override] : []),
    path.join(here, "slide-export-assets.json"),
    path.join(repoRoot, "dist", "slide-export-assets.json"),
  ];
}

/** Dev-only staleness guard: a sidecar baked from OLD player sources would ship
 *  an old runtime in every export (preview ≠ export). If the runtime entry exists
 *  on disk (dev checkout), re-hash the sidecar's recorded sources and compare; a
 *  vanished listed source (rename) also counts as stale. In a packaged app the
 *  sources are absent → the sidecar is authoritative (never stale). */
async function sidecarStale(a: ExportAssets): Promise<boolean> {
  if (!a.sources?.length || !a.sourcesHash) return false; // pre-guard sidecar: trust it
  try { await readFile(runtimeEntry); } catch { return false; } // no src/ → packaged
  try {
    return (await hashSources(a.sources)) !== a.sourcesHash;
  } catch {
    return true; // dev, but a recorded source is gone → the bundle can't match
  }
}

let _assets: ExportAssets | null = null;
/** Export-time consumer: prefer the prebuilt sidecar (required in a packaged app,
 *  present in dev after a build); fall back to computing fresh (dev without build,
 *  or a stale sidecar). Cached per process. */
async function loadExportAssets(): Promise<ExportAssets> {
  if (_assets) return _assets;
  for (const p of sidecarCandidates()) {
    try {
      const parsed = JSON.parse(await readFile(p, "utf8")) as ExportAssets;
      if (!parsed?.runtime) continue;
      if (await sidecarStale(parsed)) {
        console.warn(`[flux-slide] stale ${p} — player sources changed since it was baked; recomputing fresh (run \`npm run build\` to refresh it).`);
        continue;
      }
      _assets = parsed;
      return _assets;
    } catch {
      /* try the next candidate */
    }
  }
  _assets = await computeExportAssets();
  return _assets;
}

export interface ExportResult {
  html: string;
  bytes: number;
  warnings: string[];
}

/** Build the self-contained HTML from a fully-gathered payload (deck + inlined
 *  plots/figures/assets). `warnThreshold` (bytes) flags video-heavy decks (§7.2). */
export async function exportDeckHtml(payload: ExportPayload, opts: { warnThreshold?: number } = {}): Promise<ExportResult> {
  const assets = await loadExportAssets();
  const runtime = assets.runtime;
  const gelasio = assets.gelasio;
  const warnings: string[] = [];

  // JSON for a <script type=application/json>: only `<` needs neutralizing.
  const json = JSON.stringify(payload).replace(/</g, "\\u003c");
  const title = (payload.deck.title || "Flux Slides").replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"));

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;background:#000;overflow:hidden}
#flux-stage{position:fixed;inset:0}
.sl-el{position:absolute}
${gelasio}
</style>
</head>
<body>
<div id="flux-stage"></div>
<script type="application/json" id="flux-payload">${json}</script>
<script>${runtime}</script>
<script>
(function(){
  var p = JSON.parse(document.getElementById("flux-payload").textContent);
  FluxSlideRuntime.boot(document.getElementById("flux-stage"), p);
})();
</script>
</body>
</html>
`;

  const bytes = Buffer.byteLength(html, "utf8");
  const threshold = opts.warnThreshold ?? 25 * 1024 * 1024;
  if (bytes > threshold) warnings.push(`Exported file is ${(bytes / 1048576).toFixed(1)} MB (> ${(threshold / 1048576).toFixed(0)} MB) — consider a folder export for video-heavy decks.`);
  return { html, bytes, warnings };
}
