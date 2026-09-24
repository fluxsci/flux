import fs from "node:fs/promises";
import "./cssStub.mjs";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { writeVideoFixture } from "./slideVideoFixture";
import { addVideoToSlide, loadDeck, setVideoTrack, gatherDeckPayload } from "../../flux-core/slides";
import { createSlideRepository } from "../../src/lib/slide/embedRepository";
import { prepareSlideDocument } from "../../src/lib/slide/embedDocument";
import { newSlideEmbed, serializeSlideEmbed } from "../../src/lib/slide/embed";
import { nodeSlideRepository } from "../../flux-core/slideEmbeds";
const require = createRequire(import.meta.url), media = require("../../electron/videoMedia.cjs");
const scratch = process.env.PROBE_SCRATCH!;
if (!scratch || !process.env.HOME?.startsWith(scratch)) throw new Error("Headless video test requires an isolated home");
const root = path.join(scratch, "headless-project");
await writeVideoFixture(root); await fs.mkdir(path.join(root, "plots/_videos"), { recursive: true });
await fs.copyFile(path.resolve("scripts/fixtures/slide-video-clips/moving-box.mp4"), path.join(root, "plots/_videos/source.mp4"));
const deckFile = path.join(root, "slides/video-deck/deck.json"), assetsDir = path.join(root, "slides/video-deck/assets");
const result = await addVideoToSlide(root, "video-deck", "motion", { sourcePath: "plots/_videos/source.mp4", x: 25, y: 40, width: 200 });
await setVideoTrack(root, "video-deck", "motion", "move", result.elementId, "start");
const deck = await loadDeck(root, "video-deck"), element = deck.slides[0].elements.find(e => e.id === result.elementId)!;
assert.equal(element.type, "video"); assert.equal(element.x, 25); assert.equal(element.y, 40); assert.equal(element.width, 200); assert.equal(element.height, 112.5);
assert.ok(deck.assets.some(a => a.id === result.assetId && a.kind === "mp4" && a.sourcePath === "plots/_videos/source.mp4"));
assert.ok(deck.slides[0].beats[1].tracks.some(t => t.target === result.elementId && t.preset === "videoStart"));
const payload = await gatherDeckPayload(root, "video-deck", "motion", { refreshSources: false });
assert.ok(payload.payload.videos?.[result.assetId]?.startsWith("data:video/mp4;base64,"));
assert.equal(payload.warnings.length, 0);
const saved = await fs.readFile(deckFile), names = await fs.readdir(assetsDir);
await assert.rejects(() => addVideoToSlide(root, "video-deck", "motion", { sourcePath: "plots/_videos/source.mp4", width: -1 }), /geometry/);
assert.deepEqual(await fs.readFile(deckFile), saved); assert.deepEqual(await fs.readdir(assetsDir), names);
const cancelled = new AbortController(); cancelled.abort();
await assert.rejects(() => addVideoToSlide(root, "video-deck", "motion", { sourcePath: "plots/_videos/source.mp4", signal: cancelled.signal }), /cancelled/);
assert.deepEqual(await fs.readdir(assetsDir), names);
console.log("PROBE headless shared preparation, geometry, locked persistence, commands, portable payload, and failed-mutation cleanup");

// Run the actual bundled command from a source-free package-shaped directory.
// This catches dynamic native requires that accidentally resolve the checkout.
const unpacked = path.join(scratch, "resources/app.asar.unpacked"), encoderDir = path.join(scratch, "resources/video-encoder");
await fs.mkdir(path.join(unpacked, "dist"), { recursive: true }); await fs.mkdir(path.join(unpacked, "electron"), { recursive: true }); await fs.mkdir(encoderDir, { recursive: true });
await fs.copyFile(path.resolve("dist/flux-cli.mjs"), path.join(unpacked, "dist/flux-cli.mjs"));
await fs.copyFile(path.resolve("dist/flux-cli-core.mjs"), path.join(unpacked, "dist/flux-cli-core.mjs")); // the launcher's bundle
await fs.copyFile(path.resolve("electron/videoMedia.cjs"), path.join(unpacked, "electron/videoMedia.cjs"));
const encoder = media.encoderPath(); await fs.copyFile(encoder, path.join(encoderDir, path.basename(encoder))); await fs.chmod(path.join(encoderDir, path.basename(encoder)), 0o755);
const env = { ...process.env }; delete env.FLUX_VIDEO_APP_ROOT; delete env.FLUX_VIDEO_ENCODER;
const output = execFileSync(process.execPath, [path.join(unpacked, "dist/flux-cli.mjs"), "add-video", "video-deck", "motion", "plots/_videos/source.mp4", "--root", root, "--width", "320", "--muted"], { env, cwd: scratch, encoding: "utf8", timeout: 30000 }).trim();
const latest = await loadDeck(root, "video-deck"), imported = latest.slides[0].elements.find(e => e.id === output)!;
assert.equal(imported?.type, "video"); if (imported.type !== "video") throw new Error("Expected video");
assert.equal(imported.width, 320); assert.equal(imported.muted, true);
assert.ok(await fs.stat(path.join(root, "slides/video-deck", latest.assets.find(a => a.id === imported.assetId)!.path)));
console.log("PROBE packaged-shaped source-free bundled CLI add-video resolves native tools and persists playable assets");

let movieReads = 0;
const repo = createSlideRepository(root, {
  readText: file => fs.readFile(file, "utf8"),
  readFile: async file => { if (file.endsWith(".mp4")) movieReads++; return fs.readFile(file); },
  videoUrl: async (_file, asset) => `flux-media://video/authoring-${asset.id}`,
});
const ref = newSlideEmbed("paper/report.qmd", "video-deck", "motion"), text = serializeSlideEmbed(ref);
const streamed = await repo.load(ref);
assert.ok(Object.values(streamed.payload.videos ?? {}).every(value => value.startsWith("flux-media:"))); assert.equal(movieReads, 0);
await prepareSlideDocument(text, repo, { strict: true, interactive: false }); assert.equal(movieReads, 0, "PDF/still exports do not read movie bytes");
const preparedDocument = await prepareSlideDocument(`${text}\n\n${text}`, repo, { strict: true, interactive: true });
assert.ok(!preparedDocument.tail.includes("flux-media:"), "saved HTML must not contain native stream capabilities");
assert.ok(preparedDocument.tail.includes("data:video/mp4;base64,")); assert.equal(movieReads, 2, "duplicate embeds read each of the two clip assets once");
assert.equal(await repo.load(ref), streamed, "portable export must not replace streamed authoring cache");
const runtime = /<script>([\s\S]*?)<\/script>/.exec(preparedDocument.tail)![1];
const hash = createHash("sha256").update(runtime).digest("base64");
const documentHtml = `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${hash}'; img-src data:; media-src data:; style-src 'unsafe-inline'; font-src data:">${preparedDocument.style}</head><body>${preparedDocument.blocks.map(b => b.html).join("\n")}${preparedDocument.tail}</body></html>`;
await fs.writeFile(process.env.PROBE_PORTABLE!, documentHtml);
repo.dispose();
console.log("PROBE strict interactive Paper export embeds video bytes once; authoring stays streamed and static exports read no movie bytes");
const nodeRepo = await nodeSlideRepository(root), nodeStatic = await nodeRepo.materialize(ref);
assert.ok(Object.values(nodeStatic.payload.videos ?? {}).every(url => url.startsWith("file:")), "Node poster materialization references files without inlining movie bytes");
const nodePortable = await prepareSlideDocument(text, nodeRepo, { strict: true, interactive: true });
assert.ok(nodePortable.tail.includes("data:video/mp4;base64,"));
assert.ok(!Object.values(JSON.parse(/<script type="application\/json" id="flux-slide-data">(.*?)<\/script>/s.exec(nodePortable.tail)![1]).payloads).some((payload: any) => Object.values(payload.videos ?? {}).some((url: any) => url.startsWith("file:"))));
nodeRepo.dispose();
console.log("PROBE Node static materialization stays file-backed; interactive CLI/Quarto payloads remain portable");

// Exercise the actual renderer duplication adapter with native disk copying.
// Reading any required movie/poster through renderer bytes is a test failure.
const protectedPaths = new Set(latest.assets.filter(a => a.kind === "mp4" || a.id.endsWith("-poster")).map(a => path.join(root, "slides/video-deck", a.path)));
let duplicateCopies = 0;
(globalThis as any).window = { fig: {
  exists: (file: string) => fs.access(file).then(() => true, () => false),
  mkdir: (directory: string) => fs.mkdir(directory, { recursive: true }),
  readText: (file: string) => fs.readFile(file, "utf8"),
  writeText: (file: string, text: string) => fs.writeFile(file, text),
  remove: (file: string) => fs.rm(file, { recursive: true, force: true }),
  fsyncDir: async (directory: string) => { const handle = await fs.open(directory, "r"); try { await handle.sync(); } finally { await handle.close(); } },
  readFile: async (file: string) => { assert.ok(!protectedPaths.has(file), "movie/poster must never pass through renderer bytes"); return fs.readFile(file); },
  writeFile: (file: string, bytes: Uint8Array) => fs.writeFile(file, bytes),
  copySlideVideoAssets: async (request: any) => { duplicateCopies++; await media.copyVideoAssets(request); },
} };
const { duplicateDeckInProject } = await import("../../src/lib/project/slideBridge");
const originalDeckBytes = await fs.readFile(deckFile), beforeDuplicate = await fs.readFile(path.join(root, "project.json"));
const duplicateId = await duplicateDeckInProject(root, "video-deck");
assert.ok(duplicateId); assert.equal(duplicateCopies, 1);
const duplicatedDeck = await loadDeck(root, duplicateId!);
for (const asset of latest.assets.filter(a => a.kind === "mp4" || a.id.endsWith("-poster"))) {
  assert.deepEqual(await fs.readFile(path.join(root, "slides", duplicateId!, asset.path)), await fs.readFile(path.join(root, "slides/video-deck", asset.path)));
}
assert.equal(duplicatedDeck.slides[0].elements.filter(e => e.type === "video").length, 2);
assert.deepEqual(await fs.readFile(deckFile), originalDeckBytes, "duplicate never edits source deck");
const manifestAfterDuplicate = await fs.readFile(path.join(root, "project.json"));
assert.notDeepEqual(manifestAfterDuplicate, beforeDuplicate);
const missingPoster = latest.assets.find(a => a.id.endsWith("-poster"))!;
const missingPosterPath = path.join(root, "slides/video-deck", missingPoster.path), savedPoster = await fs.readFile(missingPosterPath);
const decksBeforeFailure = new Set(await fs.readdir(path.join(root, "slides")));
await fs.unlink(missingPosterPath);
try {
  await assert.rejects(() => duplicateDeckInProject(root, "video-deck"), /ENOENT/);
  assert.deepEqual(await fs.readFile(path.join(root, "project.json")), manifestAfterDuplicate, "failed copy does not publish a manifest entry");
  for (const name of await fs.readdir(path.join(root, "slides"))) if (!decksBeforeFailure.has(name)) {
    assert.equal(await fs.stat(path.join(root, "slides", name, "deck.json")).then(() => true, () => false), false, "failed copy does not publish a deck");
    assert.deepEqual(await fs.readdir(path.join(root, "slides", name, "assets")), [], "failed copy removes newly owned media and temporary files");
  }
} finally { await fs.writeFile(missingPosterPath, savedPoster); }
const missingMetadata = structuredClone(latest);
missingMetadata.assets = missingMetadata.assets.filter(a => a.id !== missingPoster.id);
await fs.writeFile(deckFile, JSON.stringify(missingMetadata));
try {
  await assert.rejects(() => duplicateDeckInProject(root, "video-deck"), /metadata is missing/);
  assert.deepEqual(await fs.readFile(path.join(root, "project.json")), manifestAfterDuplicate);
} finally { await fs.writeFile(deckFile, originalDeckBytes); }
console.log("PROBE actual deck duplication keeps movie/poster bytes native, copies independent files, and rolls back missing media without publishing");
