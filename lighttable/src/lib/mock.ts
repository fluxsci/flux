// Dev-only client-side mock of the preload bridge (window.lt) so the whole UI
// runs in plain Chrome for scripts/verify-ui.mjs — no Electron, no filesystem.
// Images are generated in-page (canvas -> data URLs): a page served over http
// cannot load file:// images, so a disk fixture would be useless here anyway.
// Loaded only when import.meta.env.DEV && ?mock=… — stripped from builds.
import type { AnnotItem, ItemCell, LtApi, Manifest } from "./types";

function hueFor(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

function makeImage(setId: string, key: string): string {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 96;
  const g = c.getContext("2d")!;
  g.fillStyle = `hsl(${hueFor(`${setId}/${key}`)}, 55%, 42%)`;
  g.fillRect(0, 0, 128, 96);
  g.fillStyle = "#fff";
  g.font = "600 12px sans-serif";
  g.textAlign = "center";
  g.fillText(setId, 64, 44);
  g.fillText(key, 64, 62);
  return c.toDataURL("image/png");
}

export function installMock(kind: string): void {
  const big = kind === "big";
  const setIds = big ? ["s1", "s2", "s3"] : ["A", "B"];
  const n = big ? 2000 : 6;
  const missing: Record<string, Set<string>> = big ? {} : { B: new Set(["item_004"]) };
  const keys = Array.from({ length: n }, (_, i) => `item_${String(i + 1).padStart(3, "0")}`);
  const keySet = new Set(keys);
  const bySet: Record<string, ItemCell[]> = {};
  for (const s of setIds) {
    bySet[s] = keys.map((k) =>
      missing[s]?.has(k)
        ? { key: k, present: false, file: null }
        : { key: k, present: true, file: `${k}.png` }
    );
  }
  const manifest: Manifest = {
    root: "/mock",
    name: big ? "mock-big" : "mock-collection",
    sets: setIds.map((id) => ({ id, name: id, count: bySet[id].filter((c) => c.present).length })),
    keys,
    bySet,
    annotations: { classes: [], active: null },
  };
  // A sister collection (same content, different identity) so the gates can
  // exercise the collection-name switcher.
  const sister: Manifest = { ...manifest, root: "/mock-sister", name: "mock-sister" };

  // In-memory annotation classes (per page load) — enough for the UI gate.
  const annotClasses = new Map<string, Record<string, AnnotItem>>();
  let activeClass: string | null = null;

  const cache = new Map<string, string>();
  const urlFor = (setId: string, key: string): string => {
    const ck = `${setId}/${key}`;
    let u = cache.get(ck);
    if (!u) {
      u = makeImage(setId, key);
      cache.set(ck, u);
    }
    return u;
  };
  const present = (setId: string, key: string) => keySet.has(key) && !missing[setId]?.has(key);

  const api: LtApi = {
    openDialog: async () => manifest,
    openPath: async (p) => (p === "/mock-sister" ? sister : manifest),
    onOpen: (cb) => queueMicrotask(() => cb(manifest)), // auto-open for gates
    recents: async () => [{ path: "/mock", name: manifest.name }],
    siblings: async () => [
      { path: "/mock", name: manifest.name },
      { path: "/mock-sister", name: "mock-sister" },
    ],
    thumbUrl: async (s, k) => (present(s, k) ? urlFor(s, k) : null),
    fullUrl: async (s, k) => (present(s, k) ? urlFor(s, k) : null),
    revealInFolder: async () => {},
    pathForFile: () => "",
    prefsGet: async () => ({ columns: 8, captions: true, hGap: 8, vGap: 8, recents: [] }),
    prefsSet: async () => {},
    annotList: async () => [...annotClasses.keys()].sort(),
    annotCreate: async (name) => {
      if (!annotClasses.has(name)) annotClasses.set(name, {});
      activeClass = name;
      return { name, items: { ...annotClasses.get(name)! } };
    },
    annotOpen: async (name) => {
      const items = annotClasses.get(name);
      if (!items) return null;
      activeClass = name;
      return { name, items: { ...items } };
    },
    annotClose: async () => {
      activeClass = null;
    },
    annotSet: async (key, patch) => {
      const items = activeClass ? annotClasses.get(activeClass) : undefined;
      if (!items) return;
      const it: AnnotItem = { ...(items[key] ?? {}) };
      if ("mark" in patch) {
        if (patch.mark) it.mark = patch.mark;
        else delete it.mark;
      }
      if ("notes" in patch) {
        if (patch.notes?.trim()) it.notes = patch.notes;
        else delete it.notes;
      }
      if (it.mark || it.notes) items[key] = it;
      else delete items[key];
    },
  };
  (window as unknown as { lt: LtApi }).lt = api;
}
