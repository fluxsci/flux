// Which FluxLib citekeys have a full-text PDF on disk — powers the hover
// card's "Read PDF" pill and the bibliography's read action. One readdir of
// FluxLib's items/ per refresh, throttled: hover cards mount constantly but
// the items/ directory changes rarely (stale-while-revalidate — the old set
// stays visible until the fresh one lands).

import { writable } from "svelte/store";
import { resolveFluxLibPath } from "./fluxlibBridge";
import { listPdfKeys, hasPdfIn } from "./itemsBridge";

export const pdfKeys = writable<Set<string>>(new Set());

let lastLoad = 0, generation = 0, rootRequest = 0;
let currentRoot: string | null | undefined;
export async function refreshPdfKeys(minIntervalMs = 15_000): Promise<void> {
  const request = ++rootRequest;
  const root = await resolveFluxLibPath();
  if (request !== rootRequest) return;
  if (root !== currentRoot) { currentRoot = root; lastLoad = 0; generation++; pdfKeys.set(new Set()); }
  if (Date.now() - lastLoad < minIntervalMs) return;
  const epoch = ++generation;
  try {
    const keys = await listPdfKeys(root);
    if (epoch === generation && root === currentRoot) { pdfKeys.set(keys); lastLoad = Date.now(); }
  } catch { /* Failed refresh remains retryable; keep the last known good set. */ }
}

export { hasPdfIn };
