#!/usr/bin/env node
// Explicit build-time download. No install or network request during export.
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { readFile, writeFile, mkdir, mkdtemp, rm, rename, chmod } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(repo, "build/video-encoder.json"), "utf8"));
const notice = await readFile(path.join(repo, "build/video-encoder-NOTICE.md"));
const args = process.argv.slice(2), arg = name => args[args.indexOf(name) + 1];
const platform = args.includes("--platform") ? arg("--platform") : process.platform;
const arches = (args.includes("--arches") ? arg("--arches") : platform === "darwin" ? "arm64,x64" : process.arch).split(",");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
for (const arch of arches) {
  const key = `${platform}-${arch}`, files = manifest.targets[key];
  if (!files) throw new Error(`No pinned video encoder for ${key}`);
  const root = path.join(repo, "build/video-encoder"), target = path.join(root, key);
  const executable = platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  try {
    const existing = JSON.parse(await readFile(path.join(target, "manifest.json"), "utf8"));
    if (existing.release === manifest.release && existing.archiveHash === files[`ffmpeg-${key}.gz`].sha256 && hash(await readFile(path.join(target, executable))) === existing.binaryHash) {
      await writeFile(path.join(target, "NOTICE.md"), notice);
      console.log(`Video encoder ${key}: verified ${manifest.release}`); continue;
    }
  } catch { /* fetch a complete verified bundle */ }
  await mkdir(root, { recursive: true });
  const tmp = await mkdtemp(path.join(root, `.fetch-${key}-`));
  try {
    let binaryHash = "";
    for (const [name, expected] of Object.entries(files)) {
      const response = await fetch(`${manifest.baseUrl}/${name}`, { signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error(`Video encoder download: HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length !== expected.size || hash(bytes) !== expected.sha256) throw new Error(`Video encoder checksum mismatch: ${name}`);
      const binary = name.endsWith(".gz");
      const content = binary ? gunzipSync(bytes) : bytes;
      await writeFile(path.join(tmp, binary ? executable : name.split(".").at(-1)), content);
      if (binary) binaryHash = hash(content);
    }
    await chmod(path.join(tmp, executable), 0o755);
    await writeFile(path.join(tmp, "NOTICE.md"), notice);
    await writeFile(path.join(tmp, "manifest.json"), JSON.stringify({ release: manifest.release, platform, arch, binaryHash, archiveHash: files[`ffmpeg-${key}.gz`].sha256, source: manifest.baseUrl }) + "\n");
    await rm(target, { recursive: true, force: true }); await rename(tmp, target);
    console.log(`Video encoder ${key}: installed and verified ${manifest.release}`);
  } finally { await rm(tmp, { recursive: true, force: true }); }
}
