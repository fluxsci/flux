// Unique id generator — shared by the GUI store, the pure ops core (ops.ts),
// and flux-core (Node). A leaf module with NO Svelte/DOM imports so it is safe
// to use headlessly. Format: `${prefix}_${base36(now)}${run}_${n}` — monotonic
// via the counter within one process, and the per-process `run` component keeps
// two processes started in the same millisecond (two agents driving one
// project, W3) from ever minting the same id.

let idCounter = 0;
const RUN = Math.random().toString(36).slice(2, 6);

export function newId(prefix = "el"): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${RUN}_${idCounter}`;
}
