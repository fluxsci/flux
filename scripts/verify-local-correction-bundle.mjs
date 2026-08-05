// Production-bundle gate for Paper's local correction fabric. Harper's WASM
// is intentionally large, so it must remain behind the dedicated lazy worker
// and never enter Flux's startup JavaScript graph.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const assetsDir = new URL("../dist/assets/", import.meta.url);
const assetsPath = assetsDir.pathname;
const files = readdirSync(assetsPath);
const workerFiles = files.filter((name) => /^localCorrection\.worker-.*\.js$/.test(name));
const harperWasm = files.filter((name) => /^harper_wasm.*\.wasm$/.test(name));
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

check(workerFiles.length === 1, `expected one local-correction worker, found ${workerFiles.length}`);
check(harperWasm.length === 1, `expected one Harper WASM asset, found ${harperWasm.length}`);
check(harperWasm[0]?.startsWith("harper_wasm_slim_bg-"), "production bundle must use Harper's slim WASM");

const workerBytes = workerFiles[0] ? statSync(join(assetsPath, workerFiles[0])).size : 0;
const wasmBytes = harperWasm[0] ? statSync(join(assetsPath, harperWasm[0])).size : 0;
check(workerBytes > 80_000 && workerBytes < 400_000, `unexpected worker size: ${workerBytes} bytes`);
check(wasmBytes > 12_000_000 && wasmBytes < 20_000_000, `unexpected slim WASM size: ${wasmBytes} bytes`);

const nonWorkerJs = files.filter((name) => name.endsWith(".js") && !workerFiles.includes(name));
const harperOutsideWorker = nonWorkerJs.filter((name) => {
  const source = readFileSync(join(assetsPath, name), "utf8");
  return source.includes("LocalLinter") || source.includes("harper_wasm_slim_bg");
});
check(harperOutsideWorker.length === 0, `Harper leaked outside its worker: ${harperOutsideWorker.join(", ")}`);

if (failures.length) {
  console.error(`LOCAL CORRECTION BUNDLE VERIFY: FAIL\n- ${failures.join("\n- ")}`);
  process.exit(1);
}

console.log(
  `LOCAL CORRECTION BUNDLE VERIFY: PASS — worker ${(workerBytes / 1024).toFixed(1)} KiB, slim WASM ${(wasmBytes / 1024 / 1024).toFixed(1)} MiB, no startup-graph leak`,
);
