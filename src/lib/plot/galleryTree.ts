import { RESERVED_PLOT_FOLDERS } from "../project/plotsFolders";

export interface GalleryTreeFile {
  abs: string;
  /** Relative to plots/, including the extension. */
  rel: string;
  name: string;
  semantic: boolean;
  snip?: boolean;
  video?: boolean;
}
export interface GalleryTreeEntry extends GalleryTreeFile {
  kind: "dir" | "file";
  hint?: string;
}
export interface GalleryTreeRow extends GalleryTreeEntry {
  depth: number;
  expanded?: boolean;
  status?: "loading" | "ready" | "error";
  error?: string;
}
export type GalleryDirectoryEntry = { name: string; dir: boolean };
type Directory = { entries: GalleryTreeEntry[]; status: "loading" | "ready" | "error"; error?: string };
const hints = new Map(RESERVED_PLOT_FOLDERS.map(folder => [folder.name, folder.hint]));
const filenameOrder = new Intl.Collator(undefined, { numeric: true });

export function normalizeGalleryPath(value: string): string { return value.replace(/\\/g, "/").replace(/\/+$/, ""); }
const childName = (name: string) => !!name && name !== "." && name !== ".." && !/[\\/\0]/.test(name);
export function galleryRelativePath(root: string, path: string): string | null {
  const base = normalizeGalleryPath(root), target = normalizeGalleryPath(path);
  if (target === base) return "";
  if (!base || !target.startsWith(base + "/")) return null;
  const rel = target.slice(base.length + 1);
  return rel.split("/").every(childName) ? rel : null;
}

/** Directory metadata only: sidecars mark their image, never add extra reads.
 * Reserved collections are explicit tree entries; search scoping stays with
 * the gallery host and does not cause this tree to recurse into them. */
export function galleryDirectoryEntries(root: string, dir: string, entries: readonly GalleryDirectoryEntry[], allowVideos: boolean): GalleryTreeEntry[] {
  const names = new Set(entries.filter(e => !e.dir).map(e => e.name));
  const seen = new Set<string>();
  return entries.filter(e => {
    if (!childName(e.name) || seen.has(e.name)) return false;
    seen.add(e.name);
    return e.dir || /\.(svg|png)$/i.test(e.name) || allowVideos && /\.(mp4|mov)$/i.test(e.name);
  }).map(e => {
    const abs = `${normalizeGalleryPath(dir)}/${e.name}`;
    return {
      abs, rel: galleryRelativePath(root, abs) ?? e.name, name: e.name,
      kind: e.dir ? "dir" as const : "file" as const,
      semantic: !e.dir && /\.svg$/i.test(e.name) && names.has(e.name.replace(/\.svg$/i, ".fluxplot.json")),
      ...(!e.dir && /\.png$/i.test(e.name) && names.has(e.name.replace(/\.png$/i, ".snip.json")) ? { snip: true } : {}),
      ...(!e.dir && /\.(mp4|mov)$/i.test(e.name) ? { video: true } : {}),
      ...(e.dir && hints.has(e.name) ? { hint: hints.get(e.name) } : {}),
    };
  }).sort((a, b) => a.kind === b.kind ? filenameOrder.compare(a.name, b.name) : a.kind === "dir" ? -1 : 1);
}

/** Lazy, view-local directory cache. Reads are bounded and old root/refresh
 * completions cannot publish into the current tree. There is no idle work. */
export function createGalleryTree(readDirectory: (path: string) => Promise<GalleryDirectoryEntry[]>, onChange: () => void) {
  let root = "", allowVideos = false, generation = 0, revealSequence = 0, disposed = false, active = 0;
  let directories = new Map<string, Directory>(), expanded = new Set<string>();
  const pending = new Map<string, Promise<void>>();
  const queue: { path: string; generation: number; resolve: () => void }[] = [];
  function visibleExpanded(path: string): boolean {
    if (!expanded.has(root)) return false;
    const rel = galleryRelativePath(root, path);
    if (rel === null) return false;
    let current = root;
    for (const segment of rel ? rel.split("/") : []) { current += `/${segment}`; if (!expanded.has(current)) return false; }
    return true;
  }
  function pump() {
    while (!disposed && active < 4 && queue.length) {
      const job = queue.shift()!;
      if (job.generation !== generation) { pending.delete(`${job.generation}\0${job.path}`); job.resolve(); continue; }
      if (!visibleExpanded(job.path)) { directories.delete(job.path); pending.delete(`${job.generation}\0${job.path}`); job.resolve(); continue; }
      active++;
      void (async () => {
        try {
          const entries = await readDirectory(job.path);
          if (disposed || job.generation !== generation) return;
          directories.set(job.path, { entries: galleryDirectoryEntries(root, job.path, entries, allowVideos), status: "ready" });
        } catch (error) {
          if (disposed || job.generation !== generation) return;
          directories.set(job.path, { entries: [], status: "error", error: error instanceof Error ? error.message : String(error) });
        } finally {
          active--; pending.delete(`${job.generation}\0${job.path}`); job.resolve();
          if (!disposed && job.generation === generation) {
            onChange();
            if (visibleExpanded(job.path)) for (const entry of directories.get(job.path)?.entries ?? []) {
              if (entry.kind === "dir" && expanded.has(entry.abs)) void load(entry.abs);
            }
          }
          pump();
        }
      })();
    }
  }
  function load(path: string, retry = false): Promise<void> {
    if (disposed || !root || galleryRelativePath(root, path) === null) return Promise.resolve();
    const key = `${generation}\0${path}`;
    const existing = pending.get(key);
    if (existing) return existing;
    if (directories.has(path) && !retry) return Promise.resolve();
    directories.set(path, { entries: directories.get(path)?.entries ?? [], status: "loading" });
    const promise = new Promise<void>(resolve => queue.push({ path, generation, resolve }));
    pending.set(key, promise); onChange(); pump(); return promise;
  }
  function reset(nextRoot: string, videos: boolean, keepExpanded = false) {
    generation++; root = normalizeGalleryPath(nextRoot); allowVideos = videos;
    directories = new Map(); expanded = keepExpanded ? expanded : new Set();
    if (root) expanded.add(root);
    onChange();
    return root ? load(root) : Promise.resolve();
  }
  function rows(): GalleryTreeRow[] {
    if (!root) return [];
    const result: GalleryTreeRow[] = [];
    const walk = (entry: GalleryTreeEntry, depth: number) => {
      const state = entry.kind === "dir" ? directories.get(entry.abs) : undefined;
      result.push({ ...entry, depth, ...(entry.kind === "dir" ? { expanded: expanded.has(entry.abs), status: state?.status, error: state?.error } : {}) });
      if (entry.kind === "dir" && expanded.has(entry.abs)) for (const child of state?.entries ?? []) walk(child, depth + 1);
    };
    // The root row is named for its folder: a project's plots/, or the global library.
    walk({ abs: root, rel: "", name: root.slice(root.lastIndexOf("/") + 1) || "plots", kind: "dir", semantic: false }, 0);
    return result;
  }
  return {
    reset,
    rows,
    refresh() { return reset(root, allowVideos, true); },
    retry(path: string) { expanded.add(path); return load(path, true); },
    async expand(path: string) { expanded.add(path); onChange(); await load(path); },
    collapse(path: string) { expanded.delete(path); onChange(); },
    /** Reveal only the ancestry of the gallery's current folder/file. */
    async reveal(path: string, directory = false) {
      const ownReveal = ++revealSequence;
      const rel = galleryRelativePath(root, path);
      if (rel === null) return;
      const ownGeneration = generation, segments = rel ? rel.split("/") : [];
      if (!directory) segments.pop();
      let current = root;
      let changed = !expanded.has(current);
      expanded.add(current); await load(current);
      for (const segment of segments) {
        if (disposed || ownGeneration !== generation || ownReveal !== revealSequence) return;
        const next = `${current}/${segment}`;
        if (!directories.get(current)?.entries.some(e => e.abs === next && e.kind === "dir")) return;
        current = next; changed ||= !expanded.has(current); expanded.add(current); await load(current);
      }
      if (!disposed && ownGeneration === generation && ownReveal === revealSequence && changed) onChange();
    },
    dispose() { disposed = true; generation++; for (const job of queue.splice(0)) job.resolve(); pending.clear(); directories.clear(); expanded.clear(); },
  };
}
