import { mathFallback, MAX_MATH_SOURCE, safeMathRender } from "./safeMath";
const cache = new Map<string, string>();
let cacheBytes = 0, serial = 0;
const MAX_CACHE = 8 * 1024 * 1024, MAX_QUEUE = 128;
const pending = new Map<string, Promise<string>>();
const listeners = new Set<() => void>();
type Job = { key: string; id: number; tex: string; display: boolean; resolve: (html: string) => void };
let queue: Job[] = [], active: Job | null = null, worker: Worker | null = null, ready = false;
let timeout: ReturnType<typeof setTimeout> | undefined;
export function onMathRendered(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }
const keyFor = (tex: string, display: boolean) => `${display ? "D" : "I"}\0${tex}`;
function remember(key: string, html: string) {
  cache.set(key, html); cacheBytes += 2 * (key.length + html.length);
  while (cacheBytes > MAX_CACHE || cache.size > 500) {
    const oldest = cache.keys().next().value!;
    const value = cache.get(oldest)!; cache.delete(oldest); cacheBytes -= 2 * (oldest.length + value.length);
  }
}
function finish(html: string) {
  clearTimeout(timeout); timeout = undefined;
  const job = active; active = null;
  if (job) { remember(job.key, html); pending.delete(job.key); job.resolve(html); for (const fn of listeners) fn(); }
  pump();
}
function failWorker(reason: string) {
  worker?.terminate(); worker = null; ready = false;
  if (active) finish(mathFallback(active.tex, reason));
}
function pump() {
  if (active || !queue.length) return;
  if (!worker) {
    try { worker = new Worker(new URL("./mathRender.worker.ts", import.meta.url), { type: "module", name: "flux-math" }); }
    catch (error) {
      active = queue.shift() ?? null;
      failWorker(`Math worker initialization failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const owner = worker;
    worker.onmessage = e => {
      if (worker !== owner) return;
      if (e.data.ready) { clearTimeout(timeout); ready = true; pump(); return; }
      if (active?.id === e.data.id) finish(e.data.html);
    };
    worker.onerror = () => {
      if (worker !== owner) return;
      if (!active) active = queue.shift() ?? null;
      failWorker("Math worker failed; retry the equation after editing it");
    };
    timeout = setTimeout(() => { if (!active) active = queue.shift() ?? null; failWorker("Math worker did not initialize"); }, 5000);
  }
  if (!ready) return;
  active = queue.shift()!;
  worker.postMessage({ id: active.id, tex: active.tex, display: active.display });
  // A single expression can never monopolize the worker indefinitely.
  timeout = setTimeout(() => failWorker("Math rendering exceeded the 250 ms limit"), 250);
}
export function cachedMath(tex: string, display: boolean): string | null {
  const key = keyFor(tex, display), found = cache.get(key);
  if (found !== undefined) { cache.delete(key); cache.set(key, found); return found; }
  void renderMath(tex, display);
  return cache.get(key) ?? null;
}
export function renderMath(tex: string, display: boolean): Promise<string> {
  const key = keyFor(tex, display), found = cache.get(key);
  if (found !== undefined) return Promise.resolve(found);
  const existing = pending.get(key); if (existing) return existing;
  if (tex.length > MAX_MATH_SOURCE) { const html = mathFallback(tex, `Equation exceeds ${MAX_MATH_SOURCE} source characters`); remember(key, html); return Promise.resolve(html); }
  // Node-only contract tests use the same strict bounded rendering policy.
  if (typeof Worker === "undefined") return import("katex").then(m => { const html = safeMathRender(m.default, tex, display); remember(key, html); return html; });
  if (queue.length >= MAX_QUEUE) { const html = mathFallback(tex, "Math render queue is full; edit the equation to retry"); remember(key, html); return Promise.resolve(html); }
  const promise = new Promise<string>(resolve => { queue.push({ key, id: ++serial, tex, display, resolve }); });
  pending.set(key, promise); pump(); return promise;
}
