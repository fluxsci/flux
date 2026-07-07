// W13 build step, extended for the agent surface: bundle BOTH headless entry
// points into self-contained ESM bundles in dist/:
//   • flux-cli.ts → dist/flux-cli.mjs — packaged slide export (SHL-1) spawns this,
//     and it's the real `flux` binary for agents (AGT-9; no tsx cold start, no
//     repo-clone dependency);
//   • flux-mcp.ts → dist/flux-mcp.mjs — the packaged app's agent:mcpSpec points
//     `claude` at this (app.asar.unpacked/dist/, ELECTRON_RUN_AS_NODE); without it
//     the Reader's "Ask Claude" cannot register the flux MCP server in any
//     packaged build.
// One shared externals list so the two bundles can never drift.
//
// esbuild itself is marked external: the only code path that imports it is the
// dev-only fresh-compute fallback in exportDeck.ts, which never runs in a packaged
// app (the prebaked dist/slide-export-assets.json is loaded instead).
//
// Run as part of `npm run build` (after `vite build`, so dist/ exists).

import { build } from "esbuild";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const EXTERNAL = [
  // Dev-only fresh-compute fallback in exportDeck.ts; never reached packaged.
  "esbuild",
  // Native module (.node), lazily imported only by the render-figure-PNG verb
  // (flux-core/index.ts). Can't be bundled; not on the slide-export path.
  "@resvg/resvg-js",
  // pdf.js legacy build runs `new DOMMatrix()` at module load (needs a native
  // canvas polyfill) — bundling it would crash at load for every verb. Lazily
  // imported in flux-core/fulltext.ts, so it stays out of the load path.
  "pdfjs-dist",
  "pdfjs-dist/legacy/build/pdf.mjs",
];

// CJS interop shims some bundled deps (require/__dirname/__filename) expect
// under ESM output. The shebang is fixed up after each build (below): esbuild
// preserves the entry file's own `#!/usr/bin/env -S npx tsx`, which we replace
// with a plain-node shebang so the bundle runs standalone.
const BANNER = [
  "import { createRequire as __cr } from 'node:module';",
  "import { fileURLToPath as __f2p } from 'node:url';",
  "import { dirname as __dn } from 'node:path';",
  "const require = __cr(import.meta.url);",
  "const __filename = __f2p(import.meta.url);",
  "const __dirname = __dn(__filename);",
].join("\n");

for (const entry of ["flux-cli.ts", "flux-mcp.ts"]) {
  const outfile = path.join(repoRoot, "dist", entry.replace(/\.ts$/, ".mjs"));
  await build({
    entryPoints: [path.join(repoRoot, entry)],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile,
    external: EXTERNAL,
    banner: { js: BANNER },
    legalComments: "none",
    logLevel: "warning",
  });

  // Normalize the shebang to line 1 (Node only strips a shebang on line 1).
  let src = await readFile(outfile, "utf8");
  src = src.replace(/^#![^\n]*\n/, "");
  await writeFile(outfile, `#!/usr/bin/env node\n${src}`);
  await chmod(outfile, 0o755);
  console.log(`✓ ${path.relative(repoRoot, outfile)} (${(statSync(outfile).size / 1024 / 1024).toFixed(1)} MB)`);
}
