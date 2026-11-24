// The dev server's route to Paper's artifacts (vite.config.ts mounts it with `apply: "serve"`).
// The in-memory bridge (project/memBridge.ts) has no file system and no flux-artifact: protocol,
// so for the dev fixture and the GUI gates its artifact twin asks here and gets what the desktop
// app's main process makes: the SAME lister and the SAME file server (electron/artifactServe.cjs),
// so a page is found, given its policy and its bridge script exactly as in the app. Only the
// address differs: a path on the dev server instead of an origin of its own.
//
//   GET /__flux-dev/artifacts/list            → the listing (roots, artifacts, page URLs)
//   GET /__flux-dev/artifacts/serve/<id>/…    → a file of that root
//   GET /__flux__/bridge.js                   → the bridge script every page asks for by absolute path
//
// Roots: scripts/fixtures/artifacts as the project's folder, and FLUX_DEV_ARTIFACT_DIR (when set)
// as the linked one, to look at a real folder of artifacts in the dev fixture.
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { createArtifactServer, describeRoot, bodyStream, loadRules } = require("../../electron/artifactServe.cjs");

const PREFIX = "/__flux-dev/artifacts/";

export function createArtifactDevRoutes({ projectDir = path.join(repo, "scripts/fixtures/artifacts"), linkedDir = process.env.FLUX_DEV_ARTIFACT_DIR || null, projectRoot = repo } = {}) {
  const server = createArtifactServer();
  async function listing() {
    const roots = [];
    for (const source of [{ dir: projectDir, linked: false }, ...(linkedDir ? [{ dir: path.resolve(linkedDir), linked: true }] : [])]) {
      const described = await describeRoot(server, { ...source, projectRoot, urlBase: (id) => `${PREFIX}serve/${id}` });
      if (described) roots.push({ ...described, watching: false });
    }
    return { roots, linkedDir: linkedDir ? path.resolve(linkedDir) : null, projectDir };
  }
  async function send(req, res, answer) {
    // The page is same-site with the dev app, so the frame is sandboxed into an opaque origin
    // (ArtifactView does that whenever a page's origin is the app's). An opaque origin reads its
    // own files cross-origin, and 'self' in its policy has to be spelled as this server.
    const origin = `http://${req.headers.host}`;
    const headers = { ...answer.headers, "Access-Control-Allow-Origin": "*" };
    if (headers["Content-Security-Policy"]) headers["Content-Security-Policy"] = headers["Content-Security-Policy"].replaceAll("'self'", `'self' ${origin}`);
    res.writeHead(answer.status, headers);
    const stream = req.method === "HEAD" ? null : bodyStream(answer.body);
    if (!stream) return res.end();
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  }
  async function handler(req, res, next) {
    // Every request of the dev server passes here first: one this route cannot even parse
    // ("//?fixture=demo") is someone else's, never a reason to fail.
    let url;
    try { url = new URL(req.url ?? "/", "http://dev"); } catch { return next(); }
    try {
      const { ARTIFACT_BRIDGE_PATH } = await loadRules();
      if (url.pathname === ARTIFACT_BRIDGE_PATH) {
        if (!server.roots.size) await listing();
        const id = server.roots.keys().next().value;
        return void (await send(req, res, await server.respond({ id, pathname: url.pathname, method: req.method })));
      }
      if (!url.pathname.startsWith(PREFIX)) return next();
      if (url.pathname === `${PREFIX}list`) {
        const body = JSON.stringify(await listing());
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        return void res.end(body);
      }
      const m = /^serve\/([a-z0-9]+)(\/.*)?$/.exec(url.pathname.slice(PREFIX.length));
      if (!m) { res.statusCode = 404; return void res.end(); }
      if (!server.rootOf(m[1])) await listing(); // a page reloaded after the dev server restarted
      await send(req, res, await server.respond({ id: m[1], pathname: m[2] || "/", method: req.method, range: req.headers.range ?? null }));
    } catch (error) {
      res.statusCode = 500;
      res.end(String(error?.message ?? error));
    }
  }
  return { handler, listing, server };
}

/** The Vite plugin (dev server only). */
export function artifactDevPlugin() {
  return {
    name: "flux-dev-artifacts",
    apply: "serve",
    configureServer(server) {
      const routes = createArtifactDevRoutes();
      server.middlewares.use((req, res, next) => { void routes.handler(req, res, next); });
    },
  };
}
