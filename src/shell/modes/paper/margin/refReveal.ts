// Cross-pane "show me this reference" handshake: the hover card (or any
// future caller) requests a citekey; the References pane scrolls to it,
// untwirls its details, and flashes the row. A bump-counter store, same shape
// as marginPanes' paneFocusReq.
//
// Per-pane (dual-paper 2026-08-11): one instance per PaperMode, threaded to
// the Bibliography view through the MarginHost — a module-global request would
// flash the row in BOTH panes' margins.

import { writable, type Writable } from "svelte/store";

export interface RefReveal {
  refRevealReq: Writable<{ key: string; n: number }>;
  requestRefReveal(key: string): void;
}

export function createRefReveal(): RefReveal {
  const refRevealReq = writable<{ key: string; n: number }>({ key: "", n: 0 });
  return {
    refRevealReq,
    requestRefReveal(key: string) {
      refRevealReq.update((r) => ({ key, n: r.n + 1 }));
    },
  };
}
