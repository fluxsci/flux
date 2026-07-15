// Integration gate for the REAL main-process modules without Electron:
// scan.cjs against a make-fixture temp collection, thumbs.cjs against a temp
// cache dir (initThumbs injection). Hermetic; cleans up after itself.
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync, utimesSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeFixture } from "./make-fixture.mjs";
import { check, checkAsync, section, finish } from "./lib/harness.mjs";

const require = createRequire(import.meta.url);
const { scanCollection, toManifest, LOOSE_SET_ID } = require("../electron/scan.cjs");
const thumbs = require("../electron/thumbs.cjs");
const { loadImage } = require("@napi-rs/canvas");

const base = mkdtempSync(path.join(os.tmpdir(), "lighttable-verify-"));
process.on("exit", () => rmSync(base, { recursive: true, force: true }));

// ---- scanCollection ----------------------------------------------------------
section("scanCollection: standard collection");
const stdDir = await makeFixture(path.join(base, "std"), {
  sets: {
    A: ["img_1.png", "img_2.png", "img_10.png", "zeta.svg", "anim.gif"],
    B: ["img_1.jpg", "img_2.png", "img_10.png"],
    empty_set: [],
  },
  emptyDirs: ["no_images_here"],
});
writeFileSync(path.join(stdDir, "no_images_here", "notes.txt"), "not an image");
const std = await scanCollection(stdDir);
check("scan returns a result", !!std);
check("set list: imageless subfolders omitted", std.sets.map((s) => s.id).join(",") === "A,B");
check("counts per set", std.sets[0].count === 5 && std.sets[1].count === 3);
check("keys are the natural-sorted union", std.keys.join(",") === "anim,img_1,img_2,img_10,zeta");
check("bySet arrays aligned to keys in every set", std.sets.every((s) => std.bySet[s.id].length === std.keys.length));
check(
  "cross-extension alignment: B joins img_1 via .jpg",
  std.bySet.B[1].present && std.bySet.B[1].file === "img_1.jpg"
);
check("missing items marked present:false", std.bySet.B[0].present === false && std.bySet.B[4].present === false);
check("index resolves present items to absolute paths", std.index.get("A").get("img_10") === path.join(stdDir, "A", "img_10.png"));
check("index has no entry for missing items", std.index.get("B").get("zeta") === undefined);
check("manifest strips the fs index", !("index" in toManifest(std)));
check("collection name is the folder basename", std.name === "std");

section("scanCollection: degenerate cases");
const looseDir = await makeFixture(path.join(base, "loose"), { loose: ["one.png", "two.png"] });
const loose = await scanCollection(looseDir);
check("loose images only -> single 'All' set", loose.sets.length === 1 && loose.sets[0].name === "All" && loose.sets[0].id === LOOSE_SET_ID);
check("'All' contains the loose images", loose.sets[0].count === 2 && loose.keys.join(",") === "one,two");

const mixedDir = await makeFixture(path.join(base, "mixed"), {
  sets: { variants: ["one.png", "three.png"] },
  loose: ["one.png", "two.png"],
});
const mixed = await scanCollection(mixedDir);
check("mixed: 'All' first, then subfolder sets", mixed.sets.map((s) => s.name).join(",") === "All,variants");
check("mixed alignment spans loose + set keys", mixed.keys.join(",") === "one,three,two");

const emptyDir = await makeFixture(path.join(base, "empty"), {});
const empty = await scanCollection(emptyDir);
check("empty collection -> empty manifest (not an error)", !!empty && empty.sets.length === 0 && empty.keys.length === 0);

check("nonexistent path -> null", (await scanCollection(path.join(base, "nope"))) === null);

const fileDrop = await scanCollection(path.join(stdDir, "A", "img_1.png"));
check("dropping a FILE opens its containing folder", !!fileDrop && fileDrop.name === "A" && fileDrop.sets.length === 1);

section("scanCollection: natural set ordering");
const orderDir = await makeFixture(path.join(base, "order"), {
  sets: { run10: ["a.png"], run2: ["a.png"], run1: ["a.png"] },
});
const order = await scanCollection(orderDir);
check("sets natural-sorted (run1 < run2 < run10)", order.sets.map((s) => s.id).join(",") === "run1,run2,run10");

// ---- thumbs ------------------------------------------------------------------
section("thumbs: generation, cache, fallbacks");
const cacheDir = path.join(base, "thumb-cache");
thumbs.initThumbs(cacheDir);
check("cacheRoot reports the injected dir", thumbs.cacheRoot() === cacheDir);

const bigDir = await makeFixture(path.join(base, "thumbsrc"), { sets: { S: ["big_one.png"] } });
const bigPng = path.join(bigDir, "S", "big_one.png"); // 640x400 source
const t1 = await thumbs.ensureThumb(bigPng, 200); // bucket 256
check("thumb lands in the cache dir as .webp", t1.startsWith(cacheDir) && t1.endsWith(".webp"));
await checkAsync("thumb longest edge == bucket (256), aspect preserved", async () => {
  const im = await loadImage(t1);
  return im.width === 256 && im.height === Math.round((400 / 640) * 256);
});
const t2 = await thumbs.ensureThumb(bigPng, 200);
check("cache hit returns the same file", t2 === t1);
check("exactly one cache entry so far", readdirSync(cacheDir).length === 1);

const t3 = await thumbs.ensureThumb(bigPng, 300); // bucket 384 -> second entry
check("bigger bucket caches independently", t3 !== t1 && readdirSync(cacheDir).length === 2);

// mtime change -> new key
utimesSync(bigPng, new Date(), new Date(Date.now() + 5000));
const t4 = await thumbs.ensureThumb(bigPng, 200);
check("edited (mtime-bumped) image re-thumbnails", t4 !== t1 && readdirSync(cacheDir).length === 3);

// small source never upscales
const smallDir = await makeFixture(path.join(base, "small"), {});
writeFileSync(path.join(smallDir, "tiny.png"), await (await import("@napi-rs/canvas")).createCanvas(50, 30).encode("png"));
const tSmall = await thumbs.ensureThumb(path.join(smallDir, "tiny.png"), 200);
await checkAsync("small images are never upscaled", async () => {
  const im = await loadImage(tSmall);
  return im.width === 50 && im.height === 30;
});

const svgDir = await makeFixture(path.join(base, "svg"), { loose: ["vector.svg", "anim.gif"] });
check("svg served as original", (await thumbs.ensureThumb(path.join(svgDir, "vector.svg"), 200)) === path.join(svgDir, "vector.svg"));
check("gif served as original", (await thumbs.ensureThumb(path.join(svgDir, "anim.gif"), 200)) === path.join(svgDir, "anim.gif"));

const bogusDir = await makeFixture(path.join(base, "bogus"), { loose: ["bogus_bytes.png"] });
const bogusPath = path.join(bogusDir, "bogus_bytes.png");
check("undecodable bytes fall back to the original", (await thumbs.ensureThumb(bogusPath, 200)) === bogusPath);

check("missing source falls back to the original path", (await thumbs.ensureThumb(path.join(base, "ghost.png"), 200)) === path.join(base, "ghost.png"));

section("thumbs: concurrency");
const burstDir = await makeFixture(path.join(base, "burst"), {
  sets: { S: Array.from({ length: 8 }, (_, i) => `burst_${i}.png`) },
});
const before = readdirSync(cacheDir).length;
const burst = await Promise.all(
  Array.from({ length: 24 }, (_, i) => thumbs.ensureThumb(path.join(burstDir, "S", `burst_${i % 8}.png`), 150))
);
check("24-way burst: every call resolves into the cache", burst.every((p) => p.startsWith(cacheDir)));
check("burst dedupes to one entry per source", readdirSync(cacheDir).length === before + 8);

section("thumbs: sweep");
await thumbs.sweepCache(1, 0); // force: everything is over a 1-byte budget
check("sweep empties the cache under a tiny budget", readdirSync(cacheDir).length === 0);

finish("verify-node");
