// The TIFF conversion child (bundled to electron/generated/tiffWorker.bundle.mjs by scripts/build-tiff-worker.mjs;
// spawned on Electron's own Node by electron/tiffConvert.cjs with ELECTRON_RUN_AS_NODE=1 and UV_THREADPOOL_SIZE=8,
// which must be set when the process STARTS for zstd to compress on eight threads).
//
// Protocol: one JSON object per line on stdin and stdout.
//   in   {id, op: "probe", path, rules?, max?}            out {id, ok: true, result: {probe, proposals, preview}}
//        {id, op: "preview", path, answer, max?}           out {id, ok: true, result: preview}
//        {id, op: "convert", path, answer, out, name?, sourcePath?}
//                                                          out {id, progress: {...}} (at most 10 a second), then {id, ok: true, result}
//        {id, op: "cancel", target}                        (no answer: the target answers {id, ok: false, cancelled: true})
//   failure                                                out {id, ok: false, error, code?, cancelled?}
// stdin's end means the parent is gone: everything is aborted (a converter leaves no staging folder) and the child exits.
import { probeOp, previewOp, convertOp, closeAll } from "../flux-core/tiffWorkerCore.ts";

const jobs = new Map();
const send = (msg) => { process.stdout.write(JSON.stringify(msg) + "\n"); };
const failure = (id, error) => ({ id, ok: false, error: String(error?.message ?? error), ...(error?.code ? { code: String(error.code) } : {}), ...(error?.name === "AbortError" ? { cancelled: true } : {}) });

async function handle(msg) {
  const { id } = msg;
  if (msg.op === "cancel") { jobs.get(msg.target)?.abort(); return; }
  const controller = new AbortController();
  jobs.set(id, controller);
  try {
    const signal = controller.signal;
    let result;
    if (msg.op === "probe") result = await probeOp(msg.path, { rules: msg.rules, max: msg.max, signal });
    else if (msg.op === "preview") result = await previewOp(msg.path, msg.answer, { max: msg.max, signal });
    else if (msg.op === "convert") result = await convertOp(msg.path, msg.answer, msg.out, { name: msg.name, sourcePath: msg.sourcePath, signal, onProgress: (p) => send({ id, progress: p }) });
    else throw new Error(`unknown operation ${JSON.stringify(msg.op)}`);
    if (signal.aborted) throw Object.assign(new Error("cancelled"), { name: "AbortError" });
    send({ id, ok: true, result });
  } catch (error) { send(failure(id, error)); }
  finally { jobs.delete(id); }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let nl; (nl = buffer.indexOf("\n")) >= 0;) {
    const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    void handle(msg);
  }
});
const quit = async () => {
  for (const c of jobs.values()) c.abort();
  // The aborted converters remove their staging folders in their own `finally`; give them the moment it takes.
  const t0 = Date.now();
  while (jobs.size && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 20));
  await closeAll();
  process.exit(0);
};
process.stdin.on("end", quit);
process.on("SIGTERM", quit);
