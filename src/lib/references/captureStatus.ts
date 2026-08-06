// Shell-level status line for web capture.
//
// Capture arrives asynchronously — a file lands in the download folder whenever the user
// clicks the bookmarklet, which may be while they're in Paper mode or sitting on Home. So the
// feedback can't belong to the Library pane; Shell renders it wherever you are.
import { writable } from "svelte/store";

export type CaptureKind = "busy" | "ok" | "err";
export interface CaptureStatus {
  kind: CaptureKind;
  msg: string;
}

const store = writable<CaptureStatus | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;

export const captureStatus = {
  subscribe: store.subscribe,
  /** Show a status. `ttl` 0 keeps it up (used for "busy" until the next call replaces it). */
  show(kind: CaptureKind, msg: string, ttl = 0): void {
    store.set({ kind, msg });
    clearTimeout(timer);
    if (ttl) timer = setTimeout(() => store.set(null), ttl);
  },
  clear(): void {
    clearTimeout(timer);
    store.set(null);
  },
};
