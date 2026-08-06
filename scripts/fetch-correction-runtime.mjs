#!/usr/bin/env node
// Fetch the pinned standalone llama.cpp helper used by packaged Flux. This is
// an explicit packaging step; application startup never downloads executables.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const RELEASE = "b10288";
const ASSETS = {
  "darwin-arm64": { name: `llama-${RELEASE}-bin-macos-arm64.tar.gz`, size: 10_977_848, sha256: "2dced716a80ce726be6a7418fefa611f95b632d611a0582ca7cc3880ce0f0bb1", acceleration: "metal", backendPrefix: "libggml-metal" },
  "darwin-x64": { name: `llama-${RELEASE}-bin-macos-x64.tar.gz`, size: 11_245_902, sha256: "b9c2fb2fff9ebb9eab0393bdec25d60990da4ab5a65e50ab70809090b9669171", acceleration: "cpu" },
  // Vulkan is the portable Linux GPU build: it accelerates NVIDIA/AMD/Intel
  // when a Vulkan device is present and safely retains llama.cpp's CPU path on
  // systems without one. The former Ubuntu x64 asset was CPU-only.
  "linux-x64": { name: `llama-${RELEASE}-bin-ubuntu-vulkan-x64.tar.gz`, size: 32_443_080, sha256: "eda0a9c25e15bb478b1227edb2464f20cec222b945308401617a558c8a55a48e", acceleration: "vulkan", backendPrefix: "libggml-vulkan" },
};

const values = process.argv.slice(2);
const value = (name) => {
  const index = values.indexOf(name);
  return index >= 0 ? values[index + 1] : "";
};
const platform = value("--platform") || process.platform;
const arches = (value("--arches") || (platform === "darwin" ? "arm64,x64" : process.arch)).split(",").filter(Boolean);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "build", "correction-runtime");

async function fetchOne(arch) {
  const key = `${platform}-${arch}`;
  const asset = ASSETS[key];
  if (!asset) throw new Error(`No pinned correction runtime for ${key}`);
  const target = path.join(root, key);
  const existingManifest = path.join(target, "runtime-manifest.json");
  if (existsSync(path.join(target, "llama-server")) && existsSync(existingManifest)) {
    const current = JSON.parse(readFileSync(existingManifest, "utf8"));
    if (current.release === RELEASE && current.archiveSha256 === asset.sha256 && current.acceleration === asset.acceleration && current.files?.["llama-server"]) {
      console.log(`correction runtime ${key}: already pinned at ${RELEASE}`);
      return;
    }
  }
  mkdirSync(root, { recursive: true });
  const scratch = mkdtempSync(path.join(root, `.fetch-${key}-`));
  try {
    const url = `https://github.com/ggml-org/llama.cpp/releases/download/${RELEASE}/${asset.name}`;
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) throw new Error(`runtime download failed: ${response.status} ${response.statusText}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== asset.size) throw new Error(`runtime size mismatch: expected ${asset.size}, got ${bytes.length}`);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== asset.sha256) throw new Error(`runtime checksum mismatch for ${key}`);
    const archive = path.join(scratch, asset.name);
    writeFileSync(archive, bytes);
    const extracted = path.join(scratch, "extracted");
    mkdirSync(extracted);
    const tar = spawnSync("tar", ["-xzf", archive, "--strip-components=1", "-C", extracted], { stdio: "inherit" });
    if (tar.status !== 0 || !existsSync(path.join(extracted, "llama-server"))) throw new Error(`runtime extraction failed for ${key}`);
    for (const entry of [...new Set(requireExecutableEntries(extracted))]) {
      if (entry !== "llama-server") rmSync(path.join(extracted, entry), { force: true });
    }
    chmodSync(path.join(extracted, "llama-server"), 0o755);
    const serverSha256 = createHash("sha256").update(readFileSync(path.join(extracted, "llama-server"))).digest("hex");
    const backendFile = asset.backendPrefix
      ? readdirSync(extracted).find((entry) => entry.startsWith(asset.backendPrefix) && statSync(path.join(extracted, entry)).isFile())
      : undefined;
    if (asset.backendPrefix && !backendFile) throw new Error(`runtime ${key} is missing its ${asset.acceleration} backend`);
    const backend = backendFile ? {
      file: backendFile,
      sha256: createHash("sha256").update(readFileSync(path.join(extracted, backendFile))).digest("hex"),
    } : null;
    const files = Object.fromEntries(readdirSync(extracted)
      .filter((entry) => statSync(path.join(extracted, entry)).isFile())
      .sort()
      .map((entry) => [entry, createHash("sha256").update(readFileSync(path.join(extracted, entry))).digest("hex")]));
    writeFileSync(path.join(extracted, "runtime-manifest.json"), JSON.stringify({
      version: 1,
      release: RELEASE,
      upstreamRevision: "360e1349f0009c5ad99d21e3c4546b707addc68a",
      platform,
      arch,
      archive: asset.name,
      archiveSize: asset.size,
      archiveSha256: asset.sha256,
      serverSha256,
      sourceUrl: url,
      license: "MIT",
      acceleration: asset.acceleration,
      backend,
      files,
    }, null, 2) + "\n");
    rmSync(target, { recursive: true, force: true });
    renameSync(extracted, target);
    console.log(`correction runtime ${key}: installed ${RELEASE}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function requireExecutableEntries(directory) {
  return readdirSync(directory).filter((entry) => statSync(path.join(directory, entry)).isFile() && !entry.includes(".") && entry !== "LICENSE");
}

for (const arch of arches) await fetchOne(arch);
