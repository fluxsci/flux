// Pure-tier shim: paper editor modules import Vite-style CSS (katex.min.css),
// which Node's ESM loader rejects. A RESOLVE hook rewrites any .css specifier
// to an empty data: module — no load hook, so CommonJS deps (markdown-it etc.)
// flow through Node's default loader untouched (a load hook would trip source
// validation on their `source: undefined`).
// IMPORTANT: static sibling imports load before any module EXECUTES — import
// this first and load the modules under test with dynamic import().
import { registerHooks } from "node:module";

const ASSET_RE = /\.(css|woff2?|ttf|otf|eot)$/;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (ASSET_RE.test(specifier.split("?")[0]))
      // Default-export a STRING: ?raw / ?inline importers feed these straight
      // into string ops (katexAssets inlineFonts replaceAll).
      return { url: 'data:text/javascript,export%20default%20""', shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
