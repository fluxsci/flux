import { writable } from "svelte/store";

/** A one-shot canvas placement request, owned by the canvas on this tenant. */
export const figurePlacement = writable<{ canvasId: string; root: string | null } | null>(null);
