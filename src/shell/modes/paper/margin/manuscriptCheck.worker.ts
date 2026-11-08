// Manuscript Check off the main thread: the pane posts plain inputs, this runs
// the shared pure core (lib/manuscript/checks) and posts the result back. A
// whole-document run on the 20k-line scale fixture costs ~60 ms — over the
// 50 ms a main-thread task may take beside typing (guide §6) — so it never
// runs on the renderer thread while a worker is available.
import { checkManuscript, type CheckInput } from "../../../../lib/manuscript/checks/index";

self.onmessage = (event: MessageEvent<{ id: number; input: CheckInput }>) => {
  const { id, input } = event.data;
  const t0 = performance.now();
  try {
    const result = checkManuscript(input);
    self.postMessage({ id, result, ms: performance.now() - t0 });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
self.postMessage({ ready: true });
