import assert from "node:assert/strict";
import { createGalleryTree, galleryDirectoryEntries, galleryRelativePath, type GalleryDirectoryEntry } from "../src/lib/plot/galleryTree";

let checks = 0;
const check = (condition: unknown, message: string) => { assert.ok(condition, message); checks++; console.log(`  ok: ${message}`); };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const entries = (names: string[]): GalleryDirectoryEntry[] => names.map(name => ({ name: name.replace(/\/$/, ""), dir: name.endsWith("/") }));
const listing = entries(["plot.svg", "plot.fluxplot.json", "snip.png", "snip.snip.json", "clip.MOV", "notes.txt", "_dissections/", "_lighttable/", "_videos/", "a/", "../escape.svg", "..", "plot.svg"]);
const files = galleryDirectoryEntries("/p/plots", "/p/plots", listing, false);
check(files.filter(row => row.kind === "file").map(row => row.name).join() === "plot.svg,snip.png", "tree shows supported images once and excludes sidecars, unrelated files, and traversal names");
check(files.find(row => row.name === "plot.svg")?.semantic && files.find(row => row.name === "snip.png")?.snip, "sidecar metadata comes from the existing directory listing");
check(files.filter(row => row.name.startsWith("_")).length === 3 && !!files.find(row => row.name === "_dissections")?.hint, "all reserved collections remain explicit tree directories");
check(files.findIndex(row => row.kind === "file") === 4, "directories precede image files");
check(galleryDirectoryEntries("/p/plots", "/p/plots", listing, true).some(row => row.video && row.name === "clip.MOV"), "video-enabled hosts include MP4/MOV files");
check(galleryRelativePath("C:\\project\\plots", "C:\\project\\plots\\study\\a.svg") === "study/a.svg", "Windows paths normalize to a stable plots-relative path");
check(galleryRelativePath("/p/plots", "/p/plots-other/a.svg") === null && galleryRelativePath("/p/plots", "/p/plots/../a.svg") === null, "selection reveal cannot leave the plots root");

const disk = new Map<string, GalleryDirectoryEntry[]>([
  ["/p/plots", entries(["a/", "b/", "_dissections/", "root.svg"])],
  ["/p/plots/a", entries(["deep/", "a.svg"])],
  ["/p/plots/a/deep", entries(["one.png"])],
  ["/p/plots/b", entries(["b.svg"])],
  ["/p/plots/_dissections", entries(["source/", "animal.png"])],
]);
const reads: string[] = [];
let changes = 0;
const tree = createGalleryTree(async path => { reads.push(path); const value = disk.get(path); if (!value) throw new Error("Read denied"); return value; }, () => changes++);
await tree.reset("/p/plots", false);
check(reads.join() === "/p/plots" && tree.rows().length === 5, "opening reads only plots/, never the full project tree");
await tree.expand("/p/plots/a");
check(reads.join() === "/p/plots,/p/plots/a" && tree.rows().some(row => row.name === "deep") && !tree.rows().some(row => row.name === "one.png"), "expanding one folder loads only that directory");
await tree.reveal("/p/plots/a/deep/one.png");
check(tree.rows().some(row => row.name === "one.png") && !reads.includes("/p/plots/b"), "revealing a file loads its ancestry without scanning siblings");
const beforeReveal = changes;
await tree.reveal("/p/plots/a/deep/one.png");
check(changes === beforeReveal, "selecting an already-revealed file does not rebuild the tree");
tree.collapse("/p/plots/a");
check(!tree.rows().some(row => row.name === "one.png"), "collapsing a directory removes every descendant row");
const beforeCached = reads.length;
await tree.expand("/p/plots/a");
check(tree.rows().some(row => row.name === "one.png") && reads.length === beforeCached, "reopening cached folders restores their expansion without new IO");
await tree.reveal("/other/data.svg");
check(reads.length === beforeCached, "foreign-root selection adds no filesystem reads");
await tree.expand("/p/plots/_dissections");
check(tree.rows().some(row => row.rel === "_dissections/animal.png") && !reads.includes("/p/plots/_dissections/source"), "reserved collection contents load only after explicit expansion");
tree.collapse("/p/plots/a"); tree.collapse("/p/plots/_dissections");
await tree.expand("/p/plots/b");
disk.set("/p/plots/b", entries(["fresh.svg"]));
const beforeRefresh = reads.length;
await tree.refresh(); await flush();
check(reads.slice(beforeRefresh).join() === "/p/plots,/p/plots/b" && tree.rows().some(row => row.name === "fresh.svg"), "refresh reloads visible expanded folders while leaving collapsed subtrees unread");
disk.set("/p/plots", entries(["broken/"]));
await tree.refresh(); await tree.expand("/p/plots/broken");
check(tree.rows().find(row => row.name === "broken")?.error === "Read denied", "directory failures stay visible and local to that folder");
disk.set("/p/plots/broken", entries(["recovered.png"])); await tree.retry("/p/plots/broken");
check(tree.rows().some(row => row.name === "recovered.png"), "retry replaces a failed directory with its actual contents");
tree.dispose();

let releaseOld: ((entries: GalleryDirectoryEntry[]) => void) | undefined;
const changing = createGalleryTree(path => path === "/old/plots" ? new Promise(resolve => releaseOld = resolve) : Promise.resolve(entries(["current.svg"])), () => {});
const old = changing.reset("/old/plots", false);
await changing.reset("/new/plots", false);
releaseOld!(entries(["stale.svg"])); await old;
check(changing.rows().some(row => row.name === "current.svg") && changing.rows().every(row => !row.abs.startsWith("/old")), "late completion from a previous root cannot contaminate the current tree");
changing.dispose();

let releaseSelection: ((entries: GalleryDirectoryEntry[]) => void) | undefined;
const selectionReads: string[] = [];
const selecting = createGalleryTree(path => {
  selectionReads.push(path);
  if (path === "/select/plots/a") return new Promise(resolve => releaseSelection = resolve);
  return Promise.resolve(entries(path === "/select/plots" ? ["a/", "b/"] : ["new.svg"]));
}, () => {});
await selecting.reset("/select/plots", false);
const olderSelection = selecting.reveal("/select/plots/a/deep/old.svg");
await flush();
await selecting.reveal("/select/plots/b/new.svg");
releaseSelection!(entries(["deep/"])); await olderSelection;
check(!selectionReads.includes("/select/plots/a/deep") && selecting.rows().some(row => row.abs === "/select/plots/b/new.svg"), "newer selection cancels stale ancestry expansion within the same root");
selecting.dispose();

let running = 0, maxRunning = 0;
const releases: (() => void)[] = [];
const boundedReads: string[] = [];
const bounded = createGalleryTree(async path => {
  boundedReads.push(path);
  if (path === "/scale/plots") return entries(Array.from({ length: 12 }, (_, i) => `d${i}/`));
  running++; maxRunning = Math.max(maxRunning, running);
  await new Promise<void>(resolve => releases.push(resolve)); running--;
  return entries(["image.png"]);
}, () => {});
await bounded.reset("/scale/plots", false);
const expansions = Array.from({ length: 12 }, (_, i) => bounded.expand(`/scale/plots/d${i}`));
check(maxRunning === 4 && releases.length === 4, "directory IO has a four-read concurrency bound");
bounded.collapse("/scale/plots"); releases.splice(0).forEach(release => release());
await Promise.all(expansions);
check(boundedReads.length === 5 && bounded.rows().length === 1, "collapsing an ancestor cancels queued descendant reads");
bounded.dispose();

const dense = createGalleryTree(async () => entries(Array.from({ length: 20_000 }, (_, i) => `plot-${i}.svg`)), () => {});
const started = performance.now(); await dense.reset("/dense/plots", false); const denseRows = dense.rows();
check(denseRows.length === 20_001 && denseRows.at(-1)?.name === "plot-19999.svg", "large folders retain every image with natural filename sorting");
console.log(`  dense folder model: ${(performance.now() - started).toFixed(1)}ms`);
dense.dispose();
console.log(`##VERIFY## ${JSON.stringify({ script: "verify-gallery-tree", ok: true, checks, failed: 0 })}`);
