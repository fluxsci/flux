// WS4 — the live agent context bridge (loopback control server).
//
// When a project is open, the main process serves a tiny HTTP+SSE API bound to
// 127.0.0.1 on an ephemeral port, gated by a per-session bearer token written to
// `<root>/.meta/live/bridge.json` (so only a process that can already read the
// project can authenticate). An external agent (the Flux MCP server) reads that
// file and can:
//   GET  /context  → the live UI state the human is looking at (selection, active
//                    figure, viewport, drilled-in plot part, active document…)
//   GET  /events   → an SSE stream of those context snapshots
//   POST /dispatch → an allow-listed command, applied as the SAME undoable edit a
//                    human would make (routed to the renderer, which calls commit(ops))
//
// The renderer pushes context up (cached here) and answers dispatch requests; this
// module owns only transport + auth, never app logic.

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

/**
 * @param {object} o
 * @param {string} o.root                 open project root
 * @param {() => any} o.getContext        latest cached AppContext (sync)
 * @param {(cmd:any) => Promise<any>} o.dispatch   apply a command in the renderer
 * @param {(p:string)=>void} [o.noteWrite] mark a path as a self-write
 * @returns {{ stop: () => void, pushContext: (ctx:any) => void }}
 */
function startBridge({ root, getContext, dispatch, noteWrite }) {
  const token = crypto.randomBytes(24).toString("hex");
  const sse = new Set();

  const authed = (req) => (req.headers["authorization"] || "") === `Bearer ${token}`;
  const json = (res, code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  const server = http.createServer((req, res) => {
    if (!authed(req)) return json(res, 401, { error: "unauthorized" });
    const url = (req.url || "").split("?")[0];

    if (req.method === "GET" && url === "/context") {
      return json(res, 200, getContext() || {});
    }
    if (req.method === "GET" && url === "/health") {
      return json(res, 200, { ok: true, hasContext: !!getContext() });
    }
    if (req.method === "GET" && url === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify(getContext() || {})}\n\n`);
      sse.add(res);
      req.on("close", () => sse.delete(res));
      return;
    }
    if (req.method === "POST" && url === "/dispatch") {
      let body = "";
      req.on("data", (d) => {
        body += d;
        if (body.length > 1_000_000) req.destroy(); // loopback, but cap anyway
      });
      req.on("end", async () => {
        let cmd;
        try {
          cmd = JSON.parse(body || "{}");
        } catch {
          return json(res, 400, { ok: false, error: "invalid JSON" });
        }
        try {
          const result = await dispatch(cmd);
          json(res, 200, { ok: true, result });
        } catch (e) {
          json(res, 400, { ok: false, error: String((e && e.message) || e) });
        }
      });
      return;
    }
    json(res, 404, { error: "not found" });
  });

  const file = path.join(root, ".meta", "live", "bridge.json");
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    try {
      // W12 (SHL-8): bridge.json carries the bearer token in plaintext — write it
      // owner-only (0600) inside an owner-only dir (0700), matching the proxy creds.
      // chmod after the write too: writeFileSync's mode only applies on CREATE, so a
      // pre-existing (looser) file from a prior run would otherwise keep its old perms.
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      if (noteWrite) noteWrite(file);
      fs.writeFileSync(
        file,
        JSON.stringify(
          { url: `http://127.0.0.1:${port}`, port, token, pid: process.pid, started: new Date().toISOString() },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        /* best-effort on platforms without POSIX perms */
      }
    } catch (e) {
      console.warn("[flux] bridge: could not write bridge.json:", e && e.message);
    }
  });

  const pushContext = (ctx) => {
    const data = `data: ${JSON.stringify(ctx)}\n\n`;
    for (const res of sse) {
      try {
        res.write(data);
      } catch {
        sse.delete(res);
      }
    }
  };

  const stop = () => {
    for (const res of sse) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    sse.clear();
    try {
      server.close();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* ignore */
    }
  };

  return { stop, pushContext };
}

module.exports = { startBridge };
