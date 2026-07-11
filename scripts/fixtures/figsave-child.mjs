// Fault child for verify-figsave-txn (WS-5.3): adds a canvas + figure and
// saves, in a tight loop, until killed. The parent SIGKILLs it mid-save and
// asserts the index-written-LAST invariant (the index never references a
// canvas file that doesn't exist). Watchdog: exits when stdin closes.
import { loadFigModel, saveFigModel } from "../../flux-core/index.ts";

process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));

const root = process.argv[2];
let n = 0;
// one full save first, then announce readiness
async function step() {
  n++;
  const { project, index } = await loadFigModel(root);
  const cid = `kc-${Date.now()}-${n}`;
  project.canvases.push({ id: cid, name: `Kill ${n}` });
  project.figures.push({
    id: `kf-${n}-${Math.floor(Math.random() * 1e6)}`,
    canvasId: cid,
    name: `KillFig ${n}`,
    x: 0,
    y: 0,
    width: 100,
    height: 80,
    elements: [],
  });
  await saveFigModel(root, project, index);
}
await step();
console.log("saving-started");
for (;;) await step();
