// Execute the production recipe IPC body with a trusted scratch filesystem and
// a real generating process; the Electron permission boundary remains stubbed.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { atomicWrite } from "../flux-core/fsx";
import { spawn } from "node:child_process";
import { resolveSpawn } from "../electron/execResolve.cjs";
const source = fs.readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
const start = source.indexOf("const recipeJobs = new Map();");
const end = source.indexOf("// W13: resolve the bundled CLI", start);
assert(start > 0 && end > start);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "fluxplot-ipc-"));
try {
  const recipePath = path.join(scratch, "plot.recipe.json");
  const scriptPath = path.join(scratch, "make.mjs");
  const recipe = { command: process.execPath, args: [scriptPath], output: "out.svg", plot: "target", params: { dose: 1e-7 } };
  fs.writeFileSync(scriptPath, `import fs from 'node:fs';
const params = JSON.parse(process.env.FLUX_PARAMS);
if (process.argv.includes('--__fluxplot__')) throw Error('reserved option leaked to argv');
if (process.env.FLUXPLOT_ONLY !== 'target') throw Error('sibling protection missing');
fs.writeFileSync('out.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
fs.writeFileSync('plot.recipe.json', JSON.stringify({...${JSON.stringify(recipe)}, params, inputs: ['fresh-generation']}));`);
  fs.writeFileSync(recipePath, JSON.stringify(recipe));
  const handlers = new Map<string, Function>();
  const guarded: string[] = [], writes: string[] = [];
  const moduleUrl = new URL("../src/lib/plot/recipeContract.mjs", import.meta.url).href;
  const body = source.slice(start, end).replace('"../src/lib/plot/recipeContract.mjs"', JSON.stringify(moduleUrl));
  new Function("ipcMain", "fs", "path", "fsGuard", "confirmRecipeTrust", "BrowserWindow", "resolveSpawn", "spawn", "noteWrite", "require", "atomicWriteMain", body)(
    { handle: (name: string, fn: Function) => { handlers.set(name, fn); } }, fs, path,
    (file: string) => { assert(file.startsWith(scratch + path.sep)); guarded.push(file); },
    async () => true, { fromWebContents: () => null }, resolveSpawn, spawn,
    (file: string) => writes.push(file),
    createRequire(new URL("../electron/main.cjs", import.meta.url)), atomicWrite,
  );
  const sender = Object.assign(new EventEmitter(), { id: 1 });
  const handler = handlers.get("recipe:run")!;
  const result = await handler({ sender }, { recipePath, params: { __fluxplot__: { matrix: { cmap: "plasma", vmin: 0, vmax: 2 } } } });
  assert.equal(result.code, 0, result.stderr);
  assert(result.svgText.includes("<svg"));
  const saved = JSON.parse(result.recipeText);
  assert.deepEqual(saved.inputs, ["fresh-generation"]);
  assert.equal(saved.params.__fluxplot__.matrix.vmax, 2);
  assert.equal(saved.params.dose, 1e-7);
  assert.equal(typeof saved.lastRun, "string");
  assert(guarded.includes(recipePath) && guarded.includes(path.join(scratch, "out.svg")));
  assert(writes.includes(recipePath));
  const previous = fs.readFileSync(recipePath, "utf8");
  fs.writeFileSync(scriptPath, `import fs from 'node:fs'; fs.writeFileSync('plot.recipe.json', '{malformed');`);
  await assert.rejects(() => handler({sender}, {recipePath}), /malformed/);
  const snapshots = fs.readdirSync(scratch).filter(name => name.includes(".recovery-"));
  assert(snapshots.some(name => fs.readFileSync(path.join(scratch,name),"utf8") === previous), "malformed emission retains exact good recipe recovery bytes");
  fs.writeFileSync(recipePath, previous);
  fs.writeFileSync(scriptPath, `process.exit(3);`);
  const failed = await handler({sender}, {recipePath});
  assert.equal(failed.code, 3); assert.equal(failed.svgText, null, "failed command cannot label existing old SVG as newly generated");
  fs.writeFileSync(scriptPath, `setInterval(()=>{},100);`);
  const job = handler({sender}, {recipePath,jobId:"owned-cancel-test"});
  await new Promise(resolve => setTimeout(resolve,50));
  const cancel = handlers.get("recipe:cancel")!;
  assert.equal(await cancel({sender:{id:2}}, "owned-cancel-test"), false, "foreign renderer cannot cancel another job");
  assert.equal(await cancel({sender}, "owned-cancel-test"), true, "requesting renderer cancels its own job");
  const cancelled = await job;
  assert.notEqual(cancelled.code,0); assert.equal(cancelled.svgText, null);
  console.log("Desktop recipe IPC: real regeneration, precision, nested color controls, sibling isolation and fresh provenance passed");
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
