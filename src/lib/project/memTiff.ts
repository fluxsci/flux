// The in-memory bridge's twin of Electron's tiff:* family (electron/ipc/tiff.cjs): the same requests, the same checks
// and the same words (electron/fluximgRules.js), so the dev fixture and the GUI gates refuse what the desktop app
// refuses. The conversion itself is REAL: the bytes go to the dev server's Node route (scripts/lib/tiffDevRoutes.mjs,
// mounted by vite.config.ts), which runs the same supervised child the desktop app runs; the bundle's files come
// back and are written into this fixture's fig/assets, and their content id must equal the child's.
// Dev only (memBridge is loaded behind import.meta.env.DEV).
import * as fxr from "../../../electron/fluximgRules.js";
import type { TiffConvertRequest, TiffConvertResult, TiffPreviewPng, TiffPreviewRequest, TiffProbeRequest, TiffProbeResult, TiffProgress } from "../tiff/bridge";
import type { FluximgManifest } from "../fluximg/types";

export interface MemFs {
  files: Map<string, Uint8Array>;
  isDir(p: string): boolean;
  addDir(p: string): void;
  ensureParent(p: string): void;
  /** The open project ("undefined": none watched yet) and its generation (a reopen bumps it). */
  watched(): { root: string | null | undefined; generation: number };
  norm(p: string): string;
  resolve(p: string): string | null;
  sha256(bytes: Uint8Array): Promise<string>;
  /** A file's modification time (ms): the converter records it in the bundle's provenance, as on disk. */
  mtime(p: string): number;
}

interface Token { handle: string; root: string; label: string; record: string; inside: boolean }

const b64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function createMemTiff(fs: MemFs) {
  let base = "";
  const tokens = new Map<string, Token>();
  const listeners = new Set<(p: TiffProgress) => void>();
  const jobs = new Map<string, { abort: AbortController; cancelled: boolean; started: boolean; release?: () => void }>();
  let running: string | null = null;
  const queue: string[] = [];
  let localRules: unknown[] = [];
  const enc = new TextEncoder();

  const post = async (op: string, body: unknown, signal?: AbortSignal): Promise<Response> => fetch(`${base}/__flux-dev/tiff/${op}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  async function call<T>(op: string, body: unknown): Promise<T> {
    const r = await (await post(op, body)).json();
    if (!r.ok) throw Object.assign(new Error(r.error), r.code ? { code: r.code } : {});
    return r.result as T;
  }
  const changed = (root: unknown): boolean => { const w = fs.watched().root; return typeof root === "string" && w !== undefined && w !== fs.norm(root); };
  const rootOf = (root: unknown): string => {
    if (changed(root)) throw new Error(fxr.fluximgErrors.projectChanged());
    if (typeof root !== "string" || !root.startsWith("/") || root.includes("\0")) throw new Error(fxr.fluximgErrors.root());
    return fs.resolve(root) ?? "/";
  };

  async function stage(bytes: Uint8Array | Blob, name: string, mtime: number): Promise<string> {
    const r = await (await fetch(`${base}/__flux-dev/tiff/stage`, { method: "POST", headers: { "x-flux-name": name, "x-flux-mtime": String(Math.round(mtime)) }, body: bytes as BodyInit })).json();
    if (!r.handle) throw new Error(r.error ?? "could not stage the TIFF");
    return r.handle;
  }
  async function probe(root: string, bytes: Uint8Array | Blob, label: string, record: string, inside: boolean, mtime: number, request: Partial<TiffProbeRequest>): Promise<TiffProbeResult> {
    const generation = fs.watched().generation;
    const handle = await stage(bytes, label, mtime);
    const result = await call<Omit<TiffProbeResult, "token" | "name" | "sourcePath" | "external">>("probe", { handle, rules: Array.isArray(request.rules) ? request.rules.slice(0, fxr.TIFF_MAX_RULES) : [], max: request.max });
    if (changed(root) || generation !== fs.watched().generation) throw new Error(fxr.fluximgErrors.projectChanged());
    const token = crypto.randomUUID().replace(/-/g, "");
    tokens.set(token, { handle, root, label, record, inside });
    return { token, name: label, sourcePath: record, external: !inside, ...result };
  }
  const tokenOf = (root: string, token: unknown): Token => {
    const t = typeof token === "string" ? tokens.get(token) : undefined;
    if (!t || t.root !== root) throw new Error(fxr.tiffErrors.token());
    return t;
  };
  const checkAnswer = (a: unknown) => { if (!a || typeof a !== "object" || !Array.isArray((a as { dims?: unknown }).dims)) throw new Error(fxr.tiffErrors.answer()); return a; };
  const emit = (p: TiffProgress) => { for (const l of listeners) l(p); };

  async function convert(request: TiffConvertRequest): Promise<TiffConvertResult> {
    const root = rootOf(request?.root);
    const t = tokenOf(root, request?.token);
    const answer = checkAnswer(request?.answer);
    const id = fxr.fluximgAssetId(request?.assetId);
    const jobId = fxr.tiffJobId(request?.jobId);
    if (jobs.has(jobId)) throw new Error(fxr.tiffErrors.job());
    const job = { abort: new AbortController(), cancelled: false, started: false } as { abort: AbortController; cancelled: boolean; started: boolean; release?: () => void };
    jobs.set(jobId, job);
    try {
      if (running) {
        emit({ jobId, queued: queue.length + 1 });
        queue.push(jobId);
        await new Promise<void>((resolve) => { job.release = resolve; });
      }
      if (job.cancelled) throw cancelled();
      running = jobId;
      job.started = true;
      const generation = fs.watched().generation;
      const current = () => { if (changed(root) || generation !== fs.watched().generation) throw new Error(fxr.fluximgErrors.projectChanged()); };
      current();
      if (!fs.files.has(`${root}/project.json`)) throw new Error(fxr.fluximgErrors.root());
      const destination = `${root}/${fxr.fluximgAssetRel(id)}`;
      if (fs.files.has(destination) || fs.isDir(destination)) throw new Error(fxr.fluximgErrors.exists(id));
      const res = await post("convert", { handle: t.handle, answer, name: t.label.replace(/\.(ome\.)?tiff?$/i, ""), sourcePath: t.inside ? t.record : t.label }, job.abort.signal).catch((e) => { throw job.cancelled ? cancelled() : e; });
      const reader = res.body!.getReader(), dec = new TextDecoder();
      let buf = "", final: { ok: boolean; result?: TiffConvertResult & { contents: Record<string, string> }; error?: string; cancelled?: boolean; code?: string } | null = null;
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try { chunk = await reader.read(); } catch (e) { throw job.cancelled ? cancelled() : e; }
        if (chunk.done) break;
        buf += dec.decode(chunk.value, { stream: true });
        for (let nl; (nl = buf.indexOf("\n")) >= 0;) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.progress) {
            try { current(); } catch { job.cancelled = true; job.abort.abort(); continue; }
            emit({ jobId, ...msg.progress });
          } else final = msg;
        }
      }
      if (job.cancelled) throw cancelled();
      if (!final) throw new Error(fxr.tiffErrors.stopped("no answer"));
      if (!final.ok) throw final.cancelled ? cancelled() : new Error(final.code === "stopped" ? fxr.tiffErrors.stopped(final.error ?? "") : final.error);
      current();
      if (fs.files.has(destination) || fs.isDir(destination)) throw new Error(fxr.fluximgErrors.exists(id));
      // Publish: the bundle's files, then its content id checked against the child's (what Electron's rename keeps).
      const entries: Array<{ path: string; sha256: string }> = [];
      const written: Array<[string, Uint8Array]> = Object.entries(final.result!.contents).map(([rel, data]) => [`${destination}/${fxr.fluximgInnerPath(rel).join("/")}`, b64(data)]);
      for (const [key, bytes] of written) entries.push({ path: key.slice(destination.length + 1), sha256: await fs.sha256(bytes) });
      const contentId = await fs.sha256(enc.encode(fxr.fluximgContentIdText(entries)));
      if (contentId !== final.result!.sha256) throw new Error("The converted bundle arrived damaged; nothing was added");
      fs.addDir(destination);
      for (const [key, bytes] of written) { fs.ensureParent(key); fs.files.set(key, bytes); }
      const { contents: _contents, ...rest } = final.result!;
      void _contents;
      return { ...rest, path: fxr.fluximgAssetPath(id), manifest: rest.manifest as FluximgManifest, method: "convert" };
    } finally {
      jobs.delete(jobId);
      if (running === jobId) running = null;
      const qi = queue.indexOf(jobId);
      if (qi >= 0) queue.splice(qi, 1);
      if (!running && queue.length) jobs.get(queue.shift()!)?.release?.();
    }
  }
  const cancelled = () => Object.assign(new Error(fxr.tiffErrors.cancelled()), { name: "AbortError", code: "cancelled" });

  return {
    /** Gates: the dev route's origin (the page's own by default). */
    _setTiffEndpoint(url: string) { base = url.replace(/\/+$/, ""); },
    async probeTiff(request: TiffProbeRequest): Promise<TiffProbeResult> {
      const root = rootOf(request?.root);
      const sourcePath = fxr.tiffSourcePath(request?.sourcePath);
      const relative = !sourcePath.startsWith("/");
      const abs = fs.resolve(relative ? `${root}/${sourcePath}` : sourcePath);
      const inside = !!abs && (abs === root || abs.startsWith(`${root}/`));
      if (relative && !inside) throw new Error(fxr.tiffErrors.sourceEscapes());
      if (!abs) throw new Error(fxr.tiffErrors.missing(sourcePath));
      const bytes = fs.files.get(abs);
      if (!bytes) throw new Error(fs.isDir(abs) ? fxr.tiffErrors.notFile(abs.slice(abs.lastIndexOf("/") + 1)) : fxr.tiffErrors.missing(sourcePath));
      const label = abs.slice(abs.lastIndexOf("/") + 1);
      return probe(root, bytes, label, inside ? abs.slice(root.length + 1) : abs, inside, fs.mtime(abs), request);
    },
    // A "dropped" TIFF in the fixture is the page's own File (bytes in hand; there is no file manager path).
    async probeDroppedTiff(file: File, request: Omit<TiffProbeRequest, "sourcePath">): Promise<TiffProbeResult> {
      const root = rootOf(request?.root);
      fxr.tiffSourcePath(file?.name);
      return probe(root, file, file.name, file.name, false, file.lastModified, request);
    },
    async previewTiff(request: TiffPreviewRequest): Promise<TiffPreviewPng> {
      const root = rootOf(request?.root);
      const t = tokenOf(root, request?.token);
      const generation = fs.watched().generation;
      const result = await call<TiffPreviewPng>("preview", { handle: t.handle, answer: checkAnswer(request?.answer), max: request?.max });
      if (changed(root) || generation !== fs.watched().generation) throw new Error(fxr.fluximgErrors.projectChanged());
      return result;
    },
    convertTiff: convert,
    async cancelTiff(jobId: string): Promise<boolean> {
      const job = typeof jobId === "string" ? jobs.get(jobId) : undefined;
      if (!job) return false;
      job.cancelled = true;
      job.abort.abort();
      if (!job.started) job.release?.();
      return true;
    },
    async releaseTiff(token: string): Promise<void> {
      const t = tokens.get(token);
      tokens.delete(token);
      if (t) await post("release", { handle: t.handle }).catch(() => {});
    },
    onTiffProgress(fn: (p: TiffProgress) => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    async readTiffRules(): Promise<unknown[]> {
      if (typeof localStorage === "undefined") return localRules;
      try { const v = JSON.parse(localStorage.getItem("flux.tiffRules") ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
    },
    async writeTiffRules(rules: unknown[]): Promise<boolean> {
      const list = Array.isArray(rules) ? rules.slice(0, 200) : [];
      if (typeof localStorage === "undefined") localRules = list; else localStorage.setItem("flux.tiffRules", JSON.stringify(list));
      return true;
    },
    /** A project switch forgets this window's open TIFFs (Electron's cancelOwner). */
    _forgetTiffs() { tokens.clear(); for (const j of jobs.values()) { j.cancelled = true; j.abort.abort(); if (!j.started) j.release?.(); } },
  };
}
