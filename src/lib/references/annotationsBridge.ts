// Renderer-side annotation persistence (the browser/Electron twin of flux-core/
// annotate.ts) over window.fig. Reuses the pure model in annotations.ts + the items
// path helpers. Annotations live in items/<citekey>/annotations.json.
//
// Write safety: every mutation is a read-modify-write of the whole file, so (a) a
// per-citekey promise queue serializes this renderer's own ops (two quick highlights
// no longer read the same stale file), and (b) the RMW runs under the FluxLib IPC
// lock (libLock.ts) so an agent's flux-core write (same lock dir) can't interleave.
// The main-process fs:writeText handler is already atomic (tmp+rename).
import { writable } from "svelte/store";
import { fileBridge } from "../project/types";
import { resolveFluxLibPath } from "./fluxlibBridge";
import { annotationsPath, itemDir, safeKey } from "./items";
import { withIpcLock } from "./libLock";
import { seededItem } from "./devSeed";
import { emptyAnnotationFile, type Annotation, type AnnotationFile } from "./annotations";

// Bumped after every in-app annotation write, keyed by citekey — a second view of the
// same paper (split reader panes, kept-alive tabs) reloads on it so highlights stay in
// sync. External/agent writes arrive via fluxLibRevision (the watcher) instead; the
// watcher suppresses this renderer's own writes, which is exactly the gap this fills.
export const annotationsRev = writable<{ key: string; n: number }>({ key: "", n: 0 });
let annRevN = 0;
const bumpAnnotations = (key: string) => annotationsRev.set({ key, n: ++annRevN });

// Per-citekey op queue: each mutation waits for the previous one on that key,
// success or failure, so RMW cycles never overlap within this renderer.
const opTails = new Map<string, Promise<unknown>>();
function enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const tail = opTails.get(key) ?? Promise.resolve();
  const run = tail.then(fn, fn);
  opTails.set(
    key,
    run.catch(() => undefined),
  );
  return run;
}

const locked = <T>(key: string, fn: () => Promise<T>): Promise<T> =>
  enqueue(key, () => withIpcLock("fluxlib", `annotations-${safeKey(key)}`, fn));

// Annotations are pure JSON; JSON round-trip (not structuredClone) so Svelte 5 $state
// proxies passed in from components clone instead of throwing DataCloneError.
const jsonClone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export async function loadAnnotations(key: string): Promise<AnnotationFile> {
  const s = seededItem(key);
  if (s) return jsonClone(s.annotations);
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  if (!fb || !lib) return emptyAnnotationFile();
  try {
    const p = annotationsPath(lib, key);
    return (await fb.exists(p)) ? (JSON.parse(await fb.readText(p)) as AnnotationFile) : emptyAnnotationFile();
  } catch {
    return emptyAnnotationFile();
  }
}

export async function saveAnnotations(key: string, file: AnnotationFile): Promise<void> {
  const s = seededItem(key);
  if (s) {
    s.annotations = jsonClone(file);
    return;
  }
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  if (!fb || !lib) return;
  await fb.mkdir(itemDir(lib, key));
  await fb.writeText(annotationsPath(lib, key), JSON.stringify(file, null, 2) + "\n");
}

export async function addAnnotation(
  key: string,
  partial: Omit<Annotation, "id" | "createdAt">,
): Promise<Annotation> {
  return locked(key, async () => {
    const file = await loadAnnotations(key);
    const ann: Annotation = {
      ...partial,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };
    file.annotations.push(ann);
    await saveAnnotations(key, file);
    bumpAnnotations(key);
    return ann;
  });
}

export async function updateAnnotation(key: string, id: string, patch: Partial<Annotation>): Promise<void> {
  return locked(key, async () => {
    const file = await loadAnnotations(key);
    const a = file.annotations.find((x) => x.id === id);
    if (a) {
      Object.assign(a, patch);
      await saveAnnotations(key, file);
    }
    // Unconditional so every call produces exactly one bump — readers suppress their
    // own writes by counting them, and a skipped bump would desync that count.
    bumpAnnotations(key);
  });
}

export async function deleteAnnotation(key: string, id: string): Promise<void> {
  return locked(key, async () => {
    const file = await loadAnnotations(key);
    file.annotations = file.annotations.filter((x) => x.id !== id);
    await saveAnnotations(key, file);
    bumpAnnotations(key);
  });
}
