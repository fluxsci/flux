"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const media = require("../electron/videoMedia.cjs");
const { createHdrFixture, verifyHdrOutput } = require("./lib/hdrMediaFixture.cjs");
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-hdr-calibration-"));
  const artifacts = path.resolve("test-results/slide-video-clips/hdr-calibration");
  await fs.mkdir(artifacts, { recursive: true }); await fs.mkdir(path.join(root, "slides/test.deck"), { recursive: true });
  try {
    for (const kind of ["pq", "hlg"]) {
      const rel = `plots/${kind}.mov`, source = path.join(root, rel), calibration = await createHdrFixture(media.encoderPath(), source, kind);
      const before = await fs.readFile(source), info = await media.probeVideo(source);
      assert.equal(info.hdrTransfer, kind); assert.equal(info.width, calibration.width); assert.equal(info.height, calibration.height); assert.equal(info.durationMs, 1200);
      const prepared = await media.prepareVideo({ root, deckId: "test.deck", sourcePath: rel });
      const clip = path.join(root, "slides/test.deck", prepared.asset.path), poster = path.join(root, "slides/test.deck", prepared.posterAsset.path);
      assert.equal((await media.probeVideo(clip)).hdrTransfer, undefined);
      const evidence = verifyHdrOutput(media.encoderPath(), clip, calibration, poster);
      assert.deepEqual(await fs.readFile(source), before, "original calibrated bytes unchanged");
      await fs.copyFile(source, path.join(artifacts, `${kind}-source.mov`)); await fs.copyFile(clip, path.join(artifacts, `${kind}-sdr.mp4`)); await fs.copyFile(poster, path.join(artifacts, `${kind}-poster.png`));
      await fs.writeFile(path.join(artifacts, `${kind}-evidence.json`), JSON.stringify(evidence, null, 2));
      await media.cleanupPrepared(root, "test.deck", prepared);
      console.log(`${kind}: input signal calibrated, 36 decoded frames plus poster agree with independent Hable/gamut/display reference; max RGB error ${evidence.maxChannelError}/255`);
    }
    console.log("CALIBRATED HDR MEDIA: PASS (PQ + HLG)");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
