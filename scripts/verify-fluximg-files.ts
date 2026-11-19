// The fluximg file side: importing a bundle into a project, ranged reads, discard — on the native
// module (electron/fluximgFiles.cjs), through the IPC family's per-window checks
// (electron/ipc/fluximg.cjs), and on the in-memory dev bridge (src/lib/project/memBridge.ts), which must
// accept and refuse the same requests with the same messages and compute the same content id.
// Pure and hermetic: synthetic bundles from scripts/lib/fluximgFixtures.ts in scratch directories.
//   node --import tsx scripts/verify-fluximg-files.ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { harness } from "./lib/harness.mjs";
import { fixtures, writeFixture, readValues } from "./lib/fluximgFixtures";
import { openFluximg, type BundleReadIO } from "../src/lib/fluximg/reader";
import { nodeZstd } from "../flux-core/fluximgIo";
import { toValues, valueMaps } from "../src/lib/fluximg/encoding";
import { product } from "../src/lib/fluximg/zarr";
import { FLUXIMG_READ_LIMIT } from "../src/lib/fluximg/bridge";
import * as rules from "../electron/fluximgRules.js";
import { createMemBridge } from "../src/lib/project/memBridge";

const h = harness("verify-fluximg-files");
const require = createRequire(import.meta.url);
const files = require("../electron/fluximgFiles.cjs");
const { createFluximgCore } = require("../electron/ipc/fluximg.cjs");
const { createFileCore } = require("../electron/ipc/files.cjs");
const { isFluximgAssetBundlePath } = require("../electron/projectWatchPaths.cjs");
const { CHANNELS } = require("../electron/ipc/contract.cjs");

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "flux-fluximg-files-"));
const project = path.join(scratch, "project"), outside = path.join(scratch, "outside"), src = path.join(scratch, "src");
const assets = path.join(project, "fig", "assets");
const posix = process.platform !== "win32";
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

async function rejects(p: Promise<unknown> | (() => Promise<unknown>), re: RegExp, msg: string): Promise<string> {
  try { await (typeof p === "function" ? p() : p); h.fail(`${msg} — expected a refusal matching ${re}, got success`); return ""; }
  catch (e) { const m = e instanceof Error ? e.message : String(e); h.ok(re.test(m), re.test(m) ? msg : `${msg} — expected ${re}, got: ${m}`); return m; }
}
/** Every file under `dir` as posix relative path → sha256. */
async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const ent of await fs.readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!ent.isFile()) continue;
    const abs = path.join(ent.parentPath, ent.name);
    out[path.relative(dir, abs).split(path.sep).join("/")] = sha(await fs.readFile(abs));
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}
/** Content id computed independently from the definition: lines `<path>\0<sha>\n`, sorted by UTF-8 bytes. */
function contentId(t: Record<string, string>): string {
  const keys = Object.keys(t).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return sha(keys.map((k) => `${k}\0${t[k]}\n`).join(""));
}
const assetEntries = async () => (await fs.readdir(assets).catch(() => [] as string[])).sort();
const sameValues = (a: Float64Array, b: Float64Array) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]) || v === b[i]);

/** Level-0 values through any BundleReadIO (the fixture's readValues, over an injected IO). */
async function valuesVia(io: BundleReadIO): Promise<Float64Array> {
  const reader = await openFluximg(io, await nodeZstd());
  const p = reader.manifest.pixels, nd = p.dims.length, H = p.shape[nd - 2], W = p.shape[nd - 1];
  const ci = p.dims.indexOf("c"), C = ci >= 0 ? p.shape[ci] : 1, maps = valueMaps(p.dtype, p.encoding, C, p.nodata);
  const a = await reader.level(0), lead = p.shape.slice(0, nd - 2), out = new Float64Array(product(p.shape));
  for (let i = 0, k = 0; i < product(lead); i++, k += H * W) {
    const leading: number[] = [];
    for (let d = lead.length - 1, rem = i; d >= 0; d--) { leading[d] = rem % lead[d]; rem = Math.floor(rem / lead[d]); }
    toValues(await reader.readPlane(a, leading), maps[ci >= 0 ? leading[ci] : 0], out.subarray(k, k + H * W));
  }
  return out;
}
/** The reader's IO over ranged reads: what the renderer's adapter does over FileBridge.readFluximg. */
function rangeIO(read: (p: string, offset: number, length: number) => Promise<Uint8Array>): BundleReadIO {
  return {
    readText: async (p) => new TextDecoder().decode(await read(p, 0, -1)),
    readRange: (p, offset, length) => read(p, offset, length),
    exists: (p) => read(p, 0, 0).then(() => true, (e: Error) => (/^ENOENT|ENOENT:/.test(e.message) ? false : Promise.reject(e))),
  };
}

try {
  await fs.mkdir(assets, { recursive: true });
  await fs.mkdir(path.join(project, "plots"), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(project, "project.json"), JSON.stringify({ schemaVersion: "0.7.0" }));
  await fs.writeFile(path.join(project, "fig", "index.json"), JSON.stringify({ assets: [] }));
  const byName = new Map(fixtures().map((f) => [f.name, f]));
  const names = ["gray2d_u8", "stack_u16", "sparse_f32", "mean_f64_layers", "sharded_u8"];
  for (const n of names) await writeFixture(src, byName.get(n)!);
  const bundle = (n: string) => path.join(src, `${n}.fluximg`);

  h.section("constants and wiring");
  h.eq(rules.FLUXIMG_READ_LIMIT, FLUXIMG_READ_LIMIT, "the file side's read limit is bridge.ts's FLUXIMG_READ_LIMIT (32 MiB)");
  for (const [channel, scope] of [["fluximg:import", "write"], ["fluximg:read", "read"], ["fluximg:discard", "write"]])
    h.ok(CHANNELS.some((c: { channel: string; kind: string; scope: string }) => c.channel === channel && c.kind === "invoke" && c.scope === scope), `${channel} is declared invoke/${scope} in the IPC contract`);
  const preload = await fs.readFile(new URL("../electron/preload.cjs", import.meta.url), "utf8");
  for (const name of ["importFluximg", "readFluximg", "discardFluximg"]) h.ok(new RegExp(`\\b${name}: \\(request\\) => ipcRenderer\\.invoke\\("fluximg:`).test(preload), `preload exposes window.fig.${name}`);

  h.section("import: copies, content id, manifest");
  const a = await files.importBundle({ root: project, sourcePath: bundle("stack_u16"), assetId: "fx_a" });
  const srcTree = await tree(bundle("stack_u16")), aTree = await tree(path.join(assets, "fx_a.fluximg"));
  h.eq(aTree, srcTree, "every file of the bundle is copied byte for byte");
  h.eq(a.path, "assets/fx_a.fluximg", "result path is fig-relative, the way Asset.path is written");
  h.eq(a.files, Object.keys(srcTree).length, "result counts every file");
  let srcBytes = 0; for (const k of Object.keys(srcTree)) srcBytes += (await fs.stat(path.join(bundle("stack_u16"), k))).size;
  h.eq(a.bytes, srcBytes, "result counts every byte");
  h.eq(a.sha256, contentId(srcTree), "content id = SHA-256 over sorted `<path>\\0<sha256>\\n` lines");
  h.ok(a.manifest?.spec === "fluximg/1" && a.manifest.name === "stack_u16" && Array.isArray(a.manifest.pixels?.shape), "the parsed manifest comes back");
  h.ok(a.method === "clone" || a.method === "copy", `method is reported (${a.method} on this filesystem)`);
  const b = await files.importBundle({ root: project, sourcePath: bundle("stack_u16"), assetId: "fx_b", tryClone: false });
  h.eq(b.sha256, a.sha256, "the same bundle imported twice has the same content id");
  h.eq(b.method, "copy", "with cloning unavailable the import falls back to a plain copy");
  h.eq(await tree(path.join(assets, "fx_b.fluximg")), srcTree, "the plain-copy fallback copies the same bytes");
  // Relative to the project root, and OS litter left behind.
  await fs.cp(bundle("stack_u16"), path.join(project, "plots", "stack.fluximg"), { recursive: true });
  await fs.writeFile(path.join(project, "plots", "stack.fluximg", ".DS_Store"), "finder");
  await fs.writeFile(path.join(project, "plots", "stack.fluximg", "pixels", "._zarr.json"), "appledouble");
  const rel = await files.importBundle({ root: project, sourcePath: "plots/stack.fluximg", assetId: "fx_rel" });
  h.eq(rel.sha256, a.sha256, "a project-relative source path works, and OS litter (.DS_Store, ._*) neither copies nor changes the id");
  h.ok(!(await tree(path.join(assets, "fx_rel.fluximg")))[".DS_Store"], "litter is not copied");
  // One byte changes the id.
  const flipped = path.join(scratch, "flipped.fluximg");
  await fs.cp(bundle("stack_u16"), flipped, { recursive: true });
  const shard = Object.keys(srcTree).find((k) => k.startsWith("pixels/0/c/"))!;
  const shardBytes = await fs.readFile(path.join(flipped, shard)); shardBytes[0] ^= 1; await fs.writeFile(path.join(flipped, shard), shardBytes);
  const c = await files.importBundle({ root: project, sourcePath: flipped, assetId: "fx_c" });
  h.ok(c.sha256 !== a.sha256, "changing one byte of one shard changes the content id");

  h.section("import: exclusive destination, cleanup on failure");
  await rejects(files.importBundle({ root: project, sourcePath: bundle("gray2d_u8"), assetId: "fx_a" }), /already exists/, "an existing asset id is refused");
  h.eq(await tree(path.join(assets, "fx_a.fluximg")), srcTree, "…and the existing asset is untouched");
  await fs.mkdir(path.join(assets, "fx_empty.fluximg"));
  await rejects(files.importBundle({ root: project, sourcePath: bundle("gray2d_u8"), assetId: "fx_empty" }), /already exists/, "even an empty existing folder is refused");
  await fs.rmdir(path.join(assets, "fx_empty.fluximg"));
  const before = await assetEntries();
  let calls = 0, stagingSeen: string[] = [];
  await rejects(files.importBundle({ root: project, sourcePath: bundle("sharded_u8"), assetId: "fx_fail", async checkCurrent() {
    stagingSeen = (await assetEntries()).filter((n) => n.includes(".tmp-"));
    if (++calls === 6) throw new Error("project switched");
  } }), /project switched/, "a failure part-way through the copy surfaces");
  h.eq(await assetEntries(), before, "…and leaves no destination and no staging folder behind");
  h.ok(stagingSeen.length === 1 && isFluximgAssetBundlePath(project, path.join(assets, stagingSeen[0])) && isFluximgAssetBundlePath(project, path.join(assets, "fx_a.fluximg", "pixels")),
    `the staging folder (${stagingSeen[0]}) and placed bundles are pruned from the project watcher`);
  h.ok(!isFluximgAssetBundlePath(project, path.join(project, "fig", "index.json")) && !isFluximgAssetBundlePath(project, path.join(project, "plots", "x.fluximg", "fluximg.json")), "…while fig/index.json and plots/ bundles stay watched");
  if (posix && process.getuid?.() !== 0) {
    const locked = path.join(scratch, "locked.fluximg");
    await fs.cp(bundle("sharded_u8"), locked, { recursive: true });
    const victim = path.join(locked, Object.keys(await tree(locked)).filter((k) => k.startsWith("pixels/"))[3]);
    await fs.chmod(victim, 0o000);
    await rejects(files.importBundle({ root: project, sourcePath: locked, assetId: "fx_locked" }), /EACCES|permission/i, "an unreadable file fails the import");
    h.eq(await assetEntries(), before, "…with nothing left in fig/assets");
    await fs.chmod(victim, 0o644);
  }
  await rejects(files.importBundle({ root: project, sourcePath: bundle("sharded_u8"), assetId: "fx_lim", limits: { maxFiles: 3 } }), /more than 3 files/, "the file-count limit refuses before copying");
  await rejects(files.importBundle({ root: project, sourcePath: bundle("sharded_u8"), assetId: "fx_lim", limits: { maxBytes: 1000 } }), /cannot be imported/, "the total-size limit refuses before copying");
  h.eq(await assetEntries(), before, "refused imports create nothing");
  h.ok(rules.FLUXIMG_IMPORT_MAX_FILES === 20000 && rules.FLUXIMG_IMPORT_MAX_BYTES >= 64 * 1024 ** 3, "default limits: 20,000 files and a generous total size");

  h.section("import: refusals");
  await fs.cp(bundle("gray2d_u8"), path.join(outside, "ext.fluximg"), { recursive: true });
  const mk = async (name: string, edit: (dir: string) => Promise<void>) => { const d = path.join(scratch, name); await fs.cp(bundle("gray2d_u8"), d, { recursive: true }); await edit(d); return d; };
  if (posix) {
    const linkFile = await mk("link-file.fluximg", (d) => fs.symlink(path.join(d, "fluximg.json"), path.join(d, "alias.json")));
    await rejects(files.importBundle({ root: project, sourcePath: linkFile, assetId: "fx_x" }), /contains a link \(alias\.json\)/, "a symlinked file inside the bundle is refused, not followed");
    const linkDir = await mk("link-dir.fluximg", (d) => fs.symlink(outside, path.join(d, "layers")));
    await rejects(files.importBundle({ root: project, sourcePath: linkDir, assetId: "fx_x" }), /contains a link \(layers\)/, "a symlinked folder inside the bundle is refused");
    const linkManifest = await mk("link-manifest.fluximg", async (d) => { await fs.rename(path.join(d, "fluximg.json"), path.join(outside, "m.json")); await fs.symlink(path.join(outside, "m.json"), path.join(d, "fluximg.json")); });
    await rejects(files.importBundle({ root: project, sourcePath: linkManifest, assetId: "fx_x" }), /not a fluximg bundle/, "a symlinked fluximg.json is not followed");
    let fifo = "";
    try { fifo = await mk("fifo.fluximg", async (d) => { execFileSync("mkfifo", [path.join(d, "pipe")]); }); } catch { /* no mkfifo */ }
    if (fifo) await rejects(files.importBundle({ root: project, sourcePath: fifo, assetId: "fx_x" }), /neither a file nor a folder/, "a FIFO inside the bundle is refused (never opened)");
    await fs.symlink(path.join(outside, "ext.fluximg"), path.join(project, "plots", "escape.fluximg"));
    await rejects(files.importBundle({ root: project, sourcePath: "plots/escape.fluximg", assetId: "fx_x" }), /points outside the project/, "an in-project link to an outside bundle is refused");
  }
  await rejects(files.importBundle({ root: project, sourcePath: "../outside/ext.fluximg", assetId: "fx_x" }), /must stay inside/, "a relative source path that climbs out of the project is refused");
  await rejects(files.importBundle({ root: project, sourcePath: outside, assetId: "fx_x" }), /no fluximg\.json/, "a folder without fluximg.json is refused");
  const wrongSpec = await mk("wrong-spec.fluximg", async (d) => { const m = JSON.parse(await fs.readFile(path.join(d, "fluximg.json"), "utf8")); m.spec = "fluximg/2"; await fs.writeFile(path.join(d, "fluximg.json"), JSON.stringify(m)); });
  await rejects(files.importBundle({ root: project, sourcePath: wrongSpec, assetId: "fx_x" }), /spec "fluximg\/2"/, "a different spec is refused");
  const badJson = await mk("bad-json.fluximg", (d) => fs.writeFile(path.join(d, "fluximg.json"), "{nope"));
  await rejects(files.importBundle({ root: project, sourcePath: badJson, assetId: "fx_x" }), /not valid JSON/, "an unparseable manifest is refused");
  const huge = await mk("huge.fluximg", async (d) => { await fs.writeFile(path.join(d, "fluximg.json"), ""); await fs.truncate(path.join(d, "fluximg.json"), 8 * 1024 * 1024 + 1); });
  await rejects(files.importBundle({ root: project, sourcePath: huge, assetId: "fx_x" }), /larger than 8 MiB/, "a manifest over 8 MiB is refused before it is read");
  await rejects(files.importBundle({ root: project, sourcePath: path.join(bundle("gray2d_u8"), "fluximg.json"), assetId: "fx_x" }), /is not a folder/, "a file is not a bundle");
  await rejects(files.importBundle({ root: project, sourcePath: path.join(scratch, "nope.fluximg"), assetId: "fx_x" }), /^ENOENT/, "a missing source is ENOENT");
  await fs.writeFile(path.join(project, "fluximg.json"), JSON.stringify({ spec: "fluximg/1" }));
  await rejects(files.importBundle({ root: project, sourcePath: ".", assetId: "fx_x" }), /contains this project's assets folder/, "a source that contains fig/assets is refused (it would copy into itself)");
  await fs.rm(path.join(project, "fluximg.json"));
  for (const bad of ["", "../x", "a/b", "a\\b", ".hidden", "con", "NUL", "x".repeat(182), 5, null, "a\0b"])
    await rejects(files.importBundle({ root: project, sourcePath: bundle("gray2d_u8"), assetId: bad }), /Invalid image asset id/, `asset id ${JSON.stringify(bad)} is refused`);
  for (const good of ["asset_m3x9k2ab_12", "fluximg-0b6f0c5e-1d2a-4c8e-9a51-1f2e3d4c5b6a", "A.b-c_d"]) {
    const r = await files.importBundle({ root: project, sourcePath: bundle("gray2d_u8"), assetId: good });
    h.eq(r.path, `assets/${good}.fluximg`, `asset id ${good} (the shapes Flux mints) is accepted`);
  }
  await rejects(files.importBundle({ root: outside, sourcePath: bundle("gray2d_u8"), assetId: "fx_x" }), /saved Flux project/, "a root that is not a project is refused");
  await rejects(files.importBundle({ root: "relative/root", sourcePath: bundle("gray2d_u8"), assetId: "fx_x" }), /saved Flux project/, "a relative root is refused");
  h.ok(!(await assetEntries()).some((n) => n.includes(".tmp-")), "no refusal leaves a staging folder");

  h.section("readRange");
  const B = "fig/assets/fx_a.fluximg", manifestBytes = await fs.readFile(path.join(assets, "fx_a.fluximg", "fluximg.json"));
  const rr = (p: string, offset: number, length: number, bundle = B) => files.readRange({ root: project, bundle, path: p, offset, length });
  h.ok((await rr("fluximg.json", 0, -1)).equals(manifestBytes), "offset 0, length -1 reads the whole file");
  h.ok((await rr("fluximg.json", 5, 10)).equals(manifestBytes.subarray(5, 15)), "a positive offset and length read exactly those bytes");
  h.ok((await rr("fluximg.json", -10, 10)).equals(manifestBytes.subarray(-10)), "a negative offset counts from the end");
  h.ok((await rr("fluximg.json", -7, -1)).equals(manifestBytes.subarray(-7)), "a negative offset with length -1 reads to the end");
  h.ok((await rr("fluximg.json", 3, -1)).equals(manifestBytes.subarray(3)), "a positive offset with length -1 reads to the end");
  h.eq((await rr("fluximg.json", 0, 0)).length, 0, "length 0 is an empty read (a reader's exists())");
  h.eq((await rr("fluximg.json", manifestBytes.length, 0)).length, 0, "length 0 at the very end is fine");
  await rejects(rr("fluximg.json", manifestBytes.length - 2, 3), /Short read/, "a read past the end is an error, not a short result");
  await rejects(rr("fluximg.json", manifestBytes.length + 1, -1), /Short read/, "an offset past the end is an error");
  await rejects(rr("fluximg.json", -(manifestBytes.length + 1), 1), /cannot be read/, "a negative offset before the start is an error");
  await rejects(rr("fluximg.json", 0, FLUXIMG_READ_LIMIT + 1), /limited to 32 MiB/, "a read over 32 MiB is refused");
  const big = path.join(assets, "fx_a.fluximg", "big.bin");
  await fs.writeFile(big, ""); await fs.truncate(big, FLUXIMG_READ_LIMIT + 5);
  await rejects(rr("big.bin", 0, -1), /limited to 32 MiB/, "length -1 that would exceed 32 MiB is refused");
  h.eq((await rr("big.bin", -FLUXIMG_READ_LIMIT, -1)).length, FLUXIMG_READ_LIMIT, "exactly 32 MiB is allowed");
  await fs.rm(big);
  for (const [o, l] of [[1.5, 1], [0, -2], [0, 1.5], [NaN, 1], ["0", 1], [0, Infinity]] as Array<[unknown, unknown]>)
    await rejects(files.readRange({ root: project, bundle: B, path: "fluximg.json", offset: o, length: l }), /Invalid image read range/, `offset ${String(o)} / length ${String(l)} is refused`);
  await rejects(rr("pixels/0/c/9/9/9", 0, 1), /^ENOENT: no file pixels\/0\/c\/9\/9\/9/, "a missing file's message starts ENOENT (a reader's exists() is false)");
  await rejects(rr("pixels", 0, 1), /not a regular file/, "a folder is not readable");
  for (const p of ["../fx_b.fluximg/fluximg.json", "pixels/../../fx_b.fluximg/fluximg.json", "/etc/passwd", "C:/x", "pixels\\zarr.json", "", "./fluximg.json", "pixels//zarr.json", "a\0b"])
    await rejects(rr(p, 0, 1), /Invalid path inside an image bundle/, `bundle path ${JSON.stringify(p)} is refused`);
  for (const bad of ["fig/x.fluximg", "fig/assets/../x.fluximg", "fig/assets/sub/x.fluximg", "plots", "plots/x", "plots/a.fluximg/b.fluximg", "references/x.fluximg", "/abs/fig/assets/fx_a.fluximg", project + "/fig/assets/fx_a.fluximg", "fig\\assets\\fx_a.fluximg", ".fluximg", "fig/assets/.fluximg"])
    await rejects(rr("fluximg.json", 0, 1, bad), /Invalid image bundle path/, `bundle ${JSON.stringify(bad)} is refused`);
  await rejects(rr("fluximg.json", 0, 1, "fig/assets/nope.fluximg"), /^ENOENT: no image bundle/, "a missing bundle is ENOENT");
  h.ok((await rr("fluximg.json", 0, -1, "plots/stack.fluximg")).equals(await fs.readFile(path.join(project, "plots", "stack.fluximg", "fluximg.json"))), "a bundle under plots/ is readable");
  if (posix) {
    await fs.writeFile(path.join(outside, "secret.txt"), "secret");
    await fs.symlink(path.join(outside, "secret.txt"), path.join(assets, "fx_a.fluximg", "leak"));
    await rejects(rr("leak", 0, -1), /resolves outside its image bundle/, "a link inside the bundle that leaves it is refused");
    await fs.symlink("fluximg.json", path.join(assets, "fx_a.fluximg", "alias.json"));
    h.ok((await rr("alias.json", 0, -1)).equals(manifestBytes), "a link that stays inside the bundle is read");
    await fs.rm(path.join(assets, "fx_a.fluximg", "leak")); await fs.rm(path.join(assets, "fx_a.fluximg", "alias.json"));
    await rejects(rr("fluximg.json", 0, 1, "plots/escape.fluximg"), /resolves outside fig\/assets or plots/, "a plots/ bundle that is a link out of the project is refused");
    await fs.symlink(path.join(assets, "fx_a.fluximg"), path.join(project, "plots", "inner.fluximg"));
    await rejects(rr("fluximg.json", 0, 1, "plots/inner.fluximg"), /resolves outside fig\/assets or plots/, "a plots/ link into fig/assets is held to plots/");
    await fs.mkdir(path.join(project, "plots", "notabundle"));
    await fs.symlink(path.join(project, "plots", "notabundle"), path.join(project, "plots", "fake.fluximg"));
    await rejects(rr("fluximg.json", 0, 1, "plots/fake.fluximg"), /resolves outside/, "a .fluximg link to a folder that is not a .fluximg is refused");
  }

  h.section("the pure reader over readRange");
  for (const n of ["gray2d_u8", "stack_u16", "sparse_f32", "mean_f64_layers", "sharded_u8"]) {
    const id = `dec_${n}`;
    await files.importBundle({ root: project, sourcePath: bundle(n), assetId: id });
    const got = await valuesVia(rangeIO(async (p, o, l) => new Uint8Array(await files.readRange({ root: project, bundle: `fig/assets/${id}.fluximg`, path: p, offset: o, length: l }))));
    const want = (await readValues(bundle(n))).values;
    h.ok(sameValues(got, want), `${n}: openFluximg over readRange decodes the same values as over the source folder`);
    const f = byName.get(n)!;
    if (f.expectEncoding === "exact") h.ok(sameValues(got, Float64Array.from(f.data as ArrayLike<number>)), `${n}: …which are the values the writer was given`);
  }

  h.section("discardBundle");
  await fs.writeFile(path.join(assets, "fx_b.fluximg.json"), "neighbour");
  await files.discardBundle({ root: project, assetId: "fx_b" });
  h.ok(!(await assetEntries()).includes("fx_b.fluximg"), "the target bundle is removed");
  h.eq(await tree(path.join(assets, "fx_a.fluximg")), srcTree, "a sibling bundle is untouched");
  h.ok((await assetEntries()).includes("fx_b.fluximg.json") && !(await assetEntries()).some((n) => n.includes(".tmp-")), "a same-prefix file is untouched and nothing is left aside");
  await files.discardBundle({ root: project, assetId: "fx_b" });
  h.ok(true, "discarding a missing asset is a no-op");
  for (const bad of ["../fx_a", "fx_a/..", "", "a\\b"]) await rejects(files.discardBundle({ root: project, assetId: bad }), /Invalid image asset id/, `discard refuses asset id ${JSON.stringify(bad)}`);
  await fs.writeFile(path.join(project, "fig", "index.json"), JSON.stringify({ assets: [{ id: "fx_a", kind: "fluximg", path: "assets/fx_a.fluximg" }] }));
  await rejects(files.discardBundle({ root: project, assetId: "fx_a" }), /saved in this project/, "an asset listed in fig/index.json is never discarded");
  await fs.writeFile(path.join(project, "fig", "index.json"), "{broken");
  await rejects(files.discardBundle({ root: project, assetId: "fx_a" }), /cannot be read/, "an unreadable fig/index.json refuses (ownership unknown)");
  await fs.writeFile(path.join(project, "fig", "index.json"), JSON.stringify({ assets: [] }));
  h.eq(await tree(path.join(assets, "fx_a.fluximg")), srcTree, "…and those refusals removed nothing");
  if (posix) {
    await fs.mkdir(path.join(outside, "victim")); await fs.writeFile(path.join(outside, "victim", "keep.txt"), "keep");
    await fs.symlink(path.join(outside, "victim"), path.join(assets, "fx_link.fluximg"));
    await rejects(files.discardBundle({ root: project, assetId: "fx_link" }), /not a folder/, "a link at the asset path is refused, never followed");
    h.ok(await fs.readFile(path.join(outside, "victim", "keep.txt"), "utf8") === "keep", "…and its target survives");
    await fs.rm(path.join(assets, "fx_link.fluximg"));
    await fs.symlink(path.join(outside, "victim"), path.join(assets, "fx_c.fluximg", "pixels", "trap"));
    await files.discardBundle({ root: project, assetId: "fx_c" });
    h.ok(await fs.readFile(path.join(outside, "victim", "keep.txt"), "utf8") === "keep", "a link inside a discarded bundle is removed, its target is not");
  }

  h.section("IPC family: per-window project checks");
  const handlers = new Map<string, (...args: any[]) => any>();
  const sender = Object.assign(new EventEmitter(), { id: 41, isDestroyed: () => false });
  let currentRoot = project, generation = 1;
  const fileCore = createFileCore({ app: { getPath: (kind: string) => path.join(scratch, `app-${kind}`) }, dialog: {}, shell: {}, roots: () => [project], windowFor: () => null });
  createFluximgCore({ rootFor: () => currentRoot, generationFor: () => generation, fsReadGuard: fileCore.fsReadGuard }).registerHandlers({ handle: (n: string, fn: (...args: any[]) => any) => handlers.set(n, fn) });
  // fluximg:importDropped (verify-fluximg-import covers it): an OS drop of a bundle folder, path from the preload.
  h.eq([...handlers.keys()].sort(), ["fluximg:discard", "fluximg:import", "fluximg:importDropped", "fluximg:read"], "the family registers exactly its four channels");
  const call = (n: string, payload: unknown) => Promise.resolve().then(() => handlers.get(`fluximg:${n}`)!({ sender }, payload));
  const read = await call("read", { root: project, bundle: B, path: "fluximg.json", offset: 2, length: 9 });
  h.ok(read instanceof ArrayBuffer && read.byteLength === 9 && Buffer.from(read).equals(manifestBytes.subarray(2, 11)), "fluximg:read returns an ArrayBuffer sized exactly to the bytes read");
  const small = await call("read", { root: project, bundle: B, path: "fluximg.json", offset: 0, length: 1 });
  h.ok(small instanceof ArrayBuffer && small.byteLength === 1, "a 1-byte read is a 1-byte ArrayBuffer (no pooled slab leaks out)");
  await rejects(call("read", { root: outside, bundle: B, path: "fluximg.json", offset: 0, length: 1 }), /project changed/, "a root other than the window's project is refused");
  await rejects(call("read", null), /project changed/, "a missing request is refused");
  await rejects(call("import", { root: project, sourcePath: path.join(outside, "ext.fluximg"), assetId: "fx_ipc" }), /refused path|outside/, "importing from outside the project needs the window's read capability");
  fileCore.approveDir(sender.id, path.join(outside, "ext.fluximg"));
  const ipcImport = await call("import", { root: project, sourcePath: path.join(outside, "ext.fluximg"), assetId: "fx_ipc", limits: { maxFiles: 0 }, tryClone: false });
  h.ok(ipcImport.sha256 === (await files.importBundle({ root: project, sourcePath: bundle("gray2d_u8"), assetId: "fx_ipc2" })).sha256, "…granted by a dialog, it imports (renderer-sent limits/options are ignored)");
  {
    let n = 0;
    const realRead = files.readRange;
    files.readRange = async (req: any) => { const r = await realRead(req); if (++n === 1) generation++; return r; };
    await rejects(call("read", { root: project, bundle: B, path: "fluximg.json", offset: 0, length: 1 }), /project changed/, "bytes read while the project was reopened are not returned");
    files.readRange = realRead;
  }
  await call("discard", { root: project, assetId: "fx_ipc2" });
  h.ok(!(await assetEntries()).includes("fx_ipc2.fluximg"), "fluximg:discard removes the asset");
  currentRoot = outside;
  await rejects(call("discard", { root: project, assetId: "fx_ipc" }), /project changed/, "discard is bound to the window's project too");
  currentRoot = project;

  h.section("timings");
  {
    const perf = path.join(scratch, "perf.fluximg");
    await fs.mkdir(path.join(perf, "pixels"), { recursive: true });
    await fs.writeFile(path.join(perf, "fluximg.json"), JSON.stringify({ spec: "fluximg/1", name: "perf" }));
    const chunk = Buffer.alloc(256 * 1024);
    for (let i = 0; i < 400; i++) { chunk.writeUInt32LE(i, 0); await fs.writeFile(path.join(perf, "pixels", `s${i}`), chunk); }
    let t = performance.now();
    const r = await files.importBundle({ root: project, sourcePath: perf, assetId: "perf" });
    const ms = performance.now() - t;
    h.ok(r.files === 401, `import of 401 files / ${(r.bytes / 1048576).toFixed(0)} MiB: ${ms.toFixed(0)} ms by ${r.method} (${(r.bytes / 1048576 / (ms / 1000)).toFixed(0)} MiB/s incl. hashing and fsync)`);
    t = performance.now();
    for (let i = 0; i < 1000; i++) await files.readRange({ root: project, bundle: "fig/assets/perf.fluximg", path: `pixels/s${i % 400}`, offset: -4096, length: 4096 });
    h.ok(true, `1000 ranged 4 KiB reads (path checks included): ${((performance.now() - t) / 1000).toFixed(3)} ms each`);
  }

  h.section("in-memory bridge: same semantics, same messages, same content id");
  const mem = createMemBridge(), mroot = "/memproject";
  const enc = new TextEncoder();
  mem._files.set(`${mroot}/project.json`, enc.encode(JSON.stringify({ schemaVersion: "0.7.0" })));
  mem._files.set(`${mroot}/fig/index.json`, enc.encode(JSON.stringify({ assets: [] })));
  await mem.watchRoot!(mroot);
  const asSeed = async (dir: string) => Object.fromEntries(await Promise.all(Object.keys(await tree(dir)).map(async (k) => [k, Buffer.from(await fs.readFile(path.join(dir, k))).toString("base64")] as const)));
  h.eq(mem._seedFluximg(mroot, "plots/stack.fluximg", await asSeed(bundle("stack_u16"))), `${mroot}/plots/stack.fluximg`, "_seedFluximg (base64 files) seeds a bundle under plots/");
  mem._seedFluximg(mroot, "plots/sub/gray.fluximg", await asSeed(bundle("gray2d_u8")));
  mem._files.set(`${mroot}/plots/stack.fluximg/.DS_Store`, enc.encode("finder"));
  const m = await mem.importFluximg!({ root: mroot, sourcePath: "plots/stack.fluximg", assetId: "fx_a" });
  h.eq(m.sha256, a.sha256, "the memory bridge computes the native content id for the same bundle");
  h.eq({ path: m.path, files: m.files, bytes: m.bytes, method: m.method }, { path: a.path, files: a.files, bytes: a.bytes, method: "copy" }, "…and the same path, counts and bytes");
  h.eq(m.manifest, a.manifest, "…and the same manifest");
  const mAbs = await mem.importFluximg!({ root: mroot, sourcePath: `${mroot}/plots/sub/gray.fluximg`, assetId: "fx_g" });
  h.eq(mAbs.sha256, contentId(await tree(bundle("gray2d_u8"))), "an absolute source path works too");
  const mr = async (p: string, o: number, l: number, bundle = B) => new Uint8Array(await mem.readFluximg!({ root: mroot, bundle, path: p, offset: o, length: l }));
  for (const [o, l] of [[0, -1], [5, 10], [-10, 10], [-7, -1], [0, 0]]) {
    const got = await mr("fluximg.json", o, l), want = await rr("fluximg.json", o, l);
    h.ok(Buffer.from(got).equals(want), `memory read (${o}, ${l}) returns the native bytes`);
  }
  const memBuf = await mem.readFluximg!({ root: mroot, bundle: B, path: "fluximg.json", offset: 1, length: 3 });
  h.ok(memBuf instanceof ArrayBuffer && memBuf.byteLength === 3, "memory reads return an exactly sized ArrayBuffer");
  const memValues = await valuesVia(rangeIO((p, o, l) => mr(p, o, l)));
  h.ok(sameValues(memValues, (await readValues(bundle("stack_u16"))).values), "openFluximg over the memory bridge decodes the expected values");
  // Same refusals, same words: each request goes to the native IPC family and to the memory bridge.
  mem._files.set(`${mroot}/plots/notabundle/readme.txt`, enc.encode("x"));
  await fs.mkdir(path.join(project, "plots", "notabundle"), { recursive: true });
  mem._seedFluximg(mroot, "plots/wrongspec.fluximg", { "fluximg.json": Buffer.from(JSON.stringify({ spec: "fluximg/2" })).toString("base64") });
  await fs.mkdir(path.join(project, "plots", "wrongspec.fluximg"), { recursive: true });
  await fs.writeFile(path.join(project, "plots", "wrongspec.fluximg", "fluximg.json"), JSON.stringify({ spec: "fluximg/2" }));
  mem._files.set(`${mroot}/plots/file.txt`, enc.encode("x")); await fs.writeFile(path.join(project, "plots", "file.txt"), "x");
  const cases: Array<[string, Record<string, unknown>]> = [
    ["import", { assetId: "../x", sourcePath: "plots/stack.fluximg" }],
    ["import", { assetId: "fx_a", sourcePath: "plots/stack.fluximg" }],
    ["import", { assetId: "fx_n", sourcePath: "../elsewhere.fluximg" }],
    ["import", { assetId: "fx_n", sourcePath: "plots/missing.fluximg" }],
    ["import", { assetId: "fx_n", sourcePath: "plots/notabundle" }],
    ["import", { assetId: "fx_n", sourcePath: "plots/wrongspec.fluximg" }],
    ["import", { assetId: "fx_n", sourcePath: "plots/file.txt" }],
    ["import", { assetId: "fx_n", sourcePath: "." }],
    ["import", { assetId: "fx_n", sourcePath: "" }],
    ["read", { bundle: "fig/assets/../x.fluximg", path: "fluximg.json", offset: 0, length: 1 }],
    ["read", { bundle: "plots/a.fluximg/b.fluximg", path: "fluximg.json", offset: 0, length: 1 }],
    ["read", { bundle: B, path: "../x", offset: 0, length: 1 }],
    ["read", { bundle: B, path: "fluximg.json", offset: 0.5, length: 1 }],
    ["read", { bundle: B, path: "fluximg.json", offset: 0, length: FLUXIMG_READ_LIMIT + 1 }],
    ["read", { bundle: B, path: "fluximg.json", offset: 0, length: 1e6 }],
    ["read", { bundle: B, path: "fluximg.json", offset: -1e6, length: 1 }],
    ["read", { bundle: B, path: "pixels/nope", offset: 0, length: 1 }],
    ["read", { bundle: B, path: "pixels", offset: 0, length: 1 }],
    ["read", { bundle: "fig/assets/nope.fluximg", path: "fluximg.json", offset: 0, length: 1 }],
    ["discard", { assetId: "a/b" }],
  ];
  for (const [kind, req] of cases) {
    const native = await call(kind, { root: project, ...req }).then(() => "(ok)", (e: Error) => e.message);
    const memory = await (kind === "import" ? mem.importFluximg!({ root: mroot, ...req } as any) : kind === "read" ? mem.readFluximg!({ root: mroot, ...req } as any) : mem.discardFluximg!({ root: mroot, ...req } as any))
      .then(() => "(ok)", (e: Error) => e.message);
    h.ok(native !== "(ok)" && native === memory, native === memory ? `${kind} ${JSON.stringify(req).slice(0, 90)} → both refuse: ${native.slice(0, 80)}` : `${kind} ${JSON.stringify(req)}: native "${native}" vs memory "${memory}"`);
  }
  await rejects(mem.readFluximg!({ root: "/elsewhere", bundle: B, path: "fluximg.json", offset: 0, length: 1 }), /project changed/, "memory reads are bound to the open project");
  mem._files.set(`${mroot}/fig/index.json`, enc.encode(JSON.stringify({ assets: [{ id: "fx_a" }] })));
  await rejects(mem.discardFluximg!({ root: mroot, assetId: "fx_a" }), /saved in this project/, "memory discard refuses a saved asset");
  mem._files.set(`${mroot}/fig/index.json`, enc.encode(JSON.stringify({ assets: [] })));
  mem._files.set(`${mroot}/fig/assets/fx_a.fluximg.json`, enc.encode("neighbour"));
  await mem.discardFluximg!({ root: mroot, assetId: "fx_a" });
  h.ok(![...mem._files.keys()].some((k) => k.startsWith(`${mroot}/fig/assets/fx_a.fluximg/`)) && !mem._dirs.has(`${mroot}/fig/assets/fx_a.fluximg`), "memory discard removes the bundle's files and folders");
  h.ok(mem._files.has(`${mroot}/fig/assets/fx_a.fluximg.json`) && [...mem._files.keys()].some((k) => k.startsWith(`${mroot}/fig/assets/fx_g.fluximg/`)), "…and nothing else");
  await mem.discardFluximg!({ root: mroot, assetId: "fx_a" });
  h.ok(true, "memory discard of a missing asset is a no-op");
} catch (error) {
  h.fail(`unexpected: ${error instanceof Error ? error.stack : String(error)}`);
}
await h.done(async () => {
  if (process.platform !== "win32") await fs.chmod(scratch, 0o755).catch(() => {});
  await fs.rm(scratch, { recursive: true, force: true });
});
