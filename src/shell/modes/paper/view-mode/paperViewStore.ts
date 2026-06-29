// The continuous/paginated preference — a user preference, persisted to
// localStorage exactly like src/lib/settings.ts.

import { writable } from "svelte/store";

export type PaperViewMode = "continuous" | "paginated";

const KEY = "flux.paper.viewMode";

function load(): PaperViewMode {
  try {
    return localStorage.getItem(KEY) === "paginated" ? "paginated" : "continuous";
  } catch {
    return "continuous";
  }
}

export const paperViewMode = writable<PaperViewMode>(load());
paperViewMode.subscribe((v) => {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* ignore */
  }
});
