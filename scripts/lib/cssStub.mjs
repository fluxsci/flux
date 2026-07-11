// Pure-tier shim: paper editor modules import Vite-style CSS (katex.min.css),
// which Node's ESM loader rejects. Registering a load hook that stubs .css as
// an empty module lets hermetic tests import those modules directly.
// IMPORTANT: static sibling imports load before any module EXECUTES — import
// this first and load the modules under test with dynamic import().
import { registerHooks } from "node:module";

registerHooks({
  load(url, context, nextLoad) {
    if (url.split("?")[0].endsWith(".css"))
      return { format: "module", source: "export default {}", shortCircuit: true };
    return nextLoad(url, context);
  },
});
