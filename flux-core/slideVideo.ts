import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { gatherDeckPayload } from "./slides";
import { exportSlideVideoHtml } from "../src/lib/slide/export/exportDeck";
import { videoOptions, videoSize, type SlideVideoOptions, type SlideVideoProgress } from "../src/lib/slide/video";

const here = path.dirname(fileURLToPath(import.meta.url));
export async function exportSlideVideo(root: string, deckId: string, slideId: string, input: Partial<SlideVideoOptions> & {
  out?: string; signal?: AbortSignal; refreshSources?: boolean; onProgress?: (value: Omit<SlideVideoProgress, "jobId">) => void;
} = {}): Promise<{ path: string; frames: number; durationMs: number; warnings: string[] }> {
  const options = videoOptions(Object.fromEntries(Object.keys(videoOptions()).filter(key => key in input).map(key => [key, input[key as keyof typeof input]])));
  if (!deckId || !slideId || /[\\/\0]/.test(deckId + slideId) || deckId.startsWith(".") || slideId.startsWith(".")) throw new Error("Invalid deck or slide ID");
  const out = path.resolve(input.out ?? path.join(root, "exports", `${deckId}-${slideId}.mp4`));
  if (path.extname(out).toLowerCase() !== ".mp4") throw new Error("Video output must use the .mp4 extension");
  const appRoot = process.env.FLUX_VIDEO_APP_ROOT || path.resolve(here, "..");
  const worker = path.join(appRoot, "electron/entry.cjs");
  const executable = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const packaged = path.basename(appRoot) === "app.asar.unpacked";
  const encoder = process.env.FLUX_VIDEO_ENCODER || (packaged ? path.join(path.dirname(appRoot), "video-encoder", executable) : path.join(appRoot, "build/video-encoder", `${process.platform}-${process.arch}`, executable));
  await fs.access(encoder).catch(() => { throw new Error("Video encoder is missing. In a source checkout, run npm run fetch:video-encoder, then retry. Packaged Flux includes it."); });
  const require = createRequire(import.meta.url);
  const electron = process.env.FLUX_VIDEO_ELECTRON || (process.versions.electron ? process.execPath : require("electron")) as string;
  if (typeof electron !== "string") throw new Error("Video export needs an Electron executable");
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "flux-slide-video-"));
  const tempOutput = path.join(path.dirname(out), `.${path.basename(out)}.tmp-${randomUUID()}.mp4`);
  const controller = new AbortController(), abort = () => controller.abort();
  process.once("SIGTERM", abort); process.once("SIGINT", abort);
  // IPC jobs cancel through stdin on all platforms (SIGTERM is an immediate
  // termination on Windows). Pipe closure also cleans up when the owner quits.
  const piped = process.env.FLUX_VIDEO_SAVED === "1";
  if (piped) { process.stdin.on("data", abort); process.stdin.once("end", abort); }
  input.signal?.addEventListener("abort", abort);
  if (input.signal?.aborted) abort();
  const check = () => { if (controller.signal.aborted) throw new Error("Video export cancelled"); };
  try {
    check(); input.onProgress?.({ phase: "preparing", frame: 0, total: 0 });
    const mediaFiles: Record<string, string> = {}, mediaHasAudio: Record<string, boolean> = {};
    const { payload, warnings } = await gatherDeckPayload(root, deckId, slideId, {
      refreshSources: input.refreshSources,
      videoUrl: async (source, asset) => {
        check();
        const file = path.join(scratch, `media-${randomUUID()}.mp4`);
        await fs.copyFile(source, file);
        mediaFiles[asset.id] = file; mediaHasAudio[asset.id] = asset.hasAudio === true;
        return pathToFileURL(file).href;
      },
    });
    if (payload.deck.slides.some(s => s.elements.some(e => e.type === "video" && !payload.videos?.[e.assetId])))
      throw new Error("A video clip is missing. Restore or reimport the clip before exporting.");
    check();
    const size = videoSize(payload.deck.stage, options.height);
    const html = path.join(scratch, "capture.html"), jobFile = path.join(scratch, "job.json");
    await fs.writeFile(html, await exportSlideVideoHtml(payload, options));
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(jobFile, JSON.stringify({ html, output: tempOutput, encoder, mediaFiles, mediaHasAudio, ...size }));
    const env: NodeJS.ProcessEnv = { ...process.env, FLUX_SLIDE_VIDEO_WORKER: "1", FLUX_VIDEO_JOB: jobFile }; delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
    const result = await new Promise<{ frames: number; durationMs: number; warnings: string[] }>((resolve, reject) => {
      const args = [worker, jobFile, ...(process.platform === "linux" ? ["--ozone-platform=x11"] : [])];
      const child = spawn(electron, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      let buffer = "", stderr = "", result: { frames: number; durationMs: number; warnings: string[] } | undefined, error = "";
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const cancel = () => { child.stdin.write("cancel\n"); killTimer ??= setTimeout(() => child.kill("SIGKILL"), 5000); };
      controller.signal.addEventListener("abort", cancel);
      child.stdin.on("error", () => {});
      if (controller.signal.aborted) cancel();
      child.stdout.on("data", bytes => {
        buffer += bytes;
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (!line.startsWith("FLUX_VIDEO ")) continue;
          try {
            const message = JSON.parse(line.slice(11));
            if (message.result) result = message.result;
            else if (message.error) error = message.error;
            else if (message.phase) input.onProgress?.(message);
          } catch { error = "Invalid capture-worker response"; }
        }
      });
      child.stderr.on("data", bytes => { stderr = (stderr + bytes).slice(-12000); });
      child.once("error", reject);
      child.once("close", code => {
        clearTimeout(killTimer); controller.signal.removeEventListener("abort", cancel);
        if (code === 0 && result) resolve(result);
        else reject(new Error(controller.signal.aborted ? "Video export cancelled" : error || stderr || `Video capture exited ${code}`));
      });
    });
    check();
    await fs.rename(tempOutput, out);
    // Final publication only after the encoder closes and syncs the complete MP4.
    if (process.platform !== "win32") { const dir = await fs.open(path.dirname(out), "r"); try { await dir.sync(); } finally { await dir.close(); } }
    return { path: out, ...result, warnings: [...new Set([...warnings, ...result.warnings])] };
  } finally {
    process.removeListener("SIGTERM", abort); process.removeListener("SIGINT", abort); input.signal?.removeEventListener("abort", abort);
    if (piped) { process.stdin.removeListener("data", abort); process.stdin.removeListener("end", abort); process.stdin.pause(); }
    await fs.rm(`${tempOutput}.audio.mp4`, { force: true });
    await fs.rm(tempOutput, { force: true }); await fs.rm(scratch, { recursive: true, force: true });
  }
}
