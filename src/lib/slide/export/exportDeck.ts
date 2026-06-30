// ---------------------------------------------------------------------------
// Flux Slide — the portable export (§7). Pure Node string-building (headless, no
// browser): esbuild-bundle the export runtime → one IIFE, inline the deck + all
// assets + fonts + KaTeX CSS, and emit a SINGLE self-contained `.html` that
// presents offline on any modern browser (the "flash-drive file", D8).
// ---------------------------------------------------------------------------

import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import type { ExportPayload } from "./runtime";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const runtimeEntry = path.join(here, "runtime.ts");

let _runtime: string | null = null;
/** Bundle the export runtime (player + render + morph + presets + motion + KaTeX)
 *  into a single minified IIFE exposing `FluxSlideRuntime`. Cached per process. */
export async function bundleRuntime(): Promise<string> {
  if (_runtime) return _runtime;
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
  });
  _runtime = out.outputFiles[0].text;
  return _runtime;
}

const b64 = (buf: Buffer) => buf.toString("base64");

async function gelasioFontFaces(): Promise<string> {
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

/** Read KaTeX's CSS and inline its woff2 fonts as data URIs (drop woff/ttf src
 *  entries) so equations render offline. */
async function katexCssInlined(): Promise<string> {
  const distDir = path.join(repoRoot, "node_modules/katex/dist");
  let css = await readFile(path.join(distDir, "katex.min.css"), "utf8");
  const woff2 = [...css.matchAll(/url\(fonts\/([\w-]+\.woff2)\)/g)].map((m) => m[1]);
  for (const name of new Set(woff2)) {
    try {
      const data = b64(await readFile(path.join(distDir, "fonts", name)));
      css = css.replaceAll(`url(fonts/${name})`, `url(data:font/woff2;base64,${data})`);
    } catch {
      /* skip a missing variant */
    }
  }
  // strip the now-broken woff/ttf alternates (offline they'd 404)
  css = css.replace(/,url\(fonts\/[\w-]+\.(?:woff|ttf)\)\s*format\("[^"]+"\)/g, "");
  return css;
}

export interface ExportResult {
  html: string;
  bytes: number;
  warnings: string[];
}

/** Build the self-contained HTML from a fully-gathered payload (deck + inlined
 *  plots/figures/assets). `warnThreshold` (bytes) flags video-heavy decks (§7.2). */
export async function exportDeckHtml(payload: ExportPayload, opts: { warnThreshold?: number } = {}): Promise<ExportResult> {
  const [runtime, gelasio, katexCss] = await Promise.all([bundleRuntime(), gelasioFontFaces(), katexCssInlined()]);
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
${katexCss}
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
