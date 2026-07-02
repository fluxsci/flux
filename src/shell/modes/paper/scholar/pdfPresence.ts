// Which FluxLib citekeys have a full-text PDF on disk — powers the hover
// card's "Read PDF" pill and the bibliography's read action. One readdir of
// FluxLib's items/ per refresh, throttled: hover cards mount constantly but
// the items/ directory changes rarely (stale-while-revalidate — the old set
// stays visible until the fresh one lands).

import { writable } from "svelte/store";
import { listPdfKeys, hasPdfIn } from "../../../../lib/references/itemsBridge";

export const pdfKeys = writable<Set<string>>(new Set());

let lastLoad = 0;
export function refreshPdfKeys(minIntervalMs = 15_000) {
  const now = Date.now();
  if (now - lastLoad < minIntervalMs) return;
  lastLoad = now;
  listPdfKeys()
    .then((s) => pdfKeys.set(s))
    .catch(() => {});
}

export { hasPdfIn };
