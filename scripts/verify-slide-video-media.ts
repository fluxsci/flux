import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { harness } from "./lib/harness.mjs";
const require = createRequire(import.meta.url);
const media = require("../electron/videoMedia.cjs");
const h = harness("verify-slide-video-media");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-media-pure-"));
try {
  const fixture = path.resolve("scripts/fixtures/slide-video-clips/moving-box.mp4");
  const info = await media.probeVideo(fixture);
  assert.deepEqual(info, { width: 160, height: 90, durationMs: 1200, hasAudio: true });
  h.ok(true, "MP4 metadata reads exact dimensions, picture duration and audio presence");
  assert.deepEqual(media.byteRange(undefined, 100), { start: 0, end: 99, partial: false });
  assert.deepEqual(media.byteRange("bytes=12-18", 100), { start: 12, end: 18, partial: true });
  assert.deepEqual(media.byteRange("bytes=90-", 100), { start: 90, end: 99, partial: true });
  assert.deepEqual(media.byteRange("bytes=-10", 100), { start: 90, end: 99, partial: true });
  assert.deepEqual(media.byteRange("bytes=90-200", 100), { start: 90, end: 99, partial: true });
  for (const input of ["bytes=100-", "bytes=50-20", "bytes=-0", "bytes=-", "bytes=1-2,8-9", "bytes=9007199254740993-", "wat"]) assert.equal(media.byteRange(input, 100), null, input);
  assert.equal(media.byteRange(undefined, 0), null);
  h.ok(true, "bounded, open-ended, suffix, clipped and invalid HTTP ranges");
  await fs.mkdir(path.join(root, "plots/_videos"), { recursive: true });
  await fs.copyFile(fixture, path.join(root, "plots/_videos/clip.mp4"));
  assert.equal(await media.projectFile(root, "plots/_videos/clip.mp4"), await fs.realpath(path.join(root, "plots/_videos/clip.mp4")));
  for (const relative of ["../../outside.mp4", "/tmp/escape.mp4", "plots\\escape.mp4", "plots/\0evil"]) await assert.rejects(() => media.projectFile(root, relative));
  await fs.symlink(fixture, path.join(root, "plots/_videos/escape.mp4"));
  await assert.rejects(() => media.projectFile(root, "plots/_videos/escape.mp4"), /escapes/);
  h.ok(true, "project-relative paths and symlinks cannot escape their source project");
  const invalid = path.join(root, "invalid.mov");
  for (const bytes of [Buffer.from("not a video"), Buffer.from([255, 255, 255, 255, 109, 111, 111, 118]), Buffer.from([0, 0, 0, 1, 109, 111, 111, 118])]) { await fs.writeFile(invalid, bytes); await assert.rejects(() => media.probeVideo(invalid)); }
  h.ok(true, "malformed and truncated movie boxes fail without unbounded allocations");
  // Real sparse media body: metadata near EOF must not cause a body read. The
  // original moov is enough; no encoder or large checked-in fixture is needed.
  const bytes = await fs.readFile(fixture); let at = 0, moov: Buffer | undefined;
  while (at + 8 <= bytes.length) { const n = bytes.readUInt32BE(at); if (bytes.toString("ascii", at + 4, at + 8) === "moov") moov = bytes.subarray(at, at + n); at += n; }
  assert.ok(moov);
  const atom = (name: string, body: Buffer) => { const header = Buffer.alloc(8); header.writeUInt32BE(body.length + 8); header.write(name, 4); return Buffer.concat([header, body]); };
  const fragmentedMoov = Buffer.from(moov);
  const mdhd = fragmentedMoov.indexOf("mdhd"); fragmentedMoov.writeUInt32BE(0, mdhd + 4 + 16);
  const tkhd = fragmentedMoov.indexOf("tkhd"); fragmentedMoov.writeUInt32BE(0, tkhd + 4 + 20);
  const tfhd = Buffer.alloc(12); tfhd.writeUInt32BE(8); tfhd.writeUInt32BE(1, 4); tfhd.writeUInt32BE(512, 8);
  const trun = Buffer.alloc(8); trun.writeUInt32BE(36, 4);
  const fragment = atom("moof", atom("traf", Buffer.concat([atom("tfhd", tfhd), atom("tfdt", Buffer.alloc(8)), atom("trun", trun)])));
  const fragmented = path.join(root, "fragmented.mp4"); await fs.writeFile(fragmented, Buffer.concat([fragmentedMoov, fragment]));
  assert.deepEqual(await media.probeVideo(fragmented), info);
  h.ok(true, "fragmented MP4 derives timing from bounded track fragment metadata");
  const sparse = path.join(root, "large.mp4"), bodySize = 2 * 1024 * 1024 * 1024, head = Buffer.alloc(8); head.writeUInt32BE(bodySize); head.write("mdat", 4);
  const file = await fs.open(sparse, "w"); await file.write(head, 0, head.length, 0); await file.write(moov, 0, moov.length, bodySize); await file.close();
  assert.deepEqual(await media.probeVideo(sparse), info);
  h.ok(true, "metadata probe skips a 2 GB media body by offset");
  const before = await fs.readFile(fixture);
  await assert.rejects(() => media.cleanupPrepared(root, "deck", { asset: { id: "../../bad", path: "../../bad", kind: "mp4" }, posterAsset: {} }));
  assert.deepEqual(await fs.readFile(fixture), before);
  h.ok(true, "cleanup refuses forged prepared-asset paths");
} catch (error) { h.fail(String(error)); }
finally { await fs.rm(root, { recursive: true, force: true }); }
await h.done();
