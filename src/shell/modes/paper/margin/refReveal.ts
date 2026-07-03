// Cross-pane "show me this reference" handshake: the hover card (or any
// future caller) requests a citekey; the References pane scrolls to it,
// untwirls its details, and flashes the row. A bump-counter store, same shape
// as marginPanes' paneFocusReq.

import { writable } from "svelte/store";

export const refRevealReq = writable<{ key: string; n: number }>({ key: "", n: 0 });

export function requestRefReveal(key: string) {
  refRevealReq.update((r) => ({ key, n: r.n + 1 }));
}
