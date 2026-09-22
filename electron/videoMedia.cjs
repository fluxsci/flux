"use strict";
// Shared native media IO for the desktop and headless slide importer. Movies
// never cross IPC as byte arrays: only bounded posters and metadata do.
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const VIDEO_EXT = /\.(mp4|mov)$/i;
function safeId(id) { return typeof id === "string" && /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,180}$/.test(id); }
function contained(root, absolute) {
  const relative = path.relative(path.resolve(root), path.resolve(absolute));
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function projectFile(root, relative) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative) || /[\0\\]/.test(relative)) throw new Error("Expected a project-relative video path");
  const absolute = path.resolve(root, relative);
  if (!contained(root, absolute)) throw new Error("Video path escapes the project");
  const [realRoot, real] = await Promise.all([fsp.realpath(root), fsp.realpath(absolute)]);
  if (!contained(realRoot, real)) throw new Error("Video source symlink escapes the project");
  return real;
}
function encoderPath(appRoot = path.resolve(__dirname, "..")) {
  const name = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  return process.env.FLUX_VIDEO_ENCODER || (path.basename(appRoot).startsWith("app.asar")
    ? path.join(path.dirname(appRoot), "video-encoder", name)
    : path.join(appRoot, "build/video-encoder", `${process.platform}-${process.arch}`, name));
}
function cancelled() { const e = new Error("Video import cancelled"); e.name = "AbortError"; return e; }
function check(signal) { if (signal?.aborted) throw cancelled(); }

// MP4/MOV are ISO base media containers. Read only box headers and track
// metadata by offset; a multi-GB mdat is skipped without allocating it. Bounds
// and node limits reject malformed containers before ffmpeg sees them.
async function probeVideo(file) {
  const handle = await fsp.open(file, "r");
  try {
    const { size } = await handle.stat(); let count = 0;
    async function read(position, length) {
      if (position < 0 || position + length > size) throw new Error("Truncated video metadata");
      const bytes = Buffer.alloc(length), result = await handle.read(bytes, 0, length, position);
      if (result.bytesRead !== length) throw new Error("Truncated video metadata");
      return bytes;
    }
    async function boxes(start, end) {
      const out = [];
      for (let at = start; at + 8 <= end;) {
        if (++count > 100000) throw new Error("Video metadata is too complex");
        const header = await read(at, 8); let length = header.readUInt32BE(0), head = 8;
        if (length === 1) { const large = (await read(at + 8, 8)).readBigUInt64BE(); if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Invalid video box length"); length = Number(large); head = 16; }
        else if (length === 0) length = end - at;
        if (length < head || at + length > end) throw new Error("Invalid video box length");
        out.push({ type: header.toString("ascii", 4, 8), start: at + head, end: at + length }); at += length;
      }
      return out;
    }
    const roots = await boxes(0, size), moov = roots.find(b => b.type === "moov");
    if (!moov) throw new Error("This MP4/MOV has no readable movie metadata");
    const children = await boxes(moov.start, moov.end); let video, hasAudio = false, videoClock = 0, videoTrackId = 0, movieClock = 0;
    const mvhd = children.find(b => b.type === "mvhd");
    if (mvhd) {
      const version = (await read(mvhd.start, 1))[0], offset = version === 1 ? 20 : 12;
      if (mvhd.end - mvhd.start >= offset + 4) movieClock = (await read(mvhd.start + offset, 4)).readUInt32BE();
    }
    for (const track of children.filter(b => b.type === "trak")) {
      const tracks = await boxes(track.start, track.end), mdia = tracks.find(b => b.type === "mdia"), tkhd = tracks.find(b => b.type === "tkhd");
      if (!mdia) continue;
      const media = await boxes(mdia.start, mdia.end), hdlr = media.find(b => b.type === "hdlr"), mdhd = media.find(b => b.type === "mdhd");
      if (!hdlr || hdlr.end - hdlr.start < 12) continue;
      const type = (await read(hdlr.start + 8, 4)).toString("ascii");
      if (type === "soun") hasAudio = true;
      if (type !== "vide" || video || !tkhd || !mdhd) continue;
      const tv = (await read(tkhd.start, 1))[0], mv = (await read(mdhd.start, 1))[0];
      if (tv > 1 || mv > 1 || tkhd.end - tkhd.start < (tv ? 96 : 84) || mdhd.end - mdhd.start < (mv ? 32 : 20)) throw new Error("Invalid video track metadata");
      const dims = await read(tkhd.start + (tv ? 88 : 76), 8);
      let width = dims.readUInt32BE(0) / 65536, height = dims.readUInt32BE(4) / 65536;
      const matrix = await read(tkhd.start + (tv ? 52 : 40), 8);
      if (Math.abs(matrix.readInt32BE(4)) > Math.abs(matrix.readInt32BE(0))) [width, height] = [height, width];
      const clock = await read(mdhd.start + (mv ? 20 : 12), mv ? 12 : 8), scale = clock.readUInt32BE(0);
      const duration = mv ? Number(clock.readBigUInt64BE(4)) : clock.readUInt32BE(4);
      videoClock = scale; videoTrackId = (await read(tkhd.start + (tv ? 20 : 12), 4)).readUInt32BE();
      const trackClock = await read(tkhd.start + (tv ? 28 : 20), tv ? 8 : 4);
      const trackDuration = tv ? Number(trackClock.readBigUInt64BE()) : trackClock.readUInt32BE();
      // tkhd is the presentation span in movie timescale, including edit-list
      // offsets. mdhd is raw sample time and can disagree with HTMLVideo.duration.
      video = { width, height, durationMs: movieClock && trackDuration ? trackDuration / movieClock * 1000 : scale ? duration / scale * 1000 : 0 };
      const minf = media.find(b => b.type === "minf");
      const stbl = minf && (await boxes(minf.start, minf.end)).find(b => b.type === "stbl");
      const stsd = stbl && (await boxes(stbl.start, stbl.end)).find(b => b.type === "stsd");
      if (stsd && stsd.end - stsd.start >= 8) for (const entry of await boxes(stsd.start + 8, stsd.end)) {
        if (entry.end - entry.start < 78) continue;
        const colr = (await boxes(entry.start + 78, entry.end)).find(b => b.type === "colr");
        if (!colr || colr.end - colr.start < 10) continue;
        const color = await read(colr.start, 10), type = color.toString("ascii", 0, 4), transfer = color.readUInt16BE(6);
        if (["nclx", "nclc"].includes(type) && [16, 18].includes(transfer)) video.hdrTransfer = transfer === 16 ? "pq" : "hlg";
      }
    }
    // Fragmented MP4 leaves mdhd.duration at zero. Sample timing lives in
    // moof/traf boxes; inspect only the selected picture track's durations.
    if (video && !video.durationMs && videoClock) {
      let defaultDuration = 0, pictureEnd = 0;
      const mvex = children.find(b => b.type === "mvex");
      if (mvex) for (const trex of (await boxes(mvex.start, mvex.end)).filter(b => b.type === "trex")) {
        if (trex.end - trex.start < 24) throw new Error("Invalid fragmented video defaults");
        const data = await read(trex.start, 24);
        if (data.readUInt32BE(4) === videoTrackId) defaultDuration = data.readUInt32BE(12);
      }
      for (const moof of roots.filter(b => b.type === "moof")) for (const traf of (await boxes(moof.start, moof.end)).filter(b => b.type === "traf")) {
        const parts = await boxes(traf.start, traf.end), tfhd = parts.find(b => b.type === "tfhd"), tfdt = parts.find(b => b.type === "tfdt");
        if (!tfhd || tfhd.end - tfhd.start < 8) continue;
        const data = await read(tfhd.start, Math.min(40, tfhd.end - tfhd.start));
        if (data.readUInt32BE(4) !== videoTrackId) continue;
        const flags = data.readUIntBE(1, 3); let duration = defaultDuration, offset = 8;
        if (flags & 1) offset += 8; if (flags & 2) offset += 4;
        if (flags & 8) { if (offset + 4 > data.length) throw new Error("Invalid fragmented video duration"); duration = data.readUInt32BE(offset); }
        let clock = pictureEnd;
        if (tfdt) {
          if (tfdt.end - tfdt.start < 8) throw new Error("Invalid fragmented video clock");
          const data = await read(tfdt.start, Math.min(12, tfdt.end - tfdt.start));
          clock = data[0] === 1 ? Number(data.readBigUInt64BE(4)) : data.readUInt32BE(4);
        }
        for (const trun of parts.filter(b => b.type === "trun")) {
          if (trun.end - trun.start < 8) throw new Error("Invalid fragmented video sample table");
          const head = await read(trun.start, 8), flags = head.readUIntBE(1, 3), samples = head.readUInt32BE(4);
          if (samples > 10000000) throw new Error("Video sample table is too complex");
          let offset = trun.start + 8 + ((flags & 1) ? 4 : 0) + ((flags & 4) ? 4 : 0);
          const stride = [0x100, 0x200, 0x400, 0x800].filter(flag => flags & flag).length * 4;
          if (offset + samples * stride > trun.end) throw new Error("Truncated video sample table");
          if (!(flags & (0x100 | 0x800))) { clock += samples * duration; pictureEnd = Math.max(pictureEnd, clock); continue; }
          let remaining = samples;
          while (remaining) {
            const n = Math.min(remaining, Math.floor(65536 / stride)), data = await read(offset, n * stride);
            for (let i = 0; i < n; i++) {
              const sampleDuration = flags & 0x100 ? data.readUInt32BE(i * stride) : duration;
              const compositionOffset = flags & 0x800 ? (head[0] === 1 ? data.readInt32BE(i * stride + stride - 4) : data.readUInt32BE(i * stride + stride - 4)) : 0;
              pictureEnd = Math.max(pictureEnd, clock + compositionOffset + sampleDuration); clock += sampleDuration;
            }
            remaining -= n; offset += n * stride;
          }
        }
      }
      video.durationMs = pictureEnd / videoClock * 1000;
    }
    if (!video || !(video.width > 0 && video.height > 0 && video.width <= 16384 && video.height <= 16384) || !(video.durationMs > 0 && video.durationMs <= 24 * 3600000)) throw new Error("Video must have a valid picture track and a duration under 24 hours");
    return { ...video, hasAudio };
  } finally { await handle.close(); }
}

async function runEncoder(encoder, args, { signal, onProgress, maxBytes = 4 * 1024 * 1024, timeoutMs = 24 * 3600000 } = {}) {
  check(signal);
  await fsp.access(encoder).catch(() => { throw new Error("Video tools are missing. In a source checkout, run npm run fetch:video-encoder. Packaged Flux includes them."); });
  return new Promise((resolve, reject) => {
    const child = spawn(encoder, ["-hide_banner", "-nostdin", ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "", output = [], bytes = 0, forced, progressBuffer = "";
    const stop = () => { forced = cancelled(); child.kill("SIGKILL"); };
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    const timeout = setTimeout(() => { forced = new Error("Video processing timed out"); child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", chunk => {
      if (onProgress) {
        progressBuffer += chunk.toString();
        let end;
        while ((end = progressBuffer.indexOf("\n")) >= 0) { const line = progressBuffer.slice(0, end); progressBuffer = progressBuffer.slice(end + 1); const m = /^out_time_us=(\d+)/.exec(line); if (m) onProgress(Number(m[1]) / 1000); }
      } else {
        bytes += chunk.length;
        if (bytes > maxBytes) { forced = new Error("Video preview is too large"); child.kill("SIGKILL"); }
        else output.push(chunk);
      }
    });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-6000); });
    child.once("error", error => { clearTimeout(timeout); signal?.removeEventListener("abort", stop); reject(error); });
    child.once("close", code => { clearTimeout(timeout); signal?.removeEventListener("abort", stop); if (forced) reject(forced); else if (code !== 0) reject(new Error(`Could not decode this video. ${stderr.trim() || `Encoder exited ${code}`}`)); else resolve(Buffer.concat(output)); });
  });
}
async function videoPreview(file, { encoder = encoderPath(), signal, width = 480, height = 320 } = {}) {
  if (!VIDEO_EXT.test(file)) throw new Error("Only .mp4 and .mov video clips are supported");
  const info = await probeVideo(file); check(signal);
  const png = await runEncoder(encoder, ["-loglevel", "error", "-threads", "1", "-i", file, "-map", "0:v:0", "-frames:v", "1", "-vf", `${toneMapFilter(info)}scale=min(${width}\\,iw):min(${height}\\,ih):force_original_aspect_ratio=decrease,setsar=1`, "-filter_threads", "1", "-threads", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1"], { signal, timeoutMs: 30000, maxBytes: 12 * 1024 * 1024 });
  if (!png.length) throw new Error("This video contains no decodable frames");
  return { ...info, poster: `data:image/png;base64,${png.toString("base64")}` };
}
// "r+", not "r": Windows refuses FlushFileBuffers on a read-only handle (EPERM),
// so a durability fsync taken through a read handle fails the import outright there.
async function syncFile(file) { const h = await fsp.open(file, "r+"); try { await h.sync(); } finally { await h.close(); } }
function toneMapFilter(info) {
  // Common iPhone/QuickTime HDR sources carry PQ/HLG in their colr metadata.
  // Convert linear-light luminance and gamut before the portable 8-bit encode;
  // merely changing pix_fmt would retain HDR transfer values in an SDR clip.
  return info.hdrTransfer ? "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv," : "";
}
async function cleanupPrepared(root, deckId, prepared) {
  if (!safeId(deckId)) throw new Error("Invalid deck ID");
  const assets = [prepared?.asset, prepared?.posterAsset];
  if (assets.some(a => !a || !/^video-[a-f0-9-]+(?:-poster)?$/.test(a.id) || a.path !== `assets/${a.id}.${a.kind}` || !["mp4", "png"].includes(a.kind))) throw new Error("Invalid prepared video assets");
  const realRoot = await fsp.realpath(root);
  for (const a of assets) {
    const absolute = path.join(realRoot, "slides", deckId, a.path);
    const real = await projectFile(root, `slides/${deckId}/${a.path}`).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (real && real !== absolute) throw new Error("Prepared video asset was replaced");
    if (real) await fsp.rm(real, { force: true });
  }
}

let copySequence = 0;
/** Copy required movie/poster files without loading their bytes into JS or IPC.
 * The destination is a new, unpublished deck. A failed batch removes only the
 * files this operation created; existing files are never replaced or removed. */
async function copyVideoAssets({ root, sourceDeckId, deckId, paths, checkCurrent = () => {} }) {
  if (!safeId(sourceDeckId) || !safeId(deckId) || sourceDeckId === deckId || !Array.isArray(paths) || !paths.length || paths.length > 10000
    || paths.some(p => typeof p !== "string" || !/^assets\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.(?:mp4|png)$/i.test(p))) throw new Error("Invalid video asset copy request");
  checkCurrent();
  const realRoot = await fsp.realpath(root), directory = path.join(realRoot, "slides", deckId, "assets");
  if (await projectFile(root, `slides/${deckId}/assets`) !== directory) throw new Error("Video copy destination was replaced");
  if (await fsp.stat(path.join(directory, "..", "deck.json")).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) throw new Error("Video copy destination is already a saved deck");
  const scratch = path.join(directory, `.video-copy.tmp-${process.pid}-${++copySequence}`), created = [];
  await fsp.mkdir(scratch);
  try {
    const staged = [];
    for (const relative of new Set(paths)) {
      checkCurrent();
      const source = await projectFile(root, `slides/${sourceDeckId}/${relative}`), before = await fsp.stat(source);
      if (!before.isFile()) throw new Error(`Video asset is not a file: ${relative}`);
      const temporary = path.join(scratch, path.basename(relative));
      await fsp.copyFile(source, temporary, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
      const after = await fsp.stat(source);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error(`Video asset changed while copying: ${relative}`);
      await syncFile(temporary); checkCurrent();
      staged.push({ temporary, destination: path.join(directory, path.basename(relative)) });
    }
    for (const item of staged) {
      checkCurrent();
      if (await projectFile(root, `slides/${deckId}/assets`) !== directory) throw new Error("Video copy destination was replaced");
      await fsp.link(item.temporary, item.destination); // atomic, no clobber
      created.push(item.destination);
    }
    if (process.platform !== "win32") { const dir = await fsp.open(directory, "r"); try { await dir.sync(); } finally { await dir.close(); } }
    checkCurrent();
  } catch (error) {
    await Promise.all(created.map(file => fsp.rm(file, { force: true })));
    throw error;
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true });
  }
}

/** Returns persisted Asset entries; caller owns the ONE deck model mutation.
 * Prepared bytes are immutable and uniquely named, so parallel imports cannot
 * overwrite an existing placement or leave a half-written canonical file. */
async function prepareVideo({ root, deckId, sourcePath, encoder = encoderPath(), signal, onProgress }) {
  if (!safeId(deckId)) throw new Error("Invalid deck ID");
  if (!VIDEO_EXT.test(sourcePath || "")) throw new Error("Only .mp4 and .mov video clips are supported");
  const source = await projectFile(root, sourcePath), sourceBefore = await fsp.stat(source), info = await probeVideo(source); check(signal);
  const directory = path.join(root, "slides", deckId, "assets");
  const realRoot = await fsp.realpath(root), realDeck = await fsp.realpath(path.dirname(directory));
  if (!contained(realRoot, realDeck)) throw new Error("Deck assets escape the project");
  await fsp.mkdir(directory, { recursive: true });
  if (!contained(realRoot, await fsp.realpath(directory))) throw new Error("Deck assets escape the project");
  const id = `video-${randomUUID()}`, posterId = `${id}-poster`, output = path.join(directory, `${id}.mp4`), posterFile = path.join(directory, `${posterId}.png`);
  const scratch = await fsp.mkdtemp(path.join(directory, ".video-import-")), temporary = path.join(scratch, "clip.mp4"), posterTemporary = path.join(scratch, "poster.png");
  let published = false;
  try {
    onProgress?.({ phase: "encoding", percent: 0 });
    await runEncoder(encoder, ["-loglevel", "error", "-threads", "2", "-i", source, "-map", "0:v:0", "-map", "0:a:0?", "-map_metadata", "-1", "-t", String(info.durationMs / 1000), "-vf", `${toneMapFilter(info)}scale=ceil(iw*sar/2)*2:ceil(ih/2)*2,setsar=1`, "-filter_threads", "1", "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", ...(info.hdrTransfer ? ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"] : []), "-g", "60", "-threads", "2", "-c:a", "aac", "-b:a", "192k", ...(info.hasAudio ? ["-af", "apad"] : []), "-movflags", "+faststart", "-progress", "pipe:1", "-y", temporary], { signal, onProgress: ms => onProgress?.({ phase: "encoding", percent: Math.min(99, ms / info.durationMs * 100) }) });
    check(signal); onProgress?.({ phase: "finalizing", percent: 99 });
    const normalized = await probeVideo(temporary);
    const sourceAfter = await fsp.stat(source);
    if (sourceBefore.size !== sourceAfter.size || sourceBefore.mtimeMs !== sourceAfter.mtimeMs) throw new Error("The source video changed while it was being imported. Try again after it finishes saving.");
    const preview = await videoPreview(temporary, { encoder, signal, width: 1920, height: 1080 });
    const png = Buffer.from(preview.poster.split(",")[1], "base64"); await fsp.writeFile(posterTemporary, png);
    await Promise.all([syncFile(temporary), syncFile(posterTemporary)]); check(signal);
    await fsp.rename(posterTemporary, posterFile); await fsp.rename(temporary, output); check(signal);
    if (process.platform !== "win32") { const dir = await fsp.open(directory, "r"); try { await dir.sync(); } finally { await dir.close(); } }
    published = true; onProgress?.({ phase: "finalizing", percent: 100 });
    return {
      asset: { id, name: path.basename(sourcePath), kind: "mp4", path: `assets/${id}.mp4`, naturalWidth: normalized.width, naturalHeight: normalized.height, durationMs: normalized.durationMs, hasAudio: normalized.hasAudio, sourcePath: path.posix.normalize(sourcePath.replace(/\\/g, "/")) },
      posterAsset: { id: posterId, name: `${path.basename(sourcePath)} poster`, kind: "png", path: `assets/${posterId}.png`, naturalWidth: png.readUInt32BE(16), naturalHeight: png.readUInt32BE(20) },
      poster: preview.poster,
    };
  } finally {
    if (!published) await Promise.all([fsp.rm(output, { force: true }), fsp.rm(posterFile, { force: true })]);
    await fsp.rm(scratch, { recursive: true, force: true });
  }
}
function byteRange(header, size) {
  if (!Number.isSafeInteger(size) || size <= 0) return null;
  if (!header) return { start: 0, end: size - 1, partial: false };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (!m[1] && !m[2])) return null;
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) return null;
  return { start, end, partial: true };
}
module.exports = { VIDEO_EXT, safeId, contained, projectFile, encoderPath, probeVideo, videoPreview, prepareVideo, cleanupPrepared, copyVideoAssets, byteRange };
