"use strict";
/** The finite silence clock, rather than an asynchronously drained source clip,
 * owns the audio span. Inputs and filter bounds are validated before spawn. */
function slideAudioGraph(audio, mediaFiles, durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 3600000) throw new Error("Invalid video audio duration");
  if (!Array.isArray(audio) || audio.length > 4096) throw new Error("Invalid video audio segment count");
  const seconds = durationMs / 1000, samples = Math.round(durationMs * 48);
  const inputs = [], filters = [`anullsrc=r=48000:cl=stereo,atrim=end_sample=${samples},asetpts=PTS-STARTPTS[clock]`];
  audio.forEach((segment, i) => {
    const file = mediaFiles?.[segment.assetId], offset = segment.offsetMs ?? 0;
    if (typeof file !== "string" || !file || !Number.isFinite(segment.startMs) || !Number.isFinite(segment.endMs) || !Number.isFinite(offset) || offset < 0 || segment.startMs < 0 || segment.endMs <= segment.startMs || segment.endMs > durationMs + 0.001) throw new Error("Invalid video audio segment");
    const length = (segment.endMs - segment.startMs) / 1000;
    if (segment.loop) inputs.push("-stream_loop", "-1");
    inputs.push("-ss", String(offset / 1000), "-t", String(length), "-i", file);
    filters.push(`[${i + 1}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=${length},asetpts=PTS-STARTPTS,adelay=${Math.round(segment.startMs * 48)}S:all=1[a${i}]`);
  });
  filters.push(`[clock]${audio.map((_, i) => `[a${i}]`).join("")}amix=inputs=${audio.length + 1}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.98:latency=1,atrim=end_sample=${samples}[audio]`);
  return { inputs, filter: filters.join(";"), duration: seconds, samples };
}
module.exports = { slideAudioGraph };
