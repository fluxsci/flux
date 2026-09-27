import { writable } from "svelte/store";

/** Freezes editor input and defers external model reloads until Annotate closes. */
export const annotationOpen = writable(false);
