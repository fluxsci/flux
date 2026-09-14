"use strict";
const { app, BrowserWindow, protocol, net } = require("electron");
const fs = require("node:fs/promises"), path = require("node:path"), assert = require("node:assert/strict"), { execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const media = require("../../electron/videoMedia.cjs");
const { createVideoMediaCore } = require("../../electron/ipc/videoMedia.cjs");
const { createFileCore } = require("../../electron/ipc/files.cjs");
const root = process.env.PROBE_PROJECT, scratch = process.env.PROBE_SCRATCH;
app.setPath("userData", path.join(scratch, "profile"));
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
protocol.registerSchemesAsPrivileged([{ scheme: "flux-media", privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } }]);
let currentRoot = root, revokeOnCopy = null;
const files = createFileCore({ app, roots: () => [currentRoot], setPendingRoot: () => {} });
const core = createVideoMediaCore({ app, protocol, rootFor: () => revokeOnCopy && existsSync(revokeOnCopy) ? path.join(scratch, "different-project") : currentRoot, fsReadGuard: files.fsReadGuard, noteWrite: files.noteWrite });
const handlers = new Map(); core.registerHandlers({ handle: (name, callback) => handlers.set(name, callback) });
process.stdin.resume(); process.stdin.on("end", () => { core.cancelAll(); app.exit(1); });
const watchdog = setTimeout(() => { console.error("native media watchdog"); core.cancelAll(); app.exit(1); }, 90000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 640, height: 480, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const e = { sender: window.webContents };
  try {
    const source = path.join(root, "plots/_videos/original.mp4"), mov = path.join(root, "plots/_videos/prores.mov");
    const encoder = media.encoderPath();
    execFileSync(encoder, ["-v", "error", "-i", source, "-c:v", "prores_ks", "-profile:v", "1", "-pix_fmt", "yuv422p10le", "-c:a", "pcm_s16le", "-threads", "2", "-y", mov], { timeout: 20000 });
    const sourceBytes = await fs.readFile(source), movieBytes = await fs.readFile(mov);
    const preview = await handlers.get("slides:videoPreview")(e, mov);
    assert.equal(preview.width, 160); assert.equal(preview.height, 90); assert.equal(preview.durationMs, 1200); assert.equal(preview.hasAudio, true); assert.ok(preview.poster.length < 200000);
    console.log("PROBE bounded MOV gallery poster and exact source metadata");
    for (const [i, file] of [source, mov].entries()) {
      const prepared = await handlers.get("slides:prepareVideo")(e, { root, deckId: "test.deck", path: file, jobId: `job-${i}` });
      assert.equal(prepared.asset.kind, "mp4"); assert.equal(prepared.asset.durationMs, 1200); assert.equal(prepared.asset.hasAudio, true);
      const clip = path.join(root, "slides/test.deck", prepared.asset.path), bytes = await fs.readFile(clip);
      if (i === 0) {
        const paths = [prepared.asset.path, prepared.posterAsset.path], copiedDeck = "copied.deck";
        await fs.mkdir(path.join(root, "slides", copiedDeck, "assets"), { recursive: true });
        const copyRequest = { root, sourceDeckId: "test.deck", deckId: copiedDeck, paths };
        await handlers.get("slides:copyVideoAssets")(e, copyRequest);
        for (const relative of paths) assert.deepEqual(await fs.readFile(path.join(root, "slides", copiedDeck, relative)), await fs.readFile(path.join(root, "slides/test.deck", relative)));
        assert.equal((await media.probeVideo(path.join(root, "slides", copiedDeck, prepared.asset.path))).durationMs, 1200);
        const collisionDeck = "copy-collision", collisionDir = path.join(root, "slides", collisionDeck, "assets");
        await fs.mkdir(collisionDir, { recursive: true });
        const sentinel = path.join(root, "slides", collisionDeck, prepared.posterAsset.path); await fs.writeFile(sentinel, "existing file must survive");
        await assert.rejects(() => handlers.get("slides:copyVideoAssets")(e, { ...copyRequest, deckId: collisionDeck }), /EEXIST/);
        assert.deepEqual(await fs.readdir(collisionDir), [path.basename(sentinel)], "failed second publication rolls back first copied movie");
        assert.equal(await fs.readFile(sentinel, "utf8"), "existing file must survive");
        const revokedDeck = "copy-revoked", revokedDir = path.join(root, "slides", revokedDeck, "assets");
        await fs.mkdir(revokedDir, { recursive: true }); revokeOnCopy = path.join(root, "slides", revokedDeck, prepared.asset.path);
        try { await assert.rejects(() => handlers.get("slides:copyVideoAssets")(e, { ...copyRequest, deckId: revokedDeck }), /project changed/); }
        finally { revokeOnCopy = null; }
        assert.deepEqual(await fs.readdir(revokedDir), [], "project switching during publication rolls back copied files");
        await assert.rejects(() => handlers.get("slides:copyVideoAssets")(e, { ...copyRequest, paths: ["assets/../../outside.mp4"] }), /Invalid/);
        currentRoot = path.join(scratch, "different-project");
        await assert.rejects(() => handlers.get("slides:copyVideoAssets")(e, copyRequest), /project changed/); currentRoot = root;
        const outside = path.join(scratch, "outside.mp4"); await fs.writeFile(outside, "outside");
        const linkPath = path.join(root, "slides/test.deck/assets/escape.mp4"); await fs.symlink(outside, linkPath);
        try { await assert.rejects(() => handlers.get("slides:copyVideoAssets")(e, { ...copyRequest, deckId: collisionDeck, paths: ["assets/escape.mp4"] }), /symlink escapes/); }
        finally { await fs.unlink(linkPath); }
        console.log("PROBE native scoped deck movie/poster copy, copy-conflict rollback, no clobber, and project/path/symlink rejection");
      }
      console.log("PROBE prepared", prepared.url);
      const partial = await net.fetch(prepared.url, { headers: { Range: "bytes=12-27" } });
      assert.equal(partial.status, 206); assert.equal(partial.headers.get("content-range"), `bytes 12-27/${bytes.length}`); assert.deepEqual(Buffer.from(await partial.arrayBuffer()), bytes.subarray(12, 28));
      const tail = await net.fetch(prepared.url, { headers: { Range: "bytes=-16" } }); assert.deepEqual(Buffer.from(await tail.arrayBuffer()), bytes.subarray(-16));
      assert.equal((await net.fetch(prepared.url, { headers: { Range: `bytes=${bytes.length}-` } })).status, 416);
      const html = `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src flux-media:; style-src 'unsafe-inline'"></head><body><video crossorigin="anonymous" style="width:320px;height:180px" muted preload="auto" src="${prepared.url}"></video></body></html>`;
      await window.loadURL(`data:text/html,${encodeURIComponent(html)}`);
      const sampled = await window.webContents.executeJavaScript(`(async()=>{
        const v=document.querySelector('video');
        const ready=()=>new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('video metadata timeout')),10000); if(v.readyState>=2){clearTimeout(t);resolve();return;} v.addEventListener('loadeddata',()=>{clearTimeout(t);resolve()},{once:true});v.addEventListener('error',()=>reject(Error('decode '+v.error?.message)),{once:true});}); await ready();
        const c=document.createElement('canvas'); c.width=160;c.height=90; const ctx=c.getContext('2d');
        const sample=async(t)=>{if(Math.abs(v.currentTime-t)>.00001){await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('seek timeout')),10000);v.addEventListener('seeked',()=>{clearTimeout(timeout);resolve()},{once:true});v.currentTime=t;});}ctx.drawImage(v,0,0,160,90);const data=ctx.getImageData(0,0,160,90).data;for(let x=0;x<160;x++){let p=(45*160+x)*4;if(data[p]>180&&data[p+1]<80&&data[p+2]<80)return x;}return -1;};
        const first=await sample(0), middle=await sample(.6), last=await sample(1.1); v.currentTime=0; await v.play(); await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('play timeout')),5000);v.addEventListener('ended',()=>{clearTimeout(timeout);resolve()},{once:true});});
        return {first,middle,last,width:v.videoWidth,height:v.videoHeight,duration:v.duration,time:v.currentTime};
      })()`);
      assert.equal(sampled.width, 160); assert.equal(sampled.height, 90); assert.ok(Math.abs(sampled.duration - 1.2) < .05);
      assert.ok(Math.abs(sampled.first - 20) <= 2, JSON.stringify(sampled)); assert.ok(Math.abs(sampled.middle - 68) <= 3, JSON.stringify(sampled)); assert.ok(sampled.last > 100, JSON.stringify(sampled)); assert.ok(sampled.time > 1.15);
      // Prove the retained audio is a decoded signal, not merely a metadata flag.
      const pcm = execFileSync(encoder, ["-v", "error", "-i", clip, "-vn", "-f", "s16le", "-ac", "1", "-ar", "8000", "pipe:1"], { timeout: 10000 });
      let power = 0; for (let n = 0; n < pcm.length; n += 2) power += pcm.readInt16LE(n) ** 2;
      assert.ok(Math.sqrt(power / (pcm.length / 2)) > 1000);
      currentRoot = path.join(scratch, "different-project"); assert.equal((await net.fetch(prepared.url)).status, 403); currentRoot = root;
      await handlers.get("slides:discardVideoImport")(e, { root, deckId: "test.deck", assetId: prepared.asset.id });
      assert.equal(await fs.stat(clip).then(() => true, () => false), false);
      console.log(`PROBE ${i ? "ProRes MOV" : "MP4"}: normalized H264/AAC; real decode, precise seek, playback, audio, ranges and project revocation`);
    }
    assert.deepEqual(await fs.readFile(source), sourceBytes); assert.deepEqual(await fs.readFile(mov), movieBytes);
    const variants = [
      { name: "rotated.mov", args: ["-c", "copy", "-metadata:s:v:0", "rotate=90"], width: 90, height: 160 },
      { name: "hevc.mov", args: ["-c:v", "libx265", "-x265-params", "pools=1:frame-threads=1:log-level=error", "-tag:v", "hvc1", "-c:a", "aac"], width: 160, height: 90 },
      { name: "fragmented.mp4", args: ["-c", "copy", "-movflags", "frag_keyframe+empty_moov"], width: 160, height: 90 },
      { name: "odd-size.mp4", args: ["-vf", "crop=159:89:0:0:exact=1", "-c:v", "libx264", "-pix_fmt", "yuv444p", "-c:a", "copy"], width: 160, height: 90 },
      { name: "long-audio.mov", args: ["-f", "lavfi", "-i", "sine=frequency=440:duration=2.4", "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "pcm_s16le"], width: 160, height: 90 },
      { name: "short-audio.mov", args: ["-c:v", "copy", "-af", "atrim=0:0.35", "-c:a", "pcm_s16le"], width: 160, height: 90 },
      { name: "hdr-pq.mov", args: ["-c:v", "libx265", "-pix_fmt", "yuv420p10le", "-x265-params", "pools=1:frame-threads=1:log-level=error", "-tag:v", "hvc1", "-color_primaries", "bt2020", "-color_trc", "smpte2084", "-colorspace", "bt2020nc", "-c:a", "aac"], width: 160, height: 90 },
      { name: "hdr-hlg.mov", args: ["-c:v", "libx265", "-pix_fmt", "yuv420p10le", "-x265-params", "pools=1:frame-threads=1:log-level=error", "-tag:v", "hvc1", "-color_primaries", "bt2020", "-color_trc", "arib-std-b67", "-colorspace", "bt2020nc", "-c:a", "aac"], width: 160, height: 90 },
    ];
    for (const variant of variants) {
      const input = path.join(root, "plots/_videos", variant.name);
      execFileSync(encoder, ["-v", "error", "-i", source, ...variant.args, "-threads", "2", "-y", input], { timeout: 20000 });
      const prepared = await media.prepareVideo({ root, deckId: "test.deck", sourcePath: `plots/_videos/${variant.name}` });
      if (variant.name.startsWith("hdr-")) {
        assert.ok((await media.probeVideo(input)).hdrTransfer, "HDR transfer is detected");
        const canonical = path.join(root, "slides/test.deck", prepared.asset.path);
        assert.equal((await media.probeVideo(canonical)).hdrTransfer, undefined, "portable clip carries an SDR transfer");
        const pixels = execFileSync(encoder, ["-v", "error", "-i", canonical, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { timeout: 10000 });
        assert.ok([...pixels.subarray(0, 3)].every(v => v > 160 && v < 255), "HDR highlights are tone mapped into SDR display range");
      }
      assert.equal(prepared.asset.naturalWidth, variant.width, variant.name); assert.equal(prepared.asset.naturalHeight, variant.height, variant.name);
      assert.ok(prepared.asset.durationMs >= 1166 && prepared.asset.durationMs <= 1300, variant.name);
      const decoded = execFileSync(encoder, ["-v", "error", "-i", path.join(root, "slides/test.deck", prepared.asset.path), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { timeout: 10000 });
      assert.equal(decoded.length, variant.width * variant.height * 3);
      const url = await handlers.get("slides:videoMediaUrl")(e, { root, path: `slides/test.deck/${prepared.asset.path}` });
      await window.loadURL(`data:text/html,${encodeURIComponent(`<video src="${url}" preload="metadata"></video>`)}`);
      const actualDuration = await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const v=document.querySelector('video');if(v.readyState>=1)return resolve(v.duration);const timeout=setTimeout(()=>reject(Error('duration timeout')),10000);v.onloadedmetadata=()=>{clearTimeout(timeout);resolve(v.duration)};v.onerror=()=>reject(Error('metadata decode failed'));})`);
      assert.ok(Math.abs(actualDuration * 1000 - prepared.asset.durationMs) <= 1, `${variant.name}: player duration ${actualDuration * 1000} must match timeline duration ${prepared.asset.durationMs}`);
      await media.cleanupPrepared(root, "test.deck", prepared);
    }
    console.log("PROBE HEVC MOV, rotation, fragmented MP4, odd dimensions and short/long audio preserve one exact playback clock");
    const controller = new AbortController();
    await assert.rejects(() => media.prepareVideo({ root, deckId: "test.deck", sourcePath: "plots/_videos/prores.mov", signal: controller.signal, onProgress: () => controller.abort() }), /cancelled/);
    assert.deepEqual(await fs.readdir(path.join(root, "slides/test.deck/assets")), []);
    await assert.rejects(() => handlers.get("slides:prepareVideo")(e, { root, deckId: "../outside", path: mov, jobId: "invalid" }));
    console.log("PROBE originals preserved; cancellation cleans temporary and canonical files; invalid requests rejected");
    // Fresh session has no flux-media handler, no preload and no network. The
    // exported Paper HTML must play from its own embedded video bytes alone.
    const offline = new BrowserWindow({ show: false, width: 800, height: 700, webPreferences: { partition: "video-paper-offline", sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    await offline.loadFile(process.env.PROBE_PORTABLE);
    const offlineResult = await offline.webContents.executeJavaScript(`(async()=>{
      const until=fn=>new Promise((resolve,reject)=>{const end=performance.now()+10000;const step=()=>{if(fn())resolve();else if(performance.now()>end)reject(Error('offline embed timeout'));else requestAnimationFrame(step)};step()});
      await until(()=>document.querySelector('video')?.readyState>=2);
      const v=document.querySelector('video'); const url=v.currentSrc;
      document.querySelector('[aria-label="Next animation step"]').click();
      await until(()=>v.currentTime>.3); const playingTime=v.currentTime;
      await until(()=>v.ended || v.currentTime>=1.19);
      return {url:url.slice(0,30),playingTime,endedTime:v.currentTime,width:v.videoWidth,errors:[...document.querySelectorAll('.flux-slide-error')].map(x=>x.textContent)};
    })()`);
    assert.ok(offlineResult.url.startsWith("data:video/mp4;base64,")); assert.equal(offlineResult.width, 160); assert.deepEqual(offlineResult.errors, []); assert.ok(offlineResult.playingTime > .3 && offlineResult.endedTime >= 1.19);
    offline.destroy(); console.log("PROBE exported Paper HTML decodes and plays its clips in a fresh session with only data: media allowed");
    window.destroy(); clearTimeout(watchdog); core.cancelAll(); app.exit(0);
  } catch (error) { console.error(error?.stack || JSON.stringify(error, Object.getOwnPropertyNames(error))); clearTimeout(watchdog); core.cancelAll(); window.destroy(); app.exit(1); }
});
