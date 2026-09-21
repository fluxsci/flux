import { transientHttpStatus, isTransientNetworkError } from "../src/lib/references/httpOutcome";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { reconstructAbstract, batchByDoiUrl } from "../src/lib/references/openalex";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { harness } from "./lib/harness.mjs";
const require = createRequire(import.meta.url);
const { createFileCore } = require("../electron/ipc/files.cjs");
const { createFlushCoordinator } = require("../electron/appLifecycle.cjs");
const { isPrivateAddress, publicHttpUrl, readBoundedBody } = require("../electron/netFetch.cjs");
const h = harness("verify-native-boundaries");
const root = await mkdtemp(path.join(tmpdir(), "flux-native-boundary-"));
try {
  const project = path.join(root, "project"), outside = path.join(root, "outside");
  await mkdir(project); await mkdir(outside);
  await writeFile(path.join(outside, "keep.txt"), "original");
  await symlink(outside, path.join(project, "escape"));
  const core = createFileCore({ app: { getPath: () => project }, roots: () => [project], setPendingRoot() {}, projectRootFor: (id: number) => id === 17 ? project : null });
  const handlers = new Map<string, any>(); core.registerHandlers({ handle: (name: string, fn: any) => handlers.set(name, fn) });
  const e = { sender: { id: 17 } };
  await assert.rejects(() => handlers.get("fs:writeText")(e, path.join(project, "escape", "keep.txt"), "bad"), /refused path/);
  await assert.rejects(() => handlers.get("fs:writeText")(e, path.join(project, "escape", "new.txt"), "bad"), /refused path/);
  h.eq(await readFile(path.join(outside, "keep.txt"), "utf8"), "original", "real handler blocks existing and created symlink escape writes");
  const alias = path.join(root, "alias"); await symlink(project, alias);
  await handlers.get("fs:writeText")(e, path.join(alias, "ok.txt"), "allowed");
  h.eq(await readFile(path.join(project, "ok.txt"), "utf8"), "allowed", "legitimate symlink project resolves to its granted identity");
  h.eq(core.writeOrigin(path.join(alias,"ok.txt")),17,"successful native write owns exactly its file generation");
  await writeFile(path.join(alias,"ok.txt"),"external same-path generation");
  h.eq(core.writeOrigin(path.join(alias,"ok.txt")),undefined,"external write inside self-write TTL cannot inherit renderer origin");
  h.eq(await handlers.get("fs:projectAssetPath")(e, alias, "ok.txt"), path.join(project, "ok.txt"), "stored asset resolver allows canonical project root aliases");
  await assert.rejects(() => handlers.get("fs:projectAssetPath")(e, project, "escape/keep.txt"), /escapes/);
  await assert.rejects(() => handlers.get("fs:projectAssetPath")({sender: {id: 18}}, project, "ok.txt"), /not authorized/);
  await assert.rejects(() => handlers.get("fs:projectAssetPath")(e, project, "../outside/keep.txt"), /Invalid/);
  h.ok(true, "stored assets deny symlink escape, lexical traversal and foreign window root");
  const { wrapIpcMain } = require("../electron/ipc/contract.cjs");
  const wrappedHandlers = new Map<string, any>();
  const contract = wrapIpcMain({handle: (ch: string, fn: any) => wrappedHandlers.set(ch, fn)}, {validateSender: (event: any) => event.sender.id === 17});
  contract.handle("fs:exists", () => true);
  assert.throws(() => wrappedHandlers.get("fs:exists")({sender: {id: 18}}, "file"), /trusted/);
  assert.throws(() => wrappedHandlers.get("fs:exists")(e, {bad: Infinity}), /non-finite/);
  const cycle: any = {}; cycle.self = cycle;
  assert.throws(() => wrappedHandlers.get("fs:exists")(e, cycle), /cycles/);
  h.ok(wrappedHandlers.get("fs:exists")(e, "ordinary path"), "IPC contract enforces trusted session and bounded valid payload before handler");
  await mkdir(path.join(project, "not-a-file")); await writeFile(path.join(project, "not-a-file", "keep"), "x");
  await assert.rejects(() => handlers.get("fs:remove")(e, path.join(project, "not-a-file")));
  await assert.rejects(() => handlers.get("fs:trash")(e, path.join(project, "not-a-file")));
  h.ok(true, "failed remove and trash fallback reject instead of claiming completion");
  for (const ip of ["::ffff:7f00:1", "0:0:0:0:0:ffff:7f00:1", "::ffff:127.0.0.1", "::ffff:c0a8:101", "0:0:0:0:0:0:0:1"]) h.ok(isPrivateAddress(ip), `private normalized address blocked: ${ip}`);
  h.eq(publicHttpUrl("http://[::ffff:127.0.0.1]/"), null, "URL-normalized mapped address blocked before transport");
  await assert.rejects(() => readBoundedBody(new Response("12345"), 4), /too large/);
  h.eq((await readBoundedBody(new Response("1234"), 4)).toString(), "1234", "body cap applies while streaming and retains exact limit bytes");
  h.eq(publicHttpUrl("https://user:secret@public.example/paper"), null, "paper URLs cannot carry credentials");
  const dns = require("node:dns"), http = require("node:http");
  const { publicLookup, publicFetch } = require("../electron/publicFetch.cjs");
  const savedLookup = dns.lookup, savedRequest = http.request;
  try {
    dns.lookup = (_host: string, _options: any, cb: any) => cb(null, [{address: "127.0.0.1", family: 4}]);
    await assert.rejects(() => new Promise((resolve, reject) => publicLookup("mixed.invalid", {}, (err: Error, value: any) => err ? reject(err) : resolve(value))), /blocked/);
    dns.lookup = (_host: string, _options: any, cb: any) => cb(null, [{address: "93.184.216.34", family: 4}]);
    let connectedAddress: string | undefined;
    http.request = (url: URL, options: any, callback: any) => {
      const req: any = new EventEmitter(); req.end = () => options.lookup(url.hostname, {}, (error: Error, address: string) => {
        if (error) { req.emit("error", error); return; }
        connectedAddress = address;
        const message: any = new PassThrough(); message.statusCode = 200; message.statusMessage = "OK"; message.headers = {"content-type": "text/plain"};
        callback(message); message.end("verified response");
      }); req.write = () => {}; return req;
    };
    h.eq(await (await publicFetch("http://publisher.invalid/paper")).text(), "verified response", "Node transport uses the vetted resolver in its connection options");
    h.eq(connectedAddress, "93.184.216.34", "connection receives the exact validated public address");
  } finally { dns.lookup = savedLookup; http.request = savedRequest; }
  assert.throws(() => reconstructAbstract({text: [2 ** 32 - 2]}), /position/);
  assert.throws(() => reconstructAbstract({text: [1.5]}), /position/);
  assert.throws(() => batchByDoiUrl(["10.1234/test"], {perPage: 0}), /chunk size/);
  h.eq(reconstructAbstract({scientific: [0], context: [1]}), "scientific context", "bounded metadata positions preserve ordinary abstracts and reject sparse allocation bombs");
  const {retryAfterMs} = require("../electron/publicFetch.cjs");
  h.eq([retryAfterMs("999999"),retryAfterMs("-1"),retryAfterMs("invalid"),retryAfterMs("2")],[30000,0,0,2000],"server Retry-After is honored with a bounded delay and invalid header rejection");
  h.ok([401,403,408,425,429,500,503].every(transientHttpStatus) && !transientHttpStatus(404) && !transientHttpStatus(410),"only definitive absence enters durable OA/capture miss state");
  h.ok(isTransientNetworkError("timeout") && isTransientNetworkError("HTTP 403") && !isTransientNetworkError("HTTP 404"),"auth/environment and transport failures remain retryable across twins");
  const nativeFs = require("node:fs"), originalRename = nativeFs.promises.rename;
  const secret = path.join(project,"credentials.json"); await writeFile(secret,"prior-secret");
  let temporaryMode = 0;
  try {
    nativeFs.promises.rename = async (from:string,to:string) => {
      if (to === secret) { temporaryMode = (await nativeFs.promises.stat(from)).mode & 0o777; throw Object.assign(new Error("injected disk fault"),{code:"EIO"}); }
      return originalRename(from,to);
    };
    await assert.rejects(()=>core.atomicWriteMain(secret,"new-secret",false,0o600),/injected/);
  } finally { nativeFs.promises.rename = originalRename; }
  h.eq(temporaryMode,0o600,"secret temporary file is owner-only before publication");
  h.eq(await readFile(secret,"utf8"),"prior-secret","failed atomic secret publication retains exact previous bytes");
  h.ok(!(await nativeFs.promises.readdir(project)).some((name:string)=>name.startsWith('.credentials.json.tmp-')),"failed publication removes its exclusive temporary file");
  const coord = createFlushCoordinator({ timeoutMs: 15 }); let sent: any; let result: any;
  const win = { isDestroyed: () => false, webContents: { id: 7, isDestroyed: () => false, send: (_: string, value: any) => { sent = value; } } };
  coord.request(win, (r: any) => { result = r; });
  h.eq(coord.ack(8, { requestId: sent.requestId, status: "saved" }), false, "another renderer cannot acknowledge this save");
  coord.ack(7, { requestId: sent.requestId, status: "blocked", reason: "EACCES" });
  h.eq(result.status, "blocked", "save failure remains blocked");
  result = null;
  await new Promise<void>(resolve => coord.request(win, (r: any) => { result = r; resolve(); }));
  h.ok(result.status === "blocked" && result.timedOut, "hung renderer timeout never becomes saved");
  coord.request(win, (r: any) => { result = r; }); coord.ack(7, { requestId: sent.requestId, status: "saved" });
  h.eq(result.status, "saved", "correct renderer successful persistence releases close");
} finally { await rm(root, { recursive: true, force: true }); }
h.done();
