// Unique id generator — shared by the GUI store, the pure ops core (ops.ts),
// and flux-core (Node). A leaf module with NO Svelte/DOM imports so it is safe
// to use headlessly. Format: `${prefix}_${base36(now)}_${n}` (stable within a
// run, monotonic via the counter so ids never collide inside one process).

let idCounter = 0;

export function newId(prefix = "el"): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}
