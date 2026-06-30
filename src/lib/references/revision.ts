// Bumped whenever the machine-global FluxLib changes (a DOI/URL import, a capture),
// so any open view — the Library window, a capture toast — can reload. Mirrors the
// editor's bibRevision, but for the global library, and lives in lib/references so
// the FluxLib bridge can bump it without importing from the shell layer.
import { writable } from "svelte/store";
import type { RefEntry } from "./types";

export const fluxLibRevision = writable(0);

// The live contents of the machine-global FluxLib, so editor surfaces (the margin
// reference search, the @-autocomplete) can share one source instead of each
// re-reading the file. Populated/refreshed via refreshFluxLib() in fluxlibBridge.
export const fluxLibEntries = writable<RefEntry[]>([]);

export function bumpFluxLib(): void {
  fluxLibRevision.update((n) => n + 1);
}
